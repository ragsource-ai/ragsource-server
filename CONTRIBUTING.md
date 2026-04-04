# Contributing to RAGSource Server

Danke fuer dein Interesse an RAGSource! Hier ist alles, was du wissen musst.

---

## Repos im Ueberblick

| Repo | Inhalt | Fuer wen |
|------|--------|----------|
| `ragsource-ai/ragsource-server` | Server-Code, Build-Pipeline (dieses Repo) | Entwickler |
| `ragsource-ai/ragsource-content` | Wissensartikel: Gesetze, Satzungen | Content-Autoren |
| `amtsschimmel-ai/wiki` | Wiki-Artikel fuer amtsschimmel.ai | Projekt-Team |

**Wenn du Wissensartikel hinzufuegen oder bearbeiten moechtest:** Das ist das falsche Repo. Nutze [`ragsource-content`](https://github.com/ragsource-ai/ragsource-content).

---

## Fuer Entwickler: Server-Code

### Voraussetzungen

- Node.js 20+
- Wrangler CLI
- Cloudflare-Account (fuer Remote-Tests)

### Entwicklungsumgebung

```bash
git clone https://github.com/ragsource-ai/ragsource-server
cd ragsource-server
npm install
npm run db:init:local
npm run db:seed:local
npm run dev
```

### Lokale Tests

```bash
# Parser-Tests
npx tsx scripts/test-parser.ts

# Health-Check
curl http://localhost:8787/api/health

# Suche
curl "http://localhost:8787/api/search?q=Feuerwehr&gemeinde=bad-boll"

# Query
curl -X POST http://localhost:8787/api/query \
  -H "Content-Type: application/json" \
  -d '{"query":"Feuerwehrkommandant","gemeinde":"bad-boll","persona":"buerger"}'
```

### Pull Request Prozess

1. Fork erstellen
2. Feature-Branch anlegen: `git checkout -b feature/mein-feature`
3. Aenderungen committen
4. Pull Request erstellen -- beschreibe was und warum
5. Projektleitung (Christian Traub) reviewed

### Was wir begruessen

- Bugfixes mit klarer Problembeschreibung
- Performance-Verbesserungen im Retrieval (mit Benchmark)
- Neue Retrieval-Stufen oder Ranking-Verbesserungen
- Tests und Verifikations-Skripte

### Was vorher besprochen werden sollte

- Groessere Architektureaenderungen: Issue oeffnen, erst diskutieren
- Neue Abhaengigkeiten: Begruendung mitliefern
- Breaking Changes an der API oder den MCP-Tools

---

## Fuer Content-Autoren: Wissensartikel

Neue Artikel und Korrekturen an Gesetzen/Satzungen gehoeren in [`ragsource-content`](https://github.com/ragsource-ai/ragsource-content). Dort findest du das vollstaendige Frontmatter-Schema und Qualitaetskriterien.

---

## Code-Stil

- TypeScript, kein `any` wenn vermeidbar
- Kommentare auf Deutsch (Projektsprache)
- Fehlerbehandlung explizit, kein stilles Scheitern
- Keine neuen Abhaengigkeiten ohne Diskussion

---

## Lizenz

Beitraege stehen unter der MIT-Lizenz dieses Projekts.
Durch deinen Pull Request stimmst du zu, dass dein Code unter MIT veroeffentlicht wird.

---

Fragen? Issue oeffnen oder Christian Traub direkt kontaktieren.
