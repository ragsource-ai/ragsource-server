# RAGSource Server

Cloudflare Worker mit D1-Datenbank (SQLite + FTS5), der kommunales Verwaltungswissen als durchsuchbare Wissensbasis bereitstellt -- erreichbar ueber REST und MCP (Model Context Protocol).

**Live:** `https://ragsource-api.ragsource.workers.dev`
**MCP-Endpunkt:** `https://ragsource-api.ragsource.workers.dev/mcp`
**MCP-Version:** 1.2.0
**Status:** Phase 1d live (ARS-basierte Geo-Filterung)

---

## Ueberblick

RAGSource macht kommunales Verwaltungswissen fuer KI-Systeme zugaenglich. Der Server empfaengt Anfragen von LLMs (Claude, ChatGPT, etc.), durchsucht die Wissensbasis mit einem mehrstufigen Retrieval-System (FTS5 + BM25) und liefert compliance-gepruefte, hierarchisch geordnete Artikel zurueck.

```
LLM (Claude, ChatGPT, ...)
    │
    ├── MCP-Protokoll → POST /mcp
    └── REST-API      → POST /api/query
                              │
                     Cloudflare Worker
                         │
                    D1 (SQLite + FTS5)
                    Wissensartikel als Markdown
```

---

## Projektstruktur

```
ragsource-server/
├── src/
│   ├── index.ts              # Entry point: /mcp → McpAgent, rest → Hono
│   ├── mcp.ts                # MCP-Server (RAGSourceMCP Durable Object)
│   ├── api.ts                # REST-Endpunkte (Hono)
│   ├── types.ts              # TypeScript-Typen
│   └── engine/
│       ├── matcher.ts        # 4-Stufen FTS5-Retrieval + Geo/Projekt-Filter
│       ├── hierarchy.ts      # Normenhierarchie-Sortierung
│       ├── response.ts       # Response-Paket bauen
│       └── config.ts         # Retrieval-Konfiguration + Persona-Overrides
├── scripts/
│   └── build-db.ts           # Markdown → D1 Build-Pipeline
├── data/
│   └── gemeinden.json        # Single Source of Truth: ARS, Klarnamen, Aliases
├── test-articles/            # 5 Testartikel fuer lokale Entwicklung
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

## API-Endpunkte

### MCP (fuer Claude Desktop, Claude.ai, Cursor)

| Tool | Funktion |
|------|----------|
| `ragsource_query` | Hauptsuche mit persona-gerechtem Response-Paket |
| `ragsource_search` | Einfache Stichwortsuche |
| `ragsource_article` | Einzelartikel per Dateipfad laden |

### REST

| Methode | Pfad | Funktion |
|---------|------|----------|
| POST | `/api/query` | Hauptsuche |
| GET | `/api/search` | Stichwortsuche |
| GET | `/api/article` | Einzelartikel |
| GET | `/api/health` | Server-Status |
| GET | `/api/openapi` | OpenAPI-Spezifikation |

### Beispiel-Anfrage

```bash
curl -X POST https://ragsource-api.ragsource.workers.dev/api/query \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Wie wird der Feuerwehrkommandant gewaehlt?",
    "gemeinde": "bad-boll",
    "persona": "buerger",
    "hints": ["Feuerwehr", "Kommandant", "Wahl"]
  }'
```

---

## Retrieval: 4-Stufen-System

```
Stufe 1: FTS5 ueber Artikel-Content + Titel  (BM25-Ranking)
Stufe 2: FTS5 ueber kuratierte Fragen        (natuerliche Sprache)
Stufe 3: FTS5 ueber LLM-Hints               (Synonyme, Fachbegriffe)
Stufe 4: Titel-Match ueber LLM-Sources       (vermutete Dokumenttitel)
         └── Scores kombinieren → Top-Artikel → Hierarchie pruefen → ans LLM
```

---

## Filter-Parameter

Alle Filter sind optional. Ohne Filter werden alle publizierten Artikel durchsucht.

| Parameter | Typ | Beschreibung |
|-----------|-----|--------------|
| `gemeinde` | string | Gemeinde-Slug, Klarname oder ARS (z.B. `bad-boll`, `Bad Boll`, `081175009012`). Intern via `geo_aliases` zu ARS normalisiert. Auto-Resolve: Verband/Kreis/Land werden automatisch abgeleitet |
| `bundesland` | string | Bundesland-Kuerzel, Klarname oder ARS (z.B. `bw`, `Baden-Württemberg`, `08`) |
| `landkreis` | string | Landkreis-Slug, Klarname oder ARS (z.B. `goeppingen`, `Göppingen`, `08117`) |
| `projekt` | string | Projekt-Slug fuer Projekt-Filter |
| `persona` | enum | `buerger` \| `gemeinderat` \| `verwaltung` \| `buergermeister` |

---

## Wissensartikel-Format

Artikel sind Markdown-Dateien mit YAML-Frontmatter. Sie leben in einem separaten Content-Repo (`ragsource-ai/ragsource-content`).

```yaml
---
titel: Feuerwehrsatzung der Gemeinde Bad Boll
ebene: gemeinde          # bund | land | kreis | verband | gemeinde
saule: regelungsrahmen
gemeinde: bad-boll
projekte:
  - amtsschimmel
keywords:
  - Feuerwehr
  - Feuerwehrkommandant
fragen:
  - "Wie wird der Feuerwehrkommandant gewaehlt?"
---
Artikelinhalt...
```

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

Bei Push auf `main` in diesem Repo oder per `repository_dispatch` vom Content-Repo:

1. Checkout Server-Code + Content-Repo
2. `build-db.ts` baut die D1-Datenbank neu
3. `wrangler deploy` deployt den Worker
4. Health-Check gegen `/api/health`

Benoetigt zwei Secrets im Repo:
- `CLOUDFLARE_API_TOKEN` -- Cloudflare API Token mit Worker + D1 Rechten
- `CLOUDFLARE_ACCOUNT_ID` -- Cloudflare Account ID

---

## MCP-Integration in Claude

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "ragsource": {
      "url": "https://ragsource-api.ragsource.workers.dev/mcp"
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
