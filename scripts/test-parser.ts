/**
 * Inline-Test für den parseDocument-Parser (nur-### Design).
 * Ausführen: npx tsx scripts/test-parser.ts
 */

// -----------------------------------------------------------------------
// Kopie der relevanten Parser-Teile aus build-db-v2.ts
// -----------------------------------------------------------------------

const SECTION_HEADING_MATCH_RE = /^(#{2,6})\s+(§\s*\d+(?:\s*[a-z](?![a-z]))?|Artikel\s+\d+[a-z]?|Art\.\s*\d+[a-z]?|Erwägungsgrund\s+\d+|EG\s+\d+|Kapitel\s+\d+[a-z]?|Anhang\s+\d+[a-z]?|\d+(?:\.\d+)*[a-z]?)\s*(?:[—–-]\s*)?(.*)?$/i;
const SECTION_START_RE = /^###\s+\S/;

interface ParsedSection {
  sectionRef: string;
  heading: string;
  body: string;
  sectionType: string;
  sortOrder: number;
}

function parseDocument(content: string): { toc: string | null; sections: ParsedSection[] } {
  const lines = content.split(/\r?\n/);
  let toc: string | null = null;
  const sections: ParsedSection[] = [];
  let sortOrder = 0;

  let tocStart = -1;
  let tocEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+Inhaltsverzeichnis\s*$/i.test(line)) { tocStart = i + 1; continue; }
    if (tocStart !== -1 && tocEnd === -1 && /^#{2,3}\s+[^#]/.test(line)) { tocEnd = i; break; }
  }
  if (tocStart !== -1) {
    const end = tocEnd !== -1 ? tocEnd : lines.length;
    toc = lines.slice(tocStart, end).join("\n").trim() || null;
  }

  let currentSectionLines: string[] = [];
  let currentHeadingLine: string | null = null;

  function flushSection() {
    if (!currentHeadingLine) return;
    const body = currentSectionLines.join("\n").trim();
    let sectionRef: string;
    let headingText: string;

    const headingMatch = currentHeadingLine.match(SECTION_HEADING_MATCH_RE);
    if (headingMatch) {
      sectionRef = headingMatch[2].trim();
      headingText = (headingMatch[3] || "").trim();
    } else {
      const m = currentHeadingLine.match(/^###\s+(.+?)(?:\s+[-—–]\s+(.*?))?$/);
      if (!m) return;
      sectionRef = m[1].trim();
      headingText = (m[2] || "").trim();
    }

    let sectionType = "paragraph";
    if (/^Artikel\s/i.test(sectionRef) || /^Art\./i.test(sectionRef)) sectionType = "artikel";
    else if (/^Erwägungs/i.test(sectionRef) || /^EG\s/i.test(sectionRef)) sectionType = "erwaegungsgrund";
    else if (/^Kapitel/i.test(sectionRef)) sectionType = "kapitel";
    else if (/^Anhang/i.test(sectionRef)) sectionType = "anhang";
    else if (/^\d/.test(sectionRef)) sectionType = "abschnitt";

    sections.push({ sectionRef, heading: headingText, body, sectionType, sortOrder: sortOrder++ });
    currentSectionLines = [];
    currentHeadingLine = null;
  }

  for (const line of lines) {
    if (SECTION_START_RE.test(line)) {
      flushSection();
      currentHeadingLine = line;
    } else if (currentHeadingLine !== null) {
      currentSectionLines.push(line);
    }
  }
  flushSection();

  if (sections.length === 0) {
    const FALLBACK_HEADING_RE = /^(#{2,6})\s+(.+?)(?:\s+[-—–]\s+(.*?))?$/;
    let fbLines: string[] = [];
    let fbHeading: string | null = null;
    const flushFallback = () => {
      if (!fbHeading) return;
      const m = fbHeading.match(FALLBACK_HEADING_RE);
      if (!m) return;
      sections.push({ sectionRef: m[2].trim(), heading: (m[3] || "").trim(), body: fbLines.join("\n").trim(), sectionType: "eintrag", sortOrder: sortOrder++ });
      fbLines = []; fbHeading = null;
    };
    for (const line of lines) {
      if (/^#{2,6}\s+\S/.test(line)) { flushFallback(); fbHeading = line; }
      else if (fbHeading !== null) fbLines.push(line);
    }
    flushFallback();
  }

  return { toc, sections };
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

function expect(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

console.log("\n🧪 Parser-Tests (nur-### Design)\n");

// --- Test 1: Plain-numerische Headings (IndBauRL-Stil) ---
console.log("1. Plain-numerische Headings (IndBauRL)");
test("7 Abschnitte werden erkannt", () => {
  const { sections } = parseDocument(`
### 1 Ziel
Inhalt Ziel.

### 2 Anwendungsbereich
Inhalt Anwendungsbereich.

### 7 Anforderungen an Baustoffe und Bauteile sowie an die Größe der Brandbekämpfungsabschnitte
Inhalt Abschnitt 7.

### Anhang 1: Grundsätze
Inhalt Anhang 1.
`);
  expect(sections.length, 4, "section count");
  expect(sections[0].sectionRef, "1", "sectionRef[0]");
  expect(sections[0].heading, "Ziel", "heading[0]");
  expect(sections[0].sectionType, "abschnitt", "type[0]");
  expect(sections[2].sectionRef, "7", "sectionRef[2]");
  expect(sections[2].sectionType, "abschnitt", "type[2]");
  expect(sections[3].sectionRef, "Anhang 1", "sectionRef[3]");
  expect(sections[3].sectionType, "anhang", "type[3]");
});

// --- Test 2: Standard §-Paragraphen ---
console.log("\n2. Standard §-Paragraphen (LBO/BGB-Stil)");
test("§ mit Buchstaben-Suffix", () => {
  const { sections } = parseDocument(`
### § 38 a - Wahl des Bürgermeisters
Inhalt § 38a.

### § 39 b - Repräsentative Wahlstatistik
Inhalt § 39b.
`);
  expect(sections.length, 2, "section count");
  expect(sections[0].sectionRef, "§ 38 a", "sectionRef[0]");
  expect(sections[0].heading, "Wahl des Bürgermeisters", "heading[0]");
  expect(sections[0].sectionType, "paragraph", "type[0]");
});

test("§ ohne Titel", () => {
  const { sections } = parseDocument(`
### § 1 Beginn der Rechtsfähigkeit
Jeder Mensch...
`);
  expect(sections[0].sectionRef, "§ 1", "sectionRef");
  expect(sections[0].heading, "Beginn der Rechtsfähigkeit", "heading");
});

// --- Test 3: Generische Headings (kein §, keine Zahl) ---
console.log("\n3. Generische Headings");
test("Vorwort, A. Einkommensteuergesetz", () => {
  const { sections } = parseDocument(`
### Vorwort zum Amtlichen Lohnsteuer-Handbuch 2026
Text...

### A. Einkommensteuergesetz (EStG)
Text...
`);
  expect(sections.length, 2, "section count");
  expect(sections[0].sectionRef, "Vorwort zum Amtlichen Lohnsteuer-Handbuch 2026", "sectionRef[0]");
  expect(sections[0].sectionType, "paragraph", "type[0]"); // kein § → paragraph
  expect(sections[1].sectionRef, "A. Einkommensteuergesetz (EStG)", "sectionRef[1]");
});

// --- Test 4: ## Headings werden NICHT als Sections behandelt ---
console.log("\n4. ## Headings sind keine Section-Grenzen");
test("## Kapitel wird in Body absorbiert", () => {
  const { sections } = parseDocument(`
### § 1 Erste Norm
Inhalt §1.

## Kapitel 1 - Strukturüberschrift
Kein eigener Inhalt.

### § 2 Zweite Norm
Inhalt §2.
`);
  expect(sections.length, 2, "section count"); // nur 2 §§, kein Kapitel
  expect(sections[0].sectionRef, "§ 1", "sectionRef[0]");
  // "## Kapitel 1" landet im Body von § 1
  const bodyHasKapitel = sections[0].body.includes("Kapitel 1");
  if (!bodyHasKapitel) throw new Error("## Kapitel sollte im Body von § 1 sein");
  expect(sections[1].sectionRef, "§ 2", "sectionRef[1]");
});

// --- Test 5: #### Headings werden in Body absorbiert ---
console.log("\n5. #### Headings sind keine Section-Grenzen (LSTH)");
test("#### Hinweise landen im § -Body", () => {
  const { sections } = parseDocument(`
### § 1 Steuerpflicht
Gesetzestext.

#### Hinweise
Hinweistext.

##### Erweiterte unbeschränkte Steuerpflicht
Detailtext.

### § 2 Zweite Norm
Inhalt.
`);
  expect(sections.length, 2, "section count");
  const bodyHasHinweise = sections[0].body.includes("Hinweistext");
  if (!bodyHasHinweise) throw new Error("#### Hinweise sollten im Body von § 1 sein");
  const bodyHasDetail = sections[0].body.includes("Detailtext");
  if (!bodyHasDetail) throw new Error("##### sollte im Body von § 1 sein");
});

// --- Test 6: TOC-Erkennung unverändert ---
console.log("\n6. TOC-Erkennung");
test("TOC wird korrekt extrahiert", () => {
  const { toc, sections } = parseDocument(`
## Inhaltsverzeichnis

- § 1 Titel
- § 2 Anderes

### § 1 Titel
Inhalt.

### § 2 Anderes
Mehr.
`);
  if (!toc) throw new Error("TOC sollte vorhanden sein");
  if (!toc.includes("§ 1 Titel")) throw new Error("TOC sollte § 1 enthalten");
  expect(sections.length, 2, "section count");
});

// --- Test 7: Fallback-Parser für Dateien ohne ### ---
console.log("\n7. Fallback-Parser (keine ### Headings)");
test("##-only Datei wird via Fallback geparst", () => {
  const { sections } = parseDocument(`
## Nr. 1 Gebührenposition
Text 1.

## Nr. 2 Gebührenposition
Text 2.
`);
  expect(sections.length, 2, "section count");
  expect(sections[0].sectionRef, "Nr. 1 Gebührenposition", "sectionRef[0]");
  expect(sections[0].sectionType, "eintrag", "type[0]");
});

// --- Test 8: Dezimale Abschnittsnummern ---
console.log("\n8. Dezimale Abschnittsnummern");
test("2.1, 3.2.1 werden als abschnitt erkannt", () => {
  const { sections } = parseDocument(`
### 2.1 Unterabschnitt
Text.

### 3.2.1 Tiefer Unterabschnitt
Text.
`);
  expect(sections.length, 2, "section count");
  expect(sections[0].sectionRef, "2.1", "sectionRef[0]");
  expect(sections[0].heading, "Unterabschnitt", "heading[0]");
  expect(sections[0].sectionType, "abschnitt", "type[0]");
  expect(sections[1].sectionRef, "3.2.1", "sectionRef[1]");
});

// --- Ergebnis ---
console.log(`\n${"─".repeat(40)}`);
console.log(`Ergebnis: ${passed} bestanden, ${failed} fehlgeschlagen\n`);
if (failed > 0) process.exit(1);
