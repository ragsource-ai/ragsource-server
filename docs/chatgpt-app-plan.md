# Umsetzungsplan: ChatGPT App `app.amtsschimmel.ai`

> Stand: 2026-05-17 · Repo: `ragsource-server` · Branch: `feature/chatgpt-app`
> Ziel: RAGSource als ChatGPT App ins App-Directory bringen — One-Click-Install,
> kein Developer Mode, voller agentischer Flow.

---

## 1. Hintergrund & getroffene Entscheidungen

**Ausgangslage:** RAGSource ist bereits ein MCP-Server (Streamable HTTP, Cloudflare
Workers). ChatGPT konsumiert seit der Apps-SDK-Einführung dasselbe Protokoll.

**Kernentscheidungen:**

- **Ziel = ChatGPT App-Directory** (Apps SDK), nicht GPT Actions, nicht Connector.
  Nur die App behält den vollen agentischen Flow (`catalog/toc/get/query`) — der
  `search`/`fetch`-Zwang gilt nur für Connector-/Deep-Research-Standardmodus.
- **Dev-Mode-Connector skaliert nicht** (Plus-Abo + „ERHÖHTES RISIKO"-Toggle pro
  Nutzer) — nur als Tester-Werkzeug brauchbar. Directory-Listing = echter One-Click.
- **Eigener Host `app.amtsschimmel.ai`**, Endpoint-Slug `app` (neutral — bedient
  perspektivisch auch Claude). `mcp.amtsschimmel.ai` bleibt **dauerhaft** als
  No-Auth-/Legacy-/Embedding-Pfad bestehen — installierte Connectors nie brechen.
- **Gemeinde-Auswahl beim Verbinden** über die OAuth-Authorize-Seite (Live-
  Autocomplete-Picker). Der gewählte ARS wird an den Token gebunden.
- **Systemprompt wird nicht mehr an Nutzer ausgeliefert** — kein Slot in einer
  Directory-App. Verhalten reist server-seitig mit: kompakter Betriebskontrakt +
  Tool-Descriptions.
- **`search`/`fetch`** = optional, frühestens nach Directory-Launch.

## 2. Architekturprinzip — ein Core, dünne Profile

Es entstehen **keine zwei Produkte**, sondern ein Core + Delivery-Profile:

| Schicht | Datei | Legt fest |
|---|---|---|
| Deployment | `wrangler.jsonc` env | Host, D1-Bindings, `OAUTH_PUBLIC`/`ACCESS_TOKEN`, Rate-Limiter-Namespace |
| Routing | `ENDPOINT_BY_HOST` (`mcp.ts:279`) | Host → Endpoint-Slug |
| Frontend-Profil | `ENDPOINT_PROFILES` (`mcp.ts:318`) | **Pures Datenobjekt:** `systemMessage`, `contactMail`, `operatingRules`, optional `toolDescriptionOverride` — null Logik |
| Core-Verhalten | `mcp.ts`-Funktionen | Catalog-Response, Tool-Descriptions, `INSTRUCTIONS` — einmalig, profil-parametrisiert |
| Core-Mechanik | `oauth.ts` / `index.ts` | Geo-Picker, Token-Geo-Bindung, Auth-Guard, Geo-Injection, Limiter-Keying |

**Ein neues Frontend = ein Profil-Eintrag + ein wrangler-Env. Null Core-Code.**

Descriptions/Instructions sind heute bereits 100 % Core. Eine **geteilte** imperative
`INSTRUCTIONS` + **ein** geteilter geschärfter Description-Satz bedienen Claude und
ChatGPT (kurz/imperativ schadet Claude nicht). Kein Endpoint-Split. Einzige echte
Profil-Erweiterung: `operatingRules`.

## 3. Geo-Modell

Drei Ebenen, klar getrennt:

- **Per-Call-Override** (existiert, `mcp.ts:613` `effectiveGeo = geoInput ?? _currentGeo`):
  Tool-Argument `geo` gewinnt → Multi-ARS-Fähigkeit. Keine Änderung nötig.
