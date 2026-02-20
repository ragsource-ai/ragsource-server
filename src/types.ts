// RAGSource Server Types

export interface Env {
  DB: D1Database;
  MCP_OBJECT: DurableObjectNamespace;
}

// --- Datenbank-Entities ---

export interface Article {
  id: number;
  titel: string;
  land_ars: string | null;
  kreis_ars: string | null;
  verband_ars: string | null;
  gemeinde_ars: string | null;
  ebene: Ebene;
  saule: Saule;
  content: string;
  gueltig_ab: string | null;
  status: string;
  dateipfad: string;
  quelle: string | null;
  token_count: number | null;
}

export type Ebene = "gemeinde" | "verband" | "kreis" | "land" | "bund";
export type Saule = "regelungsrahmen" | "wiki" | "lokal";
export type Persona = "buerger" | "gemeinderat" | "verwaltung" | "buergermeister";

export interface Gemeinde {
  ars: string;            // PK, 12-stellig
  slug: string;
  name: string;
  verband: string | null;
  verband_ars: string | null;
  kreis: string;
  kreis_ars: string;
  land: string;
  land_ars: string;
  land_kurz: string;
}

export interface GeoAlias {
  alias: string;
  typ: 'bundesland' | 'landkreis' | 'gemeinde' | 'verband';
  ars: string;
}

// --- Retrieval ---

export interface ScoredArticle extends Article {
  score: number;
}

export interface QueryParams {
  query: string;
  gemeinde_ars?: string;
  kreis_ars?: string;
  verband_ars?: string;
  land_ars?: string;
  geo_level?: "gemeinde" | "verband" | "kreis" | "land";
  projekt?: string;
  persona: Persona;
  hints?: string[];
  sources?: string[];
}

// --- Response-Paket (an LLM) ---

export interface ResponsePacket {
  articles: ArticleResult[];
  persona: PersonaConfig;
  geo: GeoInfo;
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

export interface GeoInfo {
  level: "gemeinde" | "verband" | "kreis" | "land" | "alle";
  name: string;
  verband: string | null;
  kreis: string | null;
  land: string | null;
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
