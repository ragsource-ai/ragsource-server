/**
 * Tests für normalize.ts — pure Helpers + resolveGeo() mit kompaktem D1-Mock.
 *
 * Ausführung: npm test
 * Direkt:     node --import tsx/esm --test src/engine/normalize.test.ts
 *
 * Strategie:
 *  - Pure Functions (normalizeString, prepareLookup) werden direkt getestet.
 *  - resolveGeo() wird mit einem in-memory D1-Mock getestet, der die gängigen
 *    SQL-Patterns aus normalize.ts erkennt (Pattern-Matching auf SQL-Substrings,
 *    Bind-Parameter werden klassifiziert in exact / prefix / substring).
 *  - Edge cases mit komplizierten SQL-Konstrukten (AND-Klauseln) werden bewusst
 *    weniger detailliert getestet — die Live-Validierung gegen die echte D1
 *    deckt das ergänzend ab.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  resolveGeo,
  normalizeString,
  prepareLookup,
  type ResolvedGeo,
  type AmbiguousGeo,
} from "./normalize.js";

// ---------------------------------------------------------------------------
// In-memory D1 Mock
// ---------------------------------------------------------------------------

interface GemeindeRow {
  ars: string;
  name: string;
  verband: string | null;
  verband_ars: string | null;
  kreis: string;
  kreis_ars: string;
  land: string;
  land_ars: string;
}

interface AliasRow {
  alias: string;
  typ: "gemeinde" | "verband" | "landkreis" | "bundesland";
  ars: string;
}

const TEST_GEMEINDEN: GemeindeRow[] = [
  // Müllheim im Markgräflerland — eindeutig auflösbar via Multi-Token
  { ars: "083155012074", name: "Müllheim im Markgräflerland, Stadt", verband: null, verband_ars: null,
    kreis: "Breisgau-Hochschwarzwald", kreis_ars: "08315", land: "Baden-Württemberg", land_ars: "08" },
  // Konstanz Stadt
  { ars: "083355004043", name: "Konstanz", verband: null, verband_ars: null,
    kreis: "Konstanz", kreis_ars: "08335", land: "Baden-Württemberg", land_ars: "08" },
  // Bad Boll mit Verband
  { ars: "081175009012", name: "Bad Boll", verband: "GVV Raum Bad Boll", verband_ars: "081175009",
    kreis: "Göppingen", kreis_ars: "08117", land: "Baden-Württemberg", land_ars: "08" },
  // Hausen-Mehrfach (unterschiedliche Länder/Kreise)
  { ars: "071345005035", name: "Hausen", verband: null, verband_ars: null,
    kreis: "Birkenfeld", kreis_ars: "07134", land: "Rheinland-Pfalz", land_ars: "07" },
  { ars: "083275004023", name: "Hausen ob Verena", verband: null, verband_ars: null,
    kreis: "Tuttlingen", kreis_ars: "08327", land: "Baden-Württemberg", land_ars: "08" },
  { ars: "092735217125", name: "Hausen", verband: null, verband_ars: null,
    kreis: "Forchheim", kreis_ars: "09474", land: "Bayern", land_ars: "09" },
];

const TEST_ALIASES: AliasRow[] = [
  { alias: "konstanz", typ: "gemeinde", ars: "083355004043" },
];

/**
 * Klassifiziert ein Bind-Parameter-Pattern.
 * exact:     'müllheim'        (kein %)
 * prefix:    'müllheim%'       (% nur am Ende)
 * substring: '%müllheim%'      (% an beiden Enden)
 */
function classifyParam(p: unknown): { kind: "exact" | "prefix" | "substring" | "other"; value: string } {
  if (typeof p !== "string") return { kind: "other", value: "" };
  const startPct = p.startsWith("%");
  const endPct = p.endsWith("%");
  if (!startPct && !endPct) return { kind: "exact", value: p };
  if (!startPct && endPct) return { kind: "prefix", value: p.slice(0, -1) };
  if (startPct && endPct) return { kind: "substring", value: p.slice(1, -1) };
  return { kind: "other", value: p };
}