- **Default** = `_currentGeo`, gefüttert aus URL-`?geo=` (No-Auth) **oder** aus dem
  OAuth-Token (App). Beide Wege münden in denselben Slot — DO-Geo-Logik bleibt
  unverändert, Abw-Kompatibilität strukturell garantiert.
- **Sticky-Switch** (server-seitig gemerkt) — bewusst NICHT gebaut; DO hält
  `_currentGeo` aber mutabel, also jederzeit nachrüstbar.

Der Token bindet den Default, **nicht** die erlaubte Reichweite — explizites `geo`
nie gegen den Token validieren.

---

## AP0 — Vorbereitung (parallel, kein Code)

- [ ] **OpenAI-Developer-Account** anlegen + verifizieren — Blocker für AP4, früh starten.
- [ ] CF: DNS für `app.amtsschimmel.ai` bereitstellen (Custom-Domain-Zuweisung nach erstem Deploy).
- [ ] Datenschutz-URL auf amtsschimmel.ai notieren (existiert) — für Submission.

## AP1 — Core: OAuth-Geo-Bindung + Rate-Limiter (~2 Tage)

- [ ] `types.ts`: `OAUTH_PUBLIC?: string` ergänzen (entkoppelt OAuth-Aktivierung vom Passwort).
- [ ] `oauth.ts`:
  - [ ] `OAuthCode` um `geo: string` erweitern; Token-KV-Wert `"1"` → `JSON.stringify({ geo })`.
  - [ ] `loginHtml()` → `pickerHtml()`: Live-Autocomplete-Geo-Feld, Hidden-Field hält gewählten ARS.
  - [ ] Neuer Handler `handleGeoSearch()` → `GET /oauth/geo-search?q=` → JSON `[{name, ars, level}]`
        aus `geo_aliases` (LIKE, Limit 10). Picker = Geo, nicht nur Gemeinde (Kreis/Verband/Land mitwählbar).
  - [ ] POST: ARS via `resolveGeo()` validieren → in `OAuthCode`. Passwortprüfung nur im
        `ACCESS_TOKEN`-Modus; bei `OAUTH_PUBLIC` entfällt sie.
  - [ ] `handleToken`: `geo` in den Token-KV-Wert übernehmen.
  - [ ] `validateBearer()`: Rückgabe `boolean` → `{ valid, geo }`.
- [ ] `index.ts`:
  - [ ] OAuth-Endpunkte + `/oauth/geo-search` aktiv bei `ACCESS_TOKEN || OAUTH_PUBLIC`.
  - [ ] Auth-Guard: gültiger Token mit geo → Request-URL klonen, `?geo=<ARS>` setzen, weiterreichen.
  - [ ] Rate-Limiter-Key: `token ?? CF-Connecting-IP` (ChatGPT bündelt über wenige OpenAI-IPs).
- [ ] DO-Geo-Logik (`mcp.ts`): **keine Änderung**.

**Done:** OAuth-Flow liefert geo-gebundenen Token; Call ohne `geo` nutzt Token-ARS,
mit explizitem `geo` überschreibt.

## AP2 — Core: operatingRules (~0,5 Tag)

- [ ] `EndpointProfile` + Feld `operatingRules?: string` (reines Datenfeld).
- [ ] Core-Konstante `OPERATING_RULES_KOMMUNAL` — ≤ 400 Tokens, imperativ-nummeriert,
      kein Fließtext/Rationale. Destilliert aus `src/prompts/masterprompt-amtsschimmel.md`
      (bleibt redaktionelle Quelle). Richtung:
  1. Immer zuerst RAGSource_catalog. Keine Rechtsaussage ohne Catalog.
  2. Nur §§ zitieren, deren Wortlaut per RAGSource_get geladen wurde.
  3. Schlussfolgerungen als „Einschätzung" markieren — kein Zitat.
  4. Fehlende Quellenlage offen benennen, nie still mit Allgemeinwissen füllen.
  5. Kommunale/spezifische Quellen vor allgemeinen priorisieren.
  6. Für eine andere Gemeinde den geo-Parameter explizit übergeben.
