import type { Persona } from "../types.js";

export interface RetrievalConfig {
  min_score: number;
  max_articles: number;
  token_budget: number;
  score_gap_threshold: number;
}

const DEFAULT_CONFIG: RetrievalConfig = {
  min_score: 0.2,
  max_articles: 5,
  token_budget: 15000,
  score_gap_threshold: 0.3,
};

const PERSONA_OVERRIDES: Record<Persona, Partial<RetrievalConfig>> = {
  buerger: { min_score: 0.3, token_budget: 10000, max_articles: 3 },
  gemeinderat: { min_score: 0.2, token_budget: 15000, max_articles: 4 },
  verwaltung: { min_score: 0.15, token_budget: 20000, max_articles: 5 },
  buergermeister: { min_score: 0.15, token_budget: 20000, max_articles: 5 },
};

export function getRetrievalConfig(persona: Persona): RetrievalConfig {
  return { ...DEFAULT_CONFIG, ...PERSONA_OVERRIDES[persona] };
}

// Score-Gewichtung für die 4 Retrieval-Stufen
export const SCORE_WEIGHTS = {
  content: 0.3,    // Stufe 1: FTS5 über Titel + Content
  question: 0.4,   // Stufe 2: FTS5 über Fragen (höchste Gewichtung)
  hints: 0.15,     // Stufe 4: FTS5 über LLM-Hints
  title: 0.15,     // Stufe 5: Titel-Match über LLM-Sources
};

export const DISCLAIMER =
  "KI-generiert, keine Rechtsberatung. Alle Angaben ohne Gewähr. " +
  "Für verbindliche Auskünfte wenden Sie sich an die zuständige Behörde.";
