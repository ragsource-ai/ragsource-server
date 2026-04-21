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
import { resolveGeo, type ResolvedGeo, type AmbiguousGeo } from "./engine/normalize.js";

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

/** Generische Kurzbeschreibung — gilt für alle RAGSource-Projekte */
const INSTRUCTIONS_DEFAULT =
  "RAGSource — Agentic RAG Framework.\n" +
  "\n" +
  "Workflow: RAGSource_catalog → RAGSource_toc (M/L) → RAGSource_get.\n" +
  "RAGSource_query als Alternative wenn: (a) Catalog liefert keine passende Quelle, " +
  "(b) Thema unklar und Quersuche über viele Quellen sinnvoll. " +
  "Nicht verwenden, wenn Quelle bereits aus Catalog bekannt — dann toc+get bevorzugen.\n" +
  "\n" +
  "Tools verfügbar machen: Falls Tools als 'deferred' gelistet sind, " +
  "zuerst ToolSearch mit 'select:RAGSource_catalog,RAGSource_toc,RAGSource_get,RAGSource_query' aufrufen — " +
  "dann erst RAGSource_catalog aufrufen.\n" +
  "\n" +
  "Skills (typ: skill): Im Catalog-Response als eigener 'skills'-Block vor den Rechtsquellen gelistet. " +
  "Skills laden und deren Anweisungen für Tool-Nutzung, Entscheidungsbäume und domänenspezifische Workflows befolgen.\n" +
  "\n" +
  "Normenhierarchie: Höherrangiges Recht bricht niederrangiges (z.B. Bundesgesetz > Landesgesetz). " +
  "Bei Konflikten: höherrangige Norm zitieren, Widerspruch benennen.";

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
    `• Landesrecht: geo = 2-stelliger ARS des Bundeslandes:\n${bundeslandListe}\n` +
    `• Kommunale Fragen: geo = ARS der Gemeinde (12-stellig), des Gemeindeverbands (9) oder des Landkreises (5)\n\n` +
    `Wenn aus dem Kontext eindeutig hervorgeht, welches Bundesland oder welche Gemeinde gemeint ist ` +
    `(z.B. durch explizite Nennung im Gespräch), verwende den entsprechenden ARS-Code selbstständig. ` +
    `Ist der Kontext unklar, frage per Multiple-Choice nach.\n\n` +
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

/**
 * Fehlermeldung wenn ein geo-Wert übergeben wurde, der nicht aufgelöst werden konnte.
 */
function buildGeoNotFoundResponse(
  input: string,
  systemMessage: string | null,
): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        ...(systemMessage && { system_message: systemMessage }),
        error: "geo_not_found",
        geo: { name: `"${input}" (nicht gefunden)`, level: "unbekannt" },
        hinweis:
          `Der geo-Wert "${input}" konnte nicht aufgelöst werden — diese ARS existiert nicht.\n\n` +
          buildGeoAnweisungen(),
      }),
    }],
  };
}

/**
 * Baut eine frühe MCP-Antwort für mehrdeutige Geo-Angaben.
 * Gibt eine Kandidatenliste + Support-Hinweis zurück, ohne Quellen zu liefern.
 */
