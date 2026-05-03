/**
 * Extensions-Taxonomie und Auflösung.
 *
 * Single Source of Truth: 22 Rechtsgebiete + Sonderwert "universal".
 * Identisch mit pipeline-validate.py:_VALID_EXTENSIONS.
 *
 * Auflösung in 5 Stufen pro Eingabewert:
 *   1. Exakter Match (case-sensitive)
 *   2. Case-insensitiver Match
 *   3. Synonym-Map (kuratiert: "Feuerwehr" → "Gefahrenabwehrrecht" etc.)
 *   4. Prefix-Match (eindeutig — "Verfassung" → "Verfassungsrecht")
 *   5. Sonst: ignorieren mit Begründung (no_match | ambiguous)
 *
 * Server kennt die Taxonomie und mappt LLM-Fehlversuche transparent.
 * Strukturiertes Response-Feedback (mapped/ignored) macht das LLM lernfähig.
 */

/** 22 gültige Werte (21 Rechtsgebiete + universal) */
export const EXTENSIONS_TAXONOMY: readonly string[] = [
  "Verfassungsrecht",
  "Zivilrecht",
  "Familienrecht",
  "Arbeitsrecht",
  "Handels- & Gesellschaftsrecht",
  "Wirtschaftsrecht",
  "Strafrecht & OWiG",
  "Verwaltungsrecht",
  "Kommunalrecht",
  "Baurecht",
  "Gefahrenabwehrrecht",
  "Verkehrsrecht",
  "Sozialrecht",
  "Gesundheitsrecht",
  "Steuer- & Abgabenrecht",
  "Umwelt- & Naturrecht",
  "Datenschutz & IT-Recht",
  "Bildungs- & Jugendrecht",
  "Europarecht",
  "Vergabe & Beschaffung",
  "Migrationsrecht",
  "Notstandsrecht",
  "universal",
] as const;

/** Lowercase → kanonischer Wert, für O(1)-Lookup */
const TAXONOMY_LOWER: Map<string, string> = new Map(
  EXTENSIONS_TAXONOMY.map((t) => [t.toLowerCase(), t]),
);

/**
 * Kuratierte Synonym-Map: häufige LLM-Fehlversuche → kanonischer Wert.
 * Keys IMMER lowercase. Werte stammen aus EXTENSIONS_TAXONOMY.
 */