/**
 * Matched einen Wert (z.B. Gemeindename) gegen die Bind-Parameter, abhängig von Typ.
 *  - exact + prefix: OR-verknüpft (irgendeiner trifft → match)
 *  - substring: AND-Gruppen, OR zwischen Gruppen
 *
 * Multi-Token-AND erzeugt im SQL einen oder zwei AND-Blöcke (normalisiert vs.
 * nicht-normalisiert), beide OR-verknüpft. Der Mock erkennt das, indem er die
 * substring-Params in Hälften teilt, wenn die Anzahl gerade ≥4 ist.
 */
function matchesAnyOrAllSubstrings(value: string, params: unknown[]): boolean {
  const lower = value.toLowerCase();
  const exacts = params.map(classifyParam).filter((c) => c.kind === "exact");
  const prefixes = params.map(classifyParam).filter((c) => c.kind === "prefix");
  const substrings = params.map(classifyParam).filter((c) => c.kind === "substring");

  // OR über exact + prefix
  const exactHit = exacts.some((c) => c.value === lower);
  const prefixHit = prefixes.some((c) => lower.startsWith(c.value));

  // Substrings: AND innerhalb einer Gruppe, OR zwischen Gruppen.
  // Bei gerader Anzahl ≥4: 2 Gruppen (Hälften — normalized + non-normalized).
  // Sonst: 1 Gruppe.
  let substringHit = false;
  if (substrings.length > 0) {
    if (substrings.length >= 4 && substrings.length % 2 === 0) {
      const half = substrings.length / 2;
      const grp1 = substrings.slice(0, half);
      const grp2 = substrings.slice(half);
      substringHit =
        grp1.every((c) => lower.includes(c.value)) ||
        grp2.every((c) => lower.includes(c.value));
    } else {
      substringHit = substrings.every((c) => lower.includes(c.value));
    }
  }

  return exactHit || prefixHit || substringHit;
}

class MockD1Database {
  constructor(private gemeinden: GemeindeRow[], private aliases: AliasRow[]) {}

  prepare(sql: string) {
    const self = this;
    return {
      bind(...params: unknown[]) {
        return {
          async first<T>(): Promise<T | null> {
            const r = self.execute(sql, params);
            return (r[0] as T) ?? null;
          },
          async all<T>(): Promise<{ results: T[] }> {
            return { results: self.execute(sql, params) as T[] };
          },
        };
      },
    };
  }

