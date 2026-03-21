# RAGSource Server

Cloudflare Worker mit D1-Datenbank (SQLite + FTS5), der kommunales Verwaltungswissen als agentic RAG-System bereitstellt -- erreichbar ueber MCP (Model Context Protocol).

**Live:** `https://ragsource-api-v2.ragsource.workers.dev`
**MCP-Endpunkt:** `https://ragsource-api-v2.ragsource.workers.dev/mcp`
**amtsschimmel.ai:** `https://mcp.amtsschimmel.ai/mcp?geo=<ARS>&rolle=<rolle>`
**Status:** v2 Agentic RAG (243 Quellen, §-granular)

---

## Ueberblick

RAGSource macht kommunales Verwaltungswissen fuer KI-Systeme zugaenglich. Der Server empfaengt Anfragen von LLMs (Claude, ChatGPT, etc.) und liefert compliance-geprueftes, hierarchisch geordnetes Rechtswissen auf Paragraphen-Ebene zurueck.

```
LLM (Claude, ChatGPT, ...)
    │
    └── MCP-Protokoll → POST /mcp
                              │
                     Cloudflare Worker (Durable Objects)
                         │
                    D1 (SQLite + FTS5)
                    243 Rechtsquellen, §-granular
```

---

## Projektstruktur

```
ragsource-server/
├── src/
│   ├── index.ts              # Entry point: /mcp → McpAgent, /api → Hono
│   ├── mcp.ts                # MCP-Server (RAGSourceMCPv2 Durable Object)
│   ├── types.ts              # TypeScript-Typen
│   └── engine/
│       ├── normalize.ts      # Geo-Aufloesung: geo-Parameter → ARS + Ebene + Klarnamen
│       └── hierarchy.ts      # Normenhierarchie-Sortierung
├── scripts/
│   └── build-db-v2.ts        # Markdown → D1 Build-Pipeline
├── data/
│   └── gemeinden.json        # Single Source of Truth: ARS, Klarnamen, Aliases
├── schema.sql                # Datenbank-Schema (FTS5 + Tabellen + Indizes)
└── wrangler.jsonc            # Cloudflare-Konfiguration
```

---

## Technologie-Stack

| Komponente | Technologie |
|-----------|-------------|
| Runtime | Cloudflare Workers (TypeScript) |
| REST-Framework | Hono |
| MCP | `@cloudflare/agents` SDK (Durable Objects) |
| Datenbank | Cloudflare D1 (SQLite + FTS5) |
| Build | Wrangler CLI, tsx |
| CI/CD | GitHub Actions |

---

## MCP-Tools (Agentic RAG)

| Tool | Funktion |
|------|----------|
| `RAGSource_catalog` | Pflichtaufruf: alle verfuegbaren Rechtsquellen fuer eine Gemeinde/Region |
| `RAGSource_toc` | Inhaltsverzeichnis(se) einer oder mehrerer Quellen (Batch, max. 8) |
| `RAGSource_get` | Originalwortlaut spezifischer Paragraphen (max. 50 §§ pro Aufruf) |
| `RAGSource_query` | FTS5-Volltextsuche (Fallback) |

### Agentic Workflow

```
RAGSource_catalog (geo=...) → liefert Quellen mit size_class
    ├── small  → RAGSource_get direkt (kein TOC noetig)
    └── medium/large → RAGSource_toc → RAGSource_get (gezielte Paragraphen)
```

### Rechtsrang (Normenhierarchie)

| Wert | Ebene |
|------|-------|
| 0 | EU-Recht |
| 1 | Bundesrecht |
| 2 | Landesrecht BW |
| 3 | Kreisrecht |
| 4 | Verbandsrecht |
| 5 | Ortsrecht |
| 6 | Tarifrecht |

---

## Filter-Parameter

| Parameter | Typ | Beschreibung |
|-----------|-----|--------------|
| `geo` | string | ARS-Code oder Klarname/Slug. ARS-Laenge bestimmt Ebene: `08` (Land), `08117` (Kreis), `081175009` (Verband), `081175009012` (Gemeinde). **"Nur aufwaerts":** Verbands-Anfragen zeigen nur Verband/Kreis/Land/Bund, keine Gemeinde-Quellen |
| `projekt` | string | Projekt-Slug fuer Mandanten-Filter (z.B. `amtsschimmel`) |

---

## Content-Format (Rechtsquellen)

Quellen sind Markdown-Dateien mit YAML-Frontmatter. Sie leben in `ragsource-ai/ragsource-content`.

```yaml
---
titel: Feuerwehrsatzung der Gemeinde Bad Boll
ebene: gemeinde
typ: satzung
land_ars: "08"
kreis_ars: "08117"
verband_ars: "081175009"
gemeinde_ars: "081175009012"
beschreibung: Regelungen zur Gemeindefeuerwehr (Aufgaben, Stärke, Kommandant)
---
## Inhaltsverzeichnis
§ 1 Aufgaben...

### § 1 Aufgaben
...
```

Heading-Konvention: `##` fuer Strukturelemente, `###` fuer abrufbare §§/Artikel.

---

## Setup & Entwicklung

### Voraussetzungen

- Node.js 20+
- Wrangler CLI (`npm install -g wrangler`)
- Cloudflare-Account mit D1-Zugriff

### Lokale Entwicklung

```bash
npm install
npm run db:init:local
npm run db:seed:local      # Laedt test-articles/ in lokale DB
npm run dev                # Startet lokalen Dev-Server auf :8787
```

### Mit eigenem Content-Repo

```bash
npm run db:seed:local -- --content-root=../../ragsource-content/regelungsrahmen
```

### Produktiv deployen

```bash
npm run db:init:remote
npm run db:seed:remote -- --content-root=../../ragsource-content/regelungsrahmen
npm run deploy
```

---

## GitHub Actions (automatisches Deploy)

Bei Push auf `main` in diesem Repo:

1. Checkout Server-Code + Content-Repo
2. `build-db-v2.ts` baut die D1-Datenbank neu
3. `wrangler deploy` deployt den Worker
4. Health-Check gegen `/api/health`

Bei `repository_dispatch` vom Content-Repo (Event: `content-updated-v2`):

1. Checkout Server-Code + Content-Repo
2. `build-db-v2.ts` baut nur die DB neu (Worker bleibt unveraendert)

Benoetigt zwei Secrets im Repo:
- `CLOUDFLARE_API_TOKEN` -- Cloudflare API Token mit Worker + D1 Rechten
- `CLOUDFLARE_ACCOUNT_ID` -- Cloudflare Account ID

---

## MCP-Integration

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "ragsource": {
      "url": "https://ragsource-api-v2.ragsource.workers.dev/mcp"
    }
  }
}
```

### Claude.ai (Web)

Settings → Integrations → MCP-Server hinzufuegen → URL eingeben.

---

## Lizenz

MIT Lizenz fuer Code und Skripte -- siehe [LICENSE](LICENSE)

Powered by [RAGSource](https://github.com/ragsource-ai/ragsource-server)
