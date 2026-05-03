/**
 * RAGSource MCP v2 — Agentic RAG
 *
 * Fünf Tools für hierarchische Rechtsquellensuche + strukturierte DB-Abfragen:
 *   RAGSource_catalog  → Verzeichnis aller verfügbaren Quellen für eine Gemeinde
 *   RAGSource_toc      → Inhaltsverzeichnis(se) einer oder mehrerer Quellen
 *   RAGSource_get      → Originalwortlaut spezifischer Paragraphen
 *   RAGSource_query    → FTS5-Volltextsuche (Convenience-Wrapper / Fallback)
 *   RAGSource_db_query → Strukturierte Abfragen gegen tabellarische Datenbestände (optional, wenn DB_STRUCTURED gebunden)
 */

import { McpAgent } from "agents/mcp";
import { getCurrentAgent } from "agents";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  Env,
  Source,
  SourceSection,
  CatalogEntry,
  TocResult,
  SectionResult,
  QueryHit,
} from "./types.js";
import { resolveGeo, suggestGeo, type ResolvedGeo, type AmbiguousGeo, type GeoCandidate } from "./engine/normalize.js";
import { resolveExtensions, buildExtensionsWarning, EXTENSIONS_PARAMETER_DESCRIPTION, type ExtensionResolution } from "./engine/extensions.js";

// -----------------------------------------------------------------------
// Geo-Filter für die sources-Tabelle
// -----------------------------------------------------------------------

/**
 * Opaque type für hardcodierte SQL-Fragmente.
 * Zweck: TypeScript-Fehler erzwingen, wenn Benutzereingaben direkt in sql landen.
 * Alle Benutzerdaten müssen über params fließen, niemals über sql.
 */
type SafeSqlStr = string & { readonly _brand: "SafeSqlStr" };
/** Markiert einen hardcodierten SQL-String als sicher. Nie mit Benutzereingaben verwenden. */
const s = (sql: string): SafeSqlStr => sql as SafeSqlStr;

interface SqlFragment {
  sql: SafeSqlStr;
  params: (string | null)[];
}

/**
 * Baut einen Geo-Filter für die sources-Tabelle (Alias: s).
 *
 * Logik "nur aufwärts":
 *   - Für jede ARS-Ebene gilt: Quelle muss NULL haben (= übergeordnet)
 *     ODER den passenden ARS-Wert.
 *   - Wenn geo keinen ARS auf einer Ebene hat (z.B. Verband-Query hat keine
 *     gemeinde_ars), dann muss die Quelle dort ebenfalls NULL haben.
 *     → Gemeinde-Quellen werden für Verband-Queries ausgeblendet. ✓
 */
function buildGeoFilter(geo: ResolvedGeo | null): SqlFragment {
  if (!geo) {
    return { sql: s("1=1"), params: [] };
  }

  const conditions: string[] = [];
  const params: (string | null)[] = [];

  // Land-Ebene
  if (geo.land_ars) {
    conditions.push("(s.land_ars IS NULL OR s.land_ars = ?)");
    params.push(geo.land_ars);
  } else {
    conditions.push("s.land_ars IS NULL");
  }

  // Kreis-Ebene
  if (geo.kreis_ars) {
    conditions.push("(s.kreis_ars IS NULL OR s.kreis_ars = ?)");
    params.push(geo.kreis_ars);
  } else {
    conditions.push("s.kreis_ars IS NULL");
  }

  // Verband-Ebene
  if (geo.verband_ars) {
    conditions.push("(s.verband_ars IS NULL OR s.verband_ars = ?)");
    params.push(geo.verband_ars);
  } else {
    conditions.push("s.verband_ars IS NULL");
  }

  // Gemeinde-Ebene
  if (geo.gemeinde_ars) {
    conditions.push("(s.gemeinde_ars IS NULL OR s.gemeinde_ars = ?)");
    params.push(geo.gemeinde_ars);
  } else {
    conditions.push("s.gemeinde_ars IS NULL");
  }

  return {
    sql: s(conditions.join(" AND ")),
    params,
  };
}

/**
 * Endpoint-Filter (Tenancy): Quellen ohne Endpoint-Einträge sind universell.
 * mandatory="all" oder undefined → kein Filter (alles durch).
 */
function buildEndpointFilter(mandatory: string | undefined): SqlFragment {
  if (!mandatory || mandatory === "all") {
    return { sql: s("1=1"), params: [] };
  }
  return {
    sql: s(`(
      NOT EXISTS (SELECT 1 FROM source_endpoints se WHERE se.source_id = s.id)
      OR EXISTS (SELECT 1 FROM source_endpoints se WHERE se.source_id = s.id AND se.endpoint = ?)
    )`),
    params: [mandatory],
  };
}

/**
 * Extension-Filter (Themen): Quellen ohne Extension-Einträge sind NICHT sichtbar,
 * wenn ein Filter aktiv ist.
 * Extension "universal" → immer sichtbar (wird automatisch hinzugefügt).
 * Leeres Array → kein Filter (alles durch).
 * Mehrere Werte → OR-verknüpft, AUSNAHME: "historisch" ist AND-verknüpft.
 * Beispiel: ["Baurecht","historisch"] → hat Baurecht UND hat historisch.
 */
function buildExtensionsFilter(userFilters: string[]): SqlFragment {
  if (userFilters.length === 0) {
    return { sql: s("1=1"), params: [] };
  }

  const hasHistorisch = userFilters.includes("historisch");
  const contentFilters = userFilters.filter((f) => f !== "historisch");

  if (hasHistorisch && contentFilters.length === 0) {
    // Nur "historisch" → alle Dokumente mit historisch-Tag
    return {
      sql: s(`EXISTS (SELECT 1 FROM source_extensions sx WHERE sx.source_id = s.id AND sx.extension = ?)`),
      params: ["historisch"],
    };
  }

  const effectiveContent = [...new Set([...contentFilters, "universal"])];
  const ph = effectiveContent.map(() => "?").join(", ");
  const contentClause = s(`EXISTS (SELECT 1 FROM source_extensions sx WHERE sx.source_id = s.id AND sx.extension IN (${ph}))`);

  if (hasHistorisch) {
    // Inhaltliche Extensions (OR) UND historisch (AND)
    return {
      sql: s(`(
        EXISTS (SELECT 1 FROM source_extensions sx2 WHERE sx2.source_id = s.id AND sx2.extension = ?)
        AND ${contentClause}
      )`),
      params: ["historisch", ...effectiveContent],
    };
  }

  return {
    sql: s(`(${contentClause})`),
    params: effectiveContent,
  };
}

// -----------------------------------------------------------------------
// Normenhierarchie-Sortierung für den Catalog
// -----------------------------------------------------------------------

/**
 * Sortiert Quellen für den Catalog: Gemeinde zuerst (lokal → spezifisch),
 * Bund zuletzt (allgemein). Innerhalb einer Ebene alphabetisch nach Titel.
 */
// Normenhierarchie: lokal zuerst → allgemein zuletzt
// Werte entsprechen dem ebene-Feld im Frontmatter (v1-Stil: "gemeinde", "land" etc.)
const EBENE_ORDER: Record<string, number> = {
  "gemeinde": 1,
  "verband": 2,
  "kreis": 3,
  "land": 4,
  "bund": 5,
  "eu": 6,
  "tarifrecht": 7,
};

function sortByEbene<T extends Pick<Source, "ebene" | "titel" | "typ">>(sources: T[]): T[] {
  return [...sources].sort((a, b) => {
    // Skills immer zuerst (vor allen Rechtsquellen)
    const aIsSkill = a.typ === "skill" ? 0 : 1;
    const bIsSkill = b.typ === "skill" ? 0 : 1;
    if (aIsSkill !== bIsSkill) return aIsSkill - bIsSkill;
    const orderA = EBENE_ORDER[a.ebene ?? ""] ?? 99;
    const orderB = EBENE_ORDER[b.ebene ?? ""] ?? 99;
    if (orderA !== orderB) return orderA - orderB;
    return (a.titel ?? "").localeCompare(b.titel ?? "", "de");
  });
}

// -----------------------------------------------------------------------
// FTS5-Hilfsfunktionen (für RAGSource_query)
// -----------------------------------------------------------------------

const STOP_WORDS = new Set([
  "der", "die", "das", "den", "dem", "des",
  "ein", "eine", "einer", "einem", "einen", "eines",
  "und", "oder", "aber", "als", "wie", "was", "wer", "wo", "wann",
  "ist", "sind", "war", "wird", "werden", "hat", "haben", "kann",
  "mit", "von", "zu", "auf", "in", "an", "für", "über", "nach",
  "bei", "aus", "um", "durch", "nicht", "noch", "auch", "nur",
  "ich", "er", "sie", "es", "wir", "ihr", "man",
  "wenn", "dass", "ob", "weil", "da", "so", "im", "am", "zum", "zur",
]);

