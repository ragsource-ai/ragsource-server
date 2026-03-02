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
} from "./types-v2.js";
import { resolveGeo, type ResolvedGeo } from "./engine/normalize.js";
import masterpromptDefaultTemplate from "./prompts/masterprompt-default.md";
import masterpromptAmtsschimmelTemplate from "./prompts/masterprompt-amtsschimmel.md";

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
// Masterprompts (werden bei MCP-Initialize automatisch als instructions injiziert)
// Quellen: src/prompts/*.md — dort bearbeiten, hier nur Platzhalter ersetzen
// -----------------------------------------------------------------------

/** Generischer RAGSource-Masterprompt (Fallback wenn kein Projekt erkannt) */
const MASTERPROMPT_DEFAULT = masterpromptDefaultTemplate.trimEnd();

/** Persona-Beschreibung für den TON & PERSONA-Block (URL-Parameter ?rolle=) */
const PERSONA_BESCHREIBUNG: Record<string, string> = {
  "verwaltung":      "Für Verwaltungsmitarbeiter: fachlich und direkt, §§ im Vordergrund. Vollständige Paragrafen-Angaben.",
  "buerger":         "Für Bürger: verständlich und handlungsorientiert erklären. Einfache Sprache, Handlungsschritte aufzeigen.",
  "buergermeister":  "Für den Bürgermeister: Briefing-Stil, kurz und entscheidungsorientiert. Kernaussagen zuerst, §§ nachgelagert.",
  "gemeinderat":     "Für den Gemeinderat: erklärend mit Hintergründen und Zusammenhängen, §§ vollständig zitieren.",
};

/**
 * Baut den amtsschimmel.ai-Masterprompt mit dynamischem Geo (ARS) und Rolle.
 * Vorlage: src/prompts/masterprompt-amtsschimmel.md
 * @param geo  ARS-Code aus ?geo= URL-Parameter (z.B. "081175009012") oder null
 * @param rolle Rollen-Kürzel aus ?rolle= URL-Parameter (z.B. "verwaltung")
 */
function buildMasterpromptAmtsschimmel(geo: string | null, rolle: string): string {
  const geoInstruction = geo
    ? `Rufe RAGSource_catalog mit geo="${geo}" auf.\n   → liefert alle für diese Gemeinde geltenden Rechtsquellen (Ortsrecht bis Bundesrecht)`
    : `Rufe RAGSource_catalog auf. Nutze den geo-Parameter entsprechend der angefragten Gemeinde.`;

  const personaText = PERSONA_BESCHREIBUNG[rolle] ?? PERSONA_BESCHREIBUNG["verwaltung"];

  return masterpromptAmtsschimmelTemplate
    .replace("{{GEO_INSTRUCTION}}", geoInstruction)
    .replace("{{PERSONA_TEXT}}", personaText)
    .trimEnd();
}

/** Mappt Projekt-Slugs auf ihre Masterprompt-Builder-Funktionen */
type MasterpromptBuilder = (geo: string | null, rolle: string) => string;

