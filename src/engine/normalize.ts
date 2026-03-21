/**
 * Geo-Auflösung: Unified `geo`-Parameter → ARS-Felder + Ebene + Klarnamen.
 *
 * Eingabe: ARS-Code (nur Ziffern) oder Klarname/Alias (nicht-numerisch).
 * ARS-Länge bestimmt Ebene: 2=Land, 5=Kreis, 9=Verband, 12=Gemeinde.
 * Auflösung nur aufwärts — Gemeinde-ARS liefert auch Verband/Kreis/Land.
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

/**
 * Hauptfunktion: Löst einen `geo`-Parameter auf.
 *
 * - Nur Ziffern → ARS direkt, Ebene aus Länge
 * - Nicht-numerisch → geo_aliases Lookup (ohne typ-Filter)
 * - Kein Match → null
 */
export async function resolveGeo(
  input: string,
  db: D1Database,
): Promise<ResolvedGeo | null> {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Nur Ziffern? → ARS direkt
  if (/^\d+$/.test(trimmed)) {
    return resolveArsUpward(trimmed, db);
  }

  // Nicht-numerisch → Alias-Lookup (ohne typ-Filter)
  const lower = trimmed.toLowerCase();
  const exact = await db
    .prepare("SELECT ars FROM geo_aliases WHERE alias = ?")
    .bind(lower)
    .first<{ ars: string }>();

  if (exact) {
    return resolveArsUpward(exact.ars, db);
  }

  // Normalisiert versuchen
  const normalized = normalizeString(lower);
  if (normalized !== lower) {
    const norm = await db
      .prepare("SELECT ars FROM geo_aliases WHERE alias = ?")
      .bind(normalized)
      .first<{ ars: string }>();
    if (norm) {
      return resolveArsUpward(norm.ars, db);
    }
  }

  return null;
}

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