const EXTENSIONS_SYNONYMS: Record<string, string> = {
  // Gefahrenabwehrrecht
  "feuerwehr": "Gefahrenabwehrrecht",
  "brandschutz": "Gefahrenabwehrrecht",
  "polizei": "Gefahrenabwehrrecht",
  "polizeirecht": "Gefahrenabwehrrecht",
  "katastrophenschutz": "Gefahrenabwehrrecht",
  "rettungsdienst": "Gefahrenabwehrrecht",
  "bevölkerungsschutz": "Gefahrenabwehrrecht",
  "bevoelkerungsschutz": "Gefahrenabwehrrecht",

  // Arbeitsrecht
  "beamtenrecht": "Arbeitsrecht",
  "beamte": "Arbeitsrecht",
  "tarifrecht": "Arbeitsrecht",
  "tvoed": "Arbeitsrecht",
  "tv-l": "Arbeitsrecht",
  "personalvertretung": "Arbeitsrecht",
  "betriebsverfassung": "Arbeitsrecht",

  // Steuer- & Abgabenrecht
  "steuerrecht": "Steuer- & Abgabenrecht",
  "steuern": "Steuer- & Abgabenrecht",
  "abgabenrecht": "Steuer- & Abgabenrecht",
  "abgaben": "Steuer- & Abgabenrecht",
  "gebühren": "Steuer- & Abgabenrecht",
  "gebuehren": "Steuer- & Abgabenrecht",
  "kag": "Steuer- & Abgabenrecht",
  "beiträge": "Steuer- & Abgabenrecht",
  "beitraege": "Steuer- & Abgabenrecht",

  // Datenschutz & IT-Recht
  "datenschutz": "Datenschutz & IT-Recht",
  "dsgvo": "Datenschutz & IT-Recht",
  "bdsg": "Datenschutz & IT-Recht",
  "it-recht": "Datenschutz & IT-Recht",
  "it-sicherheit": "Datenschutz & IT-Recht",
  "datensicherheit": "Datenschutz & IT-Recht",

  // Bildungs- & Jugendrecht
  "schulrecht": "Bildungs- & Jugendrecht",
  "schule": "Bildungs- & Jugendrecht",
  "hochschulrecht": "Bildungs- & Jugendrecht",
  "hochschule": "Bildungs- & Jugendrecht",
  "jugendhilfe": "Bildungs- & Jugendrecht",
  "jugendschutz": "Bildungs- & Jugendrecht",
  "kita": "Bildungs- & Jugendrecht",
  "kindergarten": "Bildungs- & Jugendrecht",
  "kinderbetreuung": "Bildungs- & Jugendrecht",

  // Vergabe & Beschaffung
  "vergaberecht": "Vergabe & Beschaffung",
  "vergabe": "Vergabe & Beschaffung",
  "beschaffungsrecht": "Vergabe & Beschaffung",
  "gwb": "Vergabe & Beschaffung",
  "vgv": "Vergabe & Beschaffung",
  "uvgo": "Vergabe & Beschaffung",

  // Migrationsrecht
  "asylrecht": "Migrationsrecht",
  "asyl": "Migrationsrecht",
  "aufenthaltsrecht": "Migrationsrecht",
  "aufenthalt": "Migrationsrecht",
  "ausländerrecht": "Migrationsrecht",
  "auslaenderrecht": "Migrationsrecht",
  "migration": "Migrationsrecht",
  "integration": "Migrationsrecht",

  // Umwelt- & Naturrecht
  "umweltrecht": "Umwelt- & Naturrecht",
  "umwelt": "Umwelt- & Naturrecht",
  "naturschutz": "Umwelt- & Naturrecht",
  "wasserrecht": "Umwelt- & Naturrecht",
  "wasser": "Umwelt- & Naturrecht",
  "abfallrecht": "Umwelt- & Naturrecht",
  "abfall": "Umwelt- & Naturrecht",
  "wald": "Umwelt- & Naturrecht",
  "forstrecht": "Umwelt- & Naturrecht",
  "klimaschutz": "Umwelt- & Naturrecht",
  "immissionsschutz": "Umwelt- & Naturrecht",

  // Wirtschaftsrecht
  "kartellrecht": "Wirtschaftsrecht",
  "uwg": "Wirtschaftsrecht",
  "wettbewerbsrecht": "Wirtschaftsrecht",
  "insolvenzrecht": "Wirtschaftsrecht",
  "energierecht": "Wirtschaftsrecht",
  "energie": "Wirtschaftsrecht",
  "tkg": "Wirtschaftsrecht",
  "telekommunikation": "Wirtschaftsrecht",
  "enwg": "Wirtschaftsrecht",

  // Handels- & Gesellschaftsrecht
  "gesellschaftsrecht": "Handels- & Gesellschaftsrecht",
  "hgb": "Handels- & Gesellschaftsrecht",
  "handelsrecht": "Handels- & Gesellschaftsrecht",

  // Strafrecht & OWiG
  "strafrecht": "Strafrecht & OWiG",
  "stgb": "Strafrecht & OWiG",
  "owig": "Strafrecht & OWiG",
  "bußgeldrecht": "Strafrecht & OWiG",
  "bussgeldrecht": "Strafrecht & OWiG",
  "ordnungswidrigkeitenrecht": "Strafrecht & OWiG",

  // Kommunalrecht
  "gemeindeordnung": "Kommunalrecht",
  "gemo": "Kommunalrecht",
  "kreisordnung": "Kommunalrecht",
  "ortsrecht": "Kommunalrecht",
  "eigenbetrieb": "Kommunalrecht",
  "eigenbetriebe": "Kommunalrecht",

  // Baurecht
  "bauordnung": "Baurecht",
  "baugb": "Baurecht",
  "bauo": "Baurecht",
  "baunvo": "Baurecht",
  "denkmalschutz": "Baurecht",
  "erschliessung": "Baurecht",
  "erschließung": "Baurecht",

  // Verkehrsrecht
  "verkehr": "Verkehrsrecht",
  "stvo": "Verkehrsrecht",
  "stvg": "Verkehrsrecht",
  "fahrerlaubnis": "Verkehrsrecht",
  "fahrerlaubnisrecht": "Verkehrsrecht",

  // Sozialrecht
  "sgb": "Sozialrecht",
  "sozialhilfe": "Sozialrecht",
  "rentenversicherung": "Sozialrecht",
  "krankenversicherung": "Sozialrecht",
  "pflegeversicherung": "Sozialrecht",
  "unfallversicherung": "Sozialrecht",
  "bürgergeld": "Sozialrecht",
  "buergergeld": "Sozialrecht",

  // Gesundheitsrecht
  "ifsg": "Gesundheitsrecht",
  "heilberufe": "Gesundheitsrecht",
  "arzneimittelrecht": "Gesundheitsrecht",
  "krankenhausrecht": "Gesundheitsrecht",

  // Verfassungsrecht
  "grundgesetz": "Verfassungsrecht",
  "grundrechte": "Verfassungsrecht",
  "staatsorganisation": "Verfassungsrecht",

  // Zivilrecht
  "bgb": "Zivilrecht",
  "schuldrecht": "Zivilrecht",
  "sachenrecht": "Zivilrecht",
  "mietrecht": "Zivilrecht",
  "vertragsrecht": "Zivilrecht",
  "erbrecht": "Zivilrecht",

  // Familienrecht
  "ehe": "Familienrecht",
  "scheidung": "Familienrecht",
  "unterhalt": "Familienrecht",
  "sorgerecht": "Familienrecht",
  "famfg": "Familienrecht",
  "adoption": "Familienrecht",

  // Verwaltungsrecht
  "vwvfg": "Verwaltungsrecht",
  "vwgo": "Verwaltungsrecht",
  "gewerberecht": "Verwaltungsrecht",
  "gewerbe": "Verwaltungsrecht",
  "verwaltungsverfahren": "Verwaltungsrecht",

  // Europarecht
  "eu-recht": "Europarecht",
  "europa": "Europarecht",
  "euv": "Europarecht",
  "aeuv": "Europarecht",
  "eu-verordnung": "Europarecht",
  "eu-richtlinie": "Europarecht",

  // Notstandsrecht
  "zivilschutz": "Notstandsrecht",
  "wsig": "Notstandsrecht",
  "zskg": "Notstandsrecht",
  "verteidigung": "Notstandsrecht",
  "ernährungssicherstellung": "Notstandsrecht",
  "ernaehrungssicherstellung": "Notstandsrecht",
};

