# RAGSource Server v2

Cloudflare Worker mit D1 (SQLite + FTS5), der Rechtswissen und vertrauliche Dokumente als Agentic-RAG-System über MCP (Model Context Protocol) bereitstellt.

Eine Codebasis — beliebig viele isolierte Deployments, rein konfigurationsgetrieben.

---

## Live-Deployments

| Deployment | URL | Auth | Besonderheit |
|---|---|---|---|
| prod | `mcp.amtsschimmel.ai/mcp` | keins | Standard; alle 4 Tools |
| lean | `mcp-lean.amtsschimmel.ai/mcp` | keins | Kein `RAGSource_query` (`DISABLE_QUERY=true`) |
| paragrafenreiter | `mcp.paragrafenreiter.ai/mcp` | keins | Kein Tenancy-Filter (alle Quellen sichtbar) |
| brandmeister | `mcp.brandmeister.ai/mcp` | keins | Nur Feuerwehr-Quellen (Endpoint-Filter) |
| brandmeister-gp1 | `mcp-gp1.brandmeister.ai/mcp` | OAuth | Feuerwehr-Quellen + vertrauliche GP1-Inhalte (Dual-DB) |

Health-Check: `GET /api/health` (jeder Deployment)

---

## Architektur

```
LLM (Claude Web / Desktop)
    │
    └── MCP-Protokoll → POST /mcp
                             │
                    Cloudflare Worker (index.ts)
                    ├── OAuth-Endpunkte (bei GP1_TOKEN gesetzt)
                    ├── Auth Guard (Bearer / OAuth-Token)
                    ├── Rate Limiter (60 req/min pro IP)
                    └── McpAgent Durable Object (mcp.ts)
                              │
                    D1 Hauptdatenbank (ragsource-db-v2)
                    D1 GP1-Datenbank  (brandmeister-gp1, optional)
```

### Multi-Tenant-Prinzip

Drei Konfigurationsschalter unterscheiden alle Deployments — kein Code-Fork:

| Schalter | Mechanismus | Wirkung |
|---|---|---|
| Endpoint-Filter | `ENDPOINT_BY_HOST` in `mcp.ts` (Host → Endpoint-Slug) | Welche Quellen aus der Haupt-DB sichtbar sind |
| GP1-Datenbank | `DB_GP1`-Binding in `wrangler.jsonc` | Transparente Dual-DB: GP1-Inhalte werden ohne Markierung gemergt |
| GP1-Auth | `GP1_TOKEN` Wrangler-Secret | Aktiviert OAuth 2.0 Authorization Server + Auth Guard |

---

## Projektstruktur

```
ragsource-server/
├── src/
│   ├── index.ts        # Entry Point: OAuth-Endpunkte, Auth Guard, Rate Limit, Routing
│   ├── mcp.ts          # McpAgent Durable Object — 4 MCP-Tools, Dual-DB-Logik
│   ├── oauth.ts        # OAuth 2.0 Authorization Server (Authorization Code + PKCE)
│   ├── types.ts        # TypeScript-Typen (Env, DB-Entitäten, Tool-Rückgaben)
│   └── engine/
│       ├── normalize.ts  # Geo-Auflösung: geo-Parameter → ARS + Ebene
│       └── hierarchy.ts  # Normenhierarchie-Sortierung
├── scripts/
│   ├── build-db-v2.ts    # Markdown → D1 Build-Pipeline
│   ├── sql-utils.ts      # SQL-Escape + Concat-Tree (testbar)
│   └── sql-utils.test.ts # Unit-Tests
├── schema.sql            # D1-Schema (Tabellen, Indizes, FTS5, Trigger)
└── wrangler.jsonc        # Cloudflare-Konfiguration (alle Environments)
```

---

## MCP-Tools (Agentic RAG)

| Tool | Funktion |
|---|---|
| `RAGSource_catalog` | Pflichtaufruf: verfügbare Rechtsquellen für eine Gemeinde/Region |
| `RAGSource_toc` | Inhaltsverzeichnis einer oder mehrerer Quellen (Batch, max. 8) |
| `RAGSource_get` | Originalwortlaut spezifischer Paragraphen (max. 50 §§ pro Aufruf) |
| `RAGSource_query` | FTS5-Volltextsuche (Fallback; deaktivierbar mit `DISABLE_QUERY=true`) |