function buildAmbiguousResponse(
  ambiguous: AmbiguousGeo,
  systemMessage: string | null,
): { content: Array<{ type: "text"; text: string }> } {
  const list = ambiguous.candidates
    .map((c) => {
      const kreisLabel = c.kreis || `Lkr-ARS ${c.kreis_ars}`;
      return `• ${c.name} — ${kreisLabel}, ${c.land} — ARS: ${c.ars}`;
    })
    .join("\n");

  const payload = {
    ...(systemMessage && { system_message: systemMessage }),
    error: "geo_ambiguous",
    geo: { name: `"${ambiguous.input}" (mehrdeutig)`, level: "unbekannt" },
    hinweis:
      `Der Ortsname "${ambiguous.input}" ist nicht eindeutig — es gibt mehrere Gemeinden mit diesem Namen. ` +
      `Bitte den Nutzer fragen, welche Gemeinde gemeint ist, und den geo-Parameter mit dem entsprechenden ARS-Code erneut aufrufen.\n\n` +
      `Gefundene Treffer:\n${list}\n\n` +
      `Bei Fragen oder falls die gesuchte Gemeinde nicht aufgeführt ist: support@amtsschimmel.ai`,
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
    { instructions: INSTRUCTIONS_DEFAULT },
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
    // Endpoint (Tenancy) aus Host ableiten
    const endpoint = ENDPOINT_BY_HOST[this._currentHost];

    // Instructions: KV-Eintrag hat Vorrang vor hardcoded INSTRUCTIONS_DEFAULT.
    // KV-Key: "instructions:{endpoint}" oder "instructions:default".
    const kvKey = endpoint ? `instructions:${endpoint}` : "instructions:default";
    const instructions = (await this.env.CONFIG?.get(kvKey)) ?? INSTRUCTIONS_DEFAULT;

    this.server = new McpServer(
      { name: "RAGSource", version: "2.0.0" },
      { instructions },
    );

    // ===================================================================
    // Tool 1: RAGSource_catalog
    // ===================================================================
    this.server.tool(
      "RAGSource_catalog",
      "SCHRITT 1 — Pflichtaufruf zu Beginn jeder Anfrage. " +
      "Liefert alle verfügbaren Rechtsquellen für eine Gemeinde/Region (EU- bis Ortsrecht) " +
      "sowie domänenspezifische Skills (Handlungsanleitungen für das LLM). " +
      "Kompaktformat: 'schema' definiert die Felder. " +
      "'skills' (optional) enthält Skills (typ: skill) — diese zuerst laden und befolgen. " +
      "'sources' enthält die Rechtsquellen. " +
      "Feld 'size' (S/M/L) steuert den Folgeschritt: " +
      "S → RAGSource_get direkt; M/L → RAGSource_toc, dann gezielte §§ per RAGSource_get. " +
      "Gibt optional 'system_message' zurück — dieses immer zuerst ausgeben.",
      {
        geo: z
          .string()
          .max(100)
          .optional()
          .describe(
            "ARS-Code (2/5/9/12 Stellen) oder Gemeindename. " +
            "Bestimmt welche Rechtsebenen zurückgegeben werden (Nur-aufwärts-Prinzip). " +
            "12-stellig=Gemeinde, 9-stellig=Verband, 5-stellig=Kreis, 2-stellig=Land. " +
            "Beispiele: '081175009012' (Bad Boll), '08117' (LKR Göppingen), '08' (BW).",
          ),
        extensions: z
          .array(z.string())
          .optional()
          .describe(
            "Optionale Extension-Filter (ODER-verknüpft) — schränkt den Katalog thematisch ein. " +
            "Leer = alle Quellen des Endpoints. " +
            "Beispiele: 'Feuerwehr', 'Arbeitsrecht', 'Wahlrecht', 'Datenschutz'.",
          ),
      },
      { title: "RAGSource catalog", readOnlyHint: true, destructiveHint: false },
      async ({ geo: geoInput, extensions: extensionsInput }) => {
        const db = this.env.DB;

        // KV: Broadcast-Nachricht + Nicht-konfiguriert-Meldung
        // Endpoint-spezifischer Key hat jeweils Vorrang vor globalem Fallback.
        // Alle Keys parallel laden.
        const currentEndpoint = resolveMandatoryEndpoint();
        const smKey = currentEndpoint ? `system_message:${currentEndpoint}` : null;
        const ncKey = currentEndpoint ? `not_configured_message:${currentEndpoint}` : null;
        const [smEndpoint, smGlobal, ncEndpoint, ncGlobal] = await Promise.all([
          smKey ? this.env.CONFIG?.get(smKey) ?? null : Promise.resolve(null),
          this.env.CONFIG?.get("system_message") ?? null,
          ncKey ? this.env.CONFIG?.get(ncKey) ?? null : Promise.resolve(null),
          this.env.CONFIG?.get("not_configured_message") ?? null,
        ]);
        const systemMessage = smEndpoint ?? smGlobal;
        const notConfiguredMessage = ncEndpoint ?? ncGlobal;

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
            return buildGeoNotFoundResponse(effectiveGeo, systemMessage);
          }
        }

        const geoFilter = geoSpecialFilter ?? buildGeoFilter(geo);
        const endpointFilter = buildEndpointFilter(resolveMandatoryEndpoint());
        const effectiveExtensions = extensionsInput?.length ? extensionsInput : this._currentExtensions;
        const extensionsFilter = buildExtensionsFilter(effectiveExtensions);

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
          ? (notConfiguredMessage ??
              `Hinweis an den Assistenten: Die Gemeinde "${geo!.display.name}" ist noch nicht als eigenständige Rechtsquelle hinterlegt. ` +
              `Es werden nur übergeordnete Regelungen angezeigt (z.B. Landes-, Kreis- oder Verbandsrecht — bitte konkret aus dem Catalog benennen). ` +
              `Weise den Nutzer darauf hin, dass gemeindespezifische Satzungen noch nicht aufgenommen wurden, ` +
              `und verweise ihn auf die in der System Message verlinkte Projektseite für eine vollständig konfigurierte Instanz.`)
          : undefined;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ...(systemMessage && { system_message: systemMessage }),
                geo: geoInfo,
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
      "SCHRITT 2 — Für 'medium'/'large'-Quellen aufrufen, bevor RAGSource_get verwendet wird. " +
      "Liefert das Inhaltsverzeichnis mit allen §§/Artikeln und Kurztiteln, " +
      "z.B. '§ 6 Aufgaben (Pflichtaufgaben, Mindeststärke)'. " +
      "Bis zu 8 Quellen gleichzeitig (Batch). " +
      "section_ref-Werte aus dem TOC exakt an RAGSource_get übergeben. " +
      "Wenn keine TOC-Datei hinterlegt: small/medium-Quellen liefern alle §§ direkt im Feld 'sections' — RAGSource_get ist dann für diese Quellen nicht mehr nötig.",
      {
        sources: z
          .array(z.string())
          .min(1)
          .max(8)
          .describe(
            "Liste von Source-IDs aus RAGSource_catalog, z.B. ['FwG_BW', 'BBO_Satzung_Feuerwehr']. " +
            "Max. 8 pro Aufruf.",
          ),
        level: z
          .string()
          .optional()
          .describe(
            "TOC-Ebene für mehrteilige Werke, z.B. 'buch-2' für BGB Buch 2. " +
            "Ohne Angabe: 'gesamt'.",
          ),
      },
      { title: "RAGSource toc", readOnlyHint: true, destructiveHint: false },
      async ({ sources: sourceIds, level }) => {
        const db = this.env.DB;
        const targetLevel = level ?? "gesamt";
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
      "SCHRITT 3 — Lädt den Originalwortlaut von Paragraphen aus einer oder mehreren Rechtsquellen. " +
      "section_ref exakt wie im TOC, z.B. '§ 2', 'Artikel 6', 'Prod. Nr. 41.40.08'. " +
      "Max. 8 Quellen pro Aufruf; max. 25 §§ je Quelle; max. 50 §§ gesamt. " +
      "small-Quellen: sections weglassen → liefert das komplette Dokument. " +
      "Liefert 'quelle_url' für Markdown-Links in der Antwort.",
      {
        sources: z
          .array(
            z.object({
              source: z
                .string()
                .describe("Source-ID aus RAGSource_catalog, z.B. 'FwG_BW'"),
              sections: z
                .array(z.string())
                .max(25)
                .optional()
                .describe(
                  "Paragraphen-Referenzen, z.B. ['§ 2', '§ 8', 'Artikel 24']. " +
                  "Leer lassen für gesamtes Dokument (nur für small-Quellen empfohlen).",
                ),
            }),
          )
          .min(1)
          .max(8)
          .describe(
            "Liste von Quellen mit optionalen Paragraphen-Referenzen. " +
            "Max. 8 Quellen, max. 25 §§ je Quelle, max. 50 §§ gesamt pro Aufruf.",
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
      "FALLBACK / QUERSUCHE — sinnvoll in zwei Situationen: " +
      "(1) RAGSource_catalog liefert keine eindeutig passende Quelle; " +
      "(2) Thema unklar oder Begriff soll quer über viele Quellen gleichzeitig gesucht werden " +
      "(z.B. 'Welche Paragraphen in allen Quellen erwähnen Spielhallen?'). " +
      "Nicht verwenden, wenn Quelle bereits aus dem Catalog bekannt — dann toc + get bevorzugen. " +
      "FTS5-Volltextsuche über alle indizierten Paragraphen (max. 20 Treffer). " +
      "Treffer enthalten source_id und section_ref für gezieltes Nachladen per RAGSource_get.",
      {
        query: z
          .string()
          .describe("Suchanfrage in natürlicher Sprache"),
        geo: z
          .string()
          .max(100)
          .optional()
          .describe(
            "Geo-Filter: ARS-Code (2/5/9/12 Stellen) oder Klarname. " +
            "Beispiele: '08', '08117', '081175009012', 'Bad Boll'",
          ),
        extensions: z
          .array(z.string())
          .optional()
          .describe("Optionale Extension-Filter (ODER-verknüpft). Leer = alle Quellen des Endpoints."),
        hints: z
          .array(z.string())
          .optional()
          .describe(
            "Optionale Zusatz-Suchbegriffe: Synonyme, Fachbegriffe, verwandte Begriffe",
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
        const effectiveExtensions = extensionsInput?.length ? extensionsInput : this._currentExtensions;
        const extensionsFilter = buildExtensionsFilter(effectiveExtensions);

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

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  query,
                  geo: geoInfo,
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
        "Führt strukturierte Abfragen gegen tabellarische Datenbestände aus.\n" +
        "Jede Datenbank hat eigene Filter-Spalten und Rückgabe-Spalten.\n\n" +
        "Verfügbare Datenbanken:" + dbsSection + "\n\n" +
        "Filter-Syntax (Suffix-Konvention):\n" +
        "  { spalte: 'wert' }               exakt-match\n" +
        "  { spalte_like: 'teil' }          LIKE '%teil%'\n" +
        "  { spalte_gte: n, spalte_lte: n } Range\n" +
        "  { spalte_in: ['a','b'] }         IN (OR auf Werten)\n" +
        "  { spalte_isnull: true }          IS NULL\n" +
        "  Mehrere Keys im filter:          AND-verknüpft\n" +
        "  { any_of: [...] }                OR zwischen Objekten\n\n" +
        "Ergebnis enthält: db, stand, verbindlichkeit, total, rows (+ ggf. quelle_url_template für Quellenlink).";

      this.server.tool(
        "RAGSource_db_query",
        dbQueryDescription,
        {
          db: z.string().describe("Name der Datenbank, z.B. 'gefahrstoff', 'uebergabe_regeln'."),
          filter: z
            .record(z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number()]))]))
            .optional()
            .describe(
              "Filter-Objekt mit Suffix-Konvention. " +
              "Spezialschlüssel 'any_of': Array von Filter-Objekten, OR-verknüpft. " +
              "Beispiel: { un_nr: '1203' } oder { bezeichnung_like: 'benzin' }.",
            ),
          columns: z
            .array(z.string())
            .optional()
            .describe("Welche Spalten zurückgegeben werden sollen. Default: alle Spalten der DB."),
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe("Maximale Anzahl Zeilen. Default 5, max 50."),
          order_by: z
            .object({
              column: z.string(),
              direction: z.enum(["asc", "desc"]),
            })
            .optional()
            .describe("Sortierung, z.B. { column: 'bezeichnung_de', direction: 'asc' }."),
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
            orderSql = ` ORDER BY ${order_by.column} ${dir}`;
          }

          const effectiveLimit = Math.min(limit ?? 5, 50);
          const colList = selectCols.join(", ");
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