/** FTS5-Query bereinigen: Stoppwörter entfernen, Wörter mit OR verknüpfen */
function buildFtsQuery(input: string): string | null {
  const cleaned = input
    .replace(/[^\w\sÄäÖöÜüß]/g, " ")   // Bindestrich entfernen — FTS5 interpretiert ihn als NOT-Operator
    .replace(/\s+/g, " ")
    .trim();

  const words = cleaned
    .split(" ")
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w.toLowerCase()));

  if (words.length === 0) return null;
  return words.join(" OR ");
}

// -----------------------------------------------------------------------
// MCP Instructions (kurze projektspezifische Beschreibung für MCP-Initialize)
// Vollständige Masterprompts → src/prompts/*.md (Claude.ai Projekt-System-Prompt)
// -----------------------------------------------------------------------

/**
 * Tool-Description für den `geo`-Parameter (zentral, von catalog + query genutzt).
 * Deckt ARS-Codes, Klarnamen, Multi-Token-Disambiguierung, Ebenen-Hints,
 * Sonderwerte und das Verhalten bei Mehrdeutigkeit / Unbekanntem ab.
 */
const GEO_PARAMETER_DESCRIPTION =
  "Geographic scope. Accepts ARS code or plain name. " +
  "ARS lengths: 2-digit (state), 5-digit (district), 9-digit (association), 12-digit (municipality). " +
  "Examples: '08' (BW), '083155012074', 'Müllheim Markgräflerland', 'Lkr Göppingen', 'Bayern', 'Breisgau-Hochschwarzwald'. " +
  "Multi-word names disambiguate automatically: 'Müllheim Markgräflerland' resolves uniquely to the only Müllheim with 'Markgräflerland' in its name. " +
  "Level-hint prefixes supported: 'Kreis X' / 'Lkr X' / 'Landkreis X' for district, 'Verband X' / 'GVV X' for association, 'Land X' / 'Bundesland X' for state. " +
  "Special values: '00' = EU + federal law only (no regional sources); 'full' = entire catalog (rare, only if no geo applies). " +
  "On ambiguous input the response returns 'geo_ambiguous' with a typed candidate list (typ: gemeinde/verband/kreis/land) — present these to the user as multiple-choice and re-call with the chosen ARS. " +
  "On unknown input: 'geo_not_found' with prefix-based suggestions. " +
  "Never fabricate or guess an ARS code — if the input is unclear, ask the user.";

/** Static MCP-server instructions (Single Source of Truth — same for all endpoints). */
const INSTRUCTIONS =
  "RAGSource — Agentic RAG Framework.\n" +
  "\n" +
  "Workflow: RAGSource_catalog → RAGSource_toc (M/L) → RAGSource_get.\n" +
  "RAGSource_query as alternative when: (a) catalog returns no matching source, " +
  "(b) topic unclear and cross-source search is useful. " +
  "Do not use if source is already known from catalog — prefer toc+get.\n" +
  "\n" +
  "Loading order — strictly follow:\n" +
  "(1) Säule 1: load all relevant sources from catalog (laws, FwDVs, VwVen, ordinances) " +
  "— RAGSource_toc for M/L, RAGSource_get for S.\n" +
  "(2) Säule 2: load all relevant skills from catalog (typ: skill) " +
  "— RAGSource_toc for M/L, RAGSource_get for S. " +
  "Skills appear first in catalog response but are loaded second. " +
  "Skills extend Säule-1 content with practitioner knowledge — no duplication.\n" +
  "(3) Säule 3: future local data.\n" +
  "\n" +
  "Norm hierarchy: higher-ranking law supersedes lower-ranking (e.g. federal > state). " +
  "On conflicts: cite the higher-ranking norm and name the conflict.";

// -----------------------------------------------------------------------
// Projekt-Erkennung via Host-Header
// -----------------------------------------------------------------------

/**
 * Mappt Hostnamen auf Endpoint-Slugs (Tenancy).
 * "all" = kein Endpoint-Filter (alles durch, z.B. für paragrafenreiter.ai).
 * Kein Eintrag = Direktaufruf, ebenfalls kein Filter.
 */
const ENDPOINT_BY_HOST: Record<string, string> = {
  "mcp.amtsschimmel.ai": "amtsschimmel",
  "mcp-lean.amtsschimmel.ai": "amtsschimmel",
  "mcp.paragrafenreiter.ai": "all",
  "mcp.brandmeister.ai": "brandmeister",
  "mcp-gp1.brandmeister.ai": "brandmeister",
  "mcp-ct1.ragsource.ai": "all",
};

/** Gibt den Endpoint-Slug des aktuellen Hosts zurück. */
function resolveMandatoryEndpoint(): string | undefined {
  try {
    const { request } = getCurrentAgent();
    const hostname = new URL(request?.url ?? "").hostname;
    return ENDPOINT_BY_HOST[hostname] ?? undefined;
  } catch {
    return undefined;
  }
}

// -----------------------------------------------------------------------
// Endpoint-Profile (statisches Branding pro Tenant — Single Source of Truth)
//
// Statisches Inhalts-Branding lebt im Code (versioniert, in git, Code-Review).
// Dynamische Inhalte (Wartungs-Banner, etc.) gibt es im aktuellen Setup nicht;
// für Live-Pflege ohne Redeploy müsste eine bewusste Override-Mechanik wieder
// eingeführt werden — bis dahin: jede inhaltliche Änderung läuft über git/Deploy.
// -----------------------------------------------------------------------

interface EndpointProfile {
  /** Branding-Text mit Markdown — wird als system_message im Catalog-Response geliefert */
  systemMessage: string;
  /** Kontakt-Adresse für not_configured-Hinweise und sonstige Verweise */
  contactMail: string;
}

const RAGSOURCE_BRANDING =
  "**Powered by RAGSource.ai** — Mehr Infos [hier](https://www.ragsource.ai)";

const ENDPOINT_PROFILES: Record<string, EndpointProfile> = {
  amtsschimmel: {
    systemMessage:
      "**amtsschimmel.ai — die kommunale Wissensbasis.** Mehr Infos: [www.amtsschimmel.ai](https://www.amtsschimmel.ai)",
    contactMail: "kontakt@amtsschimmel.ai",
  },
  brandmeister: {
    // Brandmeister nutzt bewusst das RAGSource-Branding (analog zum bisherigen
    // Live-Verhalten — kein eigener system_message:brandmeister-KV-Eintrag existierte).
    systemMessage: RAGSOURCE_BRANDING,
    contactMail: "kontakt@brandmeister.ai",
  },
  all: {
    // "all" = paragrafenreiter (kein Tenancy-Filter).
    systemMessage:
      "**Powered by paragrafenreiter.ai** — Mehr Infos [hier](https://www.paragrafenreiter.ai)",
    contactMail: "kontakt@paragrafenreiter.ai",
  },
  default: {
    systemMessage: RAGSOURCE_BRANDING,
    contactMail: "info@ragsource.ai",
  },
};

/** Liefert das Profil für einen Endpoint (mit Default-Fallback). */
function getEndpointProfile(endpoint: string | undefined): EndpointProfile {
  return ENDPOINT_PROFILES[endpoint ?? "default"] ?? ENDPOINT_PROFILES.default;
}

/** Baut den `not_configured`-Hinweistext aus dem Endpoint-Profil. */
function buildNotConfiguredHinweis(profile: EndpointProfile, gemeindeName: string): string {
  return (
    `Hinweis an den Assistenten: Die Gemeinde "${gemeindeName}" ist noch nicht als eigenständige ` +
    `Rechtsquelle hinterlegt. Es werden nur übergeordnete Regelungen (Land/Kreis/Verband) gezeigt — ` +
    `diese im Catalog konkret benennen. ` +
    `Teile dem Nutzer mit: 'Ihre Gemeinde wurde noch nicht aufgenommen. ` +
    `Es werden Ihnen übergeordnete Regelungen angezeigt. Um Ihre Gemeinde aufzunehmen, ` +
    `schreiben Sie bitte an ${profile.contactMail}'.`
  );
}

// -----------------------------------------------------------------------
// Geo-Hilfsfunktionen
// -----------------------------------------------------------------------

/** ARS-Tabelle der 16 Bundesländer (2-stellig) */
const BUNDESLAND_ARS: Record<string, string> = {
  "01": "Schleswig-Holstein",
  "02": "Hamburg",
  "03": "Niedersachsen",
  "04": "Bremen",
  "05": "Nordrhein-Westfalen",
  "06": "Hessen",
  "07": "Rheinland-Pfalz",
  "08": "Baden-Württemberg",
  "09": "Bayern",
  "10": "Saarland",
  "11": "Berlin",
  "12": "Brandenburg",
  "13": "Mecklenburg-Vorpommern",
  "14": "Sachsen",
  "15": "Sachsen-Anhalt",
  "16": "Thüringen",
};

