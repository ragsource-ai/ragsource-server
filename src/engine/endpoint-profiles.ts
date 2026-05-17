/**
 * Endpoint-Profile + Host-Mapping — Branding, Betriebskontrakt und die
 * Tenancy/Profil-Zuordnung pro Host.
 *
 * Reines Datenmodul ohne Workers-Abhängigkeiten: ein Profil ist ein pures
 * Datenobjekt, jede Verzweigungslogik bleibt im Core (mcp.ts). Ein neues
 * Frontend = ein Eintrag in ENDPOINT_BY_HOST + ENDPOINT_PROFILES, kein Core-Code.
 *
 * Tenancy ≠ Profil: ein App-Directory-Endpoint zeigt denselben Content wie die
 * Marke (gleiche `tenancy`), trägt aber ein eigenes `profile` mit Betriebskontrakt
 * und Picker-Branding.
 */

export interface EndpointProfile {
  /** Branding-Text mit Markdown — wird als system_message im Catalog-Response geliefert */
  systemMessage: string;
  /** Kontakt-Adresse für not_configured-Hinweise und sonstige Verweise */
  contactMail: string;
  /**
   * Optionaler Betriebskontrakt — kompakte, imperative Verhaltensregeln.
   * Wird als `operating_rules` in die erste Catalog-Response pro Session gelegt.
   * Gesetzt für Endpoints ohne nutzerseitigen Systemprompt (App-Directory).
   */
  operatingRules?: string;
  /**
   * Optionales Branding für die OAuth-Geo-Picker-Seite (passwortloser Modus).
   * Gesetzt für App-Directory-Endpoints mit OAUTH_PUBLIC.
   */
  pickerBranding?: {
    /** Markenname, z. B. "amtsschimmel.ai" */
    name: string;
    /** Kurze Zeile unter dem Markennamen */
    subtitle: string;
    /** CSS-Akzentfarbe (Hex) */
    accent: string;
  };
}

/** Zuordnung eines Hosts zu Tenancy-Filter und Endpoint-Profil. */
export interface HostConfig {
  /** Tenancy-Slug für den source_endpoints-Filter ("all" = kein Filter). */
  tenancy: string;
  /** Profil-Key in ENDPOINT_PROFILES. */
  profile: string;
}

// -----------------------------------------------------------------------
// Branding-Bausteine
// -----------------------------------------------------------------------

const RAGSOURCE_BRANDING =
  "**Powered by RAGSource.ai** — Mehr Infos [hier](https://www.ragsource.ai)";

const SM_AMTSSCHIMMEL =
  "**amtsschimmel.ai — die kommunale Wissensbasis.** Mehr Infos: [www.amtsschimmel.ai](https://www.amtsschimmel.ai)";

const SM_PARAGRAFENREITER =
  "**Powered by paragrafenreiter.ai** — Mehr Infos [hier](https://www.paragrafenreiter.ai)";

// -----------------------------------------------------------------------
// Betriebskontrakte (operating_rules) — kompakt, imperativ, nummeriert.
// Ersetzen den früher nutzerseitig eingefügten Systemprompt für Clients ohne
// Prompt-Slot. Redaktionelle Quellen: src/prompts/masterprompt-*.md
// -----------------------------------------------------------------------

export const OPERATING_RULES_KOMMUNAL =
  "Verbindliche Arbeitsregeln (amtsschimmel.ai):\n" +
  "1. Bei jeder Rechtsfrage zuerst RAGSource_catalog aufrufen — keine Antwort ohne Catalog.\n" +
  "2. Nur Paragrafen zitieren, deren Wortlaut zuvor per RAGSource_get geladen wurde — keine §§ aus dem Gedächtnis.\n" +
  "3. Wörtliche Zitate in Anführungszeichen mit exakter Fundstelle (z. B. § 39 GemO BW).\n" +
  "4. Schlussfolgerungen aus geladenen §§ ausdrücklich als „Einschätzung\" kennzeichnen — nie als Zitat.\n" +
  "5. Fehlt eine passende Quelle: offen benennen und auf Rechtsamt/Gemeindetag verweisen — Lücken nie still mit Allgemeinwissen füllen.\n" +
  "6. Vorrangig die spezifischste Ebene heranziehen (Gemeinde vor Kreis vor Land vor Bund).\n" +
  "7. Den geo-Parameter NICHT aus dem Kontext ableiten — die Region ist über die Verbindung voreingestellt. geo nur setzen, wenn der Nutzer ausdrücklich eine andere Gemeinde/Region nennt.\n" +
  "8. Keine personenbezogenen Daten an die Tools übergeben.\n" +
  "9. Entscheidungsorientiert antworten: Kernaussage zuerst, dann Rechtsgrundlage, dann Handlungsoption.";