  private execute(sql: string, params: unknown[]): unknown[] {
    // Alias-Lookup
    if (sql.includes("FROM geo_aliases WHERE alias = ?")) {
      const matches = this.aliases.filter((a) => a.alias === params[0]);
      const order: Record<string, number> = { gemeinde: 0, verband: 1, landkreis: 2 };
      matches.sort((a, b) => (order[a.typ] ?? 3) - (order[b.typ] ?? 3));
      return matches.length ? [{ ars: matches[0].ars }] : [];
    }

    // resolveArsUpward variants (LIMIT 1, kein Search-Pattern)
    if (sql.includes("FROM gemeinden WHERE ars = ?")) {
      const match = this.gemeinden.find((g) => g.ars === params[0]);
      return match ? [match] : [];
    }
    if (sql.includes("WHERE verband_ars = ?") && sql.includes("LIMIT 1")) {
      const match = this.gemeinden.find((g) => g.verband_ars === params[0]);
      return match ? [{ verband: match.verband, verband_ars: match.verband_ars,
        kreis: match.kreis, kreis_ars: match.kreis_ars,
        land: match.land, land_ars: match.land_ars }] : [];
    }
    if (sql.includes("WHERE kreis_ars = ?") && sql.includes("LIMIT 1")) {
      const match = this.gemeinden.find((g) => g.kreis_ars === params[0]);
      return match ? [{ kreis: match.kreis, land: match.land, land_ars: match.land_ars }] : [];
    }
    if (sql.includes("FROM gemeinden WHERE land_ars = ?") && sql.includes("LIMIT 1")) {
      const match = this.gemeinden.find((g) => g.land_ars === params[0]);
      return match ? [{ land: match.land }] : [];
    }

    // Search-by-name (gemeinde): direkt FROM gemeinden mit Search-Conditions
    if (sql.includes("'gemeinde' AS typ") && sql.includes("FROM gemeinden\n")) {
      const matches = this.gemeinden.filter((g) =>
        matchesAnyOrAllSubstrings(g.name, params),
      );
      return matches.slice(0, 11).map((g) => ({ typ: "gemeinde", ...g }));
    }

    // Search-Kreis (DISTINCT)
    if (sql.includes("'kreis' AS typ")) {
      const distinct = Array.from(
        new Map(
          this.gemeinden.map((g) => [
            g.kreis_ars,
            { typ: "kreis" as const, ars: g.kreis_ars, name: g.kreis,
              kreis: g.kreis, kreis_ars: g.kreis_ars,
              verband: null, verband_ars: null,
              land: g.land, land_ars: g.land_ars },
          ]),
        ).values(),
      );
      return distinct.filter((k) => matchesAnyOrAllSubstrings(k.name, params)).slice(0, 11);
    }

    // Search-Verband (DISTINCT)
    if (sql.includes("'verband' AS typ")) {
      const distinct = Array.from(
        new Map(
          this.gemeinden
            .filter((g) => g.verband_ars && g.verband)
            .map((g) => [
              g.verband_ars!,
              { typ: "verband" as const, ars: g.verband_ars!, name: g.verband!,
                kreis: g.kreis, kreis_ars: g.kreis_ars,
                verband: g.verband, verband_ars: g.verband_ars,
                land: g.land, land_ars: g.land_ars },
            ]),
        ).values(),
      );
      return distinct.filter((v) => matchesAnyOrAllSubstrings(v.name, params)).slice(0, 11);
    }

    // Search-Land (DISTINCT)
    if (sql.includes("'land' AS typ")) {
      const distinct = Array.from(
        new Map(
          this.gemeinden.map((g) => [
            g.land_ars,
            { typ: "land" as const, ars: g.land_ars, name: g.land,
              kreis: null, kreis_ars: null, verband: null, verband_ars: null,
              land: g.land, land_ars: g.land_ars },
          ]),
        ).values(),
      );
      return distinct.filter((l) => matchesAnyOrAllSubstrings(l.name, params)).slice(0, 11);
    }

    return [];
  }
}

const mockDb = new MockD1Database(TEST_GEMEINDEN, TEST_ALIASES) as unknown as D1Database;

// ---------------------------------------------------------------------------
// normalizeString — pure helper
// ---------------------------------------------------------------------------

describe("normalizeString", () => {
  test("Umlaute werden ASCII-isiert", () => {
    assert.equal(normalizeString("Müllheim"), "muellheim");
    assert.equal(normalizeString("Köthen"), "koethen");
    assert.equal(normalizeString("Straße"), "strasse");
  });

  test("Sonderzeichen werden entfernt, Whitespace komprimiert", () => {
    assert.equal(normalizeString("Bad-Boll, GVV"), "badboll gvv");
    assert.equal(normalizeString("  Müllheim  "), "muellheim");
  });

  test("bereits normalisiert bleibt unverändert", () => {
    assert.equal(normalizeString("muellheim markgraeflerland"), "muellheim markgraeflerland");
  });
});

// ---------------------------------------------------------------------------
// prepareLookup — Tokenisierung, Stoppwörter, Level-Hints
// ---------------------------------------------------------------------------

describe("prepareLookup — Tokenisierung", () => {
  test("Single-Token-Eingabe", () => {
    const p = prepareLookup("Müllheim");
    assert.deepEqual(p?.tokens, ["müllheim"]);
    assert.equal(p?.lower, "müllheim");
    assert.equal(p?.normalized, "muellheim");
    assert.equal(p?.levelHint, null);
  });

  test("Multi-Token-Eingabe", () => {
    const p = prepareLookup("Müllheim Markgräflerland");
    assert.deepEqual(p?.tokens, ["müllheim", "markgräflerland"]);
    assert.equal(p?.levelHint, null);
  });

  test("Komma als Trenner", () => {
    const p = prepareLookup("Müllheim, Markgräflerland");
    assert.deepEqual(p?.tokens, ["müllheim", "markgräflerland"]);
  });

  test("leere Eingabe → null", () => {
    assert.equal(prepareLookup(""), null);
    assert.equal(prepareLookup("   "), null);
  });

  test("nur Stoppwörter → null", () => {
    assert.equal(prepareLookup("im an der"), null);
  });
});

