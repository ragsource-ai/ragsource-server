import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env, Persona } from "./types.js";
import { search } from "./engine/matcher.js";
import { buildResponsePacket } from "./engine/response.js";
import { resolveGeo } from "./engine/normalize.js";

export class RAGSourceMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "RAGSource",
    version: "1.3.0",
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
      async ({ query, geo: geoInput, projekt, persona, hints, sources }) => {
        const db = this.env.DB;
        const p = persona as Persona;

        // Geo-Auflösung: 1 Parameter → ARS + Level
        const geo = geoInput ? await resolveGeo(geoInput, db) : null;

        // 4-Stufen-Retrieval mit ARS-Filtern
        const articles = await search(db, {
          query,
          gemeinde_ars: geo?.gemeinde_ars ?? undefined,
          verband_ars: geo?.verband_ars ?? undefined,
          kreis_ars: geo?.kreis_ars ?? undefined,
          land_ars: geo?.land_ars ?? undefined,
          geo_level: geo?.level,
          projekt,
          persona: p,
          hints,
          sources,
        });

        // Response-Paket bauen
        const packet = buildResponsePacket(articles, geo, p);

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
        geo: z
          .string()
          .optional()
          .describe(
            "Geo-Filter: ARS-Code (2/5/9/12 Stellen) oder Klarname. " +
            "Beispiele: '08', '08117', '081175009', '081175009012', 'Bad Boll'",
          ),
        projekt: z
          .string()
          .optional()
          .describe("Projekt-Slug. Optional."),
      },
      async ({ keywords, geo: geoInput, projekt }) => {
        const db = this.env.DB;

        // Geo-Auflösung: 1 Parameter → ARS + Level
        const geo = geoInput ? await resolveGeo(geoInput, db) : null;

        const articles = await search(db, {
          query: keywords,
          gemeinde_ars: geo?.gemeinde_ars ?? undefined,
          verband_ars: geo?.verband_ars ?? undefined,
          kreis_ars: geo?.kreis_ars ?? undefined,
          land_ars: geo?.land_ars ?? undefined,
          geo_level: geo?.level,
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
