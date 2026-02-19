import type { Env, ScoredArticle, QueryParams, Ebene } from "../types.js";
import { SCORE_WEIGHTS, getRetrievalConfig } from "./config.js";

interface CandidateScores {
  [articleId: number]: {
    content: number;
    question: number;
    hints: number;
    title: number;
  };
}

/**
 * Geo- und Projekt-Filter: Baut dynamisch SQL-WHERE-Fragmente.
 *
 * Alle Filter sind optional. Wenn nichts gesetzt ist, wird nur
 * `a.status = 'published'` geprüft (Phase 1a-Verhalten).
 */
interface FilterResult {
  sql: string;      // SQL WHERE-Fragment (ohne führendes AND)
  params: any[];    // Bind-Parameter in korrekter Reihenfolge
}

function buildGeoProjectFilter(params: QueryParams): FilterResult {
  const conditions: string[] = ["a.status = 'published'"];
  const bindParams: any[] = [];

  // --- Geo-Filter (unabhängig, kaskadierend) ---

  if (params.gemeinde) {
    // Gemeinde-Filter: Artikel auf höheren Ebenen passieren immer durch.
    // Auf Gemeinde-Ebene muss der Slug matchen oder NULL sein.
    conditions.push(
      "(a.ebene IN ('bund', 'land', 'kreis', 'gvv') OR a.gemeinde = ? OR a.gemeinde IS NULL)"
    );
    bindParams.push(params.gemeinde);
  }

  if (params.landkreis) {
    // Landkreis-Filter: Bund + Land passieren. Kreis/GVV/Gemeinde müssen matchen.
    conditions.push(
      "(a.ebene IN ('bund', 'land') OR a.landkreis = ? OR a.landkreis IS NULL)"
    );
    bindParams.push(params.landkreis);
  }

  if (params.bundesland) {
    // Bundesland-Filter: Bund passiert. Land/Kreis/GVV/Gemeinde müssen matchen.
    conditions.push(
      "(a.ebene = 'bund' OR a.bundesland = ? OR a.bundesland IS NULL)"
    );
    bindParams.push(params.bundesland);
  }

  // --- Projekt-Filter ---

  if (params.projekt) {
    // Regelungsrahmen: projektrelevante Artikel + universelle (kein Eintrag in article_projekte)
    // Wiki: nur Artikel mit passendem Projekt (Pflicht-Zuordnung)
    // Lokal: behandeln wie Regelungsrahmen
    conditions.push(
      `(
        (a.saule IN ('regelungsrahmen', 'lokal') AND (
          EXISTS (SELECT 1 FROM article_projekte ap WHERE ap.article_id = a.id AND ap.projekt = ?)
          OR NOT EXISTS (SELECT 1 FROM article_projekte ap WHERE ap.article_id = a.id)
        ))
        OR (a.saule = 'wiki' AND EXISTS (
          SELECT 1 FROM article_projekte ap WHERE ap.article_id = a.id AND ap.projekt = ?
        ))
      )`
    );
    bindParams.push(params.projekt, params.projekt);
  }

  return {
    sql: conditions.join("\n         AND "),
    params: bindParams,
  };
}

/**
 * 4-Stufen-Retrieval (Phase 1b, mit Geo- und Projekt-Filtern)
 *
 * Stufe 1: FTS5 über articles_fts (Titel + Content)
 * Stufe 2: FTS5 über questions_fts (typische Fragen)
 * Stufe 4: FTS5 über articles_fts mit LLM-Hints
 * Stufe 5: Titel-Match über LLM-Sources
 */
