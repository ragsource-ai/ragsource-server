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
  handleGeoSearch,
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
      deployment: c.env.ACCESS_TOKEN ? "gp1" : "public",
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
    // OAuth-Endpunkte (aktiv wenn ACCESS_TOKEN ODER OAUTH_PUBLIC gesetzt)
    //   ACCESS_TOKEN  → Passwort-Modus (GP1)
    //   OAUTH_PUBLIC  → passwortloser Geo-Picker-Modus (App-Directory)
    // ----------------------------------------------------------------
    const oauthActive = Boolean(env.ACCESS_TOKEN || env.OAUTH_PUBLIC);
    if (oauthActive) {
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
      if (path === "/oauth/geo-search") {
        return addCors(await handleGeoSearch(request, env));
      }
    }

    // ----------------------------------------------------------------
    // MCP-Endpunkt
    // ----------------------------------------------------------------
    if (path === "/mcp" || path.startsWith("/mcp/")) {
      if (request.method === "OPTIONS") return corsPreflightResponse();

      const bearer = request.headers.get("Authorization") ?? "";
      const token = bearer.startsWith("Bearer ") ? bearer.slice(7) : "";

      // Auth Guard — statischer Token ODER KV-gespeicherter OAuth-Token.
      // Im Geo-Picker-Modus trägt der Token den gewählten ARS.
      let tokenGeo: string | null = null;
      if (oauthActive) {
        const { valid, geo } = await validateBearer(bearer, env);
        if (!valid) {
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
        tokenGeo = geo;
      }

      // Rate-Limiting — pro Token (falls vorhanden), sonst pro IP.
      // ChatGPT bündelt Requests über wenige OpenAI-IPs; ein reiner IP-Key
      // würde alle App-Nutzer gegenseitig drosseln.
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const rateLimitKey = token ? `t:${token}` : `ip:${ip}`;
      const { success } = await env.RATE_LIMITER.limit({ key: rateLimitKey });
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

      // Geo-Injection: an den Token gebundener ARS wird als ?geo=-Default in die
      // MCP-URL geschrieben. Die DO liest ?geo= unverändert; ein explizites
      // geo-Tool-Argument überschreibt den Default weiterhin (Multi-ARS).
      let mcpRequest = request;
      if (tokenGeo) {
        const mcpUrl = new URL(request.url);
        mcpUrl.searchParams.set("geo", tokenGeo);
        mcpRequest = new Request(mcpUrl, request);
      }

      const mcpResponse = await RAGSourceMCPv2.serve("/mcp").fetch(mcpRequest, env, ctx);
      return addCors(mcpResponse);
    }

    // ----------------------------------------------------------------
    // REST-Endpunkte → Hono
    // ----------------------------------------------------------------
    const app = createApp();
    return app.fetch(request, env, ctx);
  },
};
