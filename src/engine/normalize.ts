/**
 * Geo-Auflösung: Unified `geo`-Parameter → ARS-Felder + Ebene + Klarnamen.
 *
 * Eingabe: ARS-Code (nur Ziffern) oder Klarname/Alias (nicht-numerisch).
 * ARS-Länge bestimmt Ebene: 2=Land, 5=Kreis, 9=Verband, 12=Gemeinde.
 * Auflösung nur aufwärts — Gemeinde-ARS liefert auch Verband/Kreis/Land.
 *
 * Klarnamen-Lookup mehrstufig:
 *   1. exakter Match in geo_aliases
 *   2. exakter Match in gemeinden.name (mit Umlaut-Fallback)
 *   3. Prefix-Match in gemeinden.name (z.B. "Müllheim" → "Müllheim im Markgräflerland, Stadt")
 *   4. Multi-Token-AND-Match in gemeinden.name (z.B. "Müllheim Markgräflerland")
 *   5. Token-Suche in gemeinden.kreis / .verband / .land (für "Konstanz" → Stadt + Kreis)
 *   6. Optional eingeschränkt durch Ebenen-Hint ("Kreis", "Lkr", "Land", "Verband")
 *
 * Bei mehreren Kandidaten → AmbiguousGeo mit Typ-Markierung.
 */

export type GeoLevel = "gemeinde" | "verband" | "kreis" | "land";

export interface ResolvedGeo {
  level: GeoLevel;
  land_ars: string | null;
  kreis_ars: string | null;
  verband_ars: string | null;
  gemeinde_ars: string | null;
  display: {
    name: string;
    verband: string | null;
    kreis: string | null;
    land: string | null;
  };
}

export interface GeoCandidate {
  typ: GeoLevel;
  name: string;
  ars: string;
  kreis: string | null;
  kreis_ars: string | null;
  verband: string | null;
  verband_ars: string | null;
  land: string | null;
  land_ars: string | null;
}

export interface AmbiguousGeo {
  ambiguous: true;
  input: string;
  candidates: GeoCandidate[];
  truncated: boolean;
}

// Maximale Kandidatenzahl in AmbiguousGeo-Antwort
const MAX_CANDIDATES = 10;

/** Stoppwörter für Tokenisierung — Präpositionen, Artikel, Connectoren */
const STOP_WORDS = new Set([
  "im", "in", "an", "am", "auf", "bei", "von", "vom",
  "zu", "zur", "zum", "ob", "ueber",
  "der", "die", "das", "den", "des", "dem",
  "und", "oder", "&",
]);

/** Erstes Token als Ebenen-Hint → schränkt Suche auf eine Spalte ein */
const LEVEL_HINTS: Record<string, GeoLevel> = {
  "kreis": "kreis",
  "kr": "kreis",
  "lkr": "kreis",
  "lkr.": "kreis",
  "landkreis": "kreis",
  "verband": "verband",
  "gvv": "verband",
  "gvb": "verband",
  "vg": "verband",
  "verbandsgemeinde": "verband",
  "gemeindeverwaltungsverband": "verband",
  "land": "land",
  "bundesland": "land",
  "stadt": "gemeinde",
  "gemeinde": "gemeinde",
};

/**
 * Hauptfunktion: Löst einen `geo`-Parameter auf.
 *
 * - Nur Ziffern → ARS direkt, Ebene aus Länge
 * - Nicht-numerisch → mehrstufiger Klarnamen-Lookup
 *   - 0 Treffer → null
 *   - 1 Treffer → ResolvedGeo (direkte Auflösung)
 *   - >1 Treffer → AmbiguousGeo mit Kandidatenliste
 */
export async function resolveGeo(
  input: string,
  db: D1Database,
): Promise<ResolvedGeo | AmbiguousGeo | null> {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Nur Ziffern? → ARS direkt
  if (/^\d+$/.test(trimmed)) {
    return resolveArsUpward(trimmed, db);
  }

  // Nicht-numerisch → Alias-Lookup zuerst (schneller, exakte Treffer)
  const lower = trimmed.toLowerCase();
  const alias = await lookupAlias(lower, db);
  if (alias) return resolveArsUpward(alias, db);

  const normalized = normalizeString(lower);
  if (normalized !== lower) {
    const aliasNorm = await lookupAlias(normalized, db);
    if (aliasNorm) return resolveArsUpward(aliasNorm, db);
  }

  // Kein Alias → mehrstufige Suche in gemeinden + abgeleitete Ebenen
  const candidates = await searchByName(trimmed, db);

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidateToResolved(candidates[0]);

  return {
    ambiguous: true,
    input: trimmed,
    candidates: candidates.slice(0, MAX_CANDIDATES),
    truncated: candidates.length > MAX_CANDIDATES,
  };
}

