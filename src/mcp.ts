import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env, Persona, Gemeinde } from "./types.js";
import { search } from "./engine/matcher.js";
import { buildResponsePacket } from "./engine/response.js";
import { normalizeGeoParam } from "./engine/normalize.js";

export class RAGSourceMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "RAGSource",
    version: "1.2.0",
  });

  async init() {
    // Tool 1: Hauptfunktion -- Vollständiges Retrieval mit Response-Paket
    this.server.tool(
      "ragsource_query",
      "Durchsucht die kommunale Wissensbasis und liefert relevante Rechtsgrundlagen, " +
        "Satzungen und Verwaltungswissen. Gibt ein strukturiertes Antwortpaket mit " +
        "vollstaendigen Artikeltexten, Persona-Konfiguration und Hierarchie-Informationen zurueck. " +
        "Nutze dieses Tool fuer alle Fragen zu kommunalem Recht, Satzungen und Verwaltung.",
      {
        query: z
          .string()
          .describe(
            "Die Suchanfrage des Nutzers in natuerlicher Sprache",
          ),
        gemeinde: z
          .string()
          .optional()
          .describe("Gemeinde-Slug, z.B. 'bad-boll'. Optional."),
        bundesland: z
          .string()
          .optional()
          .describe("Bundesland-Kuerzel, z.B. 'bw'. Optional."),
        landkreis: z
          .string()
          .optional()
          .describe("Landkreis-Slug, z.B. 'goeppingen'. Optional."),
        projekt: z
          .string()
          .optional()
          .describe("Projekt-Slug, z.B. 'amtsschimmel'. Filtert auf projektrelevante Artikel."),
        persona: z
          .enum(["buerger", "gemeinderat", "verwaltung", "buergermeister"])
          .default("buerger")
          .describe("Rolle des Nutzers"),
        hints: z
          .array(z.string())
          .optional()
          .describe(
            "Optionale zusaetzliche Suchbegriffe: Synonyme, Fachbegriffe, verwandte Begriffe",
          ),
        sources: z
          .array(z.string())
          .optional()
          .describe("Optionale vermutete Dokumenttitel"),
      },
      async ({ query, gemeinde, bundesland, landkreis, projekt, persona, hints, sources }) => {
        const db = this.env.DB;
        const p = persona as Persona;

        // Geo-Parameter normalisieren → ARS
        const gemeindeArs = gemeinde ? await normalizeGeoParam(gemeinde, "gemeinde", db) : null;
        const kreisArs = landkreis ? await normalizeGeoParam(landkreis, "landkreis", db) : null;
        const landArs = bundesland ? await normalizeGeoParam(bundesland, "bundesland", db) : null;

        // Auto-Resolve: Gemeinde → Verband/Kreis/Land
        let verbandArs: string | null = null;
        let resolvedKreisArs = kreisArs;
        let resolvedLandArs = landArs;
        let gemeindeRow: Gemeinde | null = null;

        if (gemeindeArs) {
          gemeindeRow = await db
            .prepare("SELECT * FROM gemeinden WHERE ars = ?")
            .bind(gemeindeArs)
            .first<Gemeinde>();
          if (gemeindeRow) {
            verbandArs = gemeindeRow.verband_ars;
            if (!resolvedKreisArs) resolvedKreisArs = gemeindeRow.kreis_ars;
            if (!resolvedLandArs) resolvedLandArs = gemeindeRow.land_ars;
          }
        }

        // 4-Stufen-Retrieval mit ARS-Filtern
        const articles = await search(db, {
          query,
          gemeinde_ars: gemeindeArs ?? undefined,
          verband_ars: verbandArs ?? undefined,
          kreis_ars: resolvedKreisArs ?? undefined,
          land_ars: resolvedLandArs ?? undefined,
          projekt,
          persona: p,
          hints,
          sources,
        });

        // Response-Paket bauen
        const packet = buildResponsePacket(articles, gemeindeRow, p);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(packet, null, 2),
            },
          ],
        };
      },
    );

    // Tool 2: Einfache Stichwortsuche (ohne Volltexte)
    this.server.tool(
      "ragsource_search",
      "Einfache Stichwortsuche im Index. Gibt eine Liste von Artikeln mit " +
        "Scores zurueck, ohne vollstaendigen Artikelinhalt. Nutze dieses Tool " +
        "um einen Ueberblick zu bekommen, welche Dokumente es gibt.",
      {
        keywords: z
          .string()
          .describe("Suchbegriffe, Leerzeichen-getrennt"),
        gemeinde: z
          .string()
          .optional()
          .describe("Gemeinde-Slug, z.B. 'bad-boll'. Optional."),
        bundesland: z
          .string()
          .optional()
          .describe("Bundesland-Kuerzel, z.B. 'bw'. Optional."),
        landkreis: z
          .string()
          .optional()
          .describe("Landkreis-Slug, z.B. 'goeppingen'. Optional."),
        projekt: z
          .string()
          .optional()
          .describe("Projekt-Slug. Optional."),
      },
      async ({ keywords, gemeinde, bundesland, landkreis, projekt }) => {
        const db = this.env.DB;

        // Geo-Parameter normalisieren → ARS
        const gemeindeArs = gemeinde ? await normalizeGeoParam(gemeinde, "gemeinde", db) : null;
        const kreisArs = landkreis ? await normalizeGeoParam(landkreis, "landkreis", db) : null;
        const landArs = bundesland ? await normalizeGeoParam(bundesland, "bundesland", db) : null;

        // Auto-Resolve: Gemeinde → Verband/Kreis/Land
        let verbandArs: string | null = null;
        let resolvedKreisArs = kreisArs;
        let resolvedLandArs = landArs;

        if (gemeindeArs) {
          const gemeindeRow = await db
            .prepare("SELECT * FROM gemeinden WHERE ars = ?")
            .bind(gemeindeArs)
            .first<Gemeinde>();
          if (gemeindeRow) {
            verbandArs = gemeindeRow.verband_ars;
            if (!resolvedKreisArs) resolvedKreisArs = gemeindeRow.kreis_ars;
            if (!resolvedLandArs) resolvedLandArs = gemeindeRow.land_ars;
          }
        }

        const articles = await search(db, {
          query: keywords,
          gemeinde_ars: gemeindeArs ?? undefined,
          verband_ars: verbandArs ?? undefined,
          kreis_ars: resolvedKreisArs ?? undefined,
          land_ars: resolvedLandArs ?? undefined,
          projekt,
          persona: "buerger",
        });

        const results = articles.map((a) => ({
          titel: a.titel,
          ebene: a.ebene,
          saule: a.saule,
          score: a.score,
          dateipfad: a.dateipfad,
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ results }, null, 2),
            },
          ],
        };
      },
    );

    // Tool 3: Einzelartikel laden
    this.server.tool(
      "ragsource_article",
      "Laedt einen einzelnen Artikel anhand seines Dateipfads. " +
        "Gibt den vollstaendigen Artikeltext mit Metadaten zurueck.",
      {
        path: z
          .string()
          .describe(
            "Dateipfad des Artikels (oder Teil davon), z.B. 'BBO_Satzung_Feuerwehrsatzung.md'",
          ),
      },
      async ({ path }) => {
        const db = this.env.DB;

        const article = await db
          .prepare(
            "SELECT * FROM articles WHERE dateipfad LIKE ? AND status = 'published' LIMIT 1",
          )
          .bind(`%${path}%`)
          .first();

        if (!article) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "Artikel nicht gefunden",
                  path,
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(article, null, 2),
            },
          ],
        };
      },
    );
  }
}
