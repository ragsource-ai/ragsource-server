import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, Persona, Gemeinde } from "./types.js";
import { search } from "./engine/matcher.js";
import { buildResponsePacket } from "./engine/response.js";
import { normalizeGeoParam } from "./engine/normalize.js";

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
      version: "1.2.0",
    });
  });

  // Stichwortsuche (einfach)
  app.get("/api/search", async (c) => {
    const q = c.req.query("q");
    if (!q) return c.json({ error: "Parameter 'q' fehlt" }, 400);

    const db = c.env.DB;
    const gemeinde = c.req.query("gemeinde") || undefined;
    const bundesland = c.req.query("bundesland") || undefined;
    const landkreis = c.req.query("landkreis") || undefined;

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

    const results = await search(db, {
      query: q,
      gemeinde_ars: gemeindeArs ?? undefined,
      verband_ars: verbandArs ?? undefined,
      kreis_ars: resolvedKreisArs ?? undefined,
      land_ars: resolvedLandArs ?? undefined,
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

    const db = c.env.DB;
    const persona = body.persona || "buerger";

    // Geo-Parameter normalisieren → ARS
    const gemeindeArs = body.gemeinde ? await normalizeGeoParam(body.gemeinde, "gemeinde", db) : null;
    const kreisArs = body.landkreis ? await normalizeGeoParam(body.landkreis, "landkreis", db) : null;
    const landArs = body.bundesland ? await normalizeGeoParam(body.bundesland, "bundesland", db) : null;

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

    // Retrieval
    const articles = await search(db, {
      query: body.query,
      gemeinde_ars: gemeindeArs ?? undefined,
      verband_ars: verbandArs ?? undefined,
      kreis_ars: resolvedKreisArs ?? undefined,
      land_ars: resolvedLandArs ?? undefined,
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