export const OPERATING_RULES_FEUERWEHR =
  "Verbindliche Arbeitsregeln (brandmeister.ai):\n" +
  "1. Bei jeder Anfrage zuerst RAGSource_catalog aufrufen — keine Antwort ohne Catalog.\n" +
  "2. Skills (typ:skill) aus dem Catalog großzügig laden und ihre Begleitquellen (Gesetze, FwDVen, Verordnungen) mitladen.\n" +
  "3. Nur Paragrafen zitieren, deren Wortlaut zuvor per RAGSource_get geladen wurde — keine §§ aus dem Gedächtnis.\n" +
  "4. Wörtliche Zitate in Anführungszeichen mit exakter Fundstelle (z. B. § 14 Abs. 2 FwG BW).\n" +
  "5. Für Gefahrstoffdaten (CAS, WGK, GHS, Flammpunkt, LEL/UEL) RAGSource_db_query nutzen, dann passende Vorschriften nachladen.\n" +
  "6. Fehlende Quellenlage offen benennen — Lücken nie mit „typischerweise\" füllen.\n" +
  "7. Im Einsatzkontext kompakt und handlungsorientiert antworten; sicherheitsrelevante Details nie weglassen.\n" +
  "8. Keine personenbezogenen Daten an die Tools übergeben.\n" +
  "9. Den geo-Parameter NICHT aus dem Kontext ableiten — die Region ist voreingestellt; nur bei ausdrücklich genannter anderer Region setzen.";

export const OPERATING_RULES_GENERISCH =
  "Verbindliche Arbeitsregeln (paragrafenreiter.ai):\n" +
  "1. Bei jeder Rechtsfrage zuerst RAGSource_catalog aufrufen — keine Antwort ohne Catalog.\n" +
  "2. Nur Paragrafen zitieren, deren Wortlaut zuvor per RAGSource_get geladen wurde — keine §§ aus dem Gedächtnis.\n" +
  "3. Wörtliche Zitate in Anführungszeichen mit exakter Fundstelle (z. B. § 2 Abs. 1 KAG BW).\n" +
  "4. Schlussfolgerungen aus geladenen §§ ausdrücklich als „Einschätzung\" kennzeichnen — nie als Zitat.\n" +
  "5. Mehrere einschlägige Rechtsgebiete abdecken; fehlende Quellen offen benennen, nie still mit Allgemeinwissen füllen.\n" +
  "6. Den geo-Parameter NICHT aus dem Kontext ableiten — die Region ist voreingestellt. geo nur setzen, wenn der Nutzer ausdrücklich ein anderes Bundesland/eine andere Region nennt.\n" +
  "7. Keine personenbezogenen Daten an die Tools übergeben.\n" +
  "8. Entscheidungsorientiert antworten: Kernaussage zuerst, dann Rechtsgrundlage, dann Handlungsoptionen.";

// -----------------------------------------------------------------------
// Endpoint-Profile
// -----------------------------------------------------------------------

