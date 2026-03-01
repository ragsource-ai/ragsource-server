-- RAGSource D1 Schema v2 — Agentic RAG
-- Hierarchische Suche: Catalog → TOC → Paragraphen (statt Vollartikel)

-- -----------------------------------------------------------------------
-- Rechtsquellen-Catalog (eine Datei = eine Rechtsquelle)
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,          -- "FwG_BW", "Feuerwehrsatzung_BadBoll"
  titel TEXT NOT NULL,
  kurzbezeichnung TEXT,         -- "FwG BW", "GemO BW", "DSGVO"
  typ TEXT,                     -- "gesetz" | "satzung" | "verordnung" | "eu-recht"
  ebene TEXT,                   -- "bundesrecht" | "landesrecht-bw" | "ortsrecht-bad-boll" etc.
  land_ars TEXT,                -- '08' (2-stellig) oder NULL
  kreis_ars TEXT,               -- '08117' (5-stellig) oder NULL
  verband_ars TEXT,             -- '081175009' (9-stellig) oder NULL
  gemeinde_ars TEXT,            -- '081175009012' (12-stellig) oder NULL
  section_count INTEGER,        -- Anzahl Paragraphen (für LLM-Routing)
  total_tokens INTEGER,         -- Gesamt-Token-Zahl (für LLM-Routing)
  size_class TEXT,              -- "small" | "medium" | "large"
  gueltig_ab TEXT,              -- ISO-Datum
  quelle TEXT,                  -- Rechtsgrundlage / Fundstelle
  dateipfad TEXT,               -- Originalpfad (relativ zum Content-Root)
  url TEXT,                     -- Quell-URL (z.B. https://www.gesetze-im-internet.de/...)
  beschreibung TEXT,            -- Kurzbeschreibung für Catalog (1-2 Sätze)
  stand TEXT                    -- Datum der letzten inhaltlichen Änderung (ISO-Datum)
);

CREATE INDEX IF NOT EXISTS idx_sources_ebene ON sources(ebene);
CREATE INDEX IF NOT EXISTS idx_sources_land_ars ON sources(land_ars);
CREATE INDEX IF NOT EXISTS idx_sources_kreis_ars ON sources(kreis_ars);
CREATE INDEX IF NOT EXISTS idx_sources_verband_ars ON sources(verband_ars);
CREATE INDEX IF NOT EXISTS idx_sources_gemeinde_ars ON sources(gemeinde_ars);
CREATE INDEX IF NOT EXISTS idx_sources_size_class ON sources(size_class);

-- -----------------------------------------------------------------------
-- Projekt-Zuordnung (Mandantenfähigkeit: amtsschimmel, brandmeister etc.)
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS source_projekte (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  projekt TEXT NOT NULL,
  PRIMARY KEY (source_id, projekt)
);
CREATE INDEX IF NOT EXISTS idx_source_projekte_projekt ON source_projekte(projekt);

-- -----------------------------------------------------------------------
-- Inhaltsverzeichnisse (aus Markdown extrahiert oder manuell kuratiert)
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS source_tocs (
  id TEXT PRIMARY KEY,                   -- "FwG_BW_toc" oder "BGB_Buch2_toc"
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  toc_level TEXT NOT NULL DEFAULT 'gesamt', -- "gesamt" | "buch-1" | "buch-2" etc.
  content TEXT NOT NULL                  -- TOC als Markdown (mit Stichworten in Klammern)
);
CREATE INDEX IF NOT EXISTS idx_source_tocs_source ON source_tocs(source_id);

-- -----------------------------------------------------------------------
-- Einzelne Paragraphen / Artikel / Erwägungsgründe
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS source_sections (
  id TEXT PRIMARY KEY,              -- "FwG_BW_§2", "DSGVO_Art6", "DSGVO_EG40"
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  section_ref TEXT NOT NULL,        -- "§ 2", "Art. 6", "EG 40"
  heading TEXT,                     -- "Aufgaben der Gemeindefeuerwehr" (ohne section_ref)
  body TEXT NOT NULL,               -- Originalwortlaut (ohne Heading-Zeile)
  section_type TEXT,                -- "paragraph" | "artikel" | "erwaegungsgrund"
  sort_order INTEGER NOT NULL       -- Reihenfolge innerhalb der Quelle
);

CREATE INDEX IF NOT EXISTS idx_sections_source ON source_sections(source_id);
CREATE INDEX IF NOT EXISTS idx_sections_ref ON source_sections(section_ref);
CREATE INDEX IF NOT EXISTS idx_sections_sort ON source_sections(source_id, sort_order);

-- FTS5 auf Paragraphen-Ebene (body + heading, unicode61-Tokenizer)
CREATE VIRTUAL TABLE IF NOT EXISTS sections_fts USING fts5(
  body,
  heading,
  content='source_sections',
  content_rowid='rowid',
  tokenize='unicode61'
);

-- -----------------------------------------------------------------------
-- Querverweise zwischen Rechtsquellen
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS source_relations (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  related_source_id TEXT NOT NULL,
  relation_type TEXT,               -- "ergaenzt" | "konkretisiert" | "aufgehoben_durch"
  PRIMARY KEY (source_id, related_source_id)
);

-- -----------------------------------------------------------------------
-- Gemeinde-Hierarchie Lookup (aus v1 unverändert übernommen)
-- -----------------------------------------------------------------------
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

-- -----------------------------------------------------------------------
-- Geo-Alias-Tabelle (aus v1 unverändert übernommen)
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS geo_aliases (
  alias TEXT NOT NULL,         -- Eingabe-String (lowercase)
  typ   TEXT NOT NULL,         -- 'bundesland' | 'landkreis' | 'gemeinde' | 'verband'
  ars   TEXT NOT NULL,         -- kanonischer ARS
  PRIMARY KEY (alias, typ)
);

-- -----------------------------------------------------------------------
-- Seed: Gemeinden im GVV Raum Bad Boll (aus v1 unverändert)
-- -----------------------------------------------------------------------
INSERT OR REPLACE INTO gemeinden (ars, slug, name, verband, verband_ars, kreis, kreis_ars, land, land_ars, land_kurz) VALUES
  ('081175009012', 'bad-boll', 'Bad Boll', 'GVV Raum Bad Boll', '081175009', 'Göppingen', '08117', 'Baden-Württemberg', '08', 'BW'),
  ('081175009002', 'aichelberg', 'Aichelberg', 'GVV Raum Bad Boll', '081175009', 'Göppingen', '08117', 'Baden-Württemberg', '08', 'BW'),
  ('081175009017', 'duernau', 'Dürnau', 'GVV Raum Bad Boll', '081175009', 'Göppingen', '08117', 'Baden-Württemberg', '08', 'BW'),
  ('081175009023', 'gammelshausen', 'Gammelshausen', 'GVV Raum Bad Boll', '081175009', 'Göppingen', '08117', 'Baden-Württemberg', '08', 'BW'),
  ('081175009029', 'hattenhofen', 'Hattenhofen', 'GVV Raum Bad Boll', '081175009', 'Göppingen', '08117', 'Baden-Württemberg', '08', 'BW'),
  ('081175009060', 'zell-ua', 'Zell u.A.', 'GVV Raum Bad Boll', '081175009', 'Göppingen', '08117', 'Baden-Württemberg', '08', 'BW');

-- -----------------------------------------------------------------------
-- Seed: Geo-Aliases (aus v1 unverändert)
-- -----------------------------------------------------------------------
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
