/**
 * RAGSource Server v2 — Worker Entry Point
 *
 * Routing:
 *   /mcp                               → McpAgent (Durable Objects) mit 4 Agentic-RAG-Tools
 *   /.well-known/oauth-authorization-server → OAuth 2.0 Metadata (RFC 8414)
 *   /oauth/register                    → Dynamic Client Registration (RFC 7591)
 *   /oauth/authorize                   → Authorization Endpoint (Token-Eingabe-Formular)
 *   /oauth/token                       → Token Endpoint (Code → Access Token)
 *   /api                               → Hono REST (Health Check)
 */

import { Hono } from "hono";
import { RAGSourceMCPv2 } from "./mcp.js";
import type { Env } from "./types.js";

// McpAgent als Durable Object exportieren (Pflicht für Cloudflare Workers)
export { RAGSourceMCPv2 };

// -----------------------------------------------------------------------
// Hilfsfunktionen
// -----------------------------------------------------------------------

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function verifiyPkce(
  code_verifier: string,
  code_challenge: string,
  method: string,
): Promise<boolean> {
  if (!code_challenge) return true; // PKCE optional
  if (method === "plain") return code_verifier === code_challenge;
  if (method === "S256") {
    const data = new TextEncoder().encode(code_verifier);
    const hash = await crypto.subtle.digest("SHA-256", data);
    const base64url = btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return base64url === code_challenge;
  }
  return false;
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id",
    "Access-Control-Expose-Headers": "mcp-session-id",
  };
}

