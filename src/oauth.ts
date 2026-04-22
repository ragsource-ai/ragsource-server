/**
 * Minimaler OAuth 2.0 Authorization Server für GP1-Deployments.
 *
 * Implementiert den Authorization Code Flow mit PKCE (RFC 7636),
 * Dynamic Client Registration (RFC 7591) und Server Metadata (RFC 8414).
 *
 * Aktiviert sich nur wenn ACCESS_TOKEN gesetzt ist.
 * "Passwort" = der ACCESS_TOKEN-Wert. User gibt ihn auf der /authorize-Seite ein.
 * Ausgestellte Access Tokens werden in KV gespeichert (TTL 1 Jahr).
 *
 * KV-Keys (CONFIG-Namespace):
 *   oauth:client:{clientId}  → OAuthClient (kein TTL)
 *   oauth:code:{code}        → OAuthCode (TTL 600s)
 *   oauth:token:{token}      → "1" (TTL 365 Tage)
 */

import type { Env } from "./types.js";

// -----------------------------------------------------------------------
// Typen
// -----------------------------------------------------------------------

interface OAuthClient {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
}

interface OAuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  expiresAt: number;
}

// -----------------------------------------------------------------------
// Hilfsfunktionen
// -----------------------------------------------------------------------

function randomHex(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyPKCE(verifier: string, challenge: string, method: string): Promise<boolean> {
  if (method === "plain") return verifier === challenge;
  // S256: BASE64URL(SHA256(verifier)) == challenge
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const base64url = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  return base64url === challenge;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// -----------------------------------------------------------------------
// Protected Resource Metadata (RFC 9728)
// Wird von Claude Web zur OAuth-Discovery genutzt.
// -----------------------------------------------------------------------

export function handleProtectedResourceMetadata(request: Request): Response {
  const base = new URL(request.url).origin;
  return json({
    resource: base,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    resource_documentation: `${base}/api/health`,
  });
}

// -----------------------------------------------------------------------
// Authorization Server Metadata (RFC 8414)
// -----------------------------------------------------------------------

export function handleOAuthMetadata(request: Request): Response {
  const base = new URL(request.url).origin;
  return json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256", "plain"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}

// -----------------------------------------------------------------------
// Dynamic Client Registration (RFC 7591)
// -----------------------------------------------------------------------

export async function handleClientRegistration(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_request", error_description: "Invalid JSON" }, 400);
  }

  const redirectUris = (body.redirect_uris as string[] | undefined) ?? [];
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return json({ error: "invalid_redirect_uri" }, 400);
  }

  const clientId = randomHex(16);
  const client: OAuthClient = {
    clientId,
    redirectUris,
    clientName: (body.client_name as string | undefined) ?? undefined,
  };
  await env.CONFIG.put(`oauth:client:${clientId}`, JSON.stringify(client));

  return json({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: redirectUris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }, 201);
}

// -----------------------------------------------------------------------
// Authorization Endpoint
// GET  /oauth/authorize → Login-Formular anzeigen
// POST /oauth/authorize → Zugangscode prüfen, Redirect mit Code
// -----------------------------------------------------------------------

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET") {
    // Parameter aus Query holen und ins Formular einbetten
    const clientId = url.searchParams.get("client_id") ?? "";
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const codeChallenge = url.searchParams.get("code_challenge") ?? "";
    const codeChallengeMethod = url.searchParams.get("code_challenge_method") ?? "S256";
    const error = url.searchParams.get("error") ?? "";

    // Client validieren
    const clientJson = await env.CONFIG.get(`oauth:client:${clientId}`);
    if (!clientJson) {
      return new Response("Ungültiger Client.", { status: 400 });
    }
    const client = JSON.parse(clientJson) as OAuthClient;
    if (!client.redirectUris.includes(redirectUri)) {
      return new Response("Ungültige Redirect URI.", { status: 400 });
    }

    return new Response(loginHtml({ clientId, redirectUri, state, codeChallenge, codeChallengeMethod, error }), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (request.method === "POST") {
    const form = await request.formData();
    const clientId = form.get("client_id") as string;
    const redirectUri = form.get("redirect_uri") as string;
    const state = form.get("state") as string;
    const codeChallenge = form.get("code_challenge") as string;
    const codeChallengeMethod = (form.get("code_challenge_method") as string) ?? "S256";
    const password = form.get("password") as string;

    // Zugangscode prüfen
    if (!env.ACCESS_TOKEN || password !== env.ACCESS_TOKEN) {
      // Zurück zum Formular mit Fehler
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: codeChallengeMethod,
        error: "1",
      });
      return Response.redirect(`${new URL(request.url).origin}/oauth/authorize?${params}`, 302);
    }

    // Auth-Code ausstellen (TTL 10 min)
    const code = randomHex(32);
    const oauthCode: OAuthCode = {
      clientId,
      redirectUri,
      codeChallenge: codeChallenge || undefined,
      codeChallengeMethod: codeChallengeMethod || undefined,
      expiresAt: Date.now() + 600_000,
    };
    await env.CONFIG.put(`oauth:code:${code}`, JSON.stringify(oauthCode), { expirationTtl: 600 });

    // Redirect zum Client mit Code
    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", code);
    if (state) redirect.searchParams.set("state", state);
    return Response.redirect(redirect.toString(), 302);
  }

  return json({ error: "method_not_allowed" }, 405);
}

