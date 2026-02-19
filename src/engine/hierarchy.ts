import type { ScoredArticle, Ebene, HierarchyInfo, HierarchyConflict } from "../types.js";

const EBENE_ORDER: Record<Ebene, number> = {
  gemeinde: 1,
  gvv: 2,
  kreis: 3,
  land: 4,
  bund: 5,
};

/**
 * Sortiert Artikel nach Normenhierarchie:
 * Gemeinde → GVV → Kreis → Land → Bund
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

/**
 * Erkennt potenzielle Konflikte in der Normenhierarchie.
 *
 * Ein Konflikt liegt vor, wenn Artikel verschiedener Ebenen
 * dasselbe Thema behandeln und sich widersprechen könnten.
 * Im Prototyp: Einfache Erkennung über gleiche Keywords.
 *
 * Vollständige Widerspruchserkennung ist ein Phase-2-Feature.
 */
export function detectConflicts(
  _articles: ScoredArticle[],
): HierarchyInfo {
  // Phase 1a: Keine automatische Konflikterkennung
  // Der Server markiert nur, dass mehrere Ebenen betroffen sind.
  // Das LLM kann dann selbst auf potenzielle Widersprüche hinweisen.
  return { conflicts: [] };
}