/** Nur EU + Bund (alle ARS-Spalten IS NULL) */
const GEO_BUND_ONLY: SqlFragment = {
  sql: s("s.land_ars IS NULL AND s.kreis_ars IS NULL AND s.verband_ars IS NULL AND s.gemeinde_ars IS NULL"),
  params: [],
};

/** Geo-Anweisungstext für Fehlermeldungen (a + b) */
function buildGeoAnweisungen(): string {
  const bundeslandListe = Object.entries(BUNDESLAND_ARS)
    .map(([ars, name]) => `    ${ars} → ${name}`)
    .join("\n");
  return (
    `Bitte das Tool mit dem passenden geo-Parameter erneut aufrufen:\n` +
    `• Nur EU- und Bundesrecht:  geo = "00"\n` +
    `• Gesamter Katalog (selten): geo = "full"\n` +
    `• Landesrecht: geo = 2-stelliger ARS des Bundeslandes oder Bundesland-Klarname:\n${bundeslandListe}\n` +
    `• Kommunale Fragen: geo = Klarname der Gemeinde (z.B. "Müllheim Markgräflerland") ` +
    `oder ARS der Gemeinde (12-stellig), des Gemeindeverbands (9) oder des Landkreises (5)\n\n` +
    `WICHTIG: Wenn der Klarname nicht eindeutig auflöst, frage den Nutzer per Multiple-Choice nach. ` +
    `Erfinde oder rate KEINEN ARS-Code — falsche ARS-Werte führen zu falschen Quellen.\n\n` +
    `Hinweis an den Nutzer: Die Anfrage läuft beim nächsten Mal effizienter, wenn der MCP-Link ` +
    `über die in der System Message verlinkte Projektseite für den eigenen Geltungsbereich generiert wird — ` +
    `dann wird geo automatisch übergeben.`
  );
}

/**
 * Fehlermeldung wenn kein geo-Parameter übergeben wurde.
 */
function buildNoGeoResponse(
  systemMessage: string | null,
): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        ...(systemMessage && { system_message: systemMessage }),
        error: "geo_missing",
        hinweis:
          `Dieser Aufruf enthält keinen geo-Parameter — das Tool benötigt immer eine Geo-Angabe.\n\n` +
          buildGeoAnweisungen(),
      }),
    }],
  };
}

/** Formatiert einen Kandidaten als Listenzeile mit Typ-Markierung */
function formatCandidate(c: GeoCandidate): string {
  const typLabel: Record<string, string> = {
    gemeinde: "Gemeinde",
    verband: "Verband",
    kreis: "Landkreis",
    land: "Bundesland",
  };
  const label = typLabel[c.typ] ?? c.typ;
  const ctxParts: string[] = [];
  if (c.typ === "gemeinde") {
    if (c.kreis) ctxParts.push(`Lkr ${c.kreis}`);
    if (c.land) ctxParts.push(c.land);
  } else if (c.typ === "verband") {
    if (c.kreis) ctxParts.push(`Lkr ${c.kreis}`);
    if (c.land) ctxParts.push(c.land);
  } else if (c.typ === "kreis") {
    if (c.land) ctxParts.push(c.land);
  }
  const ctx = ctxParts.length > 0 ? ` (${ctxParts.join(", ")})` : "";
  return `• [${label}] ${c.name}${ctx} — ARS: ${c.ars}`;
}

/**
 * Fehlermeldung wenn ein geo-Wert übergeben wurde, der nicht aufgelöst werden konnte.
 * Liefert zusätzlich Top-N Prefix-Vorschläge (wenn vorhanden), damit das LLM dem Nutzer
 * konkrete Alternativen anbieten kann statt ARS zu raten.
 */
