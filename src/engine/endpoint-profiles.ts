/**
 * Endpoint-Profile — statisches Branding + Betriebskontrakt pro Tenant.
 *
 * Reines Datenmodul ohne Workers-Abhängigkeiten: ein Profil ist ein pures
 * Datenobjekt, jede Verzweigungslogik bleibt im Core (mcp.ts). Ein neues
 * Frontend = ein Eintrag in ENDPOINT_PROFILES, kein Core-Code.
 *
 * Statisches Inhalts-Branding lebt im Code (versioniert, in git, Code-Review).
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
}

const RAGSOURCE_BRANDING =
  "**Powered by RAGSource.ai** — Mehr Infos [hier](https://www.ragsource.ai)";

/**
 * Betriebskontrakt für kommunale Endpoints (amtsschimmel / App-Directory).
 * Kompakt, imperativ, nummeriert — wird über das Endpoint-Profil als
 * `operating_rules` in die erste Catalog-Response gelegt. Ersetzt den früher
 * nutzerseitig eingefügten Systemprompt für Clients ohne Prompt-Slot.
 * Redaktionelle Quelle: src/prompts/masterprompt-amtsschimmel.md.
 */
export const OPERATING_RULES_KOMMUNAL =
  "Verbindliche Arbeitsregeln (amtsschimmel.ai):\n" +
  "1. Bei jeder Rechtsfrage zuerst RAGSource_catalog aufrufen — keine Antwort ohne Catalog.\n" +
  "2. Nur Paragrafen zitieren, deren Wortlaut zuvor per RAGSource_get geladen wurde — keine §§ aus dem Gedächtnis.\n" +
  "3. Wörtliche Zitate in Anführungszeichen mit exakter Fundstelle (z. B. § 39 GemO BW).\n" +
  "4. Schlussfolgerungen aus geladenen §§ ausdrücklich als „Einschätzung\" kennzeichnen — nie als Zitat.\n" +
  "5. Fehlt eine passende Quelle: offen benennen und auf Rechtsamt/Gemeindetag verweisen — Lücken nie still mit Allgemeinwissen füllen.\n" +
  "6. Vorrangig die spezifischste Ebene heranziehen (Gemeinde vor Kreis vor Land vor Bund).\n" +
  "7. Für eine andere Gemeinde oder Region den geo-Parameter explizit übergeben.\n" +
  "8. Keine personenbezogenen Daten an die Tools übergeben.\n" +
  "9. Entscheidungsorientiert antworten: Kernaussage zuerst, dann Rechtsgrundlage, dann Handlungsoption.";

export const ENDPOINT_PROFILES: Record<string, EndpointProfile> = {
  amtsschimmel: {
    systemMessage:
      "**amtsschimmel.ai — die kommunale Wissensbasis.** Mehr Infos: [www.amtsschimmel.ai](https://www.amtsschimmel.ai)",
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
    systemMessage:
      "**Powered by paragrafenreiter.ai** — Mehr Infos [hier](https://www.paragrafenreiter.ai)",
    contactMail: "kontakt@paragrafenreiter.ai",
  },
  default: {
    systemMessage: RAGSOURCE_BRANDING,
    contactMail: "info@ragsource.ai",
  },
};

/** Liefert das Profil für einen Endpoint (mit Default-Fallback). */
export function getEndpointProfile(endpoint: string | undefined): EndpointProfile {
  return ENDPOINT_PROFILES[endpoint ?? "default"] ?? ENDPOINT_PROFILES.default;
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