describe("prepareLookup — Stoppwörter", () => {
  test("Präpositionen werden gefiltert", () => {
    const p = prepareLookup("Müllheim im Markgräflerland");
    assert.deepEqual(p?.tokens, ["müllheim", "markgräflerland"]);
  });

  test("Artikel und Präpositionen werden gefiltert", () => {
    // "der" ist Stoppwort und wird entfernt; "haus" und "wald" bleiben.
    // (kein Token ist hier ein LEVEL_HINT, deshalb nichts gestrippt.)
    const p = prepareLookup("Haus der Wald");
    assert.deepEqual(p?.tokens, ["haus", "wald"]);
  });

  test("Fachbegriffe wie 'Stadt'/'Bad' bleiben Tokens", () => {
    const p = prepareLookup("Bad Boll");
    assert.deepEqual(p?.tokens, ["bad", "boll"]);
  });
});

describe("prepareLookup — Level-Hints", () => {
  test("'Kreis Konstanz' → kreis-Hint, Resttoken 'konstanz'", () => {
    const p = prepareLookup("Kreis Konstanz");
    assert.equal(p?.levelHint, "kreis");
    assert.deepEqual(p?.tokens, ["konstanz"]);
    assert.equal(p?.lower, "konstanz");
  });

  test("'Lkr Göppingen' → kreis-Hint", () => {
    const p = prepareLookup("Lkr Göppingen");
    assert.equal(p?.levelHint, "kreis");
    assert.deepEqual(p?.tokens, ["göppingen"]);
  });

  test("'Land Bayern' → land-Hint", () => {
    const p = prepareLookup("Land Bayern");
    assert.equal(p?.levelHint, "land");
    assert.deepEqual(p?.tokens, ["bayern"]);
  });

  test("'Verband Bad Boll' → verband-Hint", () => {
    const p = prepareLookup("Verband Bad Boll");
    assert.equal(p?.levelHint, "verband");
    assert.deepEqual(p?.tokens, ["bad", "boll"]);
  });

  test("Hint allein → kein Hint-Strip (allTokens.length == 1)", () => {
    const p = prepareLookup("Kreis");
    // Single-Token bleibt — Hint wird nur gestrippt wenn weitere Tokens folgen
    assert.equal(p?.levelHint, null);
    assert.deepEqual(p?.tokens, ["kreis"]);
  });
});

// ---------------------------------------------------------------------------
// resolveGeo — Integration mit Mock-D1
// ---------------------------------------------------------------------------

describe("resolveGeo — ARS direkt", () => {
  test("12-stelliger ARS → Gemeinde-Auflösung", async () => {
    const r = (await resolveGeo("083155012074", mockDb)) as ResolvedGeo;
    assert.equal(r.level, "gemeinde");
    assert.equal(r.gemeinde_ars, "083155012074");
    assert.equal(r.kreis_ars, "08315");
    assert.equal(r.land_ars, "08");
    assert.equal(r.display.name, "Müllheim im Markgräflerland, Stadt");
  });

  test("5-stelliger ARS → Kreis-Auflösung", async () => {
    const r = (await resolveGeo("08335", mockDb)) as ResolvedGeo;
    assert.equal(r.level, "kreis");
    assert.equal(r.kreis_ars, "08335");
    assert.equal(r.gemeinde_ars, null);
    assert.equal(r.display.kreis, "Konstanz");
  });

  test("2-stelliger ARS → Land-Auflösung", async () => {
    const r = (await resolveGeo("08", mockDb)) as ResolvedGeo;
    assert.equal(r.level, "land");
    assert.equal(r.land_ars, "08");
    assert.equal(r.display.name, "Baden-Württemberg");
  });

  test("9-stelliger ARS → Verband-Auflösung", async () => {
    const r = (await resolveGeo("081175009", mockDb)) as ResolvedGeo;
    assert.equal(r.level, "verband");
    assert.equal(r.verband_ars, "081175009");
    assert.equal(r.kreis_ars, "08117");
  });

  test("ungültige ARS-Länge → null", async () => {
    assert.equal(await resolveGeo("123", mockDb), null);
    assert.equal(await resolveGeo("12345678", mockDb), null);
  });

  test("nicht-existierende ARS → null", async () => {
    assert.equal(await resolveGeo("999999999999", mockDb), null);
  });
});