async function buildGeoNotFoundResponse(
  input: string,
  systemMessage: string | null,
  db: D1Database,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const suggestions = /^\d+$/.test(input.trim()) ? [] : await suggestGeo(input, db, 5);
  const suggestionList = suggestions.length > 0
    ? `\n\nÄhnliche Einträge — meintest du eine davon?\n${suggestions.map(formatCandidate).join("\n")}\n`
    : "";

  const payload = {
    ...(systemMessage && { system_message: systemMessage }),
    error: "geo_not_found",
    geo: { name: `"${input}" (nicht gefunden)`, level: "unbekannt" },
    ...(suggestions.length > 0 && { suggestions }),
    hinweis:
      `Der geo-Wert "${input}" konnte nicht aufgelöst werden.${suggestionList}\n` +
      `Bitte den Nutzer fragen, welcher Geltungsbereich gemeint ist. ` +
      `Erfinde oder rate KEINEN ARS-Code.\n\n` +
      buildGeoAnweisungen(),
  };

  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

/**
 * Baut eine frühe MCP-Antwort für mehrdeutige Geo-Angaben.
 * Gibt eine Kandidatenliste mit Typ-Markierung (Gemeinde/Verband/Kreis/Land) zurück,
 * ohne Quellen zu liefern.
 */
function buildAmbiguousResponse(
  ambiguous: AmbiguousGeo,
  systemMessage: string | null,
): { content: Array<{ type: "text"; text: string }> } {
  const list = ambiguous.candidates.map(formatCandidate).join("\n");
  const truncatedNote = ambiguous.truncated
    ? `\n\n(Liste auf ${ambiguous.candidates.length} Kandidaten begrenzt — falls die gesuchte Gemeinde fehlt, präziser fragen, z.B. mit Bundesland oder Landkreis: "${ambiguous.input}, Bayern".)`
    : "";

  const payload = {
    ...(systemMessage && { system_message: systemMessage }),
    error: "geo_ambiguous",
    geo: { name: `"${ambiguous.input}" (mehrdeutig)`, level: "unbekannt" },
    hinweis:
      `Der Geo-Name "${ambiguous.input}" ist nicht eindeutig — es gibt mehrere passende Einträge. ` +
      `Bitte den Nutzer per Multiple-Choice fragen, welcher Eintrag gemeint ist, ` +
      `und das Tool dann mit dem entsprechenden ARS-Code erneut aufrufen. ` +
      `Erfinde oder rate KEINEN ARS-Code.\n\n` +
      `Gefundene Treffer:\n${list}${truncatedNote}\n\n` +
      `Bei Fragen oder falls der gesuchte Eintrag nicht aufgeführt ist: support@amtsschimmel.ai`,
    candidates: ambiguous.candidates,
  };

  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

// -----------------------------------------------------------------------
// MCP Agent
// -----------------------------------------------------------------------

export class RAGSourceMCPv2 extends McpAgent<Env> {
  /** Host des eingehenden Requests — wird in fetch() gesetzt, bevor init() läuft */
  private _currentHost: string = "";
  /** Geo-Parameter aus der MCP-URL (?geo=...) — für geo-Hinweis in Instructions */
  private _currentGeo: string = "";
  /** Extension-Filter aus der MCP-URL (?extensions=Feuerwehr,Arbeitsrecht) */
  private _currentExtensions: string[] = [];

  /**
   * Placeholder-Server (nötig weil McpAgent die Property beim Start liest).
   * In init() wird er durch den projekt-spezifischen Server ersetzt.
   */
  server = new McpServer(
    { name: "RAGSource", version: "2.0.0" },
    { instructions: INSTRUCTIONS },
  );

  /**
   * Überschreibt den DO-fetch, um Host und geo-Parameter zu erfassen,
   * bevor init() den projekt-spezifischen Instructions-Text erstellt.
   */
  override async fetch(request: Request): Promise<Response> {
    // Der agents SDK übernimmt den originalen Host als URL-Hostname des internen DO-Requests.
    // Host-Header selbst wird dabei gestrippt — URL-Hostname ist die zuverlässige Quelle.
    try {
      const url = new URL(request.url);
      this._currentHost = url.hostname;
      this._currentGeo = url.searchParams.get("geo") ?? "";
      const ext = url.searchParams.get("extensions");
      this._currentExtensions = ext ? ext.split(",").map((e) => e.trim()).filter(Boolean) : [];
    } catch {
      this._currentHost = "";
      this._currentGeo = "";
      this._currentExtensions = [];
    }
    return super.fetch(request);
  }

  async init() {
    // Instructions sind statisch im Code — keine KV-Override-Mechanik mehr.
    // Inhaltliche Änderungen laufen ausschließlich über git/Deploy.
    this.server = new McpServer(
      { name: "RAGSource", version: "2.0.0" },
      { instructions: INSTRUCTIONS },
    );

    // ===================================================================
    // Tool 1: RAGSource_catalog
    // ===================================================================
    this.server.tool(
      "RAGSource_catalog",
      "STEP 1 — Required first call for every request. " +
      "Returns available legal sources (EU to municipal level) and optional skills (LLM instructions). " +
      "Skills (typ:skill): appear first in catalog; load with RAGSource_toc/get like any source, then follow their instructions before answering. " +
      "Routing by size: S → RAGSource_get directly; M/L → RAGSource_toc first, then RAGSource_get. " +
      "system_message in response: prepend verbatim as italicized system notice to the user.",
      {
        geo: z
          .string()
          .max(100)
          .optional()
          .describe(GEO_PARAMETER_DESCRIPTION),
        extensions: z
          .array(z.string())
          .optional()
          .describe(EXTENSIONS_PARAMETER_DESCRIPTION),
      },
      { title: "RAGSource catalog", readOnlyHint: true, destructiveHint: false },
      async ({ geo: geoInput, extensions: extensionsInput }) => {
        const db = this.env.DB;

        // Endpoint-Profile liefert das Branding (system_message) und die
        // Kontaktmail für not_configured — statisch im Code, in git versioniert.
        const currentEndpoint = resolveMandatoryEndpoint();
        const profile = getEndpointProfile(currentEndpoint);

        // KV `system_message` (ohne Suffix, global): optionaler Wartungs-/Live-Banner.
        // Überschreibt das Endpoint-Branding solange er gesetzt ist (für alle Endpoints
        // gleichzeitig). Setzen via `wrangler kv key put system_message "<Text>"`,
        // Entfernen via `wrangler kv key delete system_message`.
        const kvBanner = (await this.env.CONFIG?.get("system_message")) ?? null;
        const systemMessage = kvBanner ?? profile.systemMessage;

        // Geo auflösen; URL-?geo= als Request-Default wenn kein expliziter Parameter.
        // _currentGeo wird per fetch() pro Request gesetzt — robuster als sessionGeo-Closure,
        // die beim DO-Reuse stale sein kann.
        const effectiveGeo = geoInput ?? (this._currentGeo || null);

        // Fall a: kein geo → früher Abbruch mit Anweisungen
        if (!effectiveGeo) {
          return buildNoGeoResponse(systemMessage);
        }

        // Spezialwerte (kein DB-Lookup nötig)
        // "00"   → explizit nur EU + Bund
        // "full" → gesamter Katalog ohne Geo-Filter
        let geoSpecialFilter: SqlFragment | null = null;
        let geoSpecialInfo: { name: string; level: string } | null = null;
        if (effectiveGeo === "00") {
          geoSpecialFilter = GEO_BUND_ONLY;
          geoSpecialInfo = { name: "EU & Bund", level: "bund" };
        } else if (effectiveGeo.toLowerCase() === "full") {
          geoSpecialFilter = { sql: s("1=1"), params: [] };
          geoSpecialInfo = { name: "alle Ebenen", level: "alle" };
        }

        let geo: ResolvedGeo | null = null;
        if (!geoSpecialFilter) {
          const geoResult = await resolveGeo(effectiveGeo, db);

          // Mehrdeutiger Geo → früher Abbruch mit Kandidatenliste
          if (geoResult && "ambiguous" in geoResult) {
            return buildAmbiguousResponse(geoResult, systemMessage);
          }

          geo = geoResult as ResolvedGeo | null;

          // Fall b: ARS übergeben, aber nicht in der DB → früher Abbruch mit Anweisungen
          if (geo === null) {
            return await buildGeoNotFoundResponse(effectiveGeo, systemMessage, db);
          }
        }

        const geoFilter = geoSpecialFilter ?? buildGeoFilter(geo);
        const endpointFilter = buildEndpointFilter(resolveMandatoryEndpoint());
        // Extension-Auflösung: rohe LLM-Eingabe → kanonische Taxonomie-Werte.
        // Unbekanntes (z.B. "Feuerwehr", "Aufwandsentschädigung") wird gemappt
        // (per Synonym/Prefix) oder ignoriert — niemals 1:1 in die SQL übernommen.
        const rawExtensions = extensionsInput?.length ? extensionsInput : this._currentExtensions;
        const extResolution = resolveExtensions(rawExtensions);
        const effectiveExtensions = extResolution.resolved;
        const extensionsFilter = buildExtensionsFilter(effectiveExtensions);
        const extWarning = buildExtensionsWarning(extResolution);

        // Quellen abfragen — alle Felder, die das LLM braucht
        // Wenn Extensions aktiv: additiv — Endpoint-Match ODER Extension-Match (OR-Verknüpfung).
        // Ohne Extensions: nur Endpoint-Filter (AND-Verknüpfung wie bisher).
        const hasExtensionsFilter = effectiveExtensions.length > 0;
        const tenancyClause = hasExtensionsFilter
          ? `(${endpointFilter.sql} OR ${extensionsFilter.sql})`
          : endpointFilter.sql;
        const tenancyParams = hasExtensionsFilter
          ? [...endpointFilter.params, ...extensionsFilter.params]
          : endpointFilter.params;

        const sql = `
          SELECT s.id, s.titel, s.typ, s.ebene, s.rechtsrang, s.size_class, s.beschreibung,
                 EXISTS(SELECT 1 FROM source_tocs t WHERE t.source_id = s.id) AS toc_available
          FROM sources s
          WHERE ${geoFilter.sql}
            AND ${tenancyClause}
          ORDER BY s.ebene, s.titel
        `;

        type CatalogRow = {
          id: string;
          titel: string;
          typ: string | null;
          ebene: string | null;
          rechtsrang: number | null;
          size_class: string;
          beschreibung: string | null;
          toc_available: 0 | 1;
        };
        const result = await db
          .prepare(sql)
          .bind(...geoFilter.params, ...tenancyParams)
          .all<CatalogRow>();

        const publicSources = result.results ?? [];

        // Dual-DB: GP1-Quellen transparent hinzufügen.
        // Extensions-Filter anwenden falls aktiv — GP1-Inhalte folgen demselben
        // Filter wie die Hauptquellen (kein Endpoint-Filter nötig, da alle GP1-
        // Inhalte per Definition für dieses Deployment sichtbar sind).
        let allSources = [...publicSources];
        if (this.env.DB_GP1) {
          const gp1Filter = hasExtensionsFilter ? extensionsFilter : null;
          const gp1Sql = `
            SELECT s.id, s.titel, s.typ, s.ebene, s.rechtsrang, s.size_class, s.beschreibung,
                   EXISTS(SELECT 1 FROM source_tocs t WHERE t.source_id = s.id) AS toc_available
            FROM sources s
            WHERE ${geoFilter.sql}
              ${gp1Filter ? `AND ${gp1Filter.sql}` : ""}
            ORDER BY s.ebene, s.titel
          `;
          const gp1Result = await this.env.DB_GP1
            .prepare(gp1Sql)
            .bind(...geoFilter.params, ...(gp1Filter?.params ?? []))
            .all<CatalogRow>();
          const existingIds = new Set(publicSources.map((s) => s.id));
          for (const s of gp1Result.results ?? []) {
            if (!existingIds.has(s.id)) allSources.push(s);
          }
        }

        const sorted = sortByEbene(allSources);

        // Skills und Rechtsquellen trennen
        const sizeMap: Record<string, string> = { small: "S", medium: "M", large: "L" };
        const toEntry = (s: CatalogRow): CatalogEntry => [
          s.id,
          s.titel,
          s.rechtsrang,
          sizeMap[s.size_class] ?? "M",
          s.toc_available === 1,
          s.beschreibung || null,
        ];
        const skillEntries = sorted.filter((s) => s.typ === "skill");
        const sourceEntries = sorted.filter((s) => s.typ !== "skill");
        const skillCatalog: CatalogEntry[] = skillEntries.map(toEntry);
        const sourceCatalog: CatalogEntry[] = sourceEntries.map(toEntry);

        const geoInfo = geoSpecialInfo ?? {
          name: geo!.display.name,
          level: geo!.level,
          ars: geo!.gemeinde_ars ?? geo!.verband_ars ?? geo!.kreis_ars ?? geo!.land_ars,
        };

        // Nicht-konfiguriert-Fall (c):
        // Gemeinde-Ebene aufgelöst, aber keine Gemeinde-Quellen vorhanden
        const notConfigured =
          geo?.level === "gemeinde" && !sourceCatalog.some((s) => s[2] === 5); // rang 5 = Gemeinde
        const notConfiguredHinweis = notConfigured
          ? buildNotConfiguredHinweis(profile, geo!.display.name)
          : undefined;

        // Extensions-Block für Response: zeigt dem LLM was effektiv galt
        // und was umgemappt/ignoriert wurde — Lerneffekt für nächsten Aufruf.
        const extensionsBlock = rawExtensions.length > 0
          ? {
              extensions_input: rawExtensions,
              extensions_resolved: effectiveExtensions,
              ...(extResolution.mapped.length > 0 && { extensions_mapped: extResolution.mapped }),
              ...(extResolution.ignored.length > 0 && { extensions_ignored: extResolution.ignored }),
              ...(extWarning && { extensions_warning: extWarning }),
            }
          : null;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ...(systemMessage && { system_message: systemMessage }),
                geo: geoInfo,
                ...(extensionsBlock && extensionsBlock),
                total: sorted.length,
                ...(notConfigured && { not_configured: true, hinweis: notConfiguredHinweis }),
                schema: ["id", "titel", "rang", "size", "toc", "hint"],
                rang_legende: { 0: "EU", 1: "Bund", 2: "Land", 3: "Kreis", 4: "Verband", 5: "Gemeinde", 6: "Tarifrecht" },
                size_legende: { S: "get direkt", M: "toc empfohlen", L: "toc erforderlich" },
                ...(skillCatalog.length > 0 && { skills: skillCatalog }),
                sources: sourceCatalog,
              }),
            },
          ],
        };
      },
    );

    // ===================================================================
    // Tool 2: RAGSource_toc
    // ===================================================================
    this.server.tool(
      "RAGSource_toc",
      "STEP 2 — Table of contents for medium/large sources. " +
      "Returns all §§/articles with short titles, e.g. '§ 6 Aufgaben (Pflichtaufgaben, Mindeststärke)'. " +
      "Batch: up to 8 sources per call. Pass sections values verbatim to RAGSource_get. " +
      "Fallback: if no TOC file exists, small/medium sources return all §§ directly in 'sections' — skip RAGSource_get for those.",
      {
        sources: z
          .array(z.string())
          .min(1)
          .max(8)
          .describe(
            "Source IDs from RAGSource_catalog, e.g. ['BW_FwG', 'D_BGB']. Max. 8 per call.",
          ),
      },
      { title: "RAGSource toc", readOnlyHint: true, destructiveHint: false },
      async ({ sources: sourceIds }) => {
        const db = this.env.DB;
        const targetLevel = "gesamt";
        const ph = sourceIds.map(() => "?").join(", ");

        // Hilfsfunktion: Sources, TOCs und Sections für eine DB laden
        type SourceRow = Pick<Source, "id" | "titel" | "kurzbezeichnung" | "size_class" | "section_count">;
        const loadFromDb = async (targetDb: D1Database, ids: string[]) => {
          const p = ids.map(() => "?").join(", ");
          const [srcRes, tocRes] = await Promise.all([
            targetDb.prepare(`SELECT id, titel, kurzbezeichnung, size_class, section_count FROM sources WHERE id IN (${p})`).bind(...ids).all<SourceRow>(),
            targetDb.prepare(`SELECT source_id, content FROM source_tocs WHERE source_id IN (${p}) AND toc_level = ?`).bind(...ids, targetLevel).all<{ source_id: string; content: string }>(),
          ]);
          const sMap = new Map((srcRes.results ?? []).map((s) => [s.id, s]));
          const tMap = new Map((tocRes.results ?? []).map((t) => [t.source_id, t.content]));

          const needsSec = ids.filter((id) => { const s = sMap.get(id); return s && !tMap.has(id) && s.size_class !== "large"; });
          const secMap = new Map<string, SectionResult[]>();
          if (needsSec.length > 0) {
            const sp = needsSec.map(() => "?").join(", ");
            const secRes = await targetDb.prepare(`SELECT source_id, section_ref, heading, body FROM source_sections WHERE source_id IN (${sp}) ORDER BY source_id, sort_order`).bind(...needsSec).all<Pick<SourceSection, "section_ref" | "heading" | "body"> & { source_id: string }>();
            for (const r of secRes.results ?? []) {
              if (!secMap.has(r.source_id)) secMap.set(r.source_id, []);
              secMap.get(r.source_id)!.push({ ref: r.section_ref, heading: r.heading, body: r.body });
            }
          }
          return { sMap, tMap, secMap };
        };

        // 1. Public DB abfragen
        const { sMap: sourceMap, tMap: tocMap, secMap: sectionsMap } = await loadFromDb(db, sourceIds);

        // 2. Dual-DB: fehlende IDs in GP1 DB suchen
        if (this.env.DB_GP1) {
          const missingIds = sourceIds.filter((id) => !sourceMap.has(id));
          if (missingIds.length > 0) {
            const { sMap: gp1Sources, tMap: gp1Tocs, secMap: gp1Sections } = await loadFromDb(this.env.DB_GP1, missingIds);
            for (const [id, s] of gp1Sources) sourceMap.set(id, s);
            for (const [id, t] of gp1Tocs) tocMap.set(id, t);
            for (const [id, secs] of gp1Sections) sectionsMap.set(id, secs);
          }
        }

        // 3. Ergebnisse in der Reihenfolge der Eingabe zusammenbauen
        const results: TocResult[] = sourceIds.map((id) => {
          const source = sourceMap.get(id);
          if (!source) {
            return {
              source_id: id,
              titel: "(nicht gefunden)",
              size_class: "unknown",
              section_count: 0,
              toc: null,
            };
          }
          const toc = (tocMap.get(id) ?? null)?.replace(/\*\*/g, "") ?? null;
          const sections = sectionsMap.get(id);
          return {
            source_id: source.id,
            titel: source.titel,
            size_class: source.size_class,
            section_count: source.section_count,
            toc,
            ...(sections !== undefined && { sections }),
          };
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ tocs: results }, null, 2),
            },
          ],
        };
      },
    );

    // ===================================================================
    // Tool 3: RAGSource_get
    // ===================================================================
    this.server.tool(
      "RAGSource_get",
      "STEP 3 — Loads original text of §§ from one or more legal sources. " +
      "Batch multiple sources in one call for efficiency. " +
      "Use sections values exactly as returned by RAGSource_toc, e.g. '§ 2', 'Artikel 6'. " +
      "Limits: 8 sources / 25 §§ per source / 50 §§ total. " +
      "Response includes 'quelle_url' for source citations — use as Markdown link in citations.",
      {
        sources: z
          .array(
            z.object({
              source: z
                .string()
                .describe("Source ID from RAGSource_catalog, e.g. 'BW_FwG'"),
              sections: z
                .array(z.string())
                .max(25)
                .optional()
                .describe(
                  "Section references from RAGSource_toc, e.g. ['§ 2', '§ 8', 'Artikel 24']. " +
                  "Omit ONLY for S sources to load the full document. M/L sources always require section references from RAGSource_toc.",
                ),
            }),
          )
          .min(1)
          .max(8)
          .describe(
            "Sources with optional section references. Max. 8 sources, 25 §§ per source, 50 §§ total.",
          ),
      },
      { title: "RAGSource get", readOnlyHint: true, destructiveHint: false },
      async ({ sources: sourceRequests }) => {
        const db = this.env.DB;

        const MAX_TOTAL_SECTIONS = 50;
        type SourceResult = {
          source: string;
          titel?: string;
          kurzbezeichnung?: string | null;
          quelle?: string | null;
          quelle_url?: string | null;
          sections_geladen?: number;
          sections?: SectionResult[];
          error?: string;
        };
        const results: SourceResult[] = [];
        let totalSectionsLoaded = 0;
        let truncated = false;

        for (const req of sourceRequests) {
          // Quell-Metadaten laden — public DB zuerst, bei Fehltreffer GP1 DB versuchen
          type SourceMeta = Pick<Source, "id" | "titel" | "kurzbezeichnung" | "quelle" | "url" | "size_class" | "section_count">;
          const sourceSql = "SELECT id, titel, kurzbezeichnung, quelle, url, size_class, section_count FROM sources WHERE id = ?";
          let source = await db.prepare(sourceSql).bind(req.source).first<SourceMeta>();
          let activeDb: D1Database = db;
          if (!source && this.env.DB_GP1) {
            source = await this.env.DB_GP1.prepare(sourceSql).bind(req.source).first<SourceMeta>();
            if (source) activeDb = this.env.DB_GP1;
          }

          if (!source) {
            results.push({
              source: req.source,
              error: `Quelle '${req.source}' nicht gefunden. Bitte RAGSource_catalog aufrufen.`,
            });
            continue;
          }

          let sections: SectionResult[] = [];
          const sectionsNichtGefunden: string[] = [];

          if (!req.sections || req.sections.length === 0) {
            // Alle Paragraphen laden (gesamtes Dokument)
            const all = await activeDb
              .prepare(
                "SELECT section_ref, heading, body FROM source_sections WHERE source_id = ? ORDER BY sort_order",
              )
              .bind(req.source)
              .all<{ section_ref: string; heading: string | null; body: string }>();

            sections = (all.results ?? []).map((r) => ({
              ref: r.section_ref,
              heading: r.heading,
              body: r.body,
            }));
            totalSectionsLoaded += sections.length;
          } else {
            // Gezielte Paragraphen laden (normalisierter Abgleich)
            for (const rawRef of req.sections) {
              if (totalSectionsLoaded >= MAX_TOTAL_SECTIONS) {
                truncated = true;
                break;
              }

              const normalized = normalizeSectionRef(rawRef);

              // 1. Exakter Match (voller Titel)
              let row = await activeDb
                .prepare(
                  "SELECT section_ref, heading, body FROM source_sections WHERE source_id = ? AND section_ref = ? LIMIT 1",
                )
                .bind(req.source, normalized)
                .first<{ section_ref: string; heading: string | null; body: string }>();

              // 2. Kurzreferenz extrahieren (z.B. "§ 19 EStG [red. ...]" → "§ 19")
              //    LLMs senden oft den vollen TOC-Eintrag, DB hat nur "§ N" als section_ref
              if (!row) {
                const shortRef = extractSectionRef(normalized);
                if (shortRef && shortRef !== normalized) {
                  row = await activeDb
                    .prepare(
                      "SELECT section_ref, heading, body FROM source_sections WHERE source_id = ? AND section_ref = ? LIMIT 1",
                    )
                    .bind(req.source, shortRef)
                    .first<{ section_ref: string; heading: string | null; body: string }>();
                }
              }

              // 3. Fallback: Prefix-Match (z.B. "2.1" findet "2.1 Sachlicher Anwendungsbereich")
              //    INSTR statt LIKE: kein D1-Komplexitätslimit bei langen Unicode-Strings.
              //    Wortgrenze: Match muss an Position 1 beginnen, danach Leerzeichen oder Stringende
              //    → "§ 94" trifft nicht "§ 940" (Bug-Fix).
              if (!row) {
                row = await activeDb
                  .prepare(
                    "SELECT section_ref, heading, body FROM source_sections WHERE source_id = ? AND INSTR(section_ref, ?) = 1 AND (LENGTH(section_ref) = LENGTH(?) OR SUBSTR(section_ref, LENGTH(?) + 1, 1) = ' ') LIMIT 1",
                  )
                  .bind(req.source, normalized, normalized, normalized)
                  .first<{ section_ref: string; heading: string | null; body: string }>();
              }

              if (row) {
                sections.push({
                  ref: row.section_ref,
                  heading: row.heading,
                  body: row.body,
                });
                totalSectionsLoaded++;
              } else {
                sectionsNichtGefunden.push(rawRef);
              }
            }
          }

          results.push({
            source: source.id,
            titel: source.titel,
            kurzbezeichnung: source.kurzbezeichnung,
            quelle: source.quelle,
            quelle_url: source.url,
            sections_geladen: sections.length,
            sections,
            ...(sectionsNichtGefunden.length > 0 && {
              sections_nicht_gefunden: sectionsNichtGefunden,
            }),
          });
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  results,
                  total_sections: totalSectionsLoaded,
                  ...(truncated && {
                    hinweis: "Limit von 50 §§ pro Aufruf erreicht — nicht alle angeforderten §§ wurden geladen. Bitte Aufruf aufteilen.",
                  }),
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    );

    // ===================================================================
    // Tool 4: RAGSource_query (nicht im Compliance-Modus)
    // ===================================================================
    if (!this.env.DISABLE_QUERY) this.server.tool(
      "RAGSource_query",
      "FALLBACK / CROSS-SEARCH — two use cases: " +
      "(1) RAGSource_catalog returns no matching source; " +
      "(2) topic unclear or cross-source search needed (e.g. 'Which §§ mention Spielhallen?'). " +
      "Do not use if source is already known from catalog — prefer toc + get. " +
      "Full-text search, max. 20 results with source_id and section references for RAGSource_get.",
      {
        query: z
          .string()
          .describe("Search query in natural language"),
        geo: z
          .string()
          .max(100)
          .optional()
          .describe(GEO_PARAMETER_DESCRIPTION),
        extensions: z
          .array(z.string())
          .optional()
          .describe(EXTENSIONS_PARAMETER_DESCRIPTION),
        hints: z
          .array(z.string())
          .optional()
          .describe(
            "Additional search terms to improve recall: synonyms, technical terms, related concepts. " +
            "E.g. for query 'Abwassergebühren': hints ['Entwässerungsbeitrag', 'Kanalgebühr', 'KAG'].",
          ),
      },
      { title: "RAGSource query", readOnlyHint: true, destructiveHint: false },
      async ({ query, geo: geoInput, extensions: extensionsInput, hints }) => {
        const db = this.env.DB;

        // Geo auflösen; URL-?geo= als Request-Default wenn kein expliziter Parameter.
        // _currentGeo wird per fetch() pro Request gesetzt — robuster als sessionGeo-Closure,
        // die beim DO-Reuse stale sein kann.
        const effectiveGeo = geoInput ?? (this._currentGeo || null);
        const geoResult = effectiveGeo ? await resolveGeo(effectiveGeo, db) : null;
        // Bei ambiguem Geo im query-Tool: kein Geo-Filter (FTS sucht im Gesamtbestand)
        const geo = (geoResult && "ambiguous" in geoResult ? null : geoResult) as ResolvedGeo | null;
        const geoFilter = buildGeoFilter(geo);
        const endpointFilter = buildEndpointFilter(resolveMandatoryEndpoint());
        // Extension-Auflösung: gleiche Validierung wie in RAGSource_catalog
        const rawExtensions = extensionsInput?.length ? extensionsInput : this._currentExtensions;
        const extResolution = resolveExtensions(rawExtensions);
        const effectiveExtensions = extResolution.resolved;
        const extensionsFilter = buildExtensionsFilter(effectiveExtensions);
        const extWarning = buildExtensionsWarning(extResolution);

        // FTS5-Query bauen (Hauptquery + Hints zusammenführen)
        const allTerms = [query, ...(hints ?? [])].join(" ");
        const ftsQuery = buildFtsQuery(allTerms);

        if (!ftsQuery) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "Suchanfrage enthielt keine verwertbaren Suchbegriffe.",
                  query,
                }),
              },
            ],
          };
        }

        // FTS5-Suche auf Paragraphen-Ebene mit Geo- und Projekt-Filter auf sources
        // Wenn Extensions aktiv: additiv — Endpoint-Match ODER Extension-Match (OR-Verknüpfung).
        const hasExtensionsFilter = effectiveExtensions.length > 0;
        const tenancyClause = hasExtensionsFilter
          ? `(${endpointFilter.sql} OR ${extensionsFilter.sql})`
          : endpointFilter.sql;
        const tenancyParams = hasExtensionsFilter
          ? [...endpointFilter.params, ...extensionsFilter.params]
          : endpointFilter.params;

        const sql = `
          SELECT
            ss.section_ref, ss.heading, ss.body,
            s.id AS source_id, s.titel, s.ebene, s.size_class,
            bm25(sections_fts) AS rank
          FROM sections_fts
          JOIN source_sections ss ON sections_fts.rowid = ss.rowid
          JOIN sources s ON ss.source_id = s.id
          WHERE sections_fts MATCH ?
            AND ${geoFilter.sql}
            AND ${tenancyClause}
          ORDER BY rank
          LIMIT 20
        `;

        type FtsRow = { section_ref: string; heading: string | null; body: string; source_id: string; titel: string; ebene: string | null; size_class: string; rank: number };
        const toHit = (r: FtsRow): QueryHit => ({ source_id: r.source_id, titel: r.titel, ebene: r.ebene, size_class: r.size_class, section_ref: r.section_ref, heading: r.heading, body: r.body });

        const result = await db
          .prepare(sql)
          .bind(ftsQuery, ...geoFilter.params, ...tenancyParams)
          .all<FtsRow>();

        const publicHits = (result.results ?? []).map(toHit);

        // Dual-DB: GP1 FTS — Geo-Filter + Extensions-Filter falls aktiv
        let allHits = publicHits;
        if (this.env.DB_GP1) {
          const gp1Filter = hasExtensionsFilter ? extensionsFilter : null;
          const gp1Sql = `
            SELECT ss.section_ref, ss.heading, ss.body,
                   s.id AS source_id, s.titel, s.ebene, s.size_class,
                   bm25(sections_fts) AS rank
            FROM sections_fts
            JOIN source_sections ss ON sections_fts.rowid = ss.rowid
            JOIN sources s ON ss.source_id = s.id
            WHERE sections_fts MATCH ?
              AND ${geoFilter.sql}
              ${gp1Filter ? `AND ${gp1Filter.sql}` : ""}
            ORDER BY rank
            LIMIT 20
          `;
          const gp1Result = await this.env.DB_GP1.prepare(gp1Sql).bind(ftsQuery, ...geoFilter.params, ...(gp1Filter?.params ?? [])).all<FtsRow>();
          const gp1Hits = (gp1Result.results ?? []).map(toHit);
          const seen = new Set(publicHits.map((h) => `${h.source_id}::${h.section_ref}`));
          const newHits = gp1Hits.filter((h) => !seen.has(`${h.source_id}::${h.section_ref}`));
          allHits = [...publicHits, ...newHits].slice(0, 20);
        }

        const hits = allHits;

        const geoInfo = geo
          ? {
              name: geo.display.name,
              level: geo.level,
              ars: geo.gemeinde_ars ?? geo.verband_ars ?? geo.kreis_ars ?? geo.land_ars,
            }
          : { name: "alle Ebenen", level: "alle" };

        const extensionsBlock = rawExtensions.length > 0
          ? {
              extensions_input: rawExtensions,
              extensions_resolved: effectiveExtensions,
              ...(extResolution.mapped.length > 0 && { extensions_mapped: extResolution.mapped }),
              ...(extResolution.ignored.length > 0 && { extensions_ignored: extResolution.ignored }),
              ...(extWarning && { extensions_warning: extWarning }),
            }
          : null;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  query,
                  geo: geoInfo,
                  ...(extensionsBlock && extensionsBlock),
                  treffer: hits.length,
                  results: hits,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    );

    // ===================================================================
    // Tool 5: RAGSource_db_query (nur wenn DB_STRUCTURED gebunden)
    // ===================================================================
    if (this.env.DB_STRUCTURED) {
      const structDb = this.env.DB_STRUCTURED;
      const currentEndpoint = ENDPOINT_BY_HOST[this._currentHost] ?? undefined;

      // Datenbanken laden (Endpoint-Filter: NULL = universell, sonst nur passende)
      type DbMetaRow = {
        db: string;
        beschreibung: string;
        stand: string | null;
        verbindlichkeit: string | null;
        quelle_url_template: string | null;
        lookup_keys: string;
        columns: string;
        endpoints: string | null;
        tenant_note: string | null;
      };
      const allDbsResult = await structDb
        .prepare("SELECT db, beschreibung, stand, verbindlichkeit, quelle_url_template, lookup_keys, columns, endpoints, tenant_note FROM rag_databases")
        .all<DbMetaRow>();
      const allDbs = allDbsResult.results ?? [];

      // Für Description: nur DBs anzeigen, die für diesen Endpoint sichtbar sind
      const visibleDbs = allDbs.filter((d) => {
        if (!d.endpoints) return true; // universell
        try {
          const eps = JSON.parse(d.endpoints) as string[];
          return !currentEndpoint || currentEndpoint === "all" || eps.includes(currentEndpoint);
        } catch {
          return true;
        }
      });

      const dbsSection = visibleDbs.length > 0
        ? visibleDbs.map((d) => {
            let lookupKeysDisplay: string;
            try {
              const lk = JSON.parse(d.lookup_keys) as Record<string, string>;
              lookupKeysDisplay = Object.entries(lk).map(([k, v]) => `${k} (${v})`).join(", ");
            } catch {
              lookupKeysDisplay = d.lookup_keys;
            }
            let colsDisplay: string;
            try {
              const cols = JSON.parse(d.columns) as Array<{ name: string; typ: string }>;
              colsDisplay = cols.map((c) => `${c.name}:${c.typ}`).join(", ");
            } catch {
              colsDisplay = d.columns;
            }
            return (
              `\n**${d.db}** — ${d.beschreibung}` +
              `\nStand: ${d.stand ?? "unbekannt"} · Verbindlichkeit: ${d.verbindlichkeit ?? "unbekannt"}` +
              (d.tenant_note ? `\nLizenz: ${d.tenant_note}` : "") +
              `\nFilter-Spalten: ${lookupKeysDisplay}` +
              `\nAlle Spalten: ${colsDisplay}`
            );
          }).join("\n")
        : "\n(keine Datenbanken konfiguriert)";

      const dbQueryDescription =
        "Executes structured queries against tabular datasets.\n" +
        "Each database has its own filter columns and return columns.\n\n" +
        "Available databases:" + dbsSection + "\n\n" +
        "Filter syntax (suffix convention):\n" +
        "  { col: 'val' }                  exact match\n" +
        "  { col_like: 'part' }            LIKE '%part%'\n" +
        "  { col_in: ['a','b'] }           IN (OR over values)\n" +
        "  { col_ne: 'val' }               not equal\n" +
        "  { col_gt: n, col_lt: n }        strict range\n" +
        "  { col_gte: n, col_lte: n }      inclusive range\n" +
        "  { col_isnull: true }            IS NULL\n" +
        "  { col_notnull: true }           IS NOT NULL\n" +
        "  multiple keys in filter:        AND-linked\n" +
        "  { any_of: [...] }               OR between objects\n\n" +
        "Response includes: db, stand, verbindlichkeit, total, rows (+ optional quelle_url_template for source links).";

      this.server.tool(
        "RAGSource_db_query",
        dbQueryDescription,
        {
          db: z.string().describe("Database name, e.g. 'gefahrstoff', 'uebergabe_regeln'."),
          filter: z
            .record(z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number()]))]))
            .optional()
            .describe(
              "Filter object using the suffix convention (see tool description). " +
              "Special key 'any_of': array of filter objects, OR-linked. " +
              "Examples: { un_nr: '1203' } or { bezeichnung_like: 'benzin' }.",
            ),
          columns: z
            .array(z.string())
            .optional()
            .describe("Which columns to return. Default: all columns of the database."),
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe("Maximum number of rows. Default 5, max 50."),
          order_by: z
            .object({
              column: z.string(),
              direction: z.enum(["asc", "desc"]),
            })
            .optional()
            .describe("Result sorting, e.g. { column: 'bezeichnung_de', direction: 'asc' }."),
        },
        { title: "RAGSource db_query", readOnlyHint: true, destructiveHint: false },
        async ({ db: dbName, filter, columns: reqColumns, limit, order_by }) => {
          // Endpoint-Zugriff prüfen
          const dbMeta = allDbs.find((d) => d.db === dbName);
          if (!dbMeta) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ error: `Datenbank '${dbName}' nicht gefunden. Verfügbar: ${allDbs.map((d) => d.db).join(", ")}` }) }],
              isError: true,
            };
          }
          // Endpoint-Sichtbarkeitscheck
          if (dbMeta.endpoints) {
            try {
              const eps = JSON.parse(dbMeta.endpoints) as string[];
              if (currentEndpoint && currentEndpoint !== "all" && !eps.includes(currentEndpoint)) {
                return {
                  content: [{ type: "text" as const, text: JSON.stringify({ error: `Datenbank '${dbName}' ist für dieses Deployment nicht verfügbar.` }) }],
                  isError: true,
                };
              }
            } catch { /* JSON-Fehler → freigeben */ }
          }

          // Spalten-Whitelist aus Metadaten
          let allColumns: Array<{ name: string; typ: string }>;
          try {
            allColumns = JSON.parse(dbMeta.columns) as Array<{ name: string; typ: string }>;
          } catch {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ error: `Metadaten für '${dbName}' fehlerhaft (columns-JSON ungültig).` }) }],
              isError: true,
            };
          }
          const colNames = new Set(allColumns.map((c) => c.name));

          // Ausgabe-Spalten validieren
          const selectCols = reqColumns?.length
            ? reqColumns.filter((c) => colNames.has(c))
            : allColumns.map((c) => c.name);
          if (selectCols.length === 0) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ error: "Keine gültigen Spalten angefordert." }) }],
              isError: true,
            };
          }

          // Filter parsen
          const filterResult = buildDbQueryFilter(filter ?? {}, colNames);
          if ("error" in filterResult) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ error: filterResult.error }) }],
              isError: true,
            };
          }
          const { sql: whereSql, params: whereParams } = filterResult;

          // ORDER BY validieren
          let orderSql = "";
          if (order_by) {
            if (!colNames.has(order_by.column)) {
              return {
                content: [{ type: "text" as const, text: JSON.stringify({ error: `Ungültige order_by-Spalte '${order_by.column}'.` }) }],
                isError: true,
              };
            }
            const dir = order_by.direction === "desc" ? "DESC" : "ASC";
            orderSql = ` ORDER BY \`${order_by.column}\` ${dir}`;
          }

          const effectiveLimit = Math.min(limit ?? 5, 50);
          const colList = selectCols.map((c) => `\`${c}\``).join(", ");
          const tableName = `db_${dbName}`;
          const fullSql = `SELECT ${colList} FROM ${tableName}${whereSql ? ` WHERE ${whereSql}` : ""}${orderSql} LIMIT ${effectiveLimit + 1}`;

          let rows: Record<string, unknown>[];
          try {
            const result = await structDb.prepare(fullSql).bind(...whereParams).all<Record<string, unknown>>();
            rows = result.results ?? [];
          } catch (e) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ error: `Datenbankfehler: ${e instanceof Error ? e.message : String(e)}` }) }],
              isError: true,
            };
          }

          const truncated = rows.length > effectiveLimit;
          if (truncated) rows = rows.slice(0, effectiveLimit);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  db: dbName,
                  stand: dbMeta.stand,
                  verbindlichkeit: dbMeta.verbindlichkeit,
                  ...(dbMeta.quelle_url_template && { quelle_url_template: dbMeta.quelle_url_template }),
                  total: rows.length,
                  ...(truncated && { hinweis: `Auf ${effectiveLimit} Zeilen begrenzt. Filter verfeinern für vollständige Ergebnisse.` }),
                  rows,
                }),
              },
            ],
          };
        },
      );
    }
  }
}

