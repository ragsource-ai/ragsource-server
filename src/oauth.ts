/**
 * OAuth 2.0 Authorization Server für authentifizierte Deployments.
 *
 * Implementiert den Authorization Code Flow mit PKCE (RFC 7636),
 * Dynamic Client Registration (RFC 7591) und Server Metadata (RFC 8414).
 *
 * Zwei Betriebsmodi (aktiviert sich, sobald ACCESS_TOKEN ODER OAUTH_PUBLIC gesetzt ist):
 *
 *  (a) ACCESS_TOKEN gesetzt  → Passwort-Modus (GP1).
 *      Die /authorize-Seite zeigt ein Login-Formular; "Passwort" = der ACCESS_TOKEN-Wert.
 *      Ausgestellte Tokens tragen keine Geo-Bindung.
 *
 *  (b) OAUTH_PUBLIC = "true" → passwortloser Geo-Picker-Modus (App-Directory).
 *      Die /authorize-Seite ist ein Gemeinde-Picker mit Autocomplete. Der gewählte
 *      ARS wird an den ausgestellten Token gebunden und auf jedem MCP-Request als
 *      Geo-Default verwendet (siehe index.ts).
 *
 * Ausgestellte Access Tokens werden in KV gespeichert (TTL 1 Jahr).
 *
 * KV-Keys (CONFIG-Namespace):
 *   oauth:client:{clientId}  → OAuthClient (kein TTL)
 *   oauth:code:{code}        → OAuthCode (TTL 600s)
 *   oauth:token:{token}      → {"geo": "<ARS>"|null} (TTL 365 Tage)
 */

import type { Env } from "./types.js";
import { resolveGeo, suggestGeo, searchByName, type GeoCandidate } from "./engine/normalize.js";
import { resolveHostConfig, getEndpointProfile } from "./engine/endpoint-profiles.js";

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
  /** An den späteren Token gebundener ARS (nur Geo-Picker-Modus), sonst null. */
  geo: string | null;
  expiresAt: number;
}

/** Ergebnis der Token-Prüfung: gültig + ggf. gebundener Geo-ARS. */
export interface BearerValidation {
  valid: boolean;
  geo: string | null;
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

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/** True, wenn der passwortlose Geo-Picker-Modus aktiv ist. */
function isPublicMode(env: Env): boolean {
  return env.OAUTH_PUBLIC === "true";
}

/** Branding der Geo-Picker-Seite. */
interface PickerBranding {
  name: string;
  subtitle: string;
  accent: string;
}

/** Ermittelt das Picker-Branding aus dem Host (über das Endpoint-Profil). */
function pickerBrandingFor(hostname: string): PickerBranding {
  const profile = getEndpointProfile(resolveHostConfig(hostname)?.profile);
  return profile.pickerBranding ?? {
    name: "RAGSource",
    subtitle: "Zitiersichere Rechtsrecherche",
    accent: "#1e3a5f",
  };
}

// -----------------------------------------------------------------------
// Protected Resource Metadata (RFC 9728)
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
// Geo-Suche für den Picker-Autocomplete
// GET /oauth/geo-search?q=...  → { results: [{ ars, name, kreis, level }] }
// -----------------------------------------------------------------------

export async function handleGeoSearch(request: Request, env: Env): Promise<Response> {
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 80);
  if (q.length < 2) return json({ results: [] });

  // Dieselbe Mehr-Ebenen-Suche wie der Backend-Resolver (resolveGeo nutzt
  // searchByName intern): Gemeinde, Landkreis, Verband UND Land. So sind
  // Picker-Autocomplete und Geo-Auflösung per Konstruktion deckungsgleich.
  const candidates = await searchByName(q, env.DB);
  const results = candidates.slice(0, 10).map((c) => ({
    ars: c.ars,
    name: c.name,
    kreis: c.kreis,
    level: c.typ,
  }));
  return json({ results });
}

