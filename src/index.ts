/**
 * RAGSource Server v2 — Worker Entry Point
 *
 * Routing:
 *   /mcp                              → McpAgent (Durable Objects)
 *   /.well-known/oauth-authorization-server → OAuth Metadata (GP1)
 *   /oauth/register                   → Dynamic Client Registration (GP1)
 *   /oauth/authorize                  → Authorization Endpoint (GP1)
 *   /oauth/token                      → Token Endpoint (GP1)
 *   /api                              → Hono REST (Health Check)
 */

import { Hono } from "hono";
import { RAGSourceMCPv2 } from "./mcp.js";
import type { Env } from "./types.js";
import {
  handleProtectedResourceMetadata,
  handleOAuthMetadata,
  handleClientRegistration,
  handleAuthorize,
  handleToken,
  validateBearer,
} from "./oauth.js";

export { RAGSourceMCPv2 };

// -----------------------------------------------------------------------
// REST-API (Minimal: Health + Debug)
// -----------------------------------------------------------------------

function createApp() {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/api/health", async (c) => {
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

  app.all("*", (c) =>
    c.json({ error: "Not found", hint: "MCP-Endpunkt: /mcp" }, 404),
  );

  return app;
}

// -----------------------------------------------------------------------
// CORS-Header-Helfer
// -----------------------------------------------------------------------

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id",
  "Access-Control-Expose-Headers": "mcp-session-id",
  "Access-Control-Max-Age": "86400",
};

function corsPreflightResponse(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function addCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
    const path = url.pathname;

    // ----------------------------------------------------------------
    // OAuth-Endpunkte (nur aktiv wenn GP1_TOKEN gesetzt)
    // ----------------------------------------------------------------
    if (env.GP1_TOKEN) {
      if (path === "/.well-known/oauth-protected-resource") {
        return handleProtectedResourceMetadata(request);
      }
      if (path === "/.well-known/oauth-authorization-server") {
        return handleOAuthMetadata(request);
      }
      if (path === "/oauth/register") {
        if (request.method === "OPTIONS") return corsPreflightResponse();
        return handleClientRegistration(request, env);
      }
      if (path === "/oauth/authorize") {
        return handleAuthorize(request, env);
      }
      if (path === "/oauth/token") {
        if (request.method === "OPTIONS") return corsPreflightResponse();
        return handleToken(request, env);
      }
    }

    // ----------------------------------------------------------------
    // MCP-Endpunkt
    // ----------------------------------------------------------------
    if (path === "/mcp" || path.startsWith("/mcp/")) {
      if (request.method === "OPTIONS") return corsPreflightResponse();

      // Auth Guard — statischer Token ODER KV-gespeicherter OAuth-Token
      if (env.GP1_TOKEN) {
        const auth = request.headers.get("Authorization") ?? "";
        const ok = await validateBearer(auth, env);
        if (!ok) {
          const resourceMetaUrl = `${url.origin}/.well-known/oauth-protected-resource`;
          return new Response(
            JSON.stringify({ error: "Unauthorized", hint: "OAuth erforderlich." }),
            {
              status: 401,
              headers: {
                "Content-Type": "application/json",
                "WWW-Authenticate": `Bearer realm="${url.host}", resource_metadata="${resourceMetaUrl}"`,
                "Access-Control-Allow-Origin": "*",
              },
            },
          );
        }
      }

      // Rate-Limiting
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

      const mcpResponse = await RAGSourceMCPv2.serve("/mcp").fetch(request, env, ctx);
      return addCors(mcpResponse);
    }

    // ----------------------------------------------------------------
    // REST-Endpunkte → Hono
    // ----------------------------------------------------------------
    const app = createApp();
    return app.fetch(request, env, ctx);
  },
};
