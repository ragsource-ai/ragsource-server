import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, Persona } from "./types.js";
import { search } from "./engine/matcher.js";
import { buildResponsePacket } from "./engine/response.js";
import { resolveGeo } from "./engine/normalize.js";

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
      version: "1.3.0",
    });
  });

  // Stichwortsuche (einfach)
  app.get("/api/search", async (c) => {
    const q = c.req.query("q");
    if (!q) return c.json({ error: "Parameter 'q' fehlt" }, 400);

    const db = c.env.DB;
    const geoInput = c.req.query("geo") || undefined;

    // Geo-Auflösung: 1 Parameter → ARS + Level
    const geo = geoInput ? await resolveGeo(geoInput, db) : null;

    const results = await search(db, {
      query: q,
      gemeinde_ars: geo?.gemeinde_ars ?? undefined,
      verband_ars: geo?.verband_ars ?? undefined,
      kreis_ars: geo?.kreis_ars ?? undefined,
      land_ars: geo?.land_ars ?? undefined,
      geo_level: geo?.level,
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
      geo?: string;
      projekt?: string;
      persona?: Persona;
      hints?: string[];
      sources?: string[];
    }>();

    if (!body.query) return c.json({ error: "Feld 'query' fehlt" }, 400);

    const db = c.env.DB;
    const persona = body.persona || "buerger";

    // Geo-Auflösung: 1 Parameter → ARS + Level
    const geo = body.geo ? await resolveGeo(body.geo, db) : null;

    // Retrieval
    const articles = await search(db, {
      query: body.query,
      gemeinde_ars: geo?.gemeinde_ars ?? undefined,
      verband_ars: geo?.verband_ars ?? undefined,
      kreis_ars: geo?.kreis_ars ?? undefined,
      land_ars: geo?.land_ars ?? undefined,
      geo_level: geo?.level,
      projekt: body.projekt,
      persona,
      hints: body.hints,
      sources: body.sources,
    });

    // Response-Paket bauen
    const packet = buildResponsePacket(articles, geo, persona);
    return c.json(packet);
  });

  return app;
}
