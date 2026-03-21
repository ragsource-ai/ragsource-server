// RAGSource Server Types v2 — Agentic RAG

// -----------------------------------------------------------------------
// Cloudflare Workers Bindings
// -----------------------------------------------------------------------

export interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  MCP_OBJECT: DurableObjectNamespace;
  CONFIG: KVNamespace;
  RATE_LIMITER: RateLimiter;
}

// -----------------------------------------------------------------------
// Datenbank-Entities
// -----------------------------------------------------------------------

/** Eine Rechtsquelle (Gesetz, Satzung, Verordnung) */
export interface Source {
  id: string;                   // "FwG_BW", "Feuerwehrsatzung_BadBoll"
  titel: string;
  kurzbezeichnung: string | null; // "FwG BW", "GemO BW"
  typ: string | null;           // "gesetz" | "satzung" | "verordnung" | "eu-recht"
  ebene: string | null;         // "bundesrecht" | "landesrecht-bw" | "ortsrecht-bad-boll"
  land_ars: string | null;
  kreis_ars: string | null;
  verband_ars: string | null;
  gemeinde_ars: string | null;
  section_count: number;        // Anzahl Paragraphen
  total_tokens: number;         // Gesamt-Token-Schätzung
  size_class: string;           // "small" | "medium" | "large"
  gueltig_ab: string | null;
  quelle: string | null;
  dateipfad: string | null;
  url: string | null;
  beschreibung: string | null;
  stand: string | null;
  rechtsrang: number | null;       // 1=Bundesrecht … 6=Tarifrecht
  rechtsrang_label: string | null; // "Bundesrecht", "Landesrecht BW", …
}

/** Ein Paragraph / Artikel / Erwägungsgrund */
export interface SourceSection {
  id: string;                   // "FwG_BW_§2", "DSGVO_Artikel6"
  source_id: string;
  section_ref: string;          // "§ 2", "Artikel 6", "Erwägungsgrund 40"
  heading: string | null;       // Titel ohne section_ref
  body: string;                 // Originalwortlaut
  section_type: string;         // "paragraph" | "artikel" | "erwaegungsgrund" | "kapitel"
  sort_order: number;
}

/** Inhaltsverzeichnis einer Rechtsquelle */
export interface SourceToc {
  id: string;
  source_id: string;
  toc_level: string;            // "gesamt" | "buch-1" etc.
  content: string;              // TOC als Markdown mit Stichworten in Klammern
}

// -----------------------------------------------------------------------
// Rückgabe-Typen der MCP-Tools
// -----------------------------------------------------------------------

/** Catalog-Eintrag (für RAGSource_catalog) */
export interface CatalogEntry {
  id: string;
  titel: string;
  typ: string | null;
  ebene: string | null;
  rechtsrang: number | null;        // 1=Bundesrecht … 6=Tarifrecht
  rechtsrang_label: string | null;  // "Bundesrecht", "Landesrecht BW", …
  size_class: string;
  toc_available: boolean;       // true wenn TOC in source_tocs vorhanden
  beschreibung: string | null;  // Kurzbeschreibung der Quelle
}

/** TOC-Ergebnis (für RAGSource_toc) */
export interface TocResult {
  source_id: string;
  titel: string;
  size_class: string;
  section_count: number;
  toc: string | null;           // null wenn noch kein TOC im Content
  sections?: SectionResult[];   // Fallback: alle §§ wenn toc=null (nur small/medium)
}

/** §-Ergebnis (für RAGSource_get) */
export interface SectionResult {
  ref: string;                  // "§ 2"
  heading: string | null;       // Abschnittstitel
  body: string;                 // Originalwortlaut
}

/** Query-Treffer (für RAGSource_query) */
export interface QueryHit {
  source_id: string;
  titel: string;
  ebene: string | null;
  size_class: string;
  section_ref: string;
  heading: string | null;
  body: string;
}
