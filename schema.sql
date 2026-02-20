-- RAGSource D1 Schema
-- ARS-basierte Geo-Filterung (Amtlicher Regionalschlüssel, 12-stellig)

-- Haupttabelle: Artikel (Satzungen, Gesetze, Wiki-Einträge)
CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titel TEXT NOT NULL,
  land_ars TEXT,               -- '08' (2-stellig) oder NULL
  kreis_ars TEXT,              -- '08117' (5-stellig) oder NULL
  verband_ars TEXT,            -- '081175009' (9-stellig) oder NULL
  gemeinde_ars TEXT,           -- '081175009012' (12-stellig) oder NULL
  ebene TEXT NOT NULL,         -- gemeinde | verband | kreis | land | bund
  saule TEXT NOT NULL,         -- regelungsrahmen | wiki | lokal
  content TEXT NOT NULL,
  gueltig_ab TEXT,             -- ISO-Datum
  status TEXT NOT NULL DEFAULT 'published',
  dateipfad TEXT NOT NULL,     -- Originalpfad für Quellenangabe
  quelle TEXT,                 -- Rechtsgrundlage
  token_count INTEGER          -- Geschätzter Token-Verbrauch
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

-- Gemeinde-Hierarchie Lookup (PK = ARS 12-stellig)
CREATE TABLE IF NOT EXISTS gemeinden (
  ars TEXT PRIMARY KEY,        -- 12-stellig (Gemeinde-ARS)
  slug TEXT NOT NULL,          -- Frontmatter-Slug, z.B. 'bad-boll'
  name TEXT NOT NULL,
  verband TEXT,                -- Klarname, z.B. 'GVV Raum Bad Boll'
  verband_ars TEXT,            -- 9-stellig
  kreis TEXT NOT NULL,
  kreis_ars TEXT NOT NULL,     -- 5-stellig
  land TEXT NOT NULL,
  land_ars TEXT NOT NULL,      -- 2-stellig
  land_kurz TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gemeinden_slug ON gemeinden(slug);

-- Geo-Alias-Tabelle: Normalisierung von Eingaben → ARS
CREATE TABLE IF NOT EXISTS geo_aliases (
  alias TEXT NOT NULL,         -- Eingabe-String (lowercase)
  typ   TEXT NOT NULL,         -- 'bundesland' | 'landkreis' | 'gemeinde' | 'verband'
  ars   TEXT NOT NULL,         -- kanonischer ARS
  PRIMARY KEY (alias, typ)
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

-- Projekt-Zuordnung: Many-to-Many
CREATE TABLE IF NOT EXISTS article_projekte (
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  projekt TEXT NOT NULL,
  PRIMARY KEY (article_id, projekt)
);

-- Indizes
CREATE INDEX IF NOT EXISTS idx_articles_land_ars ON articles(land_ars);
CREATE INDEX IF NOT EXISTS idx_articles_kreis_ars ON articles(kreis_ars);
CREATE INDEX IF NOT EXISTS idx_articles_verband_ars ON articles(verband_ars);
CREATE INDEX IF NOT EXISTS idx_articles_gemeinde_ars ON articles(gemeinde_ars);
CREATE INDEX IF NOT EXISTS idx_articles_ebene ON articles(ebene);
CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status);
CREATE INDEX IF NOT EXISTS idx_keywords_article ON keywords(article_id);
CREATE INDEX IF NOT EXISTS idx_questions_article ON questions(article_id);
CREATE INDEX IF NOT EXISTS idx_relations_article ON relations(article_id);
CREATE INDEX IF NOT EXISTS idx_article_projekte_projekt ON article_projekte(projekt);
CREATE INDEX IF NOT EXISTS idx_article_projekte_article ON article_projekte(article_id);

-- Seed: Gemeinden im GVV Raum Bad Boll
INSERT OR REPLACE INTO gemeinden (ars, slug, name, verband, verband_ars, kreis, kreis_ars, land, land_ars, land_kurz) VALUES
  ('081175009012', 'bad-boll', 'Bad Boll', 'GVV Raum Bad Boll', '081175009', 'Göppingen', '08117', 'Baden-Württemberg', '08', 'BW'),
  ('081175009002', 'aichelberg', 'Aichelberg', 'GVV Raum Bad Boll', '081175009', 'Göppingen', '08117', 'Baden-Württemberg', '08', 'BW'),
  ('081175009017', 'duernau', 'Dürnau', 'GVV Raum Bad Boll', '081175009', 'Göppingen', '08117', 'Baden-Württemberg', '08', 'BW'),
  ('081175009023', 'gammelshausen', 'Gammelshausen', 'GVV Raum Bad Boll', '081175009', 'Göppingen', '08117', 'Baden-Württemberg', '08', 'BW'),
  ('081175009029', 'hattenhofen', 'Hattenhofen', 'GVV Raum Bad Boll', '081175009', 'Göppingen', '08117', 'Baden-Württemberg', '08', 'BW'),
  ('081175009060', 'zell-ua', 'Zell u.A.', 'GVV Raum Bad Boll', '081175009', 'Göppingen', '08117', 'Baden-Württemberg', '08', 'BW');

-- Seed: Geo-Aliases für Normalisierung
INSERT OR REPLACE INTO geo_aliases (alias, typ, ars) VALUES
  -- Bundesland BW
  ('bw', 'bundesland', '08'),
  ('08', 'bundesland', '08'),
  ('baden-württemberg', 'bundesland', '08'),
  ('badenwürttemberg', 'bundesland', '08'),
  ('badenwuerttemberg', 'bundesland', '08'),
  ('baden wuerttemberg', 'bundesland', '08'),
  ('baden württemberg', 'bundesland', '08'),
  -- Landkreis Göppingen
  ('goeppingen', 'landkreis', '08117'),
  ('göppingen', 'landkreis', '08117'),
  ('gp', 'landkreis', '08117'),
  ('08117', 'landkreis', '08117'),
  ('landkreis göppingen', 'landkreis', '08117'),
  ('landkreis goeppingen', 'landkreis', '08117'),
  ('lkr göppingen', 'landkreis', '08117'),
  ('lkr goeppingen', 'landkreis', '08117'),
  -- Verband Bad Boll
  ('gvv-bad-boll', 'verband', '081175009'),
  ('gvv bad boll', 'verband', '081175009'),
  ('gvv raum bad boll', 'verband', '081175009'),
  ('081175009', 'verband', '081175009'),
  -- Gemeinde Bad Boll
  ('bad-boll', 'gemeinde', '081175009012'),
  ('bad boll', 'gemeinde', '081175009012'),
  ('081175009012', 'gemeinde', '081175009012'),
  -- Gemeinde Aichelberg
  ('aichelberg', 'gemeinde', '081175009002'),
  ('081175009002', 'gemeinde', '081175009002'),
  -- Gemeinde Dürnau
  ('duernau', 'gemeinde', '081175009017'),
  ('dürnau', 'gemeinde', '081175009017'),
  ('081175009017', 'gemeinde', '081175009017'),
  -- Gemeinde Gammelshausen
  ('gammelshausen', 'gemeinde', '081175009023'),
  ('081175009023', 'gemeinde', '081175009023'),
  -- Gemeinde Hattenhofen
  ('hattenhofen', 'gemeinde', '081175009029'),
  ('081175009029', 'gemeinde', '081175009029'),
  -- Gemeinde Zell u.A.
  ('zell-ua', 'gemeinde', '081175009060'),
  ('zell ua', 'gemeinde', '081175009060'),
  ('zell u.a.', 'gemeinde', '081175009060'),
  ('zell unter aichelberg', 'gemeinde', '081175009060'),
  ('081175009060', 'gemeinde', '081175009060');