// -----------------------------------------------------------------------
// Authorization Endpoint
// GET  /oauth/authorize → Picker (public) bzw. Login-Formular (Passwort-Modus)
// POST /oauth/authorize → Geo auflösen bzw. Passwort prüfen, Redirect mit Code
// -----------------------------------------------------------------------

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const publicMode = isPublicMode(env);

  if (request.method === "GET") {
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

    const formParams = { clientId, redirectUri, state, codeChallenge, codeChallengeMethod };
    if (publicMode) {
      return htmlResponse(pickerHtml({ ...formParams, branding: pickerBrandingFor(url.hostname) }));
    }
    return htmlResponse(loginHtml({ ...formParams, error }));
  }

  if (request.method === "POST") {
    const form = await request.formData();
    const clientId = form.get("client_id") as string;
    const redirectUri = form.get("redirect_uri") as string;
    const state = form.get("state") as string;
    const codeChallenge = form.get("code_challenge") as string;
    const codeChallengeMethod = (form.get("code_challenge_method") as string) ?? "S256";
    const formParams = { clientId, redirectUri, state, codeChallenge, codeChallengeMethod };

    let geo: string | null = null;

    if (publicMode) {
      // Geo-Picker-Modus: gewählten ARS bzw. Freitext auflösen.
      // geo_ars (Hidden-Field, aus Autocomplete/Kandidaten-Button) hat Vorrang
      // vor geo_input (Freitext).
      const branding = pickerBrandingFor(url.hostname);
      const rawGeo = ((form.get("geo_ars") as string) || (form.get("geo_input") as string) || "").trim();
      if (!rawGeo) {
        return htmlResponse(pickerHtml({ ...formParams, branding, error: "Bitte wählen Sie Ihre Gemeinde." }));
      }

      const resolved = await resolveGeo(rawGeo, env.DB);
      if (!resolved) {
        const sugg = await suggestGeo(rawGeo, env.DB, 6);
        return htmlResponse(pickerHtml({
          ...formParams,
          branding,
          error: `„${rawGeo}" wurde nicht gefunden. Bitte erneut versuchen.`,
          candidates: sugg,
        }));
      }
      if ("ambiguous" in resolved) {
        return htmlResponse(pickerHtml({
          ...formParams,
          branding,
          error: "Mehrere Treffer — bitte wählen Sie aus:",
          candidates: resolved.candidates,
        }));
      }

      geo = resolved.gemeinde_ars ?? resolved.verband_ars ?? resolved.kreis_ars ?? resolved.land_ars;
    } else {
      // Passwort-Modus (GP1): Zugangscode prüfen.
      const password = form.get("password") as string;
      if (!env.ACCESS_TOKEN || password !== env.ACCESS_TOKEN) {
        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          state,
          code_challenge: codeChallenge,
          code_challenge_method: codeChallengeMethod,
          error: "1",
        });
        return Response.redirect(`${url.origin}/oauth/authorize?${params}`, 302);
      }
    }

    // Auth-Code ausstellen (TTL 10 min)
    const code = randomHex(32);
    const oauthCode: OAuthCode = {
      clientId,
      redirectUri,
      codeChallenge: codeChallenge || undefined,
      codeChallengeMethod: codeChallengeMethod || undefined,
      geo,
      expiresAt: Date.now() + 600_000,
    };
    await env.CONFIG.put(`oauth:code:${code}`, JSON.stringify(oauthCode), { expirationTtl: 600 });

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

  // Access Token ausstellen (TTL 1 Jahr) — Geo-Bindung im Wert hinterlegt
  const accessToken = randomHex(32);
  const ttl = 365 * 24 * 3600;
  await env.CONFIG.put(
    `oauth:token:${accessToken}`,
    JSON.stringify({ geo: oauthCode.geo ?? null }),
    { expirationTtl: ttl },
  );

  return json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ttl,
  });
}

// -----------------------------------------------------------------------
// Token validieren (in index.ts verwendet)
// Akzeptiert: statischen ACCESS_TOKEN ODER KV-gespeicherten OAuth-Token.
// Liefert die an den Token gebundene Geo (ARS) zurück, falls vorhanden.
// -----------------------------------------------------------------------

export async function validateBearer(authHeader: string, env: Env): Promise<BearerValidation> {
  if (!authHeader.startsWith("Bearer ")) return { valid: false, geo: null };
  const token = authHeader.slice(7);

  // Statischer Token (Fallback / direkte API-Nutzung) — keine Geo-Bindung
  if (env.ACCESS_TOKEN && token === env.ACCESS_TOKEN) {
    return { valid: true, geo: null };
  }

  // OAuth-Token aus KV
  const val = await env.CONFIG.get(`oauth:token:${token}`);
  if (val === null) return { valid: false, geo: null };
  if (val === "1") return { valid: true, geo: null }; // Legacy-Format (vor Geo-Bindung)
  try {
    const data = JSON.parse(val) as { geo?: string | null };
    return { valid: true, geo: data.geo ?? null };
  } catch {
    return { valid: true, geo: null };
  }
}

// -----------------------------------------------------------------------
// Geo-Picker-HTML (passwortloser Modus — App-Directory)
// -----------------------------------------------------------------------

const GEO_LEVEL_LABEL: Record<string, string> = {
  gemeinde: "Gemeinde",
  verband: "Verband",
  kreis: "Landkreis",
  land: "Land",
};

