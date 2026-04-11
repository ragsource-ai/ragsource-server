# Changelog

Alle wesentlichen Änderungen an RAGSource Server sind hier dokumentiert.
Format basiert auf [Keep a Changelog](https://keepachangelog.com/de/1.0.0/).

---

## [2.6.1] — 2026-04-11

### Geändert
- **`execSync` → `execFileSync`**: Alle wrangler-CLI-Aufrufe in `build-db-v2.ts` verwenden jetzt Array-Argumente statt Template-String-Interpolation (Shell-Injection-Härtung).
- **`sleep 10` → `Atomics.wait()`**: Plattformunabhängige Pause nach D1-DROP statt externem Shell-Befehl.
- **`D1_DB_ID` aus Env-Variable**: `CLOUDFLARE_D1_DB_ID` (Fallback: bisheriger Wert aus `wrangler.jsonc`), um die ID aus dem Quellcode zu entfernen.
- **`SafeSqlStr` Branded Type**: `SqlFragment.sql` ist jetzt ein opaker Typ — TypeScript erzwingt, dass nur explizit markierte Strings ins SQL-Gerüst fließen, niemals Benutzereingaben.
- **`maxLength(100)` auf `geo`-Parameter**: Zod-Validierung in `RAGSource_catalog` und `RAGSource_query`.
- **Token-Schätzung**: `length / 4` → `length / 3.5` (genauer für deutschen Text mit Umlauten/Komposita).
- **Abhängigkeiten**: `hono` → `4.12.12`, `@hono/node-server` → `1.19.13` via `overrides` (schließt 6 moderate Dependabot-CVEs).

### Behoben
- Fehler-Logs in `fetchD1Batch` loggten bei HTTP-Fehlern die gesamte API-Antwort; jetzt nur noch `data.errors`.

---

## [2.6.0] — 2026-04-09

### Hinzugefügt
- **Drei Deployments**: Prod (`mcp.amtsschimmel.ai`), Lean (`mcp-lean.amtsschimmel.ai`, kein `RAGSource_query`), Paragrafenreiter (`mcp.paragrafenreiter.ai`, sieht alle Quellen).
- **`DISABLE_QUERY`-Flag**: Wenn auf `"true"`, wird `RAGSource_query` nicht registriert (Compliance-Modus für Testkunden).
- **`?extensions=`-URL-Parameter**: Kommagetrennte Themen-Filter (z.B. `?extensions=Feuerwehr,Arbeitsrecht`), die den DO vorab konfigurieren — analog zu `?geo=`.
- **`extensions`-Tool-Parameter** in `RAGSource_catalog`, `RAGSource_toc`, `RAGSource_query`: ersetzen den alten `sammlungen`-Parameter.
- **`ENDPOINT_BY_HOST`-Mapping**: Drei Einträge (`mcp.amtsschimmel.ai` → `amtsschimmel`, `mcp-lean.amtsschimmel.ai` → `amtsschimmel`, `mcp.paragrafenreiter.ai` → `all`). `"all"` deaktiviert den Tenancy-Filter.
- **Wrangler-Environments**: `--env lean` und `--env paragrafenreiter` in `wrangler.jsonc` mit allen Bindings explizit deklariert.
- **CI/CD**: `deploy.yml` deployt jetzt alle drei Environments nach dem Prod-Deploy.

### Geändert
- **Zwei-Filter-Modell**: `buildSammlungFilter()` ersetzt durch `buildEndpointFilter()` (Tenancy, mandatory AND) + `buildExtensionsFilter()` (Themen, optional OR).
- **DB-Schema**: `source_sammlungen`/`source_projekte` → zwei getrennte Tabellen `source_endpoints` (Tenancy) und `source_extensions` (Themen).
- **Frontmatter-Felder**: `projekte`/`sammlungen` (deprecated, Legacy-Fallback bleibt) → `endpoints` (Tenancy-Array) + `extensions` (Themen-Array). Leere Arrays = universell sichtbar.
- **`projekt`-Parameter** in Tool-Definitionen: als No-op-Legacy behalten (kein Breaking Change).

### Behoben
- Wrangler-Environments erben Bindings nicht automatisch — alle Bindings in jeder `env`-Sektion explizit deklariert (war Ursache für „kv_namespaces exists at the top level, but not on env.lean"-Warnungen).
- Rate-Limiter `namespace_id` pro Environment eindeutig: 1001 (prod), 1002 (lean), 1003 (paragrafenreiter).

---

## [2.5.0] — 2026-04-04

### Geändert
- **Parser-Umstellung**: Jedes `###`-Heading ist jetzt eine Section-Grenze, unabhängig vom Inhalt. Bisher musste ein Heading `§`, `Art.`, `Kapitel` o.ä. enthalten. `##`-Headings sind weiterhin Strukturelemente und landen im Body der laufenden Section.
- **Neue sectionType-Werte**: `"abschnitt"` für plain-numerische Headings (z.B. `### 7 Anforderungen...` in IndBauRL, VwVen), `"anhang"` explizit für Anhang-Headings.
- **§ N a-Parsing**: Leerzeichen vor Buchstaben-Suffix korrekt unterstützt (`§ 38 a` statt `§ 38`, BW-Stil).

### Hinzugefügt
- `scripts/test-parser.ts`: 9 automatisierte Parser-Tests für alle Section-Typen.

### Behoben
- **IndBauRL**: Abschnitte 1–9 wurden nicht indexiert (nur Anhänge 1+2). Ursache: `Anhang`-Headings verhinderten den Fallback-Parser.
- **BW_FischG, BW_KomWG, BW_LNTVO**: 7 `## §`-Headings (§§ 1a, 21a, 44a, 38a, 39a, 39b, 11a) auf `###` angehoben (Content-Repo).

---

## [2.4.0] — 2026-03-22

### Hinzugefügt
- **Inkrementeller DB-Rebuild** (`--incremental`): SHA-256-basierter Hash-Diff — nur geänderte Dateien werden neu eingespielt, unveränderte Quellen bleiben in der DB. Deutliche CI-Zeitersparnis bei kleinen Content-Änderungen.
- **D1 REST API direkt**: Batch-Inserts über REST statt wrangler-CLI-Spawn. Vollrebuild (244 Quellen) von ~4 Minuten auf **58 Sekunden** reduziert.
- **Geo-Namensauflösung**: Klarnamen (z.B. „Konstanz") werden über `geo_aliases`-Tabelle und `gemeinden.name`-Lookup auf ARS aufgelöst. Umlaut-Normalisierung inklusive.
- **Mehrdeutige Ortsnamen**: Wenn ein Name mehreren Gemeinden entspricht, liefert die API eine `geo_ambiguous`-Antwort mit Kandidatenliste (Name, Kreis, Land, ARS).
- **GEO_BUND_ONLY-Fallback**: Unbekannte Geo-Namen → nur EU- und Bundesrecht (kein BW-Hardcoding).
- **GV100AD-Datei**: Vollständige Kreis- und Verbandsnamen aus Destatis GV100AD-Datei für alle 401 Kreise und 4.583 Verbände.
- **SQL-Escaping abgesichert**: `esc()`-Funktion für alle User-Inputs + Unit-Tests + Integrations-Teststep in `deploy.yml`.
- **`include_gemeinden`-CI-Option**: `rebuild-db.yml` kann optional alle 10.944 Gemeinden einspielen (`workflow_dispatch`, default: false).

### Geändert
- `typ` und `rechtsrang_label` aus Catalog-Response entfernt (Token-Optimierung, `rechtsrang` Integer bleibt).
- Masterprompt amtsschimmel.ai überarbeitet: präzisere Anweisungen für Normenhierarchie und Quellenauswahl.

### Behoben
- D1 REST API-Endpunkt `/batch` → `/query` korrigiert.
- `.env` wird automatisch via `--env-file` geladen (Node.js 24 built-in).
- `sessionGeo`-Closure-Bug durch `_currentGeo`-Property ersetzt; ARS korrekt in `geoInfo`.

---

## [2.3.0] — 2026-03-21

### Hinzugefügt
- **Rechtsrang**: `rechtsrang` (INTEGER 0–6) und `rechtsrang_label` (TEXT) in `sources`-Tabelle und Catalog-Response. Ermöglicht Normenhierarchie-Sortierung im LLM und im Gateway.
- **10.944 Gemeinden**: Vollständige Destatis GV-ISys-Daten in `gemeinden`-Tabelle — ARS, Klarnamen, Kreis, Land, Aliases für alle deutschen Gemeinden.
- **`not_configured`-Hinweis**: Wenn eine Gemeinde keinen Ortsrecht-Content hat, liefert der Catalog einen strukturierten Hinweis mit Kontaktadresse.
- **CI/CD-Optimierungen**: Path-Filter (kein unnötiger Rebuild bei Docs-Änderungen), Schema-Erkennung (Vollrebuild nur bei `schema.sql`-Änderung), `--skip-gemeinden`-Flag (~2–3 Minuten CI-Zeit gespart pro Run).
- **`full_rebuild`-Option** in `rebuild-db.yml` per `workflow_dispatch`.
- **FTS5-Trigger** für automatische Index-Synchronisation.

### Geändert
- **V1 vollständig entfernt**: V2 ist jetzt die einzige und primäre Architektur. Branch `v2-agentic` → `main`.

### Behoben
- **Security**: agents-Abhängigkeit 0.0.74 → 0.7.9 (alle bekannten CVEs behoben).
- Geo-Validierung, Rate-Limiting, N+1-Query-Fix, Health-Check-Härtung.
- `RAGSource_get`: Strukturierte Warnings für nicht gefundene §§ (statt stummem Fehlschlag).
- 10s Pause nach CREATE/DROP durch D1 Durable Object Polling ersetzt.

---

## [2.2.0] — 2026-03-07/08

### Hinzugefügt
- **Fallback-Parser** für Gebührenverzeichnisse und atypische Paragraph-Schemata (`Prod. Nr.`, `Nr. N`).
- Byte-basiertes Batching gegen `SQLITE_TOOBIG`-Fehler bei großen Gesetzen (BGB etc.).

### Behoben
- SQL-Parser-Bugs für Sonderzeichen (`''`, `--`) umgangen (wrangler-Parser-Limitation).
- Deploy-Pipeline: v2-Format wird nicht mehr von v1-Build übersprungen.
- CORS-Header für MCP-Endpunkt fehlten bei bestimmten Preflight-Requests.

---

## [2.1.0] — 2026-03-01/02

### Hinzugefügt
- **Multi-Source-Get**: `RAGSource_get` lädt §§ aus bis zu 8 Quellen und 50 §§ gesamt in einem Aufruf.
- **KV-Config**: `RAGSOURCE_CONFIG`-KV-Namespace für `system_message` und `not_configured_message` — ohne Re-Deploy änderbar.
- **Dynamischer Masterprompt**: URL-Parameter `?geo=` und `?rolle=` steuern den MCP-System-Prompt je Gemeinde und Nutzerrolle.
- **Masterprompts als editierbare `.md`-Dateien** im Repo (kein Hardcoding im TypeScript).
- URL-Feld in `RAGSource_get`-Response für direkte Verlinkung zur Rechtsquelle.

### Geändert
- MCP-Instructions von Masterprompt-Logik getrennt (bessere Wartbarkeit).
- Tool-Beschreibungen präzisiert für zuverlässigeres Tool-Matching durch LLMs.
- Catalog-Response verschlankt (nur relevante Felder für LLM-Entscheidung).

---

## [2.0.0] — 2026-02-28

Erster stabiler Release des Agentic RAG v2-Systems. Vollständige Neuentwicklung gegenüber v1.

### Hinzugefügt
- **Neues DB-Schema**: Drei Tabellen — `sources`, `source_sections`, `source_tocs` — mit FTS5-Index.
- **4 MCP-Tools**:
  - `RAGSource_catalog` — alle verfügbaren Quellen für eine Gemeinde/Region
  - `RAGSource_toc` — Inhaltsverzeichnis (Batch, max. 8 Quellen)
  - `RAGSource_get` — Originalwortlaut spezifischer §§ (§-granular)
  - `RAGSource_query` — FTS5-Volltextsuche als Fallback
- **Hierarchisches Retrieval**: Catalog → TOC → Get. LLM navigiert selbständig zur richtigen Rechtsquelle und zum richtigen Paragraphen.
- **§-granulares Retrieval**: Jeder § wird als einzelne Einheit gespeichert und kann gezielt abgerufen werden.
- **Geo-Filter** via ARS (Amtlicher Regionalschlüssel): 2=Land, 5=Kreis, 9=Verband, 12=Gemeinde. „Nur aufwärts"-Logik.
- **Cloudflare Workers + D1**: Serverlos, global verteilt, SQLite + FTS5.
- **GitHub Actions CI/CD**: Automatischer Rebuild bei Content-Push, manueller Deploy bei Code-Änderungen.

---

[2.6.0]: https://github.com/ragsource-ai/ragsource-server/compare/v2.5.0...v2.6.0
[2.5.0]: https://github.com/ragsource-ai/ragsource-server/compare/v2.4.0...v2.5.0
[2.4.0]: https://github.com/ragsource-ai/ragsource-server/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/ragsource-ai/ragsource-server/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/ragsource-ai/ragsource-server/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/ragsource-ai/ragsource-server/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/ragsource-ai/ragsource-server/releases/tag/v2.0.0
