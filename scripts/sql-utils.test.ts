/**
 * Tests für esc() und buildConcatTree() aus sql-utils.ts
 *
 * Ausführung: npm test
 * Direkt:     node --import tsx/esm --test scripts/sql-utils.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { esc, buildConcatTree } from "./sql-utils.js";

// ---------------------------------------------------------------------------
// buildConcatTree
// ---------------------------------------------------------------------------

describe("buildConcatTree", () => {
  test("leeres Array → leerer SQL-String", () => {
    assert.equal(buildConcatTree([]), "''");
  });

  test("ein Token → direkt zurückgegeben", () => {
    assert.equal(buildConcatTree(["'Hallo'"]), "'Hallo'");
  });

  test("zwei Tokens → einfacher || -Ausdruck", () => {
    assert.equal(buildConcatTree(["'a'", "'b'"]), "('a' || 'b')");
  });

  test("vier Tokens → balancierter Baum", () => {
    const result = buildConcatTree(["'a'", "'b'", "'c'", "'d'"]);
    assert.equal(result, "(('a' || 'b') || ('c' || 'd'))");
  });

  test("drei Tokens → Baum mit Tiefe 2", () => {
    const result = buildConcatTree(["'a'", "'b'", "'c'"]);
    assert.equal(result, "('a' || ('b' || 'c'))");
  });

  test("200 Tokens → Tiefe bleibt unter log2(200) ≈ 8", () => {
    const tokens = Array.from({ length: 200 }, (_, i) => `'${i}'`);
    const result = buildConcatTree(tokens);
    // Tiefe messen: zähle maximale Klammertiefe
    let depth = 0;
    let maxDepth = 0;
    for (const ch of result) {
      if (ch === "(") { depth++; maxDepth = Math.max(maxDepth, depth); }
      if (ch === ")") depth--;
    }
    assert.ok(maxDepth <= 8, `Tiefe ${maxDepth} überschreitet log2(200)≈8`);
  });
});

// ---------------------------------------------------------------------------
// esc
// ---------------------------------------------------------------------------

describe("esc", () => {
  // Null-Handling
  test("null → NULL", () => {
    assert.equal(esc(null), "NULL");
  });

  test("undefined → NULL", () => {
    assert.equal(esc(undefined), "NULL");
  });

  // Einfache Werte
  test("einfacher String ohne Sonderzeichen → quoted", () => {
    assert.equal(esc("Hallo Welt"), "'Hallo Welt'");
  });

  test("leerer String → leeres SQL-Literal", () => {
    assert.equal(esc(""), "''");
  });

  test("Zahl → quoted String", () => {
    assert.equal(esc(42), "'42'");
  });

  test("Boolean → quoted String", () => {
    assert.equal(esc(true), "'true'");
  });

  // Sonderzeichen: Apostrophe
  test("String mit einfachem Apostroph → char(39) statt ''", () => {
    const result = esc("O'Brien");
    assert.ok(result.includes("char(39)"), `char(39) fehlt in: ${result}`);
    assert.ok(!result.includes("''"), `Unsicheres '' gefunden in: ${result}`);
  });

  test("String mit mehreren Apostrophen → alle als char(39)", () => {
    const result = esc("it's a 'test'");
    const count = (result.match(/char\(39\)/g) ?? []).length;
    assert.equal(count, 3, `Erwartet 3× char(39), gefunden: ${count} in: ${result}`);
  });

  // Sonderzeichen: Doppelstrich
  test("String mit -- → char(45,45) statt --", () => {
    const result = esc("§§ 178 -- 180");
    assert.ok(result.includes("char(45,45)"), `char(45,45) fehlt in: ${result}`);
    // Original -- darf nicht als Literal in der SQL stehen (wird als Kommentar geparst)
    assert.ok(!result.includes("'--'"), `Literal '--' in SQL gefunden: ${result}`);
  });

  test("String mit mehreren -- → alle als char(45,45)", () => {
    const result = esc("a -- b -- c");
    const count = (result.match(/char\(45,45\)/g) ?? []).length;
    assert.equal(count, 2, `Erwartet 2× char(45,45), gefunden: ${count} in: ${result}`);
  });

  // Kombination
  test("String mit ' und -- → beide korrekt escapet", () => {
    const result = esc("§ 1 -- 'Zweck'");
    assert.ok(result.includes("char(39)"), `char(39) fehlt: ${result}`);
    assert.ok(result.includes("char(45,45)"), `char(45,45) fehlt: ${result}`);
  });

  // Reale Beispiele aus dem Content-Repo
  test("Gesetzestitel mit Paragraphenzeichen", () => {
    const result = esc("Bürgerliches Gesetzbuch (BGB)");
    assert.equal(result, "'Bürgerliches Gesetzbuch (BGB)'");
  });

  test("VwGO-Section mit ----", () => {
    const result = esc("§§ 178 ---- Zustellungsvorschriften");
    assert.ok(result.includes("char(45,45)"), `char(45,45) fehlt: ${result}`);
  });

  test("Apostroph am Anfang", () => {
    const result = esc("'Titel'");
    assert.ok(result.includes("char(39)"), `char(39) fehlt: ${result}`);
    assert.ok(!result.startsWith("''"), `Beginnt mit unsicherem '': ${result}`);
  });

  // Sicherheit: Null-Byte
  test("Null-Byte → wirft Fehler", () => {
    assert.throws(
      () => esc("harmlos\x00böse"),
      /Null-Byte/,
    );
  });

  test("Null-Byte am Anfang → wirft Fehler", () => {
    assert.throws(
      () => esc("\x00"),
      /Null-Byte/,
    );
  });

  // Ergebnis ist valides SQL-Fragment (syntaktisch prüfbar durch Klammerbalance)
  test("Ergebnis hat balancierte Klammern", () => {
    const inputs = [
      "O'Brien -- 'Test' -- Ende",
      "§§ 1--3 'Abschnitt'",
      "Nur normale Zeichen",
      "",
    ];
    for (const input of inputs) {
      const result = esc(input);
      let depth = 0;
      for (const ch of result) {
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        assert.ok(depth >= 0, `Unbalancierte Klammer bei: ${input} → ${result}`);
      }
      assert.equal(depth, 0, `Offene Klammern bei: ${input} → ${result}`);
    }
  });
});