// -----------------------------------------------------------------------
// Hilfsfunktionen
// -----------------------------------------------------------------------

/**
 * Normalisiert eine Paragraphen-Referenz für den Abgleich.
 * Stellt sicher, dass nach § / Art. / Artikel / EG ein Leerzeichen steht.
 * Ersetzt zunächst non-breaking spaces (U+00A0) durch reguläre Spaces.
 * Beispiel: "§2" → "§ 2", "Art.6" → "Art. 6"
 */
function normalizeSectionRef(ref: string): string {
  return ref
    .trim()
    .replace(/\u00A0/g, " ")
    .replace(/§\s*(\d+)/g, "§ $1")
    .replace(/Art\.\s*(\d+)/g, "Art. $1")
    .replace(/Artikel\s+(\d+)/g, "Artikel $1")
    .replace(/Erwägungsgrund\s+(\d+)/g, "Erwägungsgrund $1")
    .replace(/EG\s+(\d+)/g, "EG $1");
}

/**
 * Extrahiert die Kurzreferenz (§ N, Art. N, EG N, Kapitel N) aus einem vollen TOC-Eintrag.
 * Beispiel: "§ 19 EStG [red. Nichtselbständige Arbeit – ...]" → "§ 19"
 *           "Art. 6 Rechtmäßigkeit" → "Art. 6"
 * Gibt null zurück wenn keine Referenz erkannt wird.
 */