// -----------------------------------------------------------------------
// Token Endpoint
// POST /oauth/token → Code gegen Access Token tauschen
// -----------------------------------------------------------------------

export async function handleToken(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  let params: URLSearchParams;
  const ct = request.headers.get("Content-Type") ?? "";
  if (ct.includes("application/json")) {
    const body = (await request.json()) as Record<string, string>;
    params = new URLSearchParams(body as Record<string, string>);
  } else {
    params = new URLSearchParams(await request.text());
  }

  const grantType = params.get("grant_type");
  if (grantType !== "authorization_code") {
    return json({ error: "unsupported_grant_type" }, 400);
  }

  const code = params.get("code");
  const redirectUri = params.get("redirect_uri");
  const codeVerifier = params.get("code_verifier");

  if (!code) return json({ error: "invalid_request", error_description: "missing code" }, 400);

  // Code aus KV laden
  const codeJson = await env.CONFIG.get(`oauth:code:${code}`);
  if (!codeJson) return json({ error: "invalid_grant", error_description: "Code ungültig oder abgelaufen" }, 400);

  const oauthCode = JSON.parse(codeJson) as OAuthCode;
  await env.CONFIG.delete(`oauth:code:${code}`); // einmalig verwendbar

  // Ablaufzeit prüfen
  if (Date.now() > oauthCode.expiresAt) {
    return json({ error: "invalid_grant", error_description: "Code abgelaufen" }, 400);
  }

  // Redirect URI prüfen
  if (redirectUri && redirectUri !== oauthCode.redirectUri) {
    return json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
  }

  // PKCE prüfen
  if (oauthCode.codeChallenge) {
    if (!codeVerifier) {
      return json({ error: "invalid_grant", error_description: "code_verifier fehlt" }, 400);
    }
    const ok = await verifyPKCE(codeVerifier, oauthCode.codeChallenge, oauthCode.codeChallengeMethod ?? "S256");
    if (!ok) {
      return json({ error: "invalid_grant", error_description: "PKCE-Verifikation fehlgeschlagen" }, 400);
    }
  }

  // Access Token ausstellen (TTL 1 Jahr)
  const accessToken = randomHex(32);
  const ttl = 365 * 24 * 3600;
  await env.CONFIG.put(`oauth:token:${accessToken}`, "1", { expirationTtl: ttl });

  return json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ttl,
  });
}

// -----------------------------------------------------------------------
// Token validieren (in index.ts verwendet)
// Akzeptiert: statischen ACCESS_TOKEN ODER KV-gespeicherten OAuth-Token
// -----------------------------------------------------------------------

export async function validateBearer(authHeader: string, env: Env): Promise<boolean> {
  if (!authHeader.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7);

  // Statischer Token (Fallback / direkte API-Nutzung)
  if (token === env.ACCESS_TOKEN) return true;

  // OAuth-Token aus KV
  const val = await env.CONFIG.get(`oauth:token:${token}`);
  return val === "1";
}

// -----------------------------------------------------------------------
// Login-HTML
// -----------------------------------------------------------------------

function loginHtml(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  error: string;
}): string {
  const { clientId, redirectUri, state, codeChallenge, codeChallengeMethod, error } = params;

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Brandmeister GP1 – Zugang</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f4f4f5;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1rem;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 2px 16px rgba(0,0,0,.1);
      padding: 2rem;
      width: 100%;
      max-width: 380px;
    }
    .logo {
      font-size: 1.5rem;
      font-weight: 700;
      color: #c0392b;
      margin-bottom: 0.25rem;
    }
    .subtitle {
      font-size: 0.875rem;
      color: #71717a;
      margin-bottom: 1.5rem;
    }
    label {
      display: block;
      font-size: 0.875rem;
      font-weight: 500;
      color: #3f3f46;
      margin-bottom: 0.4rem;
    }
    input[type="password"] {
      width: 100%;
      padding: 0.6rem 0.75rem;
      border: 1px solid #d4d4d8;
      border-radius: 8px;
      font-size: 1rem;
      outline: none;
      transition: border-color .15s;
    }
    input[type="password"]:focus { border-color: #c0392b; }
    .error {
      font-size: 0.8rem;
      color: #c0392b;
      margin-top: 0.4rem;
    }
    button {
      margin-top: 1.25rem;
      width: 100%;
      padding: 0.65rem;
      background: #c0392b;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: background .15s;
    }
    button:hover { background: #a93226; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">🔥 Brandmeister GP1</div>
    <div class="subtitle">Kreisbrandmeister – Geschützter Bereich</div>

    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${esc(clientId)}">
      <input type="hidden" name="redirect_uri" value="${esc(redirectUri)}">
      <input type="hidden" name="state" value="${esc(state)}">
      <input type="hidden" name="code_challenge" value="${esc(codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="${esc(codeChallengeMethod)}">

      <label for="password">Zugangscode</label>
      <input type="password" id="password" name="password" autofocus autocomplete="current-password" placeholder="••••••••••••">
      ${error ? '<p class="error">Ungültiger Zugangscode. Bitte erneut versuchen.</p>' : ""}

      <button type="submit">Zugang freischalten</button>
    </form>
  </div>
</body>
</html>`;
}

/** Minimales HTML-Escaping für Formular-Attribute */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
