import type {
  ScoredArticle,
  Persona,
  ResponsePacket,
  ArticleResult,
  PersonaConfig,
  GeoInfo,
} from "../types.js";
import type { ResolvedGeo } from "./normalize.js";
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
  geo: ResolvedGeo | null,
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

  // Geo-Info
  const geoInfo: GeoInfo = geo
    ? {
        level: geo.level,
        name: geo.display.name,
        verband: geo.display.verband,
        kreis: geo.display.kreis,
        land: geo.display.land,
      }
    : {
        level: "alle",
        name: "Alle",
        verband: null,
        kreis: null,
        land: null,
      };

  return {
    articles: articleResults,
    persona: PERSONA_CONFIGS[persona],
    geo: geoInfo,
    hierarchy,
    disclaimer: DISCLAIMER,
  };
}
