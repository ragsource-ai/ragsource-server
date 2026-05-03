/**
 * Tests für resolveExtensions() und buildExtensionsWarning() aus extensions.ts.
 *
 * Ausführung: npm test
 * Direkt:     node --import tsx/esm --test src/engine/extensions.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  resolveExtensions,
  buildExtensionsWarning,
  EXTENSIONS_TAXONOMY,
} from "./extensions.js";

// ---------------------------------------------------------------------------
// resolveExtensions
// ---------------------------------------------------------------------------

describe("resolveExtensions — Stufe 1 (exakter Match)", () => {
  test("kanonischer Wert wird unverändert akzeptiert", () => {
    const r = resolveExtensions(["Gefahrenabwehrrecht"]);
    assert.deepEqual(r.resolved, ["Gefahrenabwehrrecht"]);
    assert.equal(r.mapped.length, 0);
    assert.equal(r.ignored.length, 0);
  });

  test("alle 22 Taxonomie-Werte sind exakt akzeptiert", () => {
    const r = resolveExtensions([...EXTENSIONS_TAXONOMY]);
    assert.equal(r.resolved.length, EXTENSIONS_TAXONOMY.length);
    assert.equal(r.mapped.length, 0);
    assert.equal(r.ignored.length, 0);
  });

  test("mehrere kanonische Werte erhalten ihre Reihenfolge", () => {
    const r = resolveExtensions(["Baurecht", "Verfassungsrecht", "Sozialrecht"]);
    assert.deepEqual(r.resolved, ["Baurecht", "Verfassungsrecht", "Sozialrecht"]);
  });
});

describe("resolveExtensions — Stufe 2 (case-insensitiv)", () => {
  test("kleingeschrieben wird auf kanonischen Wert gemappt", () => {
    const r = resolveExtensions(["gefahrenabwehrrecht"]);
    assert.deepEqual(r.resolved, ["Gefahrenabwehrrecht"]);
    assert.equal(r.mapped.length, 1);
    assert.equal(r.mapped[0].via, "case");
    assert.equal(r.mapped[0].input, "gefahrenabwehrrecht");
    assert.equal(r.mapped[0].resolved, "Gefahrenabwehrrecht");
  });

  test("großgeschrieben gemappt", () => {
    const r = resolveExtensions(["BAURECHT"]);
    assert.deepEqual(r.resolved, ["Baurecht"]);
    assert.equal(r.mapped[0].via, "case");
  });
});

describe("resolveExtensions — Stufe 3 (Synonym-Map)", () => {
  test("'Feuerwehr' → 'Gefahrenabwehrrecht'", () => {
    const r = resolveExtensions(["Feuerwehr"]);
    assert.deepEqual(r.resolved, ["Gefahrenabwehrrecht"]);
    assert.equal(r.mapped[0].via, "synonym");
  });

  test("'Beamtenrecht' → 'Arbeitsrecht'", () => {
    const r = resolveExtensions(["Beamtenrecht"]);
    assert.deepEqual(r.resolved, ["Arbeitsrecht"]);
    assert.equal(r.mapped[0].via, "synonym");
  });

  test("'DSGVO' → 'Datenschutz & IT-Recht'", () => {
    const r = resolveExtensions(["DSGVO"]);
    assert.deepEqual(r.resolved, ["Datenschutz & IT-Recht"]);
    assert.equal(r.mapped[0].via, "synonym");
  });

  test("'Vergaberecht' → 'Vergabe & Beschaffung'", () => {
    const r = resolveExtensions(["Vergaberecht"]);
    assert.deepEqual(r.resolved, ["Vergabe & Beschaffung"]);
    assert.equal(r.mapped[0].via, "synonym");
  });

  test("Synonym mit Umlaut-Fallback ('gebühren')", () => {
    const r = resolveExtensions(["gebühren"]);
    assert.deepEqual(r.resolved, ["Steuer- & Abgabenrecht"]);
  });
});

describe("resolveExtensions — Stufe 4 (Prefix-Match)", () => {
  test("'Verfassung' → 'Verfassungsrecht'", () => {
    const r = resolveExtensions(["Verfassung"]);
    assert.deepEqual(r.resolved, ["Verfassungsrecht"]);
    assert.equal(r.mapped[0].via, "prefix");
  });

  test("'Strafrecht' → 'Strafrecht & OWiG' (synonym, nicht prefix)", () => {
    // 'strafrecht' ist explizit in der Synonym-Map → synonym hat Vorrang vor prefix
    const r = resolveExtensions(["Strafrecht"]);
    assert.deepEqual(r.resolved, ["Strafrecht & OWiG"]);
    assert.equal(r.mapped[0].via, "synonym");
  });

  test("kurzes Token (<3 Zeichen) löst keinen Prefix-Match aus", () => {
    const r = resolveExtensions(["Ba"]);
    assert.deepEqual(r.resolved, []);
    assert.equal(r.ignored.length, 1);
    assert.equal(r.ignored[0].reason, "no_match");
  });
});

describe("resolveExtensions — Stufe 5 (no match / ambiguous)", () => {
  test("unbekannter Wert wird als no_match ignoriert", () => {
    const r = resolveExtensions(["Aufwandsentschädigung"]);
    assert.deepEqual(r.resolved, []);
    assert.equal(r.ignored.length, 1);
    assert.equal(r.ignored[0].reason, "no_match");
    assert.equal(r.ignored[0].input, "Aufwandsentschädigung");
  });

  test("'Recht' allein matcht nichts (kein Wert beginnt mit 'recht')", () => {
    const r = resolveExtensions(["Recht"]);
    assert.deepEqual(r.resolved, []);
    assert.equal(r.ignored.length, 1);
  });

  test("Garbage-Input wird ignoriert", () => {
    const r = resolveExtensions(["xyz123"]);
    assert.deepEqual(r.resolved, []);
    assert.equal(r.ignored[0].reason, "no_match");
  });
});

describe("resolveExtensions — Mix gültig + ungültig (Variante A)", () => {
  test("Original-Case: Feuerwehr + Aufwandsentschädigung + Entschädigung", () => {
    const r = resolveExtensions(["Feuerwehr", "Aufwandsentschädigung", "Entschädigung"]);
    assert.deepEqual(r.resolved, ["Gefahrenabwehrrecht"]);
    assert.equal(r.mapped.length, 1);
    assert.equal(r.mapped[0].input, "Feuerwehr");
    assert.equal(r.ignored.length, 2);
  });

  test("Mix: Baurecht (gültig) + Hundesteuer (ignored)", () => {
    const r = resolveExtensions(["Baurecht", "Hundesteuer"]);
    assert.deepEqual(r.resolved, ["Baurecht"]);
    assert.equal(r.ignored.length, 1);
    assert.equal(r.ignored[0].input, "Hundesteuer");
  });
});

describe("resolveExtensions — Edge cases", () => {
  test("leeres Array → leere Resolution", () => {
    const r = resolveExtensions([]);
    assert.deepEqual(r.resolved, []);
    assert.deepEqual(r.mapped, []);
    assert.deepEqual(r.ignored, []);
  });

  test("leerer String und Whitespace werden übersprungen", () => {
    const r = resolveExtensions(["", "   ", "\t"]);
    assert.deepEqual(r.resolved, []);
    assert.equal(r.ignored.length, 0);
  });

  test("Whitespace-Trimming: ' Baurecht ' → 'Baurecht'", () => {
    const r = resolveExtensions([" Baurecht "]);
    assert.deepEqual(r.resolved, ["Baurecht"]);
  });

  test("Duplikate werden dedupliziert (resolved dedup)", () => {
    const r = resolveExtensions(["Baurecht", "BAURECHT", "baurecht"]);
    assert.deepEqual(r.resolved, ["Baurecht"]);
    // mapped enthält die zwei case-Mappings (BAURECHT, baurecht)
    assert.equal(r.mapped.length, 2);
  });

  test("Synonym + Kanonisch zum gleichen Ziel → ein Eintrag in resolved", () => {
    const r = resolveExtensions(["Feuerwehr", "Gefahrenabwehrrecht"]);
    assert.deepEqual(r.resolved, ["Gefahrenabwehrrecht"]);
  });
});

// ---------------------------------------------------------------------------
// buildExtensionsWarning
// ---------------------------------------------------------------------------

describe("buildExtensionsWarning", () => {
  test("alles ok → null", () => {
    const w = buildExtensionsWarning({
      resolved: ["Baurecht"],
      mapped: [],
      ignored: [],
    });
    assert.equal(w, null);
  });

  test("nur mapped → enthält Mapping-Liste und Anweisung", () => {
    const w = buildExtensionsWarning({
      resolved: ["Gefahrenabwehrrecht"],
      mapped: [{ input: "Feuerwehr", resolved: "Gefahrenabwehrrecht", via: "synonym" }],
      ignored: [],
    });
    assert.ok(w);
    assert.match(w!, /Feuerwehr.*Gefahrenabwehrrecht.*synonym/);
    assert.match(w!, /Server rät NICHT/);
  });

  test("nur ignored → enthält Ignored-Liste", () => {
    const w = buildExtensionsWarning({
      resolved: [],
      mapped: [],
      ignored: [{ input: "xyz", reason: "no_match" }],
    });
    assert.ok(w);
    assert.match(w!, /xyz.*no_match/);
  });

  test("mapped + ignored → beide Listen", () => {
    const w = buildExtensionsWarning({
      resolved: ["Gefahrenabwehrrecht"],
      mapped: [{ input: "Feuerwehr", resolved: "Gefahrenabwehrrecht", via: "synonym" }],
      ignored: [{ input: "Aufwandsentschädigung", reason: "no_match" }],
    });
    assert.ok(w);
    assert.match(w!, /Gemappt:/);
    assert.match(w!, /Ignoriert:/);
  });
});
