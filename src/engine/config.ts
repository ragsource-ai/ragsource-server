import type { Persona } from "../types.js";

export interface RetrievalConfig {
  min_score: number;
  max_articles: number;
  token_budget: number;
  score_gap_threshold: number;
}

const DEFAULT_CONFIG: RetrievalConfig = {
  min_score: 0.15,
  max_articles: 5,
  token_budget: 40000,
  score_gap_threshold: 0.3,
};

// Retrieval-Filter sind für alle Personas gleich.
// Der Unterschied liegt im Antwort-Prompt (Sprache, Format, Detailtiefe).
const PERSONA_OVERRIDES: Record<Persona, Partial<RetrievalConfig>> = {
  buerger: { max_articles: 3 },
  gemeinderat: { max_articles: 4 },
  verwaltung: {},
  buergermeister: {},
};

export function getRetrievalConfig(persona: Persona): RetrievalConfig {
  return { ...DEFAULT_CONFIG, ...PERSONA_OVERRIDES[persona] };
}

// Score-Gewichtung für die 5 Retrieval-Stufen
export const SCORE_WEIGHTS = {
  content: 0.35,   // Stufe 1: FTS5 über Titel + Content
  question: 0.2,   // Stufe 2: FTS5 über Fragen
  keyword: 0.2,    // Stufe 3: FTS5 über Keywords (aus Frontmatter)
  hints: 0.15,     // Stufe 4: FTS5 über LLM-Hints
  title: 0.1,      // Stufe 5: Titel-Match über LLM-Sources
};

export const DISCLAIMER =
  "KI-generiert, keine Rechtsberatung. Alle Angaben ohne Gewähr. " +
  "Für verbindliche Auskünfte wenden Sie sich an die zuständige Behörde.";
