# ChatGPT App-Directory — Umsetzungsplan & Status

> Stand: 2026-05-17 · Branch: `feature/chatgpt-app`
> **Code AP1–AP4 abgeschlossen, alle 3 Worker deployed, Custom Domains live, in ChatGPT validiert.**
> Geo-Default + Multi-ARS-Override im Live-Test bestätigt. Offen: nur noch die Submission (manuell).

RAGSource wird als **ChatGPT App** (Apps SDK, MCP) ins App-Directory gebracht —
One-Click-Install, kein Developer Mode, voller agentischer Flow. Drei Marken-Apps
auf gemeinsamem Core:

| App | Host | Tenancy | Profil |
|---|---|---|---|
| amtsschimmel | `app.amtsschimmel.ai` | amtsschimmel | `amtsschimmel-app` |
| brandmeister | `app.brandmeister.ai` | brandmeister | `brandmeister-app` |
| paragrafenreiter | `app.paragrafenreiter.ai` | all | `paragrafenreiter-app` |

Die `mcp.*`-Endpoints (No-Auth, Claude/Embedding) bleiben dauerhaft bestehen.

## Architekturentscheidungen

- **Ziel = App-Directory** (Apps SDK), nicht GPT Actions, nicht Connector. Nur die
  App behält den vollen Flow (`catalog/toc/get/query`).
- **Ein Core + dünne Profile.** `EndpointProfile` ist ein pures Datenobjekt; ein
  neues Frontend = ein Profil + ein wrangler-Env. Profil ≠ Tenancy entkoppelt
  (`HostConfig {tenancy, profile}`): App zeigt Marken-Content, trägt eigenes Profil.
- **Gemeinde-Auswahl beim Verbinden** über die OAuth-Authorize-Seite (passwortloser
  Modus `OAUTH_PUBLIC`, Live-Autocomplete-Picker). ARS wird an den Token gebunden,
  als `?geo=`-Default injiziert; explizites Tool-`geo` überschreibt (Multi-ARS).
- **Verhalten reist server-seitig:** kompakter Betriebskontrakt (`operating_rules`,
  erste Catalog-Antwort pro Session) + imperative Tool-Descriptions. Kein
  nutzerseitiger Systemprompt mehr.

## Umgesetzt (Code)

| AP | Inhalt | Status |
|---|---|---|
| AP1 | OAuth-Geo-Bindung, Geo-Picker, `handleGeoSearch`, Token-Rate-Limiter | ✅ |
| AP2 | `operatingRules` im Endpoint-Profil, Auslieferung erste Catalog-Antwort | ✅ |
| AP3 | Tool-Descriptions imperativ, `structuredContent`, Profil-Modul, Snapshot-Test | ✅ |
| AP4 | 3 App-Profile + 3 Betriebskontrakte, `wrangler.jsonc`-Envs, `deploy.yml`, brand-aware Picker | ✅ |

Geänderte Dateien: `src/engine/endpoint-profiles.ts` (neu), `src/oauth.ts`,
`src/index.ts`, `src/mcp.ts`, `src/types.ts`, `wrangler.jsonc`,
`.github/workflows/deploy.yml`, `src/engine/endpoint-profiles.test.ts` (neu).
Typecheck sauber, 93 Tests grün.

## Offen — Deployment & Submission (manuell, pro Marke)

1. **OpenAI-Organisation „RAGSource"** anlegen + verifizieren — einmalig, Publisher
   aller drei Apps. Langer Vorlauf.
2. **Deploy:** `wrangler deploy --env app-amtsschimmel` (bzw. `-brandmeister` /
   `-paragrafenreiter`). Läuft auch automatisch via `deploy.yml` bei Merge nach `main`.
3. **Cloudflare Custom Domains** im Dashboard zuweisen:
   - `ragsource-api-v2-app-amtsschimmel` → `app.amtsschimmel.ai`
   - `ragsource-api-v2-app-brandmeister` → `app.brandmeister.ai`
   - `ragsource-api-v2-app-paragrafenreiter` → `app.paragrafenreiter.ai`
4. **Test** je App im ChatGPT Dev Mode (URL `https://app.<marke>.ai/mcp`, Auth OAuth).
5. **Datenschutz-URL** je Marke sicherstellen; **Logo** je Marke (PNG ≥128 px).
6. **Submission** je App über das OpenAI-Dashboard — sequenziell, amtsschimmel zuerst.

## Out of Scope

UI-Komponenten · `search`/`fetch`-Connector · Sticky-Geo-Switch.
