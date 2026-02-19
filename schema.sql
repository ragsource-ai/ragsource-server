-- RAGSource D1 Schema
-- Phase 1a: Cloudflare Worker Prototyp

-- Haupttabelle: Artikel (Satzungen, Gesetze, Wiki-Einträge)
CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titel TEXT NOT NULL,
  gemeinde TEXT,              -- 'bad-boll', NULL für Land/Bund
  bundesland TEXT,            -- 'bw', 'by', etc. (Phase 1b: Geo-Filter)
  landkreis TEXT,             -- 'goeppingen', etc. (Phase 1b: Geo-Filter)
  ebene TEXT NOT NULL,        -- gemeinde | gvv | kreis | land | bund
  saule TEXT NOT NULL,        -- regelungsrahmen | wiki | lokal
  content TEXT NOT NULL,
  gueltig_ab TEXT,            -- ISO-Datum
  status TEXT NOT NULL DEFAULT 'published',
  dateipfad TEXT NOT NULL,    -- Originalpfad für Quellenangabe
  quelle TEXT,                -- Rechtsgrundlage
  token_count INTEGER         -- Geschätzter Token-Verbrauch
);

-- Keywords pro Artikel (aus Frontmatter)
CREATE TABLE IF NOT EXISTS keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL
);

-- Typische Fragen pro Artikel (aus Frontmatter)
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  question TEXT NOT NULL
);

-- Querverweise zwischen Artikeln
CREATE TABLE IF NOT EXISTS relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  related_titel TEXT NOT NULL
);

-- Gemeinde-Hierarchie Lookup
CREATE TABLE IF NOT EXISTS gemeinden (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  gvv TEXT,
  kreis TEXT NOT NULL,
  land TEXT NOT NULL,
  land_kurz TEXT NOT NULL
);

-- FTS5: Volltextsuche über Titel + Content (Stufe 1)
CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
  titel, content, tokenize='unicode61'
);

-- FTS5: Suche über Keywords (Stufe 1 + 4)
CREATE VIRTUAL TABLE IF NOT EXISTS keywords_fts USING fts5(
  keyword, content='keywords', content_rowid='id', tokenize='unicode61'
);

-- FTS5: Suche über typische Fragen (Stufe 2)
CREATE VIRTUAL TABLE IF NOT EXISTS questions_fts USING fts5(
  question, content='questions', content_rowid='id', tokenize='unicode61'
);

-- Projekt-Zuordnung: Many-to-Many (Phase 1b)
CREATE TABLE IF NOT EXISTS article_projekte (
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  projekt TEXT NOT NULL,
  PRIMARY KEY (article_id, projekt)
);

-- Indizes
CREATE INDEX IF NOT EXISTS idx_articles_gemeinde ON articles(gemeinde);
CREATE INDEX IF NOT EXISTS idx_articles_bundesland ON articles(bundesland);
CREATE INDEX IF NOT EXISTS idx_articles_landkreis ON articles(landkreis);
CREATE INDEX IF NOT EXISTS idx_articles_ebene ON articles(ebene);
CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status);
CREATE INDEX IF NOT EXISTS idx_keywords_article ON keywords(article_id);
CREATE INDEX IF NOT EXISTS idx_questions_article ON questions(article_id);
CREATE INDEX IF NOT EXISTS idx_relations_article ON relations(article_id);
CREATE INDEX IF NOT EXISTS idx_article_projekte_projekt ON article_projekte(projekt);
CREATE INDEX IF NOT EXISTS idx_article_projekte_article ON article_projekte(article_id);

-- Seed: Gemeinden im GVV Raum Bad Boll
INSERT OR REPLACE INTO gemeinden (slug, name, gvv, kreis, land, land_kurz) VALUES
  ('bad-boll', 'Bad Boll', 'GVV Raum Bad Boll', 'Göppingen', 'Baden-Württemberg', 'BW'),
  ('aichelberg', 'Aichelberg', 'GVV Raum Bad Boll', 'Göppingen', 'Baden-Württemberg', 'BW'),
  ('duernau', 'Dürnau', 'GVV Raum Bad Boll', 'Göppingen', 'Baden-Württemberg', 'BW'),
  ('gammelshausen', 'Gammelshausen', 'GVV Raum Bad Boll', 'Göppingen', 'Baden-Württemberg', 'BW'),
  ('hattenhofen', 'Hattenhofen', 'GVV Raum Bad Boll', 'Göppingen', 'Baden-Württemberg', 'BW'),
  ('zell-ua', 'Zell u.A.', 'GVV Raum Bad Boll', 'Göppingen', 'Baden-Württemberg', 'BW');
