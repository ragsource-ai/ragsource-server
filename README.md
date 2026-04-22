# RAGSource Server

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare_Workers-F38020.svg?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![MCP](https://img.shields.io/badge/MCP-Streamable_HTTP-8A2BE2.svg)](https://modelcontextprotocol.io/)

Agentic-RAG-System, das Kontext (Skills, Wissensartikel, Rechtsquellen, Policies u.v.m.) effizient und zitierfähig an LLMs bereitstellt. Stateless, DSGVO-konform und frei skalierbar.

Eine Codebasis — beliebig viele isolierte Deployments, rein konfigurationsgetrieben.

---

## Referenzprojekte

| Projekt | Beschreibung |
|---|---|
| [**amtsschimmel.ai**](https://amtsschimmel.ai) | Kommunales Rechtswissen für Verwaltung und Bürger — Gemeinden, Landkreise, Landes- und Bundesrecht |
| [**brandmeister.ai**](https://brandmeister.ai) | Wissen für den Feuerwehreinsatz — Gefahrstoffe, Bau- und Ortsrecht, Dienstvorschriften |
| [**paragrafenreiter.ai**](https://paragrafenreiter.ai) | Rechtswissen für Profis — alle Quellen, kein Tenant-Filter |

---

## Architektur

```
LLM (Claude Web / Desktop / Code)
    │
    └── MCP-Protokoll → POST /mcp
                             │
                    Cloudflare Worker (index.ts)
                    ├── OAuth-Endpunkte (optional, bei gesetztem ACCESS_TOKEN)
                    ├── Auth Guard (Bearer / OAuth-Token)
                    ├── Rate Limiter (60 req/min pro IP)
                    └── McpAgent Durable Object (mcp.ts)
                              │
                    D1 Hauptdatenbank
                    D1 Zusatzdatenbank (optional, vertrauliche Inhalte)
```

### Multi-Tenant-Prinzip

Alle Deployments laufen auf derselben Codebasis — kein Fork, keine Doppelung. Unterschiede entstehen ausschließlich durch Konfiguration:

| Schalter | Mechanismus | Wirkung |
|---|---|---|
| **Endpoint-Filter** | `ENDPOINT_BY_HOST` in `mcp.ts` (Host → Slug) | Welche Quellen aus der Haupt-DB sichtbar sind |
| **Extensions-Filter** | `extensions`-Frontmatter + URL-Parameter | Thematische Einschränkung (z.B. Feuerwehr, Baurecht) |
| **Authentifizierung** | `ACCESS_TOKEN` Wrangler-Secret | Aktiviert OAuth 2.0 Authorization Server + Auth Guard |
| **Zweite Datenbank** | `DB_GP1`-Binding in `wrangler.jsonc` | Transparente Dual-DB: vertrauliche Inhalte ohne Markierung gemergt |

**Ein neues Deployment** = neue `env`-Sektion in `wrangler.jsonc` + Host in `ENDPOINT_BY_HOST` + `wrangler deploy --env <name>`.

---

## Projektstruktur

```
ragsource-server/
├── src/
│   ├── index.ts        # Entry Point: OAuth-Endpunkte, Auth Guard, Rate Limit, Routing
│   ├── mcp.ts          # McpAgent Durable Object — MCP-Tools, Dual-DB-Logik
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

## MCP-Tools

| Tool | Funktion |
|---|---|
| `RAGSource_catalog` | Pflichtaufruf: verfügbare Wissensquellen für eine Gemeinde/Region |
| `RAGSource_toc` | Inhaltsverzeichnis einer oder mehrerer Quellen (Batch, max. 8) |
| `RAGSource_get` | Originalwortlaut spezifischer Paragraphen (max. 50 §§ pro Aufruf) |
| `RAGSource_query` | FTS5-Volltextsuche (Fallback; deaktivierbar mit `DISABLE_QUERY=true`) |
| `RAGSource_db_query` | Strukturierter DB-Layer für tabellarische Nachschlagewerke (z.B. Gefahrstoffe) |

### Agentic Workflow

```
RAGSource_catalog(geo=...) → Quellen mit size_class
    ├── small  → RAGSource_get direkt
    └── medium/large → RAGSource_toc → RAGSource_get (gezielte §§)
```

---

## Content-Format

Quellen sind Markdown-Dateien mit YAML-Frontmatter. Das Content-Repository [`ragsource-content`](https://github.com/ragsource-ai/ragsource-content) enthält alle öffentlichen Wissensartikel.

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
id: FwSatzung_BadBoll
kurzbezeichnung: FwSatzung BB
land_ars: "08"
kreis_ars: "08117"
verband_ars: "081175009"
gemeinde_ars: "081175009012"
gueltig_ab: "2023-01-01"        # Inkrafttreten der letzten Änderung
stand: "2023-01-01"
beschreibung: Kurzbeschreibung für den Catalog (1–2 Sätze)
url: https://...
quelle: GBl. BW 2023, S. 12
endpoints:                      # Leer = universell sichtbar
  - brandmeister
extensions:                     # Leer = immer sichtbar; gesetzt = nur bei aktivem Filter
  - Feuerwehr
```

### Struktur-Konventionen

```markdown
## Inhaltsverzeichnis
§ 1 Titel...           ← Wird als TOC gespeichert

## ERSTER ABSCHNITT    ← Landet im Body der nächsten ###-Section

### § 1 Aufgaben       ← Section-Grenze — jedes ### öffnet eine neue abrufbare Einheit
Inhalt...
```

---

## Setup & Entwicklung

### Voraussetzungen

Node.js 20+, Wrangler CLI, Cloudflare-Account mit D1.

### Lokal

```bash
npm install
npm run db:init:local       # Schema anlegen
npm run db:seed:local       # test-articles/ → lokale DB
npm run dev                 # Dev-Server auf :8787
```

### Tests

```bash
npm test                        # sql-utils Unit-Tests
npx tsx scripts/test-parser.ts  # Parser-Szenarien
```

### Deployen

```bash
wrangler deploy                           # prod
wrangler deploy --env lean                # lean (kein RAGSource_query)
wrangler deploy --env paragrafenreiter    # alle Quellen sichtbar
wrangler deploy --env brandmeister        # Feuerwehr-Deployment (public)
wrangler deploy --env brandmeister-gp1    # mit OAuth-Auth + zweiter DB
```

### DB remote befüllen

```bash
node --env-file=.env --import tsx/esm scripts/build-db-v2.ts --remote --skip-gemeinden
node --env-file=.env --import tsx/esm scripts/build-db-v2.ts --remote --incremental
```

`.env` benötigt: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`

---

## MCP-Integration

### Claude Web

Settings → Integrations → Add MCP Server → URL eingeben:

```
https://mcp.amtsschimmel.ai/mcp
```

Bei OAuth-geschützten Deployments startet Claude Web den OAuth-Flow automatisch. Zugangscode = gesetzter `ACCESS_TOKEN`.

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "ragsource": {
      "url": "https://mcp.amtsschimmel.ai/mcp"
    }
  }
}
```

---

## Neues Deployment anlegen

1. **`wrangler.jsonc`**: neue `env`-Sektion mit eigenem `name` und Rate-Limit-`namespace_id`
2. **`src/mcp.ts`**: Host in `ENDPOINT_BY_HOST` eintragen
3. **Quellen taggen**: `INSERT INTO source_endpoints (source_id, endpoint) VALUES (...)`
4. **Deployen**: `wrangler deploy --env <name>`
5. **Custom Domain**: Workers → Settings → Domains (Cloudflare Dashboard)
6. **Auth aktivieren** (optional): `wrangler secret put ACCESS_TOKEN --env <name>` → erneut deployen

---

## CI/CD

Benötigte Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CONTENT_PAT`

- **Push auf `main`**: Tests → Deploy (alle Environments)
- **`content-updated-v2` Event** (vom Content-Repo): nur DB-Rebuild, kein Worker-Deploy

---

## Lizenz

MIT — Code und Skripte. Inhalte und Prompts unter [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

---

<p align="center">
  <br>
  Made with ❤️ for Open Source AI
  <br><br>
  This project started from a personal need: reliable, citable knowledge<br>
  for firefighters, public servants, and everyone who needs to get things right.<br>
  <br>
  <strong>It belongs to everybody.</strong>
</p>