export type ExtensionMapVia = "case" | "synonym" | "prefix";
export type ExtensionIgnoreReason = "no_match" | "ambiguous";

export interface ExtensionResolution {
  /** Effektiv aktive Extensions (deduped, in Eingabe-Reihenfolge) */
  resolved: string[];
  /** Eingaben, die per case-fix / Synonym / Prefix gemappt wurden */
  mapped: Array<{ input: string; resolved: string; via: ExtensionMapVia }>;
  /** Eingaben, die nicht aufgelöst werden konnten */
  ignored: Array<{ input: string; reason: ExtensionIgnoreReason }>;
}

/**
 * Löst eine Liste von Extension-Eingaben gegen die Taxonomie auf.
 *
 * Reihenfolge pro Eingabe:
 *   1. Exakt in Taxonomie (case-sensitive)
 *   2. Case-insensitiv exakt
 *   3. Synonym-Map
 *   4. Prefix-Match (eindeutig)
 *   5. Sonst: ignorieren
 *
 * Duplikate in `resolved` werden entfernt (Set-basiert).
 */
export function resolveExtensions(inputs: readonly string[]): ExtensionResolution {
  const resolvedSet = new Set<string>();
  const resolvedOrder: string[] = [];
  const mapped: ExtensionResolution["mapped"] = [];
  const ignored: ExtensionResolution["ignored"] = [];

  const accept = (canonical: string) => {
    if (!resolvedSet.has(canonical)) {
      resolvedSet.add(canonical);
      resolvedOrder.push(canonical);
    }
  };

  for (const raw of inputs) {
    const trimmed = (raw ?? "").trim();
    if (!trimmed) continue;

    // 1. Exakt
    if (EXTENSIONS_TAXONOMY.includes(trimmed as never)) {
      accept(trimmed);
      continue;
    }

    const lower = trimmed.toLowerCase();

    // 2. Case-insensitiv
    const ciExact = TAXONOMY_LOWER.get(lower);
    if (ciExact) {
      accept(ciExact);
      mapped.push({ input: trimmed, resolved: ciExact, via: "case" });
      continue;
    }

    // 3. Synonym-Map
    const syn = EXTENSIONS_SYNONYMS[lower];
    if (syn) {
      accept(syn);
      mapped.push({ input: trimmed, resolved: syn, via: "synonym" });
      continue;
    }

    // 4. Prefix-Match (eindeutig, mind. 3 Zeichen)
    if (lower.length >= 3) {
      const prefixMatches = new Set<string>();
      for (const [k, v] of TAXONOMY_LOWER) {
        if (k.startsWith(lower)) prefixMatches.add(v);
      }
      if (prefixMatches.size === 1) {
        const m = prefixMatches.values().next().value!;
        accept(m);
        mapped.push({ input: trimmed, resolved: m, via: "prefix" });
        continue;
      }
      if (prefixMatches.size > 1) {
        ignored.push({ input: trimmed, reason: "ambiguous" });
        continue;
      }
    }

    // 5. Nichts gefunden
    ignored.push({ input: trimmed, reason: "no_match" });
  }

  return { resolved: resolvedOrder, mapped, ignored };
}