function extractSectionRef(ref: string): string | null {
  const m = ref.match(
    /^(§\s*\d+[a-z]?|Art\.\s*\d+[a-z]?|Artikel\s+\d+[a-z]?|Erwägungsgrund\s+\d+|EG\s+\d+|Kapitel\s+\d+[a-z]?|Anhang\s+\d+[a-z]?|\d+(?:\.\d+)*[a-z]?)\b/i,
  );
  return m ? normalizeSectionRef(m[1]) : null;
}

// -----------------------------------------------------------------------
// RAGSource_db_query Hilfsfunktionen
// -----------------------------------------------------------------------

type ScalarOrArray = string | number | boolean | null | (string | number)[];

// Operator-Mapping: Suffix → SQL-Fragment-Funktion
const DB_QUERY_SUFFIXES: Array<{ suffix: string; buildClause: (col: string, val: ScalarOrArray) => { clause: string; params: (string | number | null)[] } | { error: string } }> = [
  {
    suffix: "_like",
    buildClause: (col, val) => {
      if (typeof val !== "string" && typeof val !== "number") return { error: `'${col}_like' erwartet einen String-Wert.` };
      return { clause: `${col} LIKE ?`, params: [`%${String(val)}%`] };
    },
  },
  {
    suffix: "_gte",
    buildClause: (col, val) => {
      if (typeof val !== "string" && typeof val !== "number") return { error: `'${col}_gte' erwartet einen Skalar-Wert.` };
      return { clause: `${col} >= ?`, params: [val] };
    },
  },
  {
    suffix: "_lte",
    buildClause: (col, val) => {
      if (typeof val !== "string" && typeof val !== "number") return { error: `'${col}_lte' erwartet einen Skalar-Wert.` };
      return { clause: `${col} <= ?`, params: [val] };
    },
  },
  {
    suffix: "_gt",
    buildClause: (col, val) => {
      if (typeof val !== "string" && typeof val !== "number") return { error: `'${col}_gt' erwartet einen Skalar-Wert.` };
      return { clause: `${col} > ?`, params: [val] };
    },
  },
  {
    suffix: "_lt",
    buildClause: (col, val) => {
      if (typeof val !== "string" && typeof val !== "number") return { error: `'${col}_lt' erwartet einen Skalar-Wert.` };
      return { clause: `${col} < ?`, params: [val] };
    },
  },
  {
    suffix: "_ne",
    buildClause: (col, val) => {
      if (typeof val !== "string" && typeof val !== "number" && val !== null) return { error: `'${col}_ne' erwartet einen Skalar-Wert.` };
      if (val === null) return { clause: `${col} IS NOT NULL`, params: [] };
      return { clause: `${col} != ?`, params: [val] };
    },
  },
  {
    suffix: "_in",
    buildClause: (col, val) => {
      if (!Array.isArray(val) || val.length === 0) return { error: `'${col}_in' erwartet ein nicht-leeres Array.` };
      const ph = val.map(() => "?").join(", ");
      return { clause: `${col} IN (${ph})`, params: val };
    },
  },
  {
    suffix: "_isnull",
    buildClause: (col, val) => {
      if (val !== true && val !== false) return { error: `'${col}_isnull' erwartet true oder false.` };
      return { clause: val ? `${col} IS NULL` : `${col} IS NOT NULL`, params: [] };
    },
  },
  {
    suffix: "_notnull",
    buildClause: (col, val) => {
      if (val !== true && val !== false) return { error: `'${col}_notnull' erwartet true oder false.` };
      return { clause: val ? `${col} IS NOT NULL` : `${col} IS NULL`, params: [] };
    },
  },
];