// -----------------------------------------------------------------------
// REST-API (Health Check)
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
        { status: "degraded", version: "2.0.0", db: { error: true }, timestamp: new Date().toISOString() },
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
// Worker Entry Point
// -----------------------------------------------------------------------

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;

    // ----------------------------------------------------------------
    // CORS-Preflight (global, vor allen anderen Routen)
    // ----------------------------------------------------------------
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(),
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // ----------------------------------------------------------------
    // OAuth 2.0 Authorization Server Metadata (RFC 8414)
    // ----------------------------------------------------------------
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256", "plain"],
      });
    }

    // ----------------------------------------------------------------
    // Dynamic Client Registration (RFC 7591) — alle Clients akzeptiert
    // ----------------------------------------------------------------
    if (url.pathname === "/oauth/register" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      return Response.json({
        client_id: "ragsource-gp1",
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: body.redirect_uris ?? [],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }, { status: 201 });
    }

    // ----------------------------------------------------------------
    // Authorization Endpoint — Token-Eingabe-Formular
    // ----------------------------------------------------------------
    if (url.pathname === "/oauth/authorize") {
      if (!env.GP1_TOKEN) {
        return new Response("OAuth nicht konfiguriert.", { status: 404 });
      }

      const redirect_uri = url.searchParams.get("redirect_uri") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const code_challenge = url.searchParams.get("code_challenge") ?? "";
      const code_challenge_method = url.searchParams.get("code_challenge_method") ?? "plain";

      if (request.method === "GET") {
        const html = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RAGSource GP1 – Zugang</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #f5f5f5;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
    }
    .card {
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 12px rgba(0,0,0,.12);
      padding: 2rem;
      width: 100%;
      max-width: 380px;
    }
    h1 { font-size: 1.1rem; margin: 0 0 1.5rem; color: #111; }
    label { display: block; font-size: .875rem; color: #444; margin-bottom: .25rem; }
    input[type=password] {
      width: 100%;
      padding: .6rem .75rem;
      font-size: 1rem;
      border: 1px solid #ccc;
      border-radius: 5px;
      margin-bottom: 1.25rem;
    }
    input[type=password]:focus { outline: 2px solid #0055ff; border-color: transparent; }
    button {
      width: 100%;
      padding: .7rem;
      background: #0055ff;
      color: white;
      border: none;
      border-radius: 5px;
      font-size: 1rem;
      cursor: pointer;
    }
    button:hover { background: #0044cc; }
  </style>
</head>
<body>
  <div class="card">
    <h1>RAGSource GP1 – Zugang</h1>
    <form method="POST">
      <input type="hidden" name="redirect_uri" value="${escHtml(redirect_uri)}">
      <input type="hidden" name="state" value="${escHtml(state)}">
      <input type="hidden" name="code_challenge" value="${escHtml(code_challenge)}">
      <input type="hidden" name="code_challenge_method" value="${escHtml(code_challenge_method)}">
      <label for="token">GP1-Token</label>
      <input type="password" id="token" name="token" autofocus autocomplete="off" required>
      <button type="submit">Anmelden</button>
    </form>
  </div>
</body>
</html>`;
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      if (request.method === "POST") {
        const body = await request.formData();
        const token = (body.get("token") as string) ?? "";
        const redir = (body.get("redirect_uri") as string) ?? redirect_uri;
        const st = (body.get("state") as string) ?? state;
        const cc = (body.get("code_challenge") as string) ?? code_challenge;
        const ccm = (body.get("code_challenge_method") as string) ?? code_challenge_method;

        if (token !== env.GP1_TOKEN) {
          const html = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RAGSource GP1 – Zugang</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: #f5f5f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: white; border-radius: 8px; box-shadow: 0 2px 12px rgba(0,0,0,.12); padding: 2rem; width: 100%; max-width: 380px; }
    h1 { font-size: 1.1rem; margin: 0 0 1.5rem; color: #111; }
    label { display: block; font-size: .875rem; color: #444; margin-bottom: .25rem; }
    input[type=password] { width: 100%; padding: .6rem .75rem; font-size: 1rem; border: 1px solid #ccc; border-radius: 5px; margin-bottom: .5rem; }
    input[type=password]:focus { outline: 2px solid #0055ff; border-color: transparent; }
    .error { color: #cc0000; font-size: .875rem; margin-bottom: 1rem; }
    button { width: 100%; padding: .7rem; background: #0055ff; color: white; border: none; border-radius: 5px; font-size: 1rem; cursor: pointer; }
    button:hover { background: #0044cc; }
  </style>
</head>
<body>
  <div class="card">
    <h1>RAGSource GP1 – Zugang</h1>
    <form method="POST">
      <input type="hidden" name="redirect_uri" value="${escHtml(redir)}">
      <input type="hidden" name="state" value="${escHtml(st)}">
      <input type="hidden" name="code_challenge" value="${escHtml(cc)}">
      <input type="hidden" name="code_challenge_method" value="${escHtml(ccm)}">
      <label for="token">GP1-Token</label>
      <input type="password" id="token" name="token" autofocus autocomplete="off" required>
      <p class="error">Ungültiger Token. Bitte erneut versuchen.</p>
      <button type="submit">Anmelden</button>
    </form>
  </div>
</body>
</html>`;
          return new Response(html, { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } });
        }

        // Token korrekt → Auth-Code generieren und in KV speichern (TTL 5 min)
        const code = crypto.randomUUID();
        await env.CONFIG.put(
          `oauth_code:${code}`,
          JSON.stringify({ redirect_uri: redir, code_challenge: cc, code_challenge_method: ccm }),
          { expirationTtl: 300 },
        );

        const redirectUrl = new URL(redir);
        redirectUrl.searchParams.set("code", code);
        if (st) redirectUrl.searchParams.set("state", st);
        return Response.redirect(redirectUrl.toString(), 302);
      }
    }

    // ----------------------------------------------------------------
    // Token Endpoint — Auth-Code → Access Token
    // ----------------------------------------------------------------
    if (url.pathname === "/oauth/token" && request.method === "POST") {
      if (!env.GP1_TOKEN) {
        return Response.json({ error: "server_error" }, { status: 500 });
      }

      let params: Record<string, string> = {};
      const ct = request.headers.get("Content-Type") ?? "";
      if (ct.includes("application/json")) {
        const json = await request.json().catch(() => ({}));
        params = json as Record<string, string>;
      } else {
        const fd = await request.formData().catch(() => new FormData());
        fd.forEach((v, k) => { params[k] = v as string; });
      }

      if (params.grant_type !== "authorization_code") {
        return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
      }

      const code = params.code ?? "";
      const storedRaw = await env.CONFIG.get(`oauth_code:${code}`, "text");
      if (!storedRaw) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }

      const stored = JSON.parse(storedRaw) as {
        redirect_uri: string;
        code_challenge: string;
        code_challenge_method: string;
      };

      // PKCE-Verifikation (wenn code_challenge gesetzt)
      if (stored.code_challenge) {
        const verifier = params.code_verifier ?? "";
        const ok = await verifiyPkce(verifier, stored.code_challenge, stored.code_challenge_method);
        if (!ok) {
          return Response.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, { status: 400 });
        }
      }

      await env.CONFIG.delete(`oauth_code:${code}`);

      return Response.json({
        access_token: env.GP1_TOKEN,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }

    // ----------------------------------------------------------------
    // MCP-Endpunkt → McpAgent (Durable Objects)
    // ----------------------------------------------------------------
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      // Auth Guard — nur aktiv wenn GP1_TOKEN gesetzt
      if (env.GP1_TOKEN) {
        const auth = request.headers.get("Authorization") ?? "";
        if (auth !== `Bearer ${env.GP1_TOKEN}`) {
          return new Response(
            JSON.stringify({ error: "Unauthorized" }),
            {
              status: 401,
              headers: {
                "Content-Type": "application/json",
                "WWW-Authenticate": `Bearer realm="${origin}"`,
                ...corsHeaders(),
              },
            },
          );
        }
      }

      // Rate-Limiting: max. 60 Requests/Minute pro IP
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
              ...corsHeaders(),
            },
          },
        );
      }

      // MCP-Request durchleiten + CORS-Header anhängen
      const mcpResponse = await RAGSourceMCPv2.serve("/mcp").fetch(request, env, ctx);
      const headers = new Headers(mcpResponse.headers);
      Object.entries(corsHeaders()).forEach(([k, v]) => headers.set(k, v));
      return new Response(mcpResponse.body, {
        status: mcpResponse.status,
        statusText: mcpResponse.statusText,
        headers,
      });
    }

    // ----------------------------------------------------------------
    // REST-Endpunkte → Hono
    // ----------------------------------------------------------------
    const app = createApp();
    return app.fetch(request, env, ctx);
  },
};