/**
 * Tool-Description für den `extensions`-Parameter (zentral, von catalog + query genutzt).
 * 21 Rechtsgebiete + Mappings + Server-Feedback-Loop. `universal` ist intern
 * (Frontmatter-Tag für immer-sichtbare Quellen) und nicht für LLM-Eingabe gedacht.
 */
export const EXTENSIONS_PARAMETER_DESCRIPTION =
  "Optional topic filters (OR-linked, additive). Default: empty (all sources visible). " +
  "Set only if user explicitly requests a topic scope. " +
  "ONLY these 21 values are valid — never invent keywords or topic names. " +
  "Valid values: Verfassungsrecht, Zivilrecht, Familienrecht, Arbeitsrecht, " +
  "Handels- & Gesellschaftsrecht, Wirtschaftsrecht, Strafrecht & OWiG, " +
  "Verwaltungsrecht, Kommunalrecht, Baurecht, Gefahrenabwehrrecht, " +
  "Verkehrsrecht, Sozialrecht, Gesundheitsrecht, Steuer- & Abgabenrecht, " +
  "Umwelt- & Naturrecht, Datenschutz & IT-Recht, Bildungs- & Jugendrecht, " +
  "Europarecht, Vergabe & Beschaffung, Migrationsrecht, Notstandsrecht. " +
  "Common mappings (server resolves automatically): " +
  "Feuerwehr/Brandschutz/Polizei/Polizeirecht/Katastrophenschutz/Rettungsdienst → Gefahrenabwehrrecht; " +
  "Beamtenrecht/Tarifrecht/TVöD → Arbeitsrecht; Ortsrecht/GemO/Kreisordnung → Kommunalrecht; " +
  "Vergaberecht/GWB/VgV → Vergabe & Beschaffung; DSGVO/IT-Recht → Datenschutz & IT-Recht; " +
  "Asylrecht/Aufenthaltsrecht → Migrationsrecht; Steuerrecht/Gebühren/KAG → Steuer- & Abgabenrecht. " +
  "Server response shows extensions_resolved/_mapped/_ignored — if your input was mapped or ignored, " +
  "use the resolved canonical value(s) on the next call. The server NEVER guesses — it maps known " +
  "synonyms or rejects unknown inputs.";

/**
 * Erzeugt einen kompakten Hinweistext für die Catalog-/Query-Antwort,
 * wenn Extensions umgemappt oder ignoriert wurden.
 * Gibt null zurück wenn nichts zu sagen ist.
 */
export function buildExtensionsWarning(res: ExtensionResolution): string | null {
  if (res.mapped.length === 0 && res.ignored.length === 0) return null;

  const parts: string[] = [];
  if (res.mapped.length > 0) {
    const items = res.mapped.map((m) => `"${m.input}" → "${m.resolved}" (${m.via})`).join(", ");
    parts.push(`Gemappt: ${items}.`);
  }
  if (res.ignored.length > 0) {
    const items = res.ignored.map((i) => `"${i.input}" (${i.reason})`).join(", ");
    parts.push(`Ignoriert: ${items}.`);
  }

  parts.push(
    `WICHTIG: Die Liste 'extensions' akzeptiert nur Werte aus der 22-teiligen Rechtsgebiete-Taxonomie ` +
    `(siehe Tool-Description). Keine Stichwörter, Synonyme oder Themenbegriffe. ` +
    `Beim nächsten Aufruf direkt einen Taxonomie-Wert verwenden — der Server rät NICHT, ` +
    `er mappt nur bekannte Synonyme.`,
  );

  return parts.join(" ");
}
