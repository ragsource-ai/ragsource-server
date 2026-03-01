/**
 * RAGSource Server v2 — Worker Entry Point
 *
 * Routing:
 *   /mcp  → McpAgent (Durable Objects) mit 4 Agentic-RAG-Tools
 *   /api  → Hono REST (Health Check, Debug)
 */

import { Hono } from "hono";
import { RAGSourceMCPv2 } from "./mcp-v2.js";
import type { Env } from "./types-v2.js";

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
      // DB noch nicht bereit
    }

    return c.json({
      status: "ok",
      version: "2.0.0",
      mcp_tools: ["RAGSource_catalog", "RAGSource_toc", "RAGSource_get", "RAGSource_query"],
      db: {
        sources: sourceCount,
        sections: sectionCount,
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
      // CORS-Preflight (ChatGPT, Cursor, andere Browser-Clients)
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
