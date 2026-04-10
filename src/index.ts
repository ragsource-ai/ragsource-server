/**
 * RAGSource Server v2 — Worker Entry Point
 *
 * Routing:
 *   /mcp  → McpAgent (Durable Objects) mit 4 Agentic-RAG-Tools
 *   /api  → Hono REST (Health Check, Debug)
 */

import { Hono } from "hono";
import { RAGSourceMCPv2 } from "./mcp.js";
import type { Env } from "./types.js";

// McpAgent als Durable Object exportieren (Pflicht für Cloudflare Workers)
export { RAGSourceMCPv2 };

// -----------------------------------------------------------------------
// REST-API (Minimal: Health + Debug)
// -----------------------------------------------------------------------

function createApp() {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/api/health", async (c) => {
    // Schneller DB-Check: Anzahl der Quellen
    let sourceCount = 0;
    let sectionCount = 0;
    let dbError = false;
    try {
      const row = await c.env.DB.prepare(
        "SELECT COUNT(*) as n FROM sources",
      ).first<{ n: number }>();
      sourceCount = row?.n ?? 0;

      const secRow = await c.env.DB.prepare(
        "SELECT COUNT(*) as n FROM source_sections",
      ).first<{ n: number }>();
      sectionCount = secRow?.n ?? 0;
    } catch {
      dbError = true;
    }

    if (dbError) {
      return c.json(
        {
          status: "degraded",
          version: "2.0.0",
          db: { error: true },
          timestamp: new Date().toISOString(),
        },
        503,
      );
    }

    let gp1SourceCount: number | null = null;
    if (c.env.DB_GP1) {
      try {
        const gp1Row = await c.env.DB_GP1.prepare("SELECT COUNT(*) as n FROM sources").first<{ n: number }>();
        gp1SourceCount = gp1Row?.n ?? 0;
      } catch { /* GP1 DB nicht erreichbar — ignorieren */ }
    }

    return c.json({
      status: "ok",
      version: "2.0.0",
      deployment: c.env.GP1_TOKEN ? "gp1" : "public",
      mcp_tools: ["RAGSource_catalog", "RAGSource_toc", "RAGSource_get", "RAGSource_query"],
      db: {
        sources: sourceCount,
        sections: sectionCount,
        ...(gp1SourceCount !== null && { gp1_sources: gp1SourceCount }),
      },
      timestamp: new Date().toISOString(),
    });
  });

  // 404-Fallback
  app.all("*", (c) =>
    c.json({ error: "Not found", hint: "MCP-Endpunkt: /mcp" }, 404),
  );

  return app;
}

// -----------------------------------------------------------------------
// Worker Entry Point
// -----------------------------------------------------------------------

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // MCP-Endpunkt → McpAgent (Durable Objects)
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      // CORS-Preflight — vor Auth, damit Browser CORS-Header entdecken können
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id",
            "Access-Control-Expose-Headers": "mcp-session-id",
            "Access-Control-Max-Age": "86400",
          },
        });
      }

      // Auth Guard — nur aktiv wenn GP1_TOKEN als Secret gesetzt ist
      if (env.GP1_TOKEN) {
        const auth = request.headers.get("Authorization") ?? "";
        if (auth !== `Bearer ${env.GP1_TOKEN}`) {
          return new Response(
            JSON.stringify({ error: "Unauthorized", hint: "Bearer Token erforderlich." }),
            {
              status: 401,
              headers: {
                "Content-Type": "application/json",
                "WWW-Authenticate": 'Bearer realm="ragsource-gp1"',
                "Access-Control-Allow-Origin": "*",
              },
            },
          );
        }
      }

      // Rate-Limiting: max. 60 Requests/Minute pro IP
      if (request.method !== "OPTIONS") {
        const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
        const { success } = await env.RATE_LIMITER.limit({ key: ip });
        if (!success) {
          return new Response(
            JSON.stringify({ error: "Too Many Requests", retry_after: 60 }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "60",
                "Access-Control-Allow-Origin": "*",
              },
            },
          );
        }
      }

      // MCP-Request durchleiten + CORS-Header anhängen
      const mcpResponse = await RAGSourceMCPv2.serve("/mcp").fetch(request, env, ctx);
      const headers = new Headers(mcpResponse.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");
      headers.set("Access-Control-Expose-Headers", "mcp-session-id");
      return new Response(mcpResponse.body, {
        status: mcpResponse.status,
        statusText: mcpResponse.statusText,
        headers,
      });
    }

    // REST-Endpunkte → Hono
    const app = createApp();
    return app.fetch(request, env, ctx);
  },
};
