// RAGSource Server Types

export interface Env {
  DB: D1Database;
  MCP_OBJECT: DurableObjectNamespace;
}

// --- Datenbank-Entities ---

export interface Article {
  id: number;
  titel: string;
  gemeinde: string | null;
  bundesland: string | null;   // Phase 1b: 'bw', 'by', etc.
  landkreis: string | null;    // Phase 1b: 'goeppingen', etc.
  ebene: Ebene;
  saule: Saule;
  content: string;
  gueltig_ab: string | null;
  status: string;
  dateipfad: string;
  quelle: string | null;
  token_count: number | null;
}

export type Ebene = "gemeinde" | "gvv" | "kreis" | "land" | "bund";
export type Saule = "regelungsrahmen" | "wiki" | "lokal";
export type Persona = "buerger" | "gemeinderat" | "verwaltung" | "buergermeister";

export interface Gemeinde {
  slug: string;
  name: string;
  gvv: string | null;
  kreis: string;
  land: string;
  land_kurz: string;
}

// --- Retrieval ---

export interface ScoredArticle extends Article {
  score: number;
}

export interface QueryParams {
  query: string;
  gemeinde?: string;            // Phase 1b: jetzt optional
  bundesland?: string;          // Phase 1b: 'bw', 'by', etc.
  landkreis?: string;           // Phase 1b: 'goeppingen', etc.
  projekt?: string;             // Phase 1b: 'amtsschimmel', 'brandmeister', etc.
  persona: Persona;
  hints?: string[];
  sources?: string[];
}

// --- Response-Paket (an LLM) ---

export interface ResponsePacket {
  articles: ArticleResult[];
  persona: PersonaConfig;
  gemeinde: GemeindeInfo;
  hierarchy: HierarchyInfo;
  disclaimer: string;
}

export interface ArticleResult {
  titel: string;
  ebene: Ebene;
  saule: Saule;
  score: number;
  content: string;
  dateipfad: string;
  quelle: string | null;
}

export interface PersonaConfig {
  rolle: Persona;
  sprache: "einfach" | "fachsprache";
  max_satzlaenge: number;
  fachsprache: boolean;
  format: "service" | "briefing" | "fachlich" | "erklaerend";
  kontaktdaten_anzeigen: boolean;
}

export interface GemeindeInfo {
  name: string;
  gvv: string | null;
  kreis: string;
  land: string;
}

export interface HierarchyInfo {
  conflicts: HierarchyConflict[];
}

export interface HierarchyConflict {
  thema: string;
  artikel_hoeher: string;
  artikel_niedriger: string;
  ebene_hoeher: Ebene;
  ebene_niedriger: Ebene;
}
