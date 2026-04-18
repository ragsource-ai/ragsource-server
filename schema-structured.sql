-- RAGSource D1 Structured DB Schema — Tabellarische Datenbestände
-- Gebunden als env.DB_STRUCTURED
-- Neue DB eintragen: Zeile in rag_databases + Tabelle anlegen. Kein Code-Deploy nötig.

-- -----------------------------------------------------------------------
-- Meta-Tabelle: Registry aller strukturierten Datenbanken
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rag_databases (
  db TEXT PRIMARY KEY,              -- "gefahrstoff", "uebergabe_regeln"
  beschreibung TEXT NOT NULL,
  stand TEXT,
  verbindlichkeit TEXT,             -- "rechtsverbindlich_DE" | "orientierung_US" | "kuratiert"
  quelle_url_template TEXT,         -- z.B. "https://dgg.bam.de/?un={un_nr}" (für Quellenlink)
  lookup_keys TEXT NOT NULL,        -- JSON: {"un_nr":"exact","cas":"exact","bezeichnung":"like"}
  columns TEXT NOT NULL,            -- JSON: [{"name":"un_nr","typ":"TEXT"},...]
  endpoints TEXT,                   -- JSON: ["brandmeister"] oder NULL (universell)
  tenant_note TEXT                  -- Attributions-/Lizenzhinweis
);

-- -----------------------------------------------------------------------
-- db_gefahrstoff — konsolidiertes Stoff-Profil (Join per CAS aus mehreren Quellen)
-- Spalten spaltenattribuiert: Präfix = Quelle (bam_, rigoletto_, niosh_, erg_, cameo_, trgs900_)
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS db_gefahrstoff (
  cas TEXT PRIMARY KEY,
  un_nr TEXT,                          -- von BAM
  bezeichnung_de TEXT,                 -- von BAM
  bezeichnung_en TEXT,                 -- von NIOSH
  aliases_json TEXT,                   -- BAM + NIOSH Synonyme (JSON-Array)

  -- BAM DGG (Transport-Regulatorik, DL-DE-BY-2.0)
  bam_klasse TEXT,
  bam_verpackungsgruppe TEXT,
  bam_tunnelcode TEXT,
  bam_sondervorschriften TEXT,
  bam_stand TEXT,

  -- Rigoletto / UBA (Wassergefährdungsklassen)
  rigoletto_wgk INTEGER,
  rigoletto_rechtsgrundlage TEXT,
  rigoletto_stand TEXT,

  -- NIOSH Pocket Guide (PSA, Gesundheit, Inkompatibilität — US Gov Work, gemeinfrei)
  niosh_rel TEXT,
  niosh_idlh TEXT,
  niosh_psa TEXT,
  niosh_first_aid TEXT,
  niosh_incompatibilities TEXT,
  niosh_symptoms TEXT,
  niosh_flammpunkt_c REAL,
  niosh_explosionsgrenzen TEXT,
  niosh_stand TEXT,

  -- ERG 2024 (Ersteinsatz, via UN-Nr verknüpft, DE-Übersetzung — US Gov Work)
  erg_guide_nr TEXT,
  erg_abstand_klein_m INTEGER,
  erg_abstand_gross_m INTEGER,
  erg_loeschmittel TEXT,
  erg_evakuierung_m INTEGER,
  erg_stand TEXT,

  -- CAMEO Chemicals (Reaktivität)
  cameo_reactivity_flags TEXT,
  cameo_stand TEXT,

  -- TRGS 900 (DE-Arbeitsplatzgrenzwerte, amtliches Werk § 5 UrhG)
  trgs900_agw TEXT,
  trgs900_spitzenbegrenzung TEXT,
  trgs900_stand TEXT
);

CREATE INDEX IF NOT EXISTS idx_gefahrstoff_un ON db_gefahrstoff(un_nr);
CREATE INDEX IF NOT EXISTS idx_gefahrstoff_bezeichnung ON db_gefahrstoff(bezeichnung_de);
CREATE INDEX IF NOT EXISTS idx_gefahrstoff_wgk ON db_gefahrstoff(rigoletto_wgk);

-- FTS5 auf Bezeichnungen (für Freitext-Suche nach Stoffname)
CREATE VIRTUAL TABLE IF NOT EXISTS db_gefahrstoff_fts USING fts5(
  bezeichnung_de,
  bezeichnung_en,
  aliases_json,
  content='db_gefahrstoff',
  content_rowid='rowid',
  tokenize='unicode61'
);

-- -----------------------------------------------------------------------
-- db_stoff_aliases — Eingangs-Lookup (Alias → CAS)
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS db_stoff_aliases (
  alias_norm TEXT NOT NULL,         -- lowercased, Umlaut-normalisiert
  alias_typ TEXT NOT NULL,          -- 'un_nr' | 'cas' | 'synonym' | 'handelsname'
  cas TEXT NOT NULL,                -- Zielschlüssel in db_gefahrstoff
  quelle TEXT,                      -- 'BAM' | 'NIOSH' | 'kuratiert'
  PRIMARY KEY (alias_norm, cas)
);

CREATE INDEX IF NOT EXISTS idx_stoff_aliases_cas ON db_stoff_aliases(cas);
CREATE INDEX IF NOT EXISTS idx_stoff_aliases_typ ON db_stoff_aliases(alias_typ);

-- -----------------------------------------------------------------------
-- db_uebergabe_regeln — DE-spezifische Handlungsableitung nach Einsatz
-- Redaktionelle Kernleistung: Matrix WGK × Stoffklasse (ca. 30–50 Zeilen)
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS db_uebergabe_regeln (
  wgk INTEGER NOT NULL,
  stoffklasse TEXT NOT NULL,                -- BAM-Klasse: "3", "6.1", "8", "nicht_wgk", ...
  kanalisation_freigabe TEXT,               -- "nein" | "nur nach UWB-Freigabe" | "ja"
  kanalisation_bedingungen TEXT,
  avv_schluessel_primaer TEXT,              -- z.B. "13 07 01"
  entsorgungspfad TEXT,                     -- "kommunaler_bauhof" | "fachentsorger"
  benachrichtigung_pflicht TEXT,            -- JSON: ["untere_wasserbehoerde", "leitstelle", ...]
  benachrichtigung_schwelle_liter INTEGER,
  rechtsgrundlage_source_id TEXT,           -- Verweis in Agentic-Schicht, z.B. "D_AwSV"
  rechtsgrundlage_section_ref TEXT,         -- z.B. "§ 18"
  stand TEXT,
  PRIMARY KEY (wgk, stoffklasse)
);