/** Vorschläge für eine nicht auflösbare Eingabe (Top-N Prefix-Treffer) */
export async function suggestGeo(input: string, db: D1Database, limit = 5): Promise<GeoCandidate[]> {
  const trimmed = input.trim();
  if (!trimmed || /^\d+$/.test(trimmed)) return [];

  const lower = trimmed.toLowerCase();
  const normalized = normalizeString(lower);
  const firstToken = lower.split(/[\s,]+/)[0] ?? lower;
  const firstTokenN = normalizeString(firstToken);

  // Suche das erste Wort als Prefix in allen vier Spalten
  const sql = `
    SELECT 'gemeinde' AS typ, ars, name, kreis, kreis_ars, verband, verband_ars, land, land_ars
      FROM gemeinden
     WHERE LOWER(name) LIKE ? OR LOWER(name) LIKE ?
     LIMIT ?
  `;
  const rows = await db
    .prepare(sql)
    .bind(`${firstToken}%`, `${firstTokenN}%`, limit)
    .all<GeoCandidate>();
  return rows.results ?? [];
}

// -----------------------------------------------------------------------
// Klarnamen-Suche (mehrstufig, parallel)
// -----------------------------------------------------------------------

export interface LookupParts {
  lower: string;          // Original lowercase
  normalized: string;     // Umlaut-normalisiert
  tokens: string[];       // Lowercase Tokens, Stoppwörter raus
  tokensNorm: string[];   // Tokens umlaut-normalisiert
  levelHint: GeoLevel | null;
}

export function prepareLookup(input: string): LookupParts | null {
  const lowerRaw = input.toLowerCase().trim();
  if (!lowerRaw) return null;

  // Tokenisierung: Whitespace + Komma/Semikolon/Punkt/Klammer als Trenner
  const allTokens = lowerRaw
    .replace(/[,;\.\(\)\/]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));

  if (allTokens.length === 0) return null;

  // Ebenen-Hint: erstes Token wenn es ein Hint ist → strippen
  let levelHint: GeoLevel | null = null;
  let tokens = allTokens;
  const firstHint = LEVEL_HINTS[allTokens[0]];
  if (firstHint && allTokens.length > 1) {
    levelHint = firstHint;
    tokens = allTokens.slice(1);
  }

  // lower/normalized aus den verbleibenden Tokens rebauen, damit exact/prefix-Match
  // bei Level-Hint nicht mehr das gestrippte Wort enthält
  // ("Kreis Konstanz" → tokens=["konstanz"], lower="konstanz", nicht "kreis konstanz")
  const lower = tokens.join(" ");
  const normalized = normalizeString(lower);
  const tokensNorm = tokens.map((t) => normalizeString(t));

  return { lower, normalized, tokens, tokensNorm, levelHint };
}