### Agentic Workflow

```
RAGSource_catalog(geo=...) → Quellen mit size_class
    ├── small  → RAGSource_get direkt
    └── medium/large → RAGSource_toc → RAGSource_get (gezielte §§)
```

### Catalog-Format

Kompaktes Array: `[id, titel, rechtsrang, size, toc_available, hint]`

| Feld | Typ | Bedeutung |
|---|---|---|
| `rechtsrang` | `0–6 \| null` | 0=EU, 1=Bund, 2=Land, 3=Kreis, 4=Verband, 5=Gemeinde, 6=Tarif |
| `size` | `S/M/L` | Basiert auf Token-Schätzung (S<3k, M<15k, L≥15k) |
| `toc_available` | bool | Ob TOC abrufbar ist |
| `hint` | string\|null | Kurzer Routing-Hinweis |

---

## Filter-Parameter

| Parameter | Typ | Beschreibung |
|---|---|---|
| `geo` | string | ARS oder Klarname. Länge bestimmt Ebene: `08`=Land, `08117`=Kreis, `081175009`=Verband, `081175009012`=Gemeinde. Nur-aufwärts: Verbands-Anfragen zeigen keine Gemeindequellen |
| `extensions` | string | Kommagetrennte Themen-Filter (z.B. `Feuerwehr,Arbeitsrecht`). Ohne Eintrag = immer sichtbar. Mehrere = OR |

Tenancy (Endpoint-Filter) wird automatisch aus dem `Host`-Header der Custom Domain abgeleitet:

```typescript
// src/mcp.ts
const ENDPOINT_BY_HOST: Record<string, string> = {
  "mcp.amtsschimmel.ai":      "amtsschimmel",
  "mcp-lean.amtsschimmel.ai": "amtsschimmel",
  "mcp.paragrafenreiter.ai":  "all",
  "mcp.brandmeister.ai":      "brandmeister",
  "mcp-gp1.brandmeister.ai":  "brandmeister",
};
```

`"all"` → kein Endpoint-Filter. Kein Eintrag (z.B. `workers.dev`) → kein Filter (Entwicklung).

---

## OAuth 2.0 (GP1-Deployments)

Aktiviert sich automatisch wenn `GP1_TOKEN` als Wrangler Secret gesetzt ist. Implementiert in `src/oauth.ts`.

### Endpunkte

| Endpunkt | Spec | Funktion |
|---|---|---|
| `GET /.well-known/oauth-protected-resource` | RFC 9728 | Resource Metadata — Claude Web Discovery |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 | Auth Server Metadata |
| `POST /oauth/register` | RFC 7591 | Dynamic Client Registration |
| `GET /oauth/authorize` | RFC 6749 | Login-Formular (Passwort = GP1_TOKEN) |
| `POST /oauth/authorize` | RFC 6749 | Token prüfen, Auth-Code ausstellen |
| `POST /oauth/token` | RFC 6749 | Auth-Code + PKCE → Access Token |

### Flow

1. Claude Web entdeckt `/.well-known/oauth-protected-resource` via `WWW-Authenticate`-Header (401)
2. Registriert sich dynamisch via `/oauth/register`
3. Öffnet `/oauth/authorize` → Nutzer gibt GP1_TOKEN ein
4. Worker stellt OAuth Access Token aus (TTL 1 Jahr, gespeichert in KV)
5. Claude Web verwendet OAuth-Token als Bearer für alle MCP-Requests

### Auth Guard

Akzeptiert zwei Token-Arten:
- **Statischer GP1_TOKEN** — für Claude Desktop, API-Direktzugriff
- **KV-gespeicherter OAuth-Token** — für Claude Web

KV-Keys (CONFIG-Namespace): `oauth:client:{id}`, `oauth:code:{code}` (TTL 600s), `oauth:token:{token}` (TTL 1 Jahr).

### Token rotieren

```bash
wrangler secret put GP1_TOKEN --env brandmeister-gp1
wrangler deploy --env brandmeister-gp1
```