- [ ] Catalog-Tool: wenn `operatingRules` gesetzt **und** DO-Flag `_rulesSent` false →
      Feld `operating_rules` in die Response, Flag setzen (nur erster Catalog-Call pro Session).
- [ ] `INSTRUCTIONS` (`mcp.ts:249`) auf kurze imperative Fassung straffen (eine, geteilt;
      Inhalt unverändert: Workflow + Säule 1/2 + Normhierarchie).

## AP3 — Core: Tool-Descriptions schärfen (~1 Tag)

- [ ] Descriptions `catalog`/`toc`/`get`/`query` (`mcp.ts:571/792/889/1071`) imperativ
      überarbeiten: MUST/ALWAYS, Routing-Logik, Wann-nicht. Bleiben Core, geteilt.
- [ ] `EndpointProfile`: optionales `toolDescriptionOverride` als Reserve definieren,
      **leer lassen**.
- [ ] Apps-SDK-Output prüfen: liefern Tool-Rückgaben `structuredContent`? Ggf. ergänzen.

**Refactor-Disziplin (AP2+AP3):** `EndpointProfile` bleibt logikfrei. Bestehende
Profile (`amtsschimmel`/`brandmeister`/`all`/`default`) müssen identischen Output
liefern → **Snapshot-Test** ergänzen (Muster: `src/engine/extensions.test.ts`).

## AP4 — Profil, Deployment, Submission (~0,5 Tag + Review)

- [ ] `mcp.ts`: `ENDPOINT_BY_HOST` + `"app.amtsschimmel.ai": "app"`;
      `ENDPOINT_PROFILES["app"]` (amtsschimmel-Branding + `operatingRules`).
- [ ] `wrangler.jsonc`: Env `app` — amtsschimmel-Bindings, `vars: { OAUTH_PUBLIC: "true" }`,
      Rate-Limiter `namespace_id: 1007`.
- [ ] `wrangler deploy --env app` → CF Custom Domain `app.amtsschimmel.ai` zuweisen.
- [ ] Submission-Paket: Logo (PNG ≥ 128 px), Screenshots, Test-Prompts, Beschreibung in
      Nutzersprache (*„Fragen Sie Ihre Gemeindeordnung direkt in ChatGPT"*),
      Datenschutz-URL, Firmeninfo → Dashboard-Review.

## Test-Phase (vor Submission)

- [ ] `app.amtsschimmel.ai` im ChatGPT Dev Mode verbinden.
- [ ] Picker: Autocomplete, Auswahl Bad Boll, Mehrdeutigkeit, Nicht-gefunden.
- [ ] Geo: Frage ohne `geo` → Bad-Boll-Quellen; „…in Ulm" → Ulm-Quellen (Multi-ARS).
- [ ] Instruction-Following: catalog-zuerst, Säule-1-Pflicht.
- [ ] Claude-Regression: `mcp.amtsschimmel.ai` unverändert.

---

## Sequencing & Aufwand

AP0 sofort parallel · AP1 → AP2 + AP3 (parallel) → Test → AP4.
**Code gesamt ~3,5–4 Tage** + externe Review-Wartezeit.

## Risiken

1. Refactor-Regression bei Profilen → Snapshot-Test fängt es.
2. GPT-5 Instruction-Following schwächer als Claude → Dev-Mode-Test ist der Prüfstein,
   ggf. Descriptions nachschärfen.
3. Review-Dauer extern, nicht steuerbar.

## Out of Scope

UI-Komponenten · `search`/`fetch` · Sticky-Geo-Switch · Claude-Migration auf `app.`
(später, eigener Vorgang).
