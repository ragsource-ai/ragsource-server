import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, Persona, Gemeinde } from "./types.js";
import { search } from "./engine/matcher.js";
import { buildResponsePacket } from "./engine/response.js";

type HonoEnv = { Bindings: Env };

export function createApp() {
  const app = new Hono<HonoEnv>();

  app.use("*", cors());

  // Health Check
  app.get("/api/health", async (c) => {
    const result = await c.env.DB.prepare(
      "SELECT COUNT(*) as count FROM articles",
    ).first<{ count: number }>();
    return c.json({
      status: "ok",
      articles_count: result?.count ?? 0,
      version: "0.1.0",
    });
  });

  // Stichwortsuche (einfach)
  app.get("/api/search", async (c) => {
    const q = c.req.query("q");
    if (!q) return c.json({ error: "Parameter 'q' fehlt" }, 400);

    const results = await search(c.env.DB, {
      query: q,
      gemeinde: c.req.query("gemeinde") || undefined,
      bundesland: c.req.query("bundesland") || undefined,
      landkreis: c.req.query("landkreis") || undefined,
      projekt: c.req.query("projekt") || undefined,
      persona: "buerger",
    });

    return c.json({
      results: results.map((a) => ({
        titel: a.titel,
        ebene: a.ebene,
        saule: a.saule,
        score: a.score,
        dateipfad: a.dateipfad,
      })),
    });
  });

  // Einzelartikel
  app.get("/api/article", async (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "Parameter 'path' fehlt" }, 400);

    const article = await c.env.DB.prepare(
      "SELECT * FROM articles WHERE dateipfad LIKE ? AND status = 'published' LIMIT 1",
    )
      .bind(`%${path}%`)
      .first();

    if (!article) return c.json({ error: "Artikel nicht gefunden" }, 404);
    return c.json(article);
  });

  // Hauptfunktion: Query
  app.post("/api/query", async (c) => {
    const body = await c.req.json<{
      query: string;
      gemeinde?: string;
      bundesland?: string;
      landkreis?: string;
      projekt?: string;
      persona?: Persona;
      hints?: string[];
      sources?: string[];
    }>();

    if (!body.query) return c.json({ error: "Feld 'query' fehlt" }, 400);

    const gemeinde = body.gemeinde || undefined;
    const persona = body.persona || "buerger";

    // Gemeinde-Hierarchie auflösen (nur wenn gemeinde übergeben)
    let gemeindeRow: Gemeinde | null = null;
    if (gemeinde) {
      gemeindeRow = await c.env.DB.prepare(
        "SELECT * FROM gemeinden WHERE slug = ?",
      )
        .bind(gemeinde)
        .first<Gemeinde>();
    }

    // Retrieval
    const articles = await search(c.env.DB, {
      query: body.query,
      gemeinde,
      bundesland: body.bundesland,
      landkreis: body.landkreis,
      projekt: body.projekt,
      persona,
      hints: body.hints,
      sources: body.sources,
    });

    // Response-Paket bauen
    const packet = buildResponsePacket(articles, gemeindeRow, persona);
    return c.json(packet);
  });

  return app;
}