Alte KV-OAuth-Tokens werden beim nächsten MCP-Request mit neuem Login ungültig (statischer Token ändert sich).

---

## Dual-DB (GP1)

Wenn `DB_GP1` gebunden ist, mergt der Worker beide Datenbanken transparent:

| Tool | Verhalten |
|---|---|
| `RAGSource_catalog` | Parallele Queries auf DB + DB_GP1, Dedup per Source-ID, kein Endpoint-Filter auf GP1 |
| `RAGSource_toc` | DB zuerst, Fallback auf DB_GP1 bei unbekannter Source-ID |
| `RAGSource_get` | DB zuerst für Source-Lookup, automatischer Wechsel zu DB_GP1 für unbekannte Sources |
| `RAGSource_query` | FTS5 auf beiden DBs, Merge top 20, Dedup per `source_id::section_ref` |

GP1-Quellen sind für den LLM nicht als "privat" markiert — Transparenz by design.

---

## Content-Format

Quellen sind Markdown-Dateien mit YAML-Frontmatter.

### Pflichtfelder

```yaml
---
titel: Feuerwehrsatzung der Gemeinde Bad Boll
ebene: gemeinde          # eu | bund | land | kreis | verband | gemeinde | intern
typ: satzung             # gesetz | satzung | verordnung | eu-recht | dienstanweisung | richtlinie | sonstiges
---
```

### Optionale Felder

```yaml
id: FwSatzung_BadBoll           # Überschreibt Dateiname-Ableitung (empfohlen)
kurzbezeichnung: FwSatzung BB
land_ars: "08"
kreis_ars: "08117"
verband_ars: "081175009"
gemeinde_ars: "081175009012"
gueltig_ab: "2023-01-01"        # Inkrafttreten der letzten Änderung (bei konsolid. Fassungen)
stand: "2023-01-01"
beschreibung: Kurzbeschreibung für Catalog (1–2 Sätze)
url: https://...
quelle: GBl. BW 2023, S. 12
```

### Tenancy / Extensions (nur Haupt-DB)

```yaml
endpoints:        # Leer = universell sichtbar. Gesetzt = nur für diese Deployments sichtbar
  - brandmeister
extensions:       # Leer = immer sichtbar. Gesetzt = nur wenn dieser Filter aktiv
  - Feuerwehr
```

GP1-Datenbank-Quellen brauchen **kein** `endpoints`-Feld — sie sind immer für GP1-Nutzer sichtbar.

### Struktur-Konventionen

```markdown
## Inhaltsverzeichnis
§ 1 Titel...           ← Wird als TOC gespeichert

## ERSTER ABSCHNITT    ← Wird in Body der nächsten ###-Section absorbiert

### § 1 Aufgaben       ← Section-Grenze (jedes ### öffnet neue Section)
Inhalt...

### § 2 Mitglieder
Inhalt...
```

**Regel:** Jedes `###`-Heading ist eine abrufbare Section. `##` (außer Inhaltsverzeichnis) landet im Body.

### Section-Typen

| `section_type` | Bedingung | Beispiel |
|---|---|---|
| `paragraph` | Default (§ oder generisches Heading) | `§ 1`, `Vorwort` |
| `artikel` | `Artikel N` / `Art. N` | `Art. 12a` |
| `erwaegungsgrund` | `Erwägungs...` / `EG N` | `EG 5` |
| `kapitel` | `Kapitel N` | `Kapitel 1` |
| `anhang` | `Anhang N` | `Anhang A` |
| `abschnitt` | Startet mit Ziffer | `1`, `2.1`, `3.2.1` |

---

## Neues Deployment anlegen

### 1. Environment in `wrangler.jsonc` anlegen

```jsonc
"mein-deployment": {
  "name": "mein-worker-name",
  "d1_databases": [
    { "binding": "DB", "database_name": "ragsource-db-v2", "database_id": "55d4deda-..." }
    // Optional: zweite DB für GP1
    // { "binding": "DB_GP1", "database_name": "mein-gp1-db", "database_id": "..." }
  ],
  "kv_namespaces": [{ "binding": "CONFIG", "id": "e0af38b6cee446adb258055e172c8a26" }],
  "durable_objects": { "bindings": [{ "class_name": "RAGSourceMCPv2", "name": "MCP_OBJECT" }] },
  "migrations": [{ "new_sqlite_classes": ["RAGSourceMCPv2"], "tag": "v1" }],
  "unsafe": { "bindings": [{ "type": "ratelimit", "name": "RATE_LIMITER", "namespace_id": "100X", "simple": { "limit": 60, "period": 60 } }] }
}
```