describe("resolveGeo — Klarname Auflösung", () => {
  test("Single-Token 'Müllheim' → Müllheim im Markgräflerland (Prefix-Match)", async () => {
    const r = (await resolveGeo("Müllheim", mockDb)) as ResolvedGeo;
    assert.equal(r.level, "gemeinde");
    assert.equal(r.gemeinde_ars, "083155012074");
  });

  test("Multi-Token 'Müllheim Markgräflerland' → eindeutig", async () => {
    const r = (await resolveGeo("Müllheim Markgräflerland", mockDb)) as ResolvedGeo;
    assert.equal(r.level, "gemeinde");
    assert.equal(r.gemeinde_ars, "083155012074");
  });

  test("'Bayern' → Land", async () => {
    const r = (await resolveGeo("Bayern", mockDb)) as ResolvedGeo;
    assert.equal(r.level, "land");
    assert.equal(r.land_ars, "09");
  });

  test("'Breisgau-Hochschwarzwald' → Kreis", async () => {
    const r = (await resolveGeo("Breisgau-Hochschwarzwald", mockDb)) as ResolvedGeo;
    assert.equal(r.level, "kreis");
    assert.equal(r.kreis_ars, "08315");
  });

  test("Alias 'konstanz' → ARS aus geo_aliases (Stadt)", async () => {
    const r = (await resolveGeo("konstanz", mockDb)) as ResolvedGeo;
    assert.equal(r.level, "gemeinde");
    assert.equal(r.gemeinde_ars, "083355004043");
  });
});

describe("resolveGeo — Level-Hints", () => {
  test("'Kreis Konstanz' → Kreis 08335 statt Stadt-Alias", async () => {
    const r = (await resolveGeo("Kreis Konstanz", mockDb)) as ResolvedGeo;
    assert.equal(r.level, "kreis");
    assert.equal(r.kreis_ars, "08335");
  });

  test("'Land Bayern' → Land", async () => {
    const r = (await resolveGeo("Land Bayern", mockDb)) as ResolvedGeo;
    assert.equal(r.level, "land");
    assert.equal(r.land_ars, "09");
  });
});

describe("resolveGeo — Mehrdeutigkeit", () => {
  test("'Hausen' → AmbiguousGeo mit mehreren Kandidaten", async () => {
    const r = (await resolveGeo("Hausen", mockDb)) as AmbiguousGeo;
    assert.equal((r as { ambiguous: true }).ambiguous, true);
    assert.ok(r.candidates.length >= 2, `expected ≥2 Kandidaten, got ${r.candidates.length}`);
    assert.ok(r.candidates.every((c) => c.typ === "gemeinde"));
  });
});

describe("resolveGeo — nicht auflösbar", () => {
  test("Garbage → null", async () => {
    const r = await resolveGeo("Quxullheim42", mockDb);
    assert.equal(r, null);
  });

  test("nur Whitespace → null", async () => {
    assert.equal(await resolveGeo("   ", mockDb), null);
  });

  test("Stoppwort-only → null", async () => {
    assert.equal(await resolveGeo("im an der", mockDb), null);
  });
});

describe("resolveGeo — Sonderwerte werden NICHT in resolveGeo behandelt", () => {
  // '00' und 'full' werden im mcp.ts catalog-Code abgefangen, bevor resolveGeo
  // gerufen wird. resolveGeo selbst sieht diese nicht — Test dokumentiert das.
  test("'00' wird als 2-stelliger ARS interpretiert (kein 'EU+Bund'-Sonderwert)", async () => {
    // In der Test-DB existiert kein land_ars="00" → null
    assert.equal(await resolveGeo("00", mockDb), null);
  });
});