const MASTERPROMPT_BUILDERS: Record<string, MasterpromptBuilder> = {
  "amtsschimmel": buildMasterpromptAmtsschimmel,
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
// MCP Agent
// -----------------------------------------------------------------------

export class RAGSourceMCPv2 extends McpAgent<Env> {
  /** Host des eingehenden Requests — wird in fetch() gesetzt, bevor init() läuft */
  private _currentHost: string = "";
  /** Geo-Parameter aus der MCP-URL (?geo=...) — leer = kein Geo-Filter im Masterprompt */
  private _currentGeo: string = "";
  /** Rollen-Parameter aus der MCP-URL (?rolle=...) — Default: "verwaltung" */
  private _currentRolle: string = "verwaltung";

  /**
   * Placeholder-Server (nötig weil McpAgent die Property beim Start liest).
   * In init() wird er durch den projekt-spezifischen Server ersetzt.
   */
  server = new McpServer(
    { name: "RAGSource", version: "2.0.0" },
    { instructions: MASTERPROMPT_DEFAULT },
  );

  /**
   * Überschreibt den DO-fetch, um den Host-Header zu erfassen,
   * bevor init() den Server mit dem passenden Masterprompt erstellt.
   */
  override async fetch(request: Request): Promise<Response> {
    // Der agents SDK übernimmt den originalen Host als URL-Hostname des internen DO-Requests.
    // Host-Header selbst wird dabei gestrippt — URL-Hostname ist die zuverlässige Quelle.
    // URL-Parameter (?geo=, ?rolle=) werden vom SDK ebenfalls durchgereicht.
    try {
      const url = new URL(request.url);
      this._currentHost = url.hostname;
      this._currentGeo = url.searchParams.get("geo") ?? "";
      this._currentRolle = url.searchParams.get("rolle") ?? "verwaltung";
    } catch {
      this._currentHost = "";
      this._currentGeo = "";
      this._currentRolle = "verwaltung";
    }
    return super.fetch(request);
  }

  async init() {
    // Projekt aus Host ableiten
    const projekt = PROJEKT_BY_HOST[this._currentHost];

    // Masterprompt bauen: projekt-spezifischer Builder oder generischer Default.
    // geo wird als ARS-Code (Raw aus ?geo= URL-Param) direkt übergeben — kein resolveGeo nötig.
    const geo = this._currentGeo || null;
    const builder = projekt ? MASTERPROMPT_BUILDERS[projekt] : undefined;
    const instructions = builder
      ? builder(geo, this._currentRolle)
      : MASTERPROMPT_DEFAULT;

    this.server = new McpServer(
      { name: "RAGSource", version: "2.0.0" },
      { instructions },
    );

    // ===================================================================
    // Tool 1: RAGSource_catalog
    // ===================================================================
    this.server.tool(
      "RAGSource_catalog",
      "Liefert das Verzeichnis aller verfuegbaren Rechtsquellen (Gesetze, Satzungen, Verordnungen) " +
      "fuer eine bestimmte Gemeinde oder Region. " +
      "Jeder Eintrag enthaelt id, titel, typ, ebene, size_class, toc_available und beschreibung. " +
      "Routing-Regel: " +
      "'small' → RAGSource_get direkt (gesamtes Dokument, wenige §§); " +
      "'medium'/'large' → RAGSource_toc aufrufen — liefert bei toc_available=true das Inhaltsverzeichnis " +
      "zur gezielten §-Auswahl, bei toc_available=false alle §§ direkt als Fallback (sections). " +
      "Einmalig zu Beginn einer Session aufrufen; der Catalog aendert sich selten.",
      {
        geo: z
          .string()
          .optional()
          .describe(
            "Geo-Filter: ARS-Code (2/5/9/12 Stellen) oder Klarname. " +
            "2-stellig=Land, 5-stellig=Kreis, 9-stellig=Verband, 12-stellig=Gemeinde. " +
            "Beispiele: '08', '08117', '081175009', '081175009012', 'Bad Boll'",
          ),
        projekt: z
          .string()
          .optional()
          .describe(
            "Projekt-Slug fuer Mandanten-Filter, z.B. 'amtsschimmel' oder 'brandmeister'. " +
            "Ohne Angabe werden alle Quellen zurueckgegeben.",
          ),
      },
      { title: "Quellen-Katalog abrufen", readOnlyHint: true, destructiveHint: false },
      async ({ geo: geoInput, projekt: projektInput }) => {
        const db = this.env.DB;

        // KV: Broadcast-Nachricht (Wartung, Updates) — null wenn nicht gesetzt
        const systemMessage = await this.env.CONFIG.get("system_message");

        // Geo auflösen; Projekt via Parameter oder Host-Header bestimmen
        const geo = geoInput ? await resolveGeo(geoInput, db) : null;
        const geoFilter = buildGeoFilter(geo);
        const projektFilter = buildProjektFilter(resolveProjekt(projektInput));

        // Quellen abfragen — nur die 7 Felder, die das LLM braucht
        const sql = `
          SELECT s.id, s.titel, s.typ, s.ebene, s.size_class, s.beschreibung,
                 EXISTS(SELECT 1 FROM source_tocs t WHERE t.source_id = s.id) AS toc_available
          FROM sources s
          WHERE ${geoFilter.sql}
            AND ${projektFilter.sql}
          ORDER BY s.ebene, s.titel
        `;

        type CatalogRow = {
          id: string;
          titel: string;
          typ: string | null;
          ebene: string | null;
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

        // Catalog-Einträge (ohne body-Inhalte)
        const catalog: CatalogEntry[] = sorted.map((s) => ({
          id: s.id,
          titel: s.titel,
          typ: s.typ,
          ebene: s.ebene,
          size_class: s.size_class,
          toc_available: s.toc_available === 1,
          beschreibung: s.beschreibung,
        }));

        const geoInfo = geo
          ? { name: geo.display.name, level: geo.level }
          : { name: "alle Ebenen", level: "alle" };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ...(systemMessage && { system_message: systemMessage }),
                  geo: geoInfo,
                  total: catalog.length,
                  routing_hinweis:
                    "small → RAGSource_get direkt | medium/large → RAGSource_toc (toc_available=true: TOC; toc_available=false: alle §§ als Fallback)",
                  sources: catalog,
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
    // Tool 2: RAGSource_toc
    // ===================================================================
    this.server.tool(
      "RAGSource_toc",
      "Liefert das Inhaltsverzeichnis einer oder mehrerer Rechtsquellen. " +
      "Das Inhaltsverzeichnis enthaelt alle §§/Artikel mit Kurztiteln und optionalen Stichworten " +
      "in Klammern, z.B. '§ 6 Aufgaben (Pflichtaufgaben, Mindeststärke)'. " +
      "Nutze dieses Tool vor RAGSource_get, um gezielt relevante §§ zu identifizieren. " +
      "Mehrere source_ids koennen in einem Aufruf abgefragt werden (Batch, max. 5). " +
      "Falls kein Inhaltsverzeichnis vorhanden ist (toc: null), liefert das Tool bei small/medium-Quellen " +
      "automatisch alle §§ im Feld 'sections' — kein extra RAGSource_get-Aufruf noetig.",
      {
        sources: z
          .array(z.string())
          .min(1)
          .max(5)
          .describe(
            "Liste von Source-IDs aus RAGSource_catalog, z.B. ['FwG_BW', 'BBO_Satzung_Feuerwehr']. " +
            "Max. 5 pro Aufruf.",
          ),
        level: z
          .string()
          .optional()
          .describe(
            "TOC-Ebene fuer mehrteilige Werke, z.B. 'buch-2' fuer BGB Buch 2. " +
            "Ohne Angabe: 'gesamt'.",
          ),
      },
      { title: "Inhaltsverzeichnis abrufen", readOnlyHint: true, destructiveHint: false },
      async ({ sources: sourceIds, level }) => {
        const db = this.env.DB;
        const targetLevel = level ?? "gesamt";

        const results: TocResult[] = [];

        for (const sourceId of sourceIds) {
          // Quell-Metadaten laden
          const source = await db
            .prepare(
              "SELECT id, titel, kurzbezeichnung, size_class, section_count FROM sources WHERE id = ?",
            )
            .bind(sourceId)
            .first<Pick<Source, "id" | "titel" | "kurzbezeichnung" | "size_class" | "section_count">>();

          if (!source) {
            results.push({
              source_id: sourceId,
              titel: "(nicht gefunden)",
              size_class: "unknown",
              section_count: 0,
              toc: null,
            });
            continue;
          }

          // TOC laden
          const tocRow = await db
            .prepare(
              "SELECT content FROM source_tocs WHERE source_id = ? AND toc_level = ?",
            )
            .bind(sourceId, targetLevel)
            .first<{ content: string }>();

          const toc = tocRow?.content ?? null;

          // Kein TOC + small/medium → alle §§ direkt mitliefern (spart Extra-Aufruf)
          let sectionsFallback: SectionResult[] | undefined;
          if (!toc && source.size_class !== "large") {
            const rows = await db
              .prepare(
                "SELECT section_ref, heading, body FROM source_sections WHERE source_id = ? ORDER BY sort_order",
              )
              .bind(sourceId)
              .all<Pick<SourceSection, "section_ref" | "heading" | "body">>();
            sectionsFallback = (rows.results ?? []).map((r) => ({
              ref: r.section_ref,
              heading: r.heading,
              body: r.body,
            }));
          }

          results.push({
            source_id: source.id,
            titel: source.titel,
            size_class: source.size_class,
            section_count: source.section_count,
            toc,
            ...(sectionsFallback !== undefined && { sections: sectionsFallback }),
          });
        }

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
      "Liefert den Originalwortlaut spezifischer Paragraphen einer Rechtsquelle. " +
      "Wenn sections leer oder nicht angegeben: komplettes Dokument (alle §§). " +
      "Empfehlung: Nur bei size_class='small' alle §§ auf einmal laden. " +
      "Bei medium/large: gezielte §§ aus dem TOC auswaehlen (max. 15 pro Aufruf). " +
      "section_ref exakt wie im TOC oder Catalog angegeben verwenden, " +
      "z.B. '§ 2', 'Artikel 6', 'Erwägungsgrund 40'. " +
      "Koennen weitere §§ bei Folgefragen nachgeladen werden.",
      {
        source: z
          .string()
          .describe("Source-ID aus RAGSource_catalog, z.B. 'FwG_BW'"),
        sections: z
          .array(z.string())
          .max(15)
          .optional()
          .describe(
            "Paragraphen-Referenzen, z.B. ['§ 2', '§ 8', 'Artikel 24']. " +
            "Leer lassen fuer gesamtes Dokument (nur fuer small-Quellen empfohlen).",
          ),
      },
      { title: "Paragraphen abrufen", readOnlyHint: true, destructiveHint: false },
      async ({ source: sourceId, sections: requestedRefs }) => {
        const db = this.env.DB;

        // Quell-Metadaten laden (inkl. url für quelle_url in der Response)
        const source = await db
          .prepare(
            "SELECT id, titel, kurzbezeichnung, quelle, url, size_class, section_count FROM sources WHERE id = ?",
          )
          .bind(sourceId)
          .first<Pick<Source, "id" | "titel" | "kurzbezeichnung" | "quelle" | "url" | "size_class" | "section_count">>();

        if (!source) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `Quelle '${sourceId}' nicht gefunden. Bitte RAGSource_catalog aufrufen.`,
                }),
              },
            ],
          };
        }

        let sections: SectionResult[] = [];

        if (!requestedRefs || requestedRefs.length === 0) {
          // Alle Paragraphen laden (gesamtes Dokument)
          const all = await db
            .prepare(
              "SELECT section_ref, heading, body FROM source_sections WHERE source_id = ? ORDER BY sort_order",
            )
            .bind(sourceId)
            .all<{ section_ref: string; heading: string | null; body: string }>();

          sections = (all.results ?? []).map((r) => ({
            ref: r.section_ref,
            heading: r.heading,
            body: r.body,
          }));
        } else {
          // Gezielte Paragraphen laden (normalisierter Abgleich)
          for (const rawRef of requestedRefs) {
            const normalized = normalizeSectionRef(rawRef);

            // Exakter Match zuerst
            let row = await db
              .prepare(
                "SELECT section_ref, heading, body FROM source_sections WHERE source_id = ? AND section_ref = ? LIMIT 1",
              )
              .bind(sourceId, normalized)
              .first<{ section_ref: string; heading: string | null; body: string }>();

            // Fallback: LIKE-Suche (z.B. "§2" statt "§ 2")
            if (!row) {
              row = await db
                .prepare(
                  "SELECT section_ref, heading, body FROM source_sections WHERE source_id = ? AND section_ref LIKE ? LIMIT 1",
                )
                .bind(sourceId, `%${normalized.replace(/\s+/g, "%")}%`)
                .first<{ section_ref: string; heading: string | null; body: string }>();
            }

            if (row) {
              sections.push({
                ref: row.section_ref,
                heading: row.heading,
                body: row.body,
              });
            }
            // Nicht gefundene §§ werden stillschweigend übersprungen
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  source: source.id,
                  titel: source.titel,
                  kurzbezeichnung: source.kurzbezeichnung,
                  quelle: source.quelle,
                  quelle_url: source.url,
                  sections_geladen: sections.length,
                  sections,
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
      "Volltextsuche ueber alle Paragraphen. " +
      "Convenience-Tool fuer einfache Anfragen oder wenn der agentic Flow " +
      "(catalog → toc → get) nicht moeglich ist. " +
      "Liefert direkt relevante Paragraphen mit Source-Kontext. " +
      "Nutzt FTS5-Volltext-Suche auf Paragraphen-Ebene — praeziser als v1. " +
      "Fuer komplexe oder große Quellen besser RAGSource_catalog → RAGSource_toc → RAGSource_get verwenden.",
      {
        query: z
          .string()
          .describe("Suchanfrage in natuerlicher Sprache"),
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
      { title: "Volltext-Suche", readOnlyHint: true, destructiveHint: false },
      async ({ query, geo: geoInput, projekt: projektInput, hints }) => {
        const db = this.env.DB;

        // Geo auflösen; Projekt via Parameter oder Host-Header bestimmen
        const geo = geoInput ? await resolveGeo(geoInput, db) : null;
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
          ? { name: geo.display.name, level: geo.level }
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