/**
 * Parst ein Filter-Objekt (mit Suffix-Konvention) zu SQL WHERE-Fragment + Params.
 * Spaltennamen werden gegen die Whitelist validiert — keine SQL-Injection möglich.
 * `any_of`-Schlüssel erzeugt OR-Verknüpfung zwischen mehreren Filter-Objekten.
 */
function buildDbQueryFilter(
  filter: Record<string, ScalarOrArray>,
  colNames: Set<string>,
): { sql: string; params: (string | number | null)[]; error?: never } | { sql?: never; params?: never; error: string } {
  const andClauses: string[] = [];
  const allParams: (string | number | null)[] = [];

  // any_of: Array von Filter-Objekten, OR-verknüpft
  if ("any_of" in filter) {
    const anyOf = filter["any_of"];
    if (!Array.isArray(anyOf)) return { error: "'any_of' muss ein Array von Filter-Objekten sein." };
    const orClauses: string[] = [];
    for (const subFilter of anyOf) {
      if (typeof subFilter !== "object" || subFilter === null || Array.isArray(subFilter)) {
        return { error: "'any_of'-Einträge müssen Objekte sein." };
      }
      const sub = buildDbQueryFilter(subFilter as Record<string, ScalarOrArray>, colNames);
      if ("error" in sub) return sub;
      if (sub.sql) {
        orClauses.push(`(${sub.sql})`);
        allParams.push(...sub.params);
      }
    }
    if (orClauses.length > 0) {
      andClauses.push(`(${orClauses.join(" OR ")})`);
    }
    // Rest des Filters (ohne any_of) weiterverarbeiten
    const { any_of: _removed, ...rest } = filter;
    if (Object.keys(rest).length > 0) {
      const restResult = buildDbQueryFilter(rest, colNames);
      if ("error" in restResult) return restResult;
      if (restResult.sql) {
        andClauses.push(restResult.sql);
        allParams.push(...restResult.params);
      }
    }
    return { sql: andClauses.join(" AND "), params: allParams };
  }

  for (const [key, val] of Object.entries(filter)) {
    // Suffix ermitteln
    let column = key;
    let clauseResult: { clause: string; params: (string | number | null)[] } | { error: string } | null = null;

    for (const { suffix, buildClause } of DB_QUERY_SUFFIXES) {
      if (key.endsWith(suffix)) {
        column = key.slice(0, -suffix.length);
        clauseResult = buildClause(column, val);
        break;
      }
    }

    // Spaltennamen gegen Whitelist prüfen
    if (!colNames.has(column)) {
      return { error: `Unbekannte Spalte '${column}'. Gültige Spalten: ${[...colNames].join(", ")}.` };
    }

    if (clauseResult === null) {
      // Kein Suffix → exakt-Match
      if (val === null) {
        andClauses.push(`${column} IS NULL`);
      } else if (typeof val === "string" || typeof val === "number") {
        andClauses.push(`${column} = ?`);
        allParams.push(val);
      } else {
        return { error: `Ungültiger Wert für Spalte '${column}'. Exakt-Match erwartet Skalar oder null.` };
      }
    } else if ("error" in clauseResult) {
      return { error: clauseResult.error };
    } else {
      andClauses.push(clauseResult.clause);
      allParams.push(...clauseResult.params);
    }
  }

  return { sql: andClauses.join(" AND "), params: allParams };
}