### 2. Host in `ENDPOINT_BY_HOST` eintragen (`src/mcp.ts`)

```typescript
"mcp.meine-domain.de": "mein-endpoint",
```

### 3. Sources mit Endpoint taggen (Haupt-DB)

```sql
INSERT INTO source_endpoints (source_id, endpoint) VALUES ('MeineQuelle', 'mein-endpoint');
```

### 4. Deployen

```bash
wrangler deploy --env mein-deployment
```

### 5. GP1-Auth aktivieren (optional)

```bash
wrangler secret put GP1_TOKEN --env mein-deployment
wrangler deploy --env mein-deployment
```

### 6. Custom Domain (Cloudflare Dashboard)

Workers → Deployment → Settings → Domains → Custom Domain eintragen.

---

## Setup & Entwicklung

### Voraussetzungen

- Node.js 20+, Wrangler CLI, Cloudflare-Account mit D1

### Lokal

```bash
npm install
npm run db:init:local       # Schema anlegen
npm run db:seed:local       # test-articles/ → lokale DB
npm run dev                 # Dev-Server auf :8787
```

### Tests

```bash
npm test                    # sql-utils Unit-Tests
npx tsx scripts/test-parser.ts  # Parser-Szenarien
```

### Produktiv

```bash
wrangler deploy                           # prod (amtsschimmel.ai)
wrangler deploy --env lean                # lean (mcp-lean.amtsschimmel.ai)
wrangler deploy --env paragrafenreiter    # paragrafenreiter.ai
wrangler deploy --env brandmeister        # brandmeister (public)
wrangler deploy --env brandmeister-gp1    # brandmeister GP1 (OAuth)
```

### DB remote befüllen

```bash
node --env-file=.env --import tsx/esm scripts/build-db-v2.ts --remote --skip-gemeinden
# Incremental:
node --env-file=.env --import tsx/esm scripts/build-db-v2.ts --remote --incremental
```

`.env` benötigt: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`

---

## MCP-Integration

### Claude Web

Settings → Integrations → Add MCP Server → URL eingeben.

**Ohne Auth** (public):
```
https://mcp.amtsschimmel.ai/mcp
```

**Mit OAuth** (GP1):
```
https://mcp-gp1.brandmeister.ai/mcp
```
→ Claude Web startet automatisch den OAuth-Flow. Zugangscode = GP1_TOKEN-Wert.

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "amtsschimmel": {
      "url": "https://mcp.amtsschimmel.ai/mcp"
    },
    "brandmeister-gp1": {
      "url": "https://mcp-gp1.brandmeister.ai/mcp",
      "headers": {
        "Authorization": "Bearer <GP1_TOKEN>"
      }
    }
  }
}
```

---

## GP1-Content-Pipeline

Vertrauliche Inhalte kommen aus dem privaten Repo `chrtrb/brandmeister-gp1`.
Bei Push auf `main` (Änderungen in `content/`) deployt GitHub Actions automatisch in die `brandmeister-gp1` D1.

Manueller Full-Rebuild: Actions → "Deploy GP1 Content to D1" → Run workflow → `full_rebuild: true`.

---

## GitHub Actions (ragsource-server)

Benötigte Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CONTENT_PAT`

Bei Push auf `main`:
1. Tests (`npm test`)
2. Bei `schema.sql`-Änderung: D1 neu bauen
3. `wrangler deploy` für prod, lean, paragrafenreiter
4. Health-Check `/api/health`

Bei `repository_dispatch` (Event `content-updated-v2`) vom Content-Repo:
1. Nur DB-Rebuild, kein Worker-Deploy

---

## Lizenz

MIT — Code und Skripte. Powered by [RAGSource](https://github.com/ragsource-ai/ragsource-server)
