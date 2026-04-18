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
-- Staging-Tabellen (Input der Importer, nicht direkt vom LLM abrufbar)
-- -----------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS db_bam (
  bamnr     TEXT PRIMARY KEY,
  cas       TEXT,
  bezeichnung_de TEXT,
  spezifik  TEXT,
  un_nr     TEXT,
  klasse    TEXT,
  vpgruppe  TEXT,
  tunnelcode TEXT,
  gefahrnr  TEXT,
  stand     TEXT
);
CREATE INDEX IF NOT EXISTS idx_bam_unnr ON db_bam(un_nr);
CREATE INDEX IF NOT EXISTS idx_bam_cas  ON db_bam(cas);

CREATE TABLE IF NOT EXISTS db_rigoletto (
  kenn_nr    TEXT PRIMARY KEY,
  cas        TEXT,
  bezeichnung_de TEXT,
  bezeichnung_en TEXT,
  eg_nr      TEXT,
  wgk        TEXT,
  wgk_zahl   INTEGER,
  stand      TEXT
);
CREATE INDEX IF NOT EXISTS idx_rigoletto_cas ON db_rigoletto(cas);
CREATE INDEX IF NOT EXISTS idx_rigoletto_wgk ON db_rigoletto(wgk_zahl);

CREATE TABLE IF NOT EXISTS db_trgs900 (
  cas        TEXT PRIMARY KEY,
  bezeichnung TEXT,
  eg_nr      TEXT,
  agw_ppm    TEXT,
  agw_mg_m3  TEXT,
  art        TEXT,
  ueberschreitungsfaktor TEXT,
  quelle     TEXT,
  aenderungsdatum TEXT,
  stand      TEXT
);
CREATE INDEX IF NOT EXISTS idx_trgs900_cas ON db_trgs900(cas);

CREATE TABLE IF NOT EXISTS db_pubchem (
  cid        TEXT PRIMARY KEY,
  cas        TEXT,                   -- primäre CAS (erste gefundene)
  ghs_signal TEXT,                   -- "Warning" / "Danger"
  ghs_hazards TEXT,                  -- H-Codes kommagetrennt: "H225,H302,H315"
  ghs_precautionary TEXT,            -- P-Code-Kürzel kommagetrennt
  idlh       TEXT,                   -- Immediately Dangerous to Life or Health
  niosh_rel_twa TEXT,
  niosh_rel_stel TEXT,
  osha_pel   TEXT,
  stand      TEXT
);
CREATE INDEX IF NOT EXISTS idx_pubchem_cas ON db_pubchem(cas);

-- -----------------------------------------------------------------------
-- db_gefahrstoff — konsolidiertes Stoff-Profil (Join per CAS)
-- Spalten spaltenattribuiert: Präfix = Quelle
-- Verbindlichkeitslevel: bam_/rigoletto_/trgs900_ = DE-verbindlich; pubchem_ = US-orientierend
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS db_gefahrstoff (
  cas TEXT PRIMARY KEY,
  un_nr TEXT,                          -- von BAM (primäre UN-Nr)
  bezeichnung_de TEXT,                 -- von BAM (DE-Name)
  bezeichnung_en TEXT,                 -- von Rigoletto oder PubChem
  aliases_json TEXT,                   -- Synonyme aus BAM + Rigoletto (JSON-Array)

  -- BAM DGG (Transport-Regulatorik DE, § 5 UrhG)
  bam_klasse TEXT,
  bam_vpgruppe TEXT,
  bam_tunnelcode TEXT,
  bam_gefahrnr TEXT,
  bam_stand TEXT,

  -- Rigoletto / UBA (Wassergefährdungsklassen nach AwSV, dl-de/by-2-0)
  rigoletto_wgk INTEGER,               -- 0=nwg, 1-3
  rigoletto_wgk_text TEXT,             -- "WGK 1" / "WGK 2" / "WGK 3" / "nwg"
  rigoletto_stand TEXT,

  -- PubChem (NIOSH-Daten via PubChem LCSS, US Gov Work, gemeinfrei)
  pubchem_cid TEXT,
  pubchem_ghs_signal TEXT,             -- "Warning" / "Danger"
  pubchem_ghs_hazards TEXT,            -- H-Codes: "H225,H302,H315"
  pubchem_idlh TEXT,                   -- IDLH-Wert (z.B. "200 ppm")
  pubchem_niosh_rel_twa TEXT,          -- NIOSH REL TWA
  pubchem_niosh_rel_stel TEXT,         -- NIOSH REL STEL
  pubchem_osha_pel TEXT,               -- OSHA PEL TWA
  pubchem_stand TEXT,

  -- TRGS 900 (DE Luftgrenzwerte, § 5 UrhG amtliches Werk)
  trgs900_agw_ppm TEXT,
  trgs900_agw_mg_m3 TEXT,
  trgs900_art TEXT,                    -- "AGW" / "MAK" / "H"
  trgs900_stand TEXT,

  -- ERG 2024 (Phase G5 — Platzhalter)
  erg_guide_nr TEXT,
  erg_abstand_klein_m INTEGER,
  erg_abstand_gross_m INTEGER,
  erg_stand TEXT
);

CREATE INDEX IF NOT EXISTS idx_gefahrstoff_un ON db_gefahrstoff(un_nr);
CREATE INDEX IF NOT EXISTS idx_gefahrstoff_bezeichnung ON db_gefahrstoff(bezeichnung_de);
CREATE INDEX IF NOT EXISTS idx_gefahrstoff_wgk ON db_gefahrstoff(rigoletto_wgk);
CREATE INDEX IF NOT EXISTS idx_gefahrstoff_ghs ON db_gefahrstoff(pubchem_ghs_signal);

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
  quelle TEXT,                      -- 'BAM' | 'Rigoletto' | 'kuratiert'
  PRIMARY KEY (alias_norm, cas)
);

CREATE INDEX IF NOT EXISTS idx_stoff_aliases_cas ON db_stoff_aliases(cas);
CREATE INDEX IF NOT EXISTS idx_stoff_aliases_typ ON db_stoff_aliases(alias_typ);

-- -----------------------------------------------------------------------
-- db_uebergabe_regeln — DE-spezifische Handlungsableitung nach Einsatz
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