async function searchByName(input: string, db: D1Database): Promise<GeoCandidate[]> {
  const parts = prepareLookup(input);
  if (!parts) return [];

  const targets: GeoLevel[] = parts.levelHint
    ? [parts.levelHint]
    : ["gemeinde", "kreis", "verband", "land"];

  const queries = targets.map((typ) => searchInTarget(typ, parts, db));
  const results = await Promise.all(queries);

  const seen = new Set<string>();
  const merged: GeoCandidate[] = [];
  for (const arr of results) {
    for (const c of arr) {
      const key = `${c.typ}::${c.ars}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(c);
      if (merged.length > MAX_CANDIDATES) return merged; // truncated
    }
  }
  return merged;
}

/**
 * Sucht in einer Geo-Ebene (Gemeinde/Kreis/Verband/Land).
 * Pro Ebene: exakter Match + Prefix-Match + (bei >1 Token) Multi-Token-AND.
 */
async function searchInTarget(
  typ: GeoLevel,
  p: LookupParts,
  db: D1Database,
): Promise<GeoCandidate[]> {
  // Spalte und SELECT-Felder pro Ebene
  let col: string;
  let fromClause: string;
  let baseSelect: string;

  switch (typ) {
    case "gemeinde":
      col = "name";
      fromClause = "gemeinden";
      baseSelect = "ars, name, kreis, kreis_ars, verband, verband_ars, land, land_ars";
      break;
    case "kreis":
      col = "kreis";
      // DISTINCT pro Kreis-ARS (1 Repräsentant)
      fromClause = "(SELECT kreis_ars AS ars, kreis AS name, kreis, kreis_ars, NULL AS verband, NULL AS verband_ars, land, land_ars FROM gemeinden GROUP BY kreis_ars)";
      baseSelect = "ars, name, kreis, kreis_ars, verband, verband_ars, land, land_ars";
      break;
    case "verband":
      col = "name";
      fromClause = "(SELECT verband_ars AS ars, verband AS name, kreis, kreis_ars, verband, verband_ars, land, land_ars FROM gemeinden WHERE verband_ars IS NOT NULL GROUP BY verband_ars)";
      baseSelect = "ars, name, kreis, kreis_ars, verband, verband_ars, land, land_ars";
      break;
    case "land":
      col = "name";
      fromClause = "(SELECT land_ars AS ars, land AS name, NULL AS kreis, NULL AS kreis_ars, NULL AS verband, NULL AS verband_ars, land, land_ars FROM gemeinden GROUP BY land_ars)";
      baseSelect = "ars, name, kreis, kreis_ars, verband, verband_ars, land, land_ars";
      break;
  }

  const conditions: string[] = [];
  const params: string[] = [];

  // Exakt-Match (lower + ggf. normalisiert)
  conditions.push(`LOWER(${col}) = ?`);
  params.push(p.lower);
  if (p.normalized !== p.lower) {
    conditions.push(`LOWER(${col}) = ?`);
    params.push(p.normalized);
  }

  // Prefix-Match
  conditions.push(`LOWER(${col}) LIKE ?`);
  params.push(`${p.lower}%`);
  if (p.normalized !== p.lower) {
    conditions.push(`LOWER(${col}) LIKE ?`);
    params.push(`${p.normalized}%`);
  }

  // Multi-Token-AND (nur wenn mehr als 1 Token)
  if (p.tokens.length > 1) {
    const andClauses = p.tokens.map(() => `LOWER(${col}) LIKE ?`);
    conditions.push(`(${andClauses.join(" AND ")})`);
    for (const t of p.tokens) params.push(`%${t}%`);

    if (p.tokensNorm.some((t, i) => t !== p.tokens[i])) {
      const andClausesN = p.tokensNorm.map(() => `LOWER(${col}) LIKE ?`);
      conditions.push(`(${andClausesN.join(" AND ")})`);
      for (const t of p.tokensNorm) params.push(`%${t}%`);
    }
  }

  const sql = `
    SELECT '${typ}' AS typ, ${baseSelect}
    FROM ${fromClause}
    WHERE ${conditions.join(" OR ")}
    LIMIT ${MAX_CANDIDATES + 1}
  `;

  type Row = Omit<GeoCandidate, "typ">;
  const result = await db.prepare(sql).bind(...params).all<Row>();
  return (result.results ?? []).map((r) => ({ ...r, typ }));
}

async function lookupAlias(alias: string, db: D1Database): Promise<string | null> {
  const row = await db
    .prepare(
      "SELECT ars FROM geo_aliases WHERE alias = ? ORDER BY CASE typ WHEN 'gemeinde' THEN 0 WHEN 'verband' THEN 1 WHEN 'landkreis' THEN 2 ELSE 3 END LIMIT 1",
    )
    .bind(alias)
    .first<{ ars: string }>();
  return row?.ars ?? null;
}

/** Direkter Bau eines ResolvedGeo aus einem GeoCandidate ohne weiteren DB-Roundtrip */
function candidateToResolved(c: GeoCandidate): ResolvedGeo {
  switch (c.typ) {
    case "gemeinde":
      return {
        level: "gemeinde",
        land_ars: c.land_ars,
        kreis_ars: c.kreis_ars,
        verband_ars: c.verband_ars,
        gemeinde_ars: c.ars,
        display: { name: c.name, verband: c.verband, kreis: c.kreis, land: c.land },
      };
    case "verband":
      return {
        level: "verband",
        land_ars: c.land_ars,
        kreis_ars: c.kreis_ars,
        verband_ars: c.ars,
        gemeinde_ars: null,
        display: { name: c.verband ?? c.name, verband: c.verband, kreis: c.kreis, land: c.land },
      };
    case "kreis":
      return {
        level: "kreis",
        land_ars: c.land_ars,
        kreis_ars: c.ars,
        verband_ars: null,
        gemeinde_ars: null,
        display: { name: c.kreis ?? c.name, verband: null, kreis: c.kreis, land: c.land },
      };
    case "land":
      return {
        level: "land",
        land_ars: c.ars,
        kreis_ars: null,
        verband_ars: null,
        gemeinde_ars: null,
        display: { name: c.land ?? c.name, verband: null, kreis: null, land: c.land },
      };
  }
}

// -----------------------------------------------------------------------
// ARS-Auflösung
// -----------------------------------------------------------------------

/**
 * Löst einen ARS-Code aufwärts auf: Gemeinde → Verband → Kreis → Land.
 * ARS-Länge bestimmt die Ebene.
 */
async function resolveArsUpward(
  ars: string,
  db: D1Database,
): Promise<ResolvedGeo | null> {
  const len = ars.length;

  // Ungültige ARS-Länge → sofort abbrechen, keine DB-Lookups nötig
  if (len !== 2 && len !== 5 && len !== 9 && len !== 12) return null;

  if (len === 12) {
    // Gemeinde → volle Auflösung über gemeinden-Tabelle
    const row = await db
      .prepare("SELECT * FROM gemeinden WHERE ars = ?")
      .bind(ars)
      .first<{
        ars: string;
        name: string;
        verband: string | null;
        verband_ars: string | null;
        kreis: string;
        kreis_ars: string;
        land: string;
        land_ars: string;
      }>();
    if (!row) return null;

    return {
      level: "gemeinde",
      land_ars: row.land_ars,
      kreis_ars: row.kreis_ars,
      verband_ars: row.verband_ars,
      gemeinde_ars: row.ars,
      display: {
        name: row.name,
        verband: row.verband,
        kreis: row.kreis,
        land: row.land,
      },
    };
  }

  if (len === 9) {
    // Verband → Kreis + Land aus gemeinden-Tabelle (erste Gemeinde im Verband)
    const row = await db
      .prepare("SELECT verband, verband_ars, kreis, kreis_ars, land, land_ars FROM gemeinden WHERE verband_ars = ? LIMIT 1")
      .bind(ars)
      .first<{
        verband: string | null;
        verband_ars: string | null;
        kreis: string;
        kreis_ars: string;
        land: string;
        land_ars: string;
      }>();
    if (!row) return null;

    return {
      level: "verband",
      land_ars: row.land_ars,
      kreis_ars: row.kreis_ars,
      verband_ars: ars,
      gemeinde_ars: null,
      display: {
        name: row.verband ?? ars,
        verband: row.verband,
        kreis: row.kreis,
        land: row.land,
      },
    };
  }

  if (len === 5) {
    // Kreis → Land aus gemeinden-Tabelle (erste Gemeinde im Kreis)
    const row = await db
      .prepare("SELECT kreis, land, land_ars FROM gemeinden WHERE kreis_ars = ? LIMIT 1")
      .bind(ars)
      .first<{ kreis: string; land: string; land_ars: string }>();
    if (!row) return null;

    return {
      level: "kreis",
      land_ars: row.land_ars,
      kreis_ars: ars,
      verband_ars: null,
      gemeinde_ars: null,
      display: {
        name: row.kreis,
        verband: null,
        kreis: row.kreis,
        land: row.land,
      },
    };
  }

  // len === 2
  // Land → nur land_ars, Name aus gemeinden-Tabelle
  const row = await db
    .prepare("SELECT land FROM gemeinden WHERE land_ars = ? LIMIT 1")
    .bind(ars)
    .first<{ land: string }>();
  if (!row) return null;

  return {
    level: "land",
    land_ars: ars,
    kreis_ars: null,
    verband_ars: null,
    gemeinde_ars: null,
    display: {
      name: row.land,
      verband: null,
      kreis: null,
      land: row.land,
    },
  };
}

/**
 * Normalisiert einen String: Umlaute→ASCII, Sonderzeichen weg, lowercase.
 */
export function normalizeString(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