export const ENDPOINT_PROFILES: Record<string, EndpointProfile> = {
  amtsschimmel: {
    systemMessage: SM_AMTSSCHIMMEL,
    contactMail: "kontakt@amtsschimmel.ai",
  },
  brandmeister: {
    // Brandmeister nutzt bewusst das RAGSource-Branding (analog zum bisherigen
    // Live-Verhalten — kein eigener system_message:brandmeister-KV-Eintrag existierte).
    systemMessage: RAGSOURCE_BRANDING,
    contactMail: "kontakt@brandmeister.ai",
  },
  all: {
    // "all" = paragrafenreiter (kein Tenancy-Filter).
    systemMessage: SM_PARAGRAFENREITER,
    contactMail: "kontakt@paragrafenreiter.ai",
  },
  default: {
    systemMessage: RAGSOURCE_BRANDING,
    contactMail: "info@ragsource.ai",
  },

  // App-Directory-Profile: gleiche Tenancy wie die jeweilige Marke, zusätzlich
  // Betriebskontrakt (Clients ohne Systemprompt-Slot) + Picker-Branding.
  "amtsschimmel-app": {
    systemMessage: SM_AMTSSCHIMMEL,
    contactMail: "kontakt@amtsschimmel.ai",
    operatingRules: OPERATING_RULES_KOMMUNAL,
    pickerBranding: {
      name: "amtsschimmel.ai",
      subtitle: "Die kommunale Wissensbasis",
      accent: "#1e3a5f",
    },
  },
  "brandmeister-app": {
    systemMessage: RAGSOURCE_BRANDING,
    contactMail: "kontakt@brandmeister.ai",
    operatingRules: OPERATING_RULES_FEUERWEHR,
    pickerBranding: {
      name: "brandmeister.ai",
      subtitle: "Recherche für Feuerwehr & Brandschutz",
      accent: "#c0392b",
    },
  },
  "paragrafenreiter-app": {
    systemMessage: SM_PARAGRAFENREITER,
    contactMail: "kontakt@paragrafenreiter.ai",
    operatingRules: OPERATING_RULES_GENERISCH,
    pickerBranding: {
      name: "paragrafenreiter.ai",
      subtitle: "Zitiersichere Rechtsrecherche",
      accent: "#475569",
    },
  },
};

/** Liefert das Profil für einen Profil-Key (mit Default-Fallback). */
export function getEndpointProfile(profile: string | undefined): EndpointProfile {
  return ENDPOINT_PROFILES[profile ?? "default"] ?? ENDPOINT_PROFILES.default;
}

// -----------------------------------------------------------------------
// Host → {tenancy, profile}
//
// "all" = kein Tenancy-Filter. Kein Eintrag = Direktaufruf, ebenfalls kein Filter.
// App-Directory-Endpoints (app.*) teilen die Tenancy ihrer Marke, nutzen aber
// das jeweilige *-app-Profil.
// -----------------------------------------------------------------------

export const ENDPOINT_BY_HOST: Record<string, HostConfig> = {
  "mcp.amtsschimmel.ai":      { tenancy: "amtsschimmel", profile: "amtsschimmel" },
  "mcp-lean.amtsschimmel.ai": { tenancy: "amtsschimmel", profile: "amtsschimmel" },
  "mcp.paragrafenreiter.ai":  { tenancy: "all",          profile: "all" },
  "mcp.brandmeister.ai":      { tenancy: "brandmeister", profile: "brandmeister" },
  "mcp-gp1.brandmeister.ai":  { tenancy: "brandmeister", profile: "brandmeister" },
  "mcp-ct1.ragsource.ai":     { tenancy: "all",          profile: "all" },
  "app.amtsschimmel.ai":      { tenancy: "amtsschimmel", profile: "amtsschimmel-app" },
  "app.brandmeister.ai":      { tenancy: "brandmeister", profile: "brandmeister-app" },
  "app.paragrafenreiter.ai":  { tenancy: "all",          profile: "paragrafenreiter-app" },
};

/** Liefert die Host-Konfiguration (Tenancy + Profil), oder undefined bei Direktaufruf. */
export function resolveHostConfig(hostname: string): HostConfig | undefined {
  return ENDPOINT_BY_HOST[hostname];
}

/** Baut den `not_configured`-Hinweistext aus dem Endpoint-Profil. */
export function buildNotConfiguredHinweis(profile: EndpointProfile, gemeindeName: string): string {
  return (
    `Hinweis an den Assistenten: Die Gemeinde "${gemeindeName}" ist noch nicht als eigenständige ` +
    `Rechtsquelle hinterlegt. Es werden nur übergeordnete Regelungen (Land/Kreis/Verband) gezeigt — ` +
    `diese im Catalog konkret benennen. ` +
    `Teile dem Nutzer mit: 'Ihre Gemeinde wurde noch nicht aufgenommen. ` +
    `Es werden Ihnen übergeordnete Regelungen angezeigt. Um Ihre Gemeinde aufzunehmen, ` +
    `schreiben Sie bitte an ${profile.contactMail}'.`
  );
}
