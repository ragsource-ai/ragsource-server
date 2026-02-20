import type {
  ScoredArticle,
  Gemeinde,
  Persona,
  ResponsePacket,
  ArticleResult,
  PersonaConfig,
  GemeindeInfo,
} from "../types.js";
import { sortByHierarchy, detectConflicts } from "./hierarchy.js";
import { DISCLAIMER } from "./config.js";

const PERSONA_CONFIGS: Record<Persona, PersonaConfig> = {
  buerger: {
    rolle: "buerger",
    sprache: "einfach",
    max_satzlaenge: 15,
    fachsprache: false,
    format: "service",
    kontaktdaten_anzeigen: true,
  },
  gemeinderat: {
    rolle: "gemeinderat",
    sprache: "fachsprache",
    max_satzlaenge: 25,
    fachsprache: true,
    format: "erklaerend",
    kontaktdaten_anzeigen: false,
  },
  verwaltung: {
    rolle: "verwaltung",
    sprache: "fachsprache",
    max_satzlaenge: 30,
    fachsprache: true,
    format: "fachlich",
    kontaktdaten_anzeigen: false,
  },
  buergermeister: {
    rolle: "buergermeister",
    sprache: "fachsprache",
    max_satzlaenge: 25,
    fachsprache: true,
    format: "briefing",
    kontaktdaten_anzeigen: false,
  },
};

/**
 * Baut das Response-Paket, das an das LLM zurückgegeben wird.
 */
export function buildResponsePacket(
  articles: ScoredArticle[],
  gemeinde: Gemeinde | null,
  persona: Persona,
): ResponsePacket {
  // Artikel nach Hierarchie sortieren
  const sorted = sortByHierarchy(articles);

  // Konflikte erkennen
  const hierarchy = detectConflicts(sorted);

  // Artikel-Ergebnisse aufbereiten
  const articleResults: ArticleResult[] = sorted.map((a) => ({
    titel: a.titel,
    ebene: a.ebene,
    saule: a.saule,
    score: a.score,
    content: a.content,
    dateipfad: a.dateipfad,
    quelle: a.quelle,
  }));

  // Gemeinde-Info
  const gemeindeInfo: GemeindeInfo = gemeinde
    ? {
        name: gemeinde.name,
        verband: gemeinde.verband,
        kreis: gemeinde.kreis,
        land: gemeinde.land,
      }
    : {
        name: "Alle",
        verband: null,
        kreis: "Alle",
        land: "Alle",
      };

  return {
    articles: articleResults,
    persona: PERSONA_CONFIGS[persona],
    gemeinde: gemeindeInfo,
    hierarchy,
    disclaimer: DISCLAIMER,
  };
}
