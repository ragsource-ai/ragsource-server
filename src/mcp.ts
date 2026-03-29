/**
 * RAGSource MCP v2 — Agentic RAG
 *
 * Vier Tools für hierarchische Rechtsquellensuche:
 *   RAGSource_catalog → Verzeichnis aller verfügbaren Quellen für eine Gemeinde
 *   RAGSource_toc     → Inhaltsverzeichnis(se) einer oder mehrerer Quellen
 *   RAGSource_get     → Originalwortlaut spezifischer Paragraphen
 *   RAGSource_query   → FTS5-Volltextsuche (Convenience-Wrapper / Fallback)
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

interface SqlFragment {
  sql: string;
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
    return { sql: "1=1", params: [] };
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
    sql: conditions.join(" AND "),
    params,
  };
}

/**
 * Baut einen Projekt-Filter für die sources-Tabelle (Alias: s).
 *
 * Quellen ohne Projekt-Einträge sind für alle Projekte sichtbar.
 * Quellen mit Einträgen nur, wenn das Projekt übereinstimmt.
 */
function buildProjektFilter(projekt: string | undefined): SqlFragment {
  if (!projekt) {
    return { sql: "1=1", params: [] };
  }
  return {
    sql: `(
      NOT EXISTS (SELECT 1 FROM source_projekte sp WHERE sp.source_id = s.id)
      OR EXISTS (SELECT 1 FROM source_projekte sp WHERE sp.source_id = s.id AND sp.projekt = ?)
    )`,
    params: [projekt],
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

function sortByEbene<T extends Pick<Source, "ebene" | "titel">>(sources: T[]): T[] {
  return [...sources].sort((a, b) => {
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
    .replace(/[^\w\sÄäÖöÜüß-]/g, " ")
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
  "Workflow: RAGSource_catalog → RAGSource_toc (medium/large) → RAGSource_get. " +
  "RAGSource_query nur als Fallback, wenn Quelle unklar oder Catalog kein Ergebnis liefert.\n" +
  "\n" +
  "Normenhierarchie: Höherrangiges Recht bricht niederrangiges (z.B. Bundesgesetz > Landesgesetz). " +
  "Bei Konflikten: höherrangige Norm zitieren, Widerspruch benennen.";

/**
 * Kurzbeschreibung für amtsschimmel.ai — ergänzt den Default um den Geo-Kontext.
 * @param geo ARS-Code aus ?geo= URL-Parameter (z.B. "081175009012") oder null
 */
function buildInstructionsAmtsschimmel(geo: string | null): string {
  return INSTRUCTIONS_DEFAULT + (geo ? `\nGeo-Kontext: geo="${geo}" — diesen Wert an alle Tools übergeben.` : "");
}

/** Mappt Projekt-Slugs auf ihre Instructions-Builder-Funktionen */
type InstructionsBuilder = (geo: string | null) => string;

const INSTRUCTIONS_BUILDERS: Record<string, InstructionsBuilder> = {
  "amtsschimmel": buildInstructionsAmtsschimmel,
};

// -----------------------------------------------------------------------
// Projekt-Erkennung via Host-Header
// -----------------------------------------------------------------------

/** Mappt Hostnamen auf Projekt-Slugs (für Mandanten-Filter) */
const PROJEKT_BY_HOST: Record<string, string> = {
  "mcp.amtsschimmel.ai": "amtsschimmel",
};

/**
 * Gibt den effektiven Projekt-Slug zurück.
 * Priorität: expliziter Parameter > Host-Header > undefined
 */
function resolveProjekt(explicitProjekt: string | undefined): string | undefined {
  if (explicitProjekt) return explicitProjekt;
  try {
    const { request } = getCurrentAgent();
    const hostname = new URL(request?.url ?? "").hostname;
    return PROJEKT_BY_HOST[hostname] ?? undefined;
  } catch {
    return undefined;
  }
}

// -----------------------------------------------------------------------
// Geo-Hilfsfunktionen
// -----------------------------------------------------------------------

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
    } catch {
      this._currentHost = "";
      this._currentGeo = "";
    }
    return super.fetch(request);
  }

  async init() {
    // Projekt aus Host ableiten
    const projekt = PROJEKT_BY_HOST[this._currentHost];

    // Kurze Instructions bauen: projekt-spezifischer Builder oder generischer Default.
    // geo wird als ARS-Code (Raw aus ?geo= URL-Param) direkt übergeben — kein resolveGeo nötig.
    // sessionGeo nur für Instructions-Text (init-Zeit); Tool-Handler lesen _currentGeo direkt.
    const sessionGeo = this._currentGeo || null;
    const builder = projekt ? INSTRUCTIONS_BUILDERS[projekt] : undefined;
    const instructions = builder ? builder(sessionGeo) : INSTRUCTIONS_DEFAULT;

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
      "Liefert alle verfügbaren Rechtsquellen für eine Gemeinde/Region (EU- bis Ortsrecht). " +
      "Kompaktformat: 'schema' definiert die Felder, 'sources' ist ein Array von Arrays. " +
      "Feld 'size' (S/M/L) steuert den Folgeschritt: " +
      "S → RAGSource_get direkt; M/L → RAGSource_toc, dann gezielte §§ per RAGSource_get. " +
      "Gibt optional 'system_message' zurück — dieses immer zuerst ausgeben.",
      {
        geo: z
          .string()
          .optional()
          .describe(
            "ARS-Code (2/5/9/12 Stellen) oder Gemeindename. " +
            "Bestimmt welche Rechtsebenen zurückgegeben werden (Nur-aufwärts-Prinzip). " +
            "12-stellig=Gemeinde, 9-stellig=Verband, 5-stellig=Kreis, 2-stellig=Land. " +
            "Beispiele: '081175009012' (Bad Boll), '08117' (LKR Göppingen), '08' (BW).",
          ),
        projekt: z
          .string()
          .optional()
          .describe(
            "Mandanten-Filter. Wird automatisch aus dem Host-Header erkannt — " +
            "nur setzen wenn explizit ein anderes Projekt benötigt wird.",
          ),
      },
      { title: "RAGSource catalog", readOnlyHint: true, destructiveHint: false },
      async ({ geo: geoInput, projekt: projektInput }) => {
        const db = this.env.DB;

        // KV: Broadcast-Nachricht (Wartung, Updates) + Nicht-konfiguriert-Meldung
        const [systemMessage, notConfiguredMessage] = await Promise.all([
          this.env.CONFIG.get("system_message"),
          this.env.CONFIG.get("not_configured_message"),
        ]);

        // Geo auflösen; URL-?geo= als Request-Default wenn kein expliziter Parameter.
        // _currentGeo wird per fetch() pro Request gesetzt — robuster als sessionGeo-Closure,
        // die beim DO-Reuse stale sein kann.
        const effectiveGeo = geoInput ?? (this._currentGeo || null);
        const geoResult = effectiveGeo ? await resolveGeo(effectiveGeo, db) : null;

        // Mehrdeutiger Geo → früher Abbruch mit Kandidatenliste
        if (geoResult && "ambiguous" in geoResult) {
          return buildAmbiguousResponse(geoResult, systemMessage);
        }

        const geo = geoResult as ResolvedGeo | null;
        // Geo wurde angegeben aber konnte nicht aufgelöst werden (kein Alias, kein Gemeindename)
        const geoUnresolved = effectiveGeo !== null && geo === null;
        // Fallback: nur EU + Bund (alle ARS-Spalten IS NULL) — kein Land bekannt, daher kein Land-Filter
        const GEO_BUND_ONLY: SqlFragment = {
          sql: "s.land_ars IS NULL AND s.kreis_ars IS NULL AND s.verband_ars IS NULL AND s.gemeinde_ars IS NULL",
          params: [],
        };
        const geoFilter = geoUnresolved ? GEO_BUND_ONLY : buildGeoFilter(geo);
        const projektFilter = buildProjektFilter(resolveProjekt(projektInput));

        // Quellen abfragen — alle Felder, die das LLM braucht
        const sql = `
          SELECT s.id, s.titel, s.ebene, s.rechtsrang, s.size_class, s.beschreibung,
                 EXISTS(SELECT 1 FROM source_tocs t WHERE t.source_id = s.id) AS toc_available
          FROM sources s
          WHERE ${geoFilter.sql}
            AND ${projektFilter.sql}
          ORDER BY s.ebene, s.titel
        `;

        type CatalogRow = {
          id: string;
          titel: string;
          ebene: string | null;
          rechtsrang: number | null;
          size_class: string;
          beschreibung: string | null;
          toc_available: 0 | 1;
        };
        const result = await db
          .prepare(sql)
          .bind(...geoFilter.params, ...projektFilter.params)
          .all<CatalogRow>();

        const sources = result.results ?? [];
        const sorted = sortByEbene(sources);

        // Catalog-Einträge als kompakte Arrays: [id, titel, rang, size, toc, hint]
        const sizeMap: Record<string, string> = { small: "S", medium: "M", large: "L" };
        const catalog: CatalogEntry[] = sorted.map((s) => [
          s.id,
          s.titel,
          s.rechtsrang,
          sizeMap[s.size_class] ?? "M",
          s.toc_available === 1,
          s.beschreibung || null,
        ]);

        const geoInfo = geo
          ? {
              name: geo.display.name,
              level: geo.level,
              ars: geo.gemeinde_ars ?? geo.verband_ars ?? geo.kreis_ars ?? geo.land_ars,
            }
          : geoUnresolved
            ? { name: `"${effectiveGeo}" (nicht gefunden)`, level: "unbekannt" }
            : { name: "alle Ebenen", level: "alle" };

        // Nicht-konfiguriert-Fall:
        // a) Geo nicht auflösbar (kein Alias, kein Gemeindename) → nur EU/Bund/Land angezeigt
        // b) Gemeinde-Ebene aufgelöst, aber keine Gemeinde-Quellen vorhanden
        const notConfigured =
          geoUnresolved ||
          (geo?.level === "gemeinde" && !catalog.some((s) => s[2] === 5)); // rang 5 = Gemeinde
        const notConfiguredHinweis = notConfigured
          ? (notConfiguredMessage ??
              `Hinweis an den Assistenten: Die Gemeinde "${effectiveGeo ?? geoInfo.name}" ist noch nicht als eigenständige Rechtsquelle hinterlegt. ` +
              `Es werden nur übergeordnete Regelungen angezeigt (z.B. Landes-, Kreis- oder Verbandsrecht — bitte konkret aus dem Catalog benennen). ` +
              `Weise den Nutzer darauf hin, dass gemeindespezifische Satzungen fehlen und die Gemeinde noch nicht aufgenommen wurde.`)
          : undefined;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ...(systemMessage && { system_message: systemMessage }),
                geo: geoInfo,
                total: catalog.length,
                ...(notConfigured && { not_configured: true, hinweis: notConfiguredHinweis }),
                schema: ["id", "titel", "rang", "size", "toc", "hint"],
                rang_legende: { 0: "EU", 1: "Bund", 2: "Land", 3: "Kreis", 4: "Verband", 5: "Gemeinde", 6: "Tarifrecht" },
                size_legende: { S: "get direkt", M: "toc empfohlen", L: "toc erforderlich" },
                sources: catalog,
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
      "Kein TOC vorhanden: liefert bei small/medium alle §§ direkt im Feld 'sections'.",
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
        geo: z
          .string()
          .optional()
          .describe(
            "Geo-Kontext (ARS-Code oder Klarname) — wird als Metadaten weitergegeben, " +
            "beeinflusst nicht die Abfrage (Source-IDs sind bereits geo-gefiltert).",
          ),
      },
      { title: "RAGSource toc", readOnlyHint: true, destructiveHint: false },
      async ({ sources: sourceIds, level }) => {
        const db = this.env.DB;
        const targetLevel = level ?? "gesamt";
        const ph = sourceIds.map(() => "?").join(", ");

        // 1. Alle Quellen in einem Query laden
        const sourcesResult = await db
          .prepare(
            `SELECT id, titel, kurzbezeichnung, size_class, section_count FROM sources WHERE id IN (${ph})`,
          )
          .bind(...sourceIds)
          .all<Pick<Source, "id" | "titel" | "kurzbezeichnung" | "size_class" | "section_count">>();
        const sourceMap = new Map(
          (sourcesResult.results ?? []).map((s) => [s.id, s]),
        );

        // 2. Alle TOCs in einem Query laden
        const tocsResult = await db
          .prepare(
            `SELECT source_id, content FROM source_tocs WHERE source_id IN (${ph}) AND toc_level = ?`,
          )
          .bind(...sourceIds, targetLevel)
          .all<{ source_id: string; content: string }>();
        const tocMap = new Map(
          (tocsResult.results ?? []).map((t) => [t.source_id, t.content]),
        );

        // 3. Für small/medium-Quellen ohne TOC: alle §§ in einem Query laden (Fallback)
        const needsSections = sourceIds.filter((id) => {
          const src = sourceMap.get(id);
          return src && !tocMap.has(id) && src.size_class !== "large";
        });
        const sectionsMap = new Map<string, SectionResult[]>();
        if (needsSections.length > 0) {
          const secPh = needsSections.map(() => "?").join(", ");
          const secResult = await db
            .prepare(
              `SELECT source_id, section_ref, heading, body FROM source_sections WHERE source_id IN (${secPh}) ORDER BY source_id, sort_order`,
            )
            .bind(...needsSections)
            .all<Pick<SourceSection, "section_ref" | "heading" | "body"> & { source_id: string }>();
          for (const r of secResult.results ?? []) {
            if (!sectionsMap.has(r.source_id)) sectionsMap.set(r.source_id, []);
            sectionsMap.get(r.source_id)!.push({
              ref: r.section_ref,
              heading: r.heading,
              body: r.body,
            });
          }
        }

        // 4. Ergebnisse in der Reihenfolge der Eingabe zusammenbauen
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
          const toc = tocMap.get(id) ?? null;
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
        geo: z
          .string()
          .optional()
          .describe(
            "Geo-Kontext (ARS-Code oder Klarname) — wird als Metadaten weitergegeben, " +
            "beeinflusst nicht die Abfrage (Source-IDs sind bereits geo-gefiltert).",
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
          // Quell-Metadaten laden (inkl. url für quelle_url in der Response)
          const source = await db
            .prepare(
              "SELECT id, titel, kurzbezeichnung, quelle, url, size_class, section_count FROM sources WHERE id = ?",
            )
            .bind(req.source)
            .first<Pick<Source, "id" | "titel" | "kurzbezeichnung" | "quelle" | "url" | "size_class" | "section_count">>();

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
            const all = await db
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
              let row = await db
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
                  row = await db
                    .prepare(
                      "SELECT section_ref, heading, body FROM source_sections WHERE source_id = ? AND section_ref = ? LIMIT 1",
                    )
                    .bind(req.source, shortRef)
                    .first<{ section_ref: string; heading: string | null; body: string }>();
                }
              }

              // 3. Fallback: LIKE-Suche (z.B. "§2" statt "§ 2")
              //    % _ \ [ ] escapen, damit sie nicht als Pattern-Zeichen interpretiert werden
              //    Whitespace → % nur für kurze Refs (≤3 Wörter), sonst SQLITE_ERROR: LIKE pattern too complex
              if (!row) {
                const escapedForLike = normalized.replace(/[%_\\[\]]/g, "\\$&");
                const words = escapedForLike.trim().split(/\s+/);
                const likePattern = words.length <= 3
                  ? `%${words.join("%")}%`
                  : `%${escapedForLike}%`;
                row = await db
                  .prepare(
                    "SELECT section_ref, heading, body FROM source_sections WHERE source_id = ? AND section_ref LIKE ? ESCAPE '\\' LIMIT 1",
                  )
                  .bind(req.source, likePattern)
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
    // Tool 4: RAGSource_query
    // ===================================================================
    this.server.tool(
      "RAGSource_query",
      "FALLBACK — nur wenn RAGSource_catalog keine passende Quelle liefert oder das Thema unklar ist. " +
      "FTS5-Volltextsuche über alle indizierten Paragraphen. " +
      "Liefert Treffer mit source_id und section_ref für gezieltes Nachladen per RAGSource_get.",
      {
        query: z
          .string()
          .describe("Suchanfrage in natürlicher Sprache"),
        geo: z
          .string()
          .optional()
          .describe(
            "Geo-Filter: ARS-Code (2/5/9/12 Stellen) oder Klarname. " +
            "Beispiele: '08', '08117', '081175009012', 'Bad Boll'",
          ),
        projekt: z
          .string()
          .optional()
          .describe("Projekt-Slug, z.B. 'amtsschimmel'"),
        hints: z
          .array(z.string())
          .optional()
          .describe(
            "Optionale Zusatz-Suchbegriffe: Synonyme, Fachbegriffe, verwandte Begriffe",
          ),
      },
      { title: "RAGSource query", readOnlyHint: true, destructiveHint: false },
      async ({ query, geo: geoInput, projekt: projektInput, hints }) => {
        const db = this.env.DB;

        // Geo auflösen; URL-?geo= als Request-Default wenn kein expliziter Parameter.
        // _currentGeo wird per fetch() pro Request gesetzt — robuster als sessionGeo-Closure,
        // die beim DO-Reuse stale sein kann.
        const effectiveGeo = geoInput ?? (this._currentGeo || null);
        const geoResult = effectiveGeo ? await resolveGeo(effectiveGeo, db) : null;
        // Bei ambiguem Geo im query-Tool: kein Geo-Filter (FTS sucht im Gesamtbestand)
        const geo = (geoResult && "ambiguous" in geoResult ? null : geoResult) as ResolvedGeo | null;
        const geoFilter = buildGeoFilter(geo);
        const projektFilter = buildProjektFilter(resolveProjekt(projektInput));

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
            AND ${projektFilter.sql}
          ORDER BY rank
          LIMIT 20
        `;

        const result = await db
          .prepare(sql)
          .bind(ftsQuery, ...geoFilter.params, ...projektFilter.params)
          .all<{
            section_ref: string;
            heading: string | null;
            body: string;
            source_id: string;
            titel: string;
            ebene: string | null;
            size_class: string;
            rank: number;
          }>();

        const hits: QueryHit[] = (result.results ?? []).map((r) => ({
          source_id: r.source_id,
          titel: r.titel,
          ebene: r.ebene,
          size_class: r.size_class,
          section_ref: r.section_ref,
          heading: r.heading,
          body: r.body,
        }));

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
  }
}

// -----------------------------------------------------------------------
// Hilfsfunktionen
// -----------------------------------------------------------------------

/**
 * Normalisiert eine Paragraphen-Referenz für den Abgleich.
 * Stellt sicher, dass nach § / Art. / Artikel / EG ein Leerzeichen steht.
 * Beispiel: "§2" → "§ 2", "Art.6" → "Art. 6"
 */
function normalizeSectionRef(ref: string): string {
  return ref
    .trim()
    .replace(/§\s*(\d)/g, "§ $1")
    .replace(/Art\.\s*(\d)/g, "Art. $1")
    .replace(/Artikel\s+(\d)/g, "Artikel $1")
    .replace(/Erwägungsgrund\s+(\d)/g, "Erwägungsgrund $1")
    .replace(/EG\s+(\d)/g, "EG $1");
}

/**
 * Extrahiert die Kurzreferenz (§ N, Art. N, EG N, Kapitel N) aus einem vollen TOC-Eintrag.
 * Beispiel: "§ 19 EStG [red. Nichtselbständige Arbeit – ...]" → "§ 19"
 *           "Art. 6 Rechtmäßigkeit" → "Art. 6"
 * Gibt null zurück wenn keine Referenz erkannt wird.
 */
function extractSectionRef(ref: string): string | null {
  const m = ref.match(
    /^(§\s*\d+[a-z]?|Art\.\s*\d+[a-z]?|Artikel\s+\d+[a-z]?|Erwägungsgrund\s+\d+|EG\s+\d+|Kapitel\s+\d+[a-z]?)\b/i,
  );
  return m ? normalizeSectionRef(m[1]) : null;
}
