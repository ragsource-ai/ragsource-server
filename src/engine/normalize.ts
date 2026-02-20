type GeoTyp = "bundesland" | "landkreis" | "gemeinde" | "verband";

/**
 * Normalisiert einen Geo-Parameter zu einem ARS-Wert.
 *
 * Stufe 1: exact match (lowercase, trim)
 * Stufe 2: normalisiert (Umlaute→ASCII, Sonderzeichen weg)
 * Kein Match → null (Parameter verwerfen, kein Filter)
 */
export async function normalizeGeoParam(
  input: string,
  typ: GeoTyp,
  db: D1Database,
): Promise<string | null> {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  // Stufe 1: Exact match
  const exact = await db
    .prepare("SELECT ars FROM geo_aliases WHERE alias = ? AND typ = ?")
    .bind(trimmed, typ)
    .first<{ ars: string }>();
  if (exact) return exact.ars;

  // Stufe 2: Normalisierter match
  const normalized = normalizeString(trimmed);
  const norm = await db
    .prepare("SELECT ars FROM geo_aliases WHERE alias = ? AND typ = ?")
    .bind(normalized, typ)
    .first<{ ars: string }>();
  if (norm) return norm.ars;

  // Kein Match → verwerfen
  return null;
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
