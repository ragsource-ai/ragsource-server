import type { ScoredArticle, Ebene } from "../types.js";

const EBENE_ORDER: Record<Ebene, number> = {
  gemeinde: 1,
  verband: 2,
  kreis: 3,
  land: 4,
  bund: 5,
};

/**
 * Sortiert Artikel nach Normenhierarchie:
 * Gemeinde → Verband → Kreis → Land → Bund
 *
 * Innerhalb derselben Ebene wird nach Score sortiert.
 */
export function sortByHierarchy(articles: ScoredArticle[]): ScoredArticle[] {
  return [...articles].sort((a, b) => {
    const orderA = EBENE_ORDER[a.ebene] || 99;
    const orderB = EBENE_ORDER[b.ebene] || 99;
    if (orderA !== orderB) return orderA - orderB;
    return b.score - a.score;
  });
}