export async function search(
  db: D1Database,
  params: QueryParams,
): Promise<ScoredArticle[]> {
  const candidates: CandidateScores = {};

  // Filter einmal bauen, in allen Stufen wiederverwenden
  const filter = buildGeoProjectFilter(params);

  // --- Stufe 1: FTS5 über Titel + Content ---
  const ftsQuery = sanitizeFtsQuery(params.query);
  if (ftsQuery) {
    const results = await db
      .prepare(
        `SELECT a.id, a.titel, a.ebene, a.saule, a.gemeinde, a.dateipfad,
              a.content, a.quelle, a.token_count, a.gueltig_ab, a.status,
              bm25(articles_fts, 5.0, 1.0) AS rank
       FROM articles_fts
       JOIN articles a ON articles_fts.rowid = a.id
       WHERE articles_fts MATCH ?
         AND ${filter.sql}
       ORDER BY rank
       LIMIT 20`,
      )
      .bind(ftsQuery, ...filter.params)
      .all();

    if (results.results) {
      const maxRank = Math.max(
        ...results.results.map((r: any) => Math.abs(r.rank as number)),
        1,
      );
      for (const row of results.results as any[]) {
        const id = row.id as number;
        if (!candidates[id])
          candidates[id] = { content: 0, question: 0, hints: 0, title: 0 };
        // bm25 gibt negative Werte, je negativer desto besser
        candidates[id].content = Math.abs(row.rank as number) / maxRank;
      }
    }
  }

  // --- Stufe 2: FTS5 über typische Fragen ---
  // Phase 1b: Jetzt MIT Geo-/Projekt-Filter (vorher ungefiltert)
  if (ftsQuery) {
    const qResults = await db
      .prepare(
        `SELECT q.article_id, bm25(questions_fts) AS rank
       FROM questions_fts
       JOIN questions q ON questions_fts.rowid = q.id
       JOIN articles a ON q.article_id = a.id
       WHERE questions_fts MATCH ?
         AND ${filter.sql}
       LIMIT 20`,
      )
      .bind(ftsQuery, ...filter.params)
      .all();

    if (qResults.results) {
      const maxRank = Math.max(
        ...qResults.results.map((r: any) => Math.abs(r.rank as number)),
        1,
      );
      for (const row of qResults.results as any[]) {
        const id = row.article_id as number;
        if (!candidates[id])
          candidates[id] = { content: 0, question: 0, hints: 0, title: 0 };
        candidates[id].question = Math.max(
          candidates[id].question,
          Math.abs(row.rank as number) / maxRank,
        );
      }
    }
  }

  // --- Stufe 4: FTS5 mit LLM-Hints ---
  if (params.hints && params.hints.length > 0) {
    const hintsQuery = sanitizeFtsQuery(params.hints.join(" "));
    if (hintsQuery) {
      const hResults = await db
        .prepare(
          `SELECT a.id, bm25(articles_fts, 5.0, 1.0) AS rank
         FROM articles_fts
         JOIN articles a ON articles_fts.rowid = a.id
         WHERE articles_fts MATCH ?
           AND ${filter.sql}
         LIMIT 20`,
        )
        .bind(hintsQuery, ...filter.params)
        .all();

      if (hResults.results) {
        const maxRank = Math.max(
          ...hResults.results.map((r: any) => Math.abs(r.rank as number)),
          1,
        );
        for (const row of hResults.results as any[]) {
          const id = row.id as number;
          if (!candidates[id])
            candidates[id] = { content: 0, question: 0, hints: 0, title: 0 };
          candidates[id].hints = Math.max(
            candidates[id].hints,
            Math.abs(row.rank as number) / maxRank,
          );
        }
      }
    }
  }

  // --- Stufe 5: Titel-Match über LLM-Sources ---
  if (params.sources && params.sources.length > 0) {
    for (const source of params.sources) {
      const tResults = await db
        .prepare(
          `SELECT a.id FROM articles a
         WHERE a.titel LIKE ?
           AND ${filter.sql}
         LIMIT 5`,
        )
        .bind(`%${source}%`, ...filter.params)
        .all();

      if (tResults.results) {
        for (const row of tResults.results as any[]) {
          const id = row.id as number;
          if (!candidates[id])
            candidates[id] = { content: 0, question: 0, hints: 0, title: 0 };
          candidates[id].title = 1.0;
        }
      }
    }
  }

  // --- Scores kombinieren ---
  const articleIds = Object.keys(candidates).map(Number);
  if (articleIds.length === 0) return [];

  // Artikel-Daten laden (mit Filter als Safety-Net)
  const placeholders = articleIds.map(() => "?").join(",");
  const articlesResult = await db
    .prepare(
      `SELECT * FROM articles a WHERE a.id IN (${placeholders}) AND ${filter.sql}`,
    )
    .bind(...articleIds, ...filter.params)
    .all();

  if (!articlesResult.results) return [];

  const scored: ScoredArticle[] = (articlesResult.results as any[]).map(
    (row) => {
      const scores = candidates[row.id as number];
      const combined =
        scores.content * SCORE_WEIGHTS.content +
        scores.question * SCORE_WEIGHTS.question +
        scores.hints * SCORE_WEIGHTS.hints +
        scores.title * SCORE_WEIGHTS.title;

      return {
        ...row,
        score: Math.round(combined * 100) / 100,
      } as ScoredArticle;
    },
  );

  // Nach Score sortieren (absteigend)
  scored.sort((a, b) => b.score - a.score);

  // --- Ergebnis-Filterung ---
  const config = getRetrievalConfig(params.persona);

  // Filter 1: Score-Schwelle
  let filtered = scored.filter((a) => a.score >= config.min_score);

  // Filter 2: Score-Sprung erkennen
  for (let i = 1; i < filtered.length; i++) {
    const gap = filtered[i - 1].score - filtered[i].score;
    if (gap >= config.score_gap_threshold) {
      filtered = filtered.slice(0, i);
      break;
    }
  }

  // Filter 3: Token-Budget
  let tokenSum = 0;
  const budgeted: ScoredArticle[] = [];
  for (const article of filtered) {
    const tokens = article.token_count || 0;
    if (tokenSum + tokens > config.token_budget && budgeted.length > 0) break;
    tokenSum += tokens;
    budgeted.push(article);
  }

  // Filter 4: Hard Limit
  return budgeted.slice(0, config.max_articles);
}

/**
 * FTS5-Query bereinigen und mit OR verknüpfen.
 *
 * Stoppwörter entfernen, Sonderzeichen bereinigen,
 * verbleibende Wörter mit OR verknüpfen (statt implizitem AND).
 */
const STOP_WORDS = new Set([
  "der", "die", "das", "den", "dem", "des",
  "ein", "eine", "einer", "einem", "einen", "eines",
  "und", "oder", "aber", "als", "wie", "was", "wer", "wo", "wann",
  "ist", "sind", "war", "wird", "werden", "hat", "haben", "kann",
  "mit", "von", "zu", "auf", "in", "an", "für", "über", "nach",
  "bei", "aus", "um", "durch", "nicht", "noch", "auch", "nur",
  "ich", "er", "sie", "es", "wir", "ihr", "man",
  "wenn", "dass", "ob", "weil", "da", "so", "im", "am", "zum", "zur",
]);

function sanitizeFtsQuery(input: string): string {
  const cleaned = input
    .replace(/[^\w\sÄäÖöÜüß-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = cleaned
    .split(" ")
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w.toLowerCase()));

  if (words.length === 0) return cleaned; // Fallback: Original-Query
  return words.join(" OR ");
}