function pickerHtml(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  branding: PickerBranding;
  error?: string;
  candidates?: GeoCandidate[];
}): string {
  const { clientId, redirectUri, state, codeChallenge, codeChallengeMethod, branding, error, candidates } = params;

  const candidatesHtml = (candidates && candidates.length > 0)
    ? `<div class="candidates">${candidates
        .map((c) => {
          const label = `${c.name}${c.kreis && c.kreis !== c.name ? " · " + c.kreis : ""}`;
          const badge = GEO_LEVEL_LABEL[c.typ] ?? c.typ;
          return `<button type="button" class="cand" onclick="pick('${esc(c.ars)}', '${esc(c.name).replace(/'/g, "\\'")}')">`
            + `<span>${esc(label)}</span><em>${esc(badge)}</em></button>`;
        })
        .join("")}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(branding.name)} – Gemeinde wählen</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #eef1f5;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; padding: 1rem;
    }
    .card {
      background: #fff; border-radius: 14px;
      box-shadow: 0 2px 20px rgba(0,0,0,.12);
      padding: 2rem; width: 100%; max-width: 420px;
    }
    .logo { font-size: 1.4rem; font-weight: 700; color: ${esc(branding.accent)}; }
    .subtitle { font-size: .875rem; color: #64748b; margin: .15rem 0 1.4rem; }
    label { display: block; font-size: .875rem; font-weight: 600; color: #334155; margin-bottom: .4rem; }
    .hint { font-size: .8rem; color: #64748b; margin-bottom: 1rem; }
    .field { position: relative; }
    input[type="text"] {
      width: 100%; padding: .65rem .8rem;
      border: 1px solid #cbd5e1; border-radius: 9px;
      font-size: 1rem; outline: none; transition: border-color .15s;
    }
    input[type="text"]:focus { border-color: ${esc(branding.accent)}; }
    .suggestions {
      position: absolute; left: 0; right: 0; top: calc(100% + 4px);
      background: #fff; border: 1px solid #cbd5e1; border-radius: 9px;
      box-shadow: 0 6px 18px rgba(0,0,0,.12); overflow: hidden; z-index: 10;
    }
    .suggestions:empty { display: none; }
    .sug { padding: .55rem .8rem; font-size: .95rem; cursor: pointer; }
    .sug:hover { background: #eef1f5; }
    .error { font-size: .85rem; color: #b91c1c; margin: .8rem 0 .2rem; }
    .candidates { display: flex; flex-direction: column; gap: .4rem; margin-top: .7rem; }
    .cand {
      display: flex; justify-content: space-between; align-items: center;
      padding: .55rem .8rem; background: #f1f5f9; border: 1px solid #e2e8f0;
      border-radius: 9px; font-size: .95rem; cursor: pointer; text-align: left;
    }
    .cand:hover { background: #e2e8f0; }
    .cand em { font-style: normal; font-size: .75rem; color: #64748b; }
    button.submit {
      margin-top: 1.3rem; width: 100%; padding: .7rem;
      background: ${esc(branding.accent)}; color: #fff; border: none; border-radius: 9px;
      font-size: 1rem; font-weight: 600; cursor: pointer; transition: filter .15s;
    }
    button.submit:hover { filter: brightness(0.92); }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">${esc(branding.name)}</div>
    <div class="subtitle">${esc(branding.subtitle)}</div>

    <form method="POST" action="/oauth/authorize" id="f" autocomplete="off">
      <input type="hidden" name="client_id" value="${esc(clientId)}">
      <input type="hidden" name="redirect_uri" value="${esc(redirectUri)}">
      <input type="hidden" name="state" value="${esc(state)}">
      <input type="hidden" name="code_challenge" value="${esc(codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="${esc(codeChallengeMethod)}">
      <input type="hidden" name="geo_ars" id="geo_ars" value="">

      <label for="geo_input">Ihre Gemeinde</label>
      <div class="hint">Geben Sie Ihre Gemeinde ein. Auch ein Landkreis, Verband oder Bundesland ist möglich.</div>
      <div class="field">
        <input type="text" name="geo_input" id="geo_input" placeholder="z. B. Bad Boll" autofocus autocomplete="off">
        <div class="suggestions" id="suggestions"></div>
      </div>
      ${error ? `<p class="error">${esc(error)}</p>` : ""}
      ${candidatesHtml}

      <button type="submit" class="submit">Verbinden</button>
    </form>
  </div>

  <script>
    var inp = document.getElementById('geo_input');
    var ars = document.getElementById('geo_ars');
    var box = document.getElementById('suggestions');
    var timer;
    inp.addEventListener('input', function () {
      ars.value = '';
      clearTimeout(timer);
      var q = inp.value.trim();
      if (q.length < 2) { box.innerHTML = ''; return; }
      timer = setTimeout(function () { search(q); }, 180);
    });
    function search(q) {
      fetch('/oauth/geo-search?q=' + encodeURIComponent(q))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          box.innerHTML = '';
          (d.results || []).forEach(function (it) {
            var el = document.createElement('div');
            el.className = 'sug';
            var lvl = { verband: 'Verband', kreis: 'Landkreis', land: 'Land' };
            var sub = it.level === 'gemeinde'
              ? (it.kreis && it.kreis !== it.name ? ' · ' + it.kreis : '')
              : ' · ' + (lvl[it.level] || it.level);
            el.textContent = it.name + sub;
            el.addEventListener('click', function () {
              inp.value = it.name; ars.value = it.ars; box.innerHTML = '';
            });
            box.appendChild(el);
          });
        })
        .catch(function () {});
    }
    function pick(a, n) {
      ars.value = a; inp.value = n;
      document.getElementById('f').submit();
    }
    document.addEventListener('click', function (e) {
      if (e.target !== inp) box.innerHTML = '';
    });
  </script>
</body>
</html>`;
}

// -----------------------------------------------------------------------
// Login-HTML (Passwort-Modus — GP1)
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

/** Minimales HTML-Escaping für Formular-Attribute und Texte */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
