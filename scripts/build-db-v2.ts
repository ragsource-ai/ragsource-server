/**
 * Build-Pipeline v2: Markdown → D1 (Agentic RAG Schema)
 *
 * Verarbeitet Markdown-Dateien aus dem Content-Repo und befüllt die v2-Datenbank:
 *   1. Frontmatter → sources (Metadaten, section_count, total_tokens, size_class)
 *   2. ## Inhaltsverzeichnis-Block → source_tocs
 *   3. ### § / ### Art. / ### EG / ## Kapitel-Blöcke → source_sections
 *   4. FTS5-Rebuild → sections_fts
 *
 * Nutzung:
 *   npx tsx scripts/build-db-v2.ts --local    # Lokale D1
 *   npx tsx scripts/build-db-v2.ts --remote   # Remote D1
 *   npx tsx scripts/build-db-v2.ts --local --content-root=/pfad/zum/content
 */

import {
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from "fs";
import { join, relative, basename } from "path";
import matter from "gray-matter";
import { execSync } from "child_process";

// -----------------------------------------------------------------------
// Konfiguration
// -----------------------------------------------------------------------

const DB_NAME = "ragsource-db-v2";
const SCHEMA_FILE = "schema-v2.sql";
const WRANGLER_CONFIG = "wrangler-v2.jsonc"; // Separate Konfiguration für v2
const BATCH_SIZE = 80; // Statements pro Batch (etwas kleiner für v2, da mehr Statements pro Datei)

// Token-Schwellen für size_class
const TOKEN_SMALL = 3_000;
const TOKEN_LARGE = 15_000;

// Regex für §-Headings — unterstützt alle Varianten aus dem bestehenden Content:
//   - §: ## bis ###### § N, § Na (z.B. § 12a)
//   - Artikel: #### Artikel N (DSGVO), ### Art. N
//   - Erwägungsgrund: #### Erwägungsgrund N (DSGVO)
//   - EG: ### EG N (Plan-Format)
//   - Kapitel: ## Kapitel N
// Kein Limit auf Heading-Ebene (2–6 Rauten) um ##### und ###### (GKZ BW) zu erfassen
const SECTION_HEADING_MATCH_RE = /^(#{2,6})\s+(§\s*\d+[a-z]?|Artikel\s+\d+[a-z]?|Art\.\s*\d+[a-z]?|Erwägungsgrund\s+\d+|EG\s+\d+|Kapitel\s+\d+[a-z]?)\s*(?:[—–-]\s*)?(.*)?$/i;
// Für das Splitting: Beginnt eine Zeile mit einem §/Artikel/Erwägungsgrund-Heading (2–6 Rauten)?
const SECTION_START_RE = /^#{2,6}\s+(?:§\s*\d+[a-z]?|Artikel\s+\d+[a-z]?|Art\.\s*\d+[a-z]?|Erwägungsgrund\s+\d+|EG\s+\d+|Kapitel\s+\d+[a-z]?)/m;

// -----------------------------------------------------------------------
// CLI-Argumente
// -----------------------------------------------------------------------

const args = process.argv.slice(2);
const isRemote = args.includes("--remote");
const mode = isRemote ? "--remote" : "--local";

const contentRoots = args
  .filter((a) => a.startsWith("--content-root="))
  .map((a) => a.split("=")[1]);

if (contentRoots.length === 0) {
  // Fallback: test-articles
  contentRoots.push(join(import.meta.dirname!, "..", "test-articles"));
}

console.log(`📂 Content-Roots: ${contentRoots.join(", ")}`);
console.log(`💾 Modus: ${mode}`);
console.log(`🗄️  Datenbank: ${DB_NAME}`);

// -----------------------------------------------------------------------
// Hilfsfunktionen
// -----------------------------------------------------------------------

/**
 * SQL-Escaping: Single quotes werden via char(39) umgangen,
 * weil wrangler's splitSqlIntoStatements '' (doppeltes Hochkomma)
 * nicht korrekt als escaped quote erkennt und falsch splittet.
 * SQLite: 'part1' || char(39) || 'part2' = 'part1'part2'
 */
function esc(val: unknown): string {
  if (val == null) return "NULL";
  const s = String(val);
  if (!s.includes("'")) return "'" + s + "'";
  // Apostrophe mit char(39) umgehen
  return s.split("'").map(p => "'" + p + "'").join(" || char(39) || ");
}

/** Schätzt Token-Anzahl: 1 Token ≈ 4 Zeichen (englisch/deutsch) */
function estimateTokens(text: string): number {
  return Math.round(text.length / 4);
}

/** Bestimmt size_class anhand des Token-Counts */
function getSizeClass(tokens: number): string {
  if (tokens < TOKEN_SMALL) return "small";
  if (tokens <= TOKEN_LARGE) return "medium";
  return "large";
}

/**
 * Generiert eine stabile Source-ID aus dem Dateinamen.
 * Beispiel: "FwG-BW.md" → "FwG_BW"
 *           "GKZ-BW_TEIL-1-2_Allgemeine-Vorschriften.md" → "GKZ_BW_TEIL_1_2_Allgemeine_Vorschriften"
 */
function generateSourceId(filePath: string): string {
  return basename(filePath, ".md").replace(/[-\s]+/g, "_");
}

/**
 * Generiert eine Section-ID aus Source-ID + section_ref.
 * Beispiel: "FwG_BW" + "§ 2" → "FwG_BW_§2"
 *           "DSGVO" + "Art. 6" → "DSGVO_Art6"
 *           "DSGVO" + "EG 40" → "DSGVO_EG40"
 */
function generateSectionId(sourceId: string, sectionRef: string): string {
  const normalized = sectionRef
    .replace(/\s+/g, "")
    .replace(/\./g, "");
  return `${sourceId}_${normalized}`;
}

/** Rekursiv alle .md-Dateien finden (mit denselben Ausschlüssen wie v1) */
function findMarkdownFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (["node_modules", ".obsidian", ".git", ".github", "server"].includes(entry)) {
        continue;
      }
      files.push(...findMarkdownFiles(full));
    } else if (entry.endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

// -----------------------------------------------------------------------
// Markdown-Parsing: TOC + Paragraphen
// -----------------------------------------------------------------------

interface ParsedSection {
  sectionRef: string;    // "§ 2", "Art. 6", "EG 40"
  heading: string;       // Titel ohne section_ref (kann leer sein)
  body: string;          // Volltext des Abschnitts (ohne Heading-Zeile)
  sectionType: string;   // "paragraph" | "artikel" | "erwaegungsgrund" | "kapitel"
  sortOrder: number;
}

interface ParsedDocument {
  toc: string | null;    // TOC-Inhalt als Markdown (oder null wenn nicht vorhanden)
  sections: ParsedSection[];
}

/**
 * Parst eine Markdown-Datei (nach dem Frontmatter) in TOC + Paragraphen.
 *
 * Erwartet die v2-Struktur:
 *   ## Inhaltsverzeichnis
 *   ...TOC-Inhalt...
 *
 *   ## ERSTER TEIL / ## Abschnitt... (optional, wird ignoriert)
 *   ### § 1 Titel
 *   ...Inhalt...
 *   ### § 2 Titel
 *   ...
 *
 * Wenn kein TOC-Block vorhanden: toc = null.
 * Wenn keine §-Headings vorhanden: sections = [] (alte v1-Artikel).
 */
function parseDocument(content: string): ParsedDocument {
  const lines = content.split(/\r?\n/); // CRLF + LF kompatibel
  let toc: string | null = null;
  const sections: ParsedSection[] = [];
  let sortOrder = 0;

  // --- Phase 1: TOC suchen ---
  // Beginnt bei "## Inhaltsverzeichnis", endet beim nächsten "## " (nicht "###")
  let tocStart = -1;
  let tocEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+Inhaltsverzeichnis\s*$/i.test(line)) {
      tocStart = i + 1;
      continue;
    }
    if (tocStart !== -1 && tocEnd === -1) {
      // TOC-Ende: nächste ## -Überschrift (auch ###) — deckt Gesetze ohne ##-Struktur ab
      // (z.B. VwVfG, das nur ### § N Headings hat, kein ## ABSCHNITT)
      if (/^#{2,3}\s+[^#]/.test(line)) {
        tocEnd = i;
        break;
      }
    }
  }

  if (tocStart !== -1) {
    const end = tocEnd !== -1 ? tocEnd : lines.length;
    toc = lines.slice(tocStart, end).join("\n").trim();
    if (!toc) toc = null;
  }

  // --- Phase 2: §-Abschnitte extrahieren ---
  // Splittet den Content an §/Art./EG/Kapitel-Headings (### oder ##)
  let currentSectionLines: string[] = [];
  let currentHeadingLine: string | null = null;

  function flushSection() {
    if (!currentHeadingLine) return;

    const headingMatch = currentHeadingLine.match(SECTION_HEADING_MATCH_RE);
    if (!headingMatch) return;

    const sectionRef = headingMatch[2].trim();
    const headingText = (headingMatch[3] || "").trim();
    const body = currentSectionLines.join("\n").trim();

    // Section-Type bestimmen
    let sectionType = "paragraph";
    if (/^Artikel\s/i.test(sectionRef) || /^Art\./i.test(sectionRef)) sectionType = "artikel";
    else if (/^Erwägungs/i.test(sectionRef) || /^EG\s/i.test(sectionRef)) sectionType = "erwaegungsgrund";
    else if (/^Kapitel/i.test(sectionRef)) sectionType = "kapitel";

    sections.push({
      sectionRef,
      heading: headingText,
      body,
      sectionType,
      sortOrder: sortOrder++,
    });

    currentSectionLines = [];
    currentHeadingLine = null;
  }

  for (const line of lines) {
    // Ist das eine §-Heading-Zeile? (2–6 Rauten, alle Varianten)
    const isSectionHeading = SECTION_START_RE.test(line);

    if (isSectionHeading) {
      flushSection();
      currentHeadingLine = line;
    } else if (currentHeadingLine !== null) {
      currentSectionLines.push(line);
    }
    // Zeilen vor dem ersten § werden ignoriert (Präambel, TOC, etc.)
  }

  // Letzten Abschnitt flush
  flushSection();

  return { toc, sections };
}

// -----------------------------------------------------------------------
// Alle Content-Dateien einlesen
// -----------------------------------------------------------------------

const mdFilesWithRoot: Array<{ file: string; root: string }> = [];
for (const root of contentRoots) {
  if (!existsSync(root)) {
    console.warn(`⚠️  Content-Root existiert nicht: ${root}`);
    continue;
  }
  const files = findMarkdownFiles(root);
  for (const file of files) {
    mdFilesWithRoot.push({ file, root });
  }
}

console.log(
  `📄 ${mdFilesWithRoot.length} Markdown-Dateien gefunden (aus ${contentRoots.length} Root(s))\n`,
);

// -----------------------------------------------------------------------
// Schema anwenden: DROP + CREATE (idempotent)
// -----------------------------------------------------------------------

console.log("🗃️  Schema anwenden (DROP + CREATE)...");

const schemaDrop = [
  "DROP TABLE IF EXISTS sections_fts;",
  "DROP TABLE IF EXISTS source_relations;",
  "DROP TABLE IF EXISTS source_sections;",
  "DROP TABLE IF EXISTS source_tocs;",
  "DROP TABLE IF EXISTS source_projekte;",
  "DROP TABLE IF EXISTS sources;",
  "DROP TABLE IF EXISTS gemeinden;",
  "DROP TABLE IF EXISTS geo_aliases;",
].join("\n");

const schemaDir = join(import.meta.dirname!, "..");
const schemaSql = readFileSync(join(schemaDir, SCHEMA_FILE), "utf-8");

const dropFile = join(schemaDir, ".build-drop-v2.sql");
writeFileSync(dropFile, schemaDrop, "utf-8");
try {
  execSync(`npx wrangler d1 execute ${DB_NAME} ${mode} --config=${WRANGLER_CONFIG} --file=.build-drop-v2.sql`, {
    cwd: schemaDir,
    stdio: "pipe",
  });
  console.log("  DROP ✅");
} catch (e) {
  console.error("❌ Fehler beim DROP:", e);
  if (existsSync(dropFile)) unlinkSync(dropFile);
  process.exit(1);
}
if (existsSync(dropFile)) unlinkSync(dropFile);

const schemaOutFile = join(schemaDir, ".build-schema-v2.sql");
writeFileSync(schemaOutFile, schemaSql, "utf-8");
try {
  execSync(`npx wrangler d1 execute ${DB_NAME} ${mode} --config=${WRANGLER_CONFIG} --file=.build-schema-v2.sql`, {
    cwd: schemaDir,
    stdio: "pipe",
  });
  console.log("  CREATE + SEED ✅\n");
} catch (e) {
  console.error("❌ Fehler beim Schema-Anlegen:", e);
  if (existsSync(schemaOutFile)) unlinkSync(schemaOutFile);
  process.exit(1);
}
if (existsSync(schemaOutFile)) unlinkSync(schemaOutFile);

// -----------------------------------------------------------------------
// Dateien verarbeiten und SQL-Statements erzeugen
// -----------------------------------------------------------------------

// Artikel-Gruppen: Pro Quelldatei ein Array von Statements (nie über Dateigrenzen batchen)
const articleGroups: string[][] = [];
const tailStatements: string[] = [];

let imported = 0;
let skipped = 0;
let sectionTotal = 0;

// Source-IDs zur Deduplizierung tracken
const seenIds = new Map<string, string>(); // id → filePath

for (const { file, root } of mdFilesWithRoot) {
  const raw = readFileSync(file, "utf-8");

  let parsed;
  try {
    parsed = matter(raw);
  } catch {
    console.log(`  ⏭️  Übersprungen (kein gültiges Frontmatter): ${file}`);
    skipped++;
    continue;
  }

  const fm = parsed.data;

  // Pflichtfeld: titel
  if (!fm.titel) {
    console.log(`  ⏭️  Übersprungen (fehlt titel): ${file}`);
    skipped++;
    continue;
  }

  // Status-Filter (wie v1)
  if (fm.status && fm.status !== "published") {
    console.log(`  ⏭️  Übersprungen (status=${fm.status}): ${file}`);
    skipped++;
    continue;
  }

  // Source-ID aus Dateinamen generieren
  const sourceId = generateSourceId(file);

  // Kollision prüfen
  if (seenIds.has(sourceId)) {
    console.warn(`  ⚠️  ID-Kollision: "${sourceId}" bereits von ${seenIds.get(sourceId)}, überspringe ${file}`);
    skipped++;
    continue;
  }
  seenIds.set(sourceId, file);

  // Markdown-Body parsen (TOC + §§)
  const body = parsed.content;
  const { toc, sections } = parseDocument(body);

  // Token-Schätzung (Gesamt-Body inkl. TOC)
  const totalTokens = estimateTokens(body);
  const sizeClass = getSizeClass(totalTokens);

  // Geo-Felder aus Frontmatter (direkt, wie v1)
  const land_ars: string | null = fm.land_ars || null;
  const kreis_ars: string | null = fm.kreis_ars || null;
  const verband_ars: string | null = fm.verband_ars || null;
  const gemeinde_ars: string | null = fm.gemeinde_ars || null;

  // Ebene normalisieren
  const ebene: string | null = fm.ebene === "gvv" ? "verband" : (fm.ebene || null);

  // Dateipfad relativ zum Content-Root
  const dateipfad = relative(root, file).replace(/\\/g, "/");

  // Projekte
  const projekte: string[] = fm.projekte || [];

  imported++;
  console.log(
    `  ✅ ${fm.titel} (${totalTokens} Token, ${sizeClass}, ${sections.length} §§, ` +
    `land=${land_ars || "-"}, kreis=${kreis_ars || "-"}, verband=${verband_ars || "-"}, gemeinde=${gemeinde_ars || "-"})`,
  );

  // --- SQL-Gruppe für diese Quelle ---
  const group: string[] = [];

  // 1. sources-Eintrag
  group.push(
    `INSERT INTO sources (id, titel, kurzbezeichnung, typ, ebene, land_ars, kreis_ars, verband_ars, gemeinde_ars, section_count, total_tokens, size_class, gueltig_ab, quelle, dateipfad) VALUES (` +
    `${esc(sourceId)}, ${esc(fm.titel)}, ${esc(fm.kurzbezeichnung || null)}, ${esc(fm.typ || null)}, ${esc(ebene)}, ` +
    `${esc(land_ars)}, ${esc(kreis_ars)}, ${esc(verband_ars)}, ${esc(gemeinde_ars)}, ` +
    `${sections.length}, ${totalTokens}, ${esc(sizeClass)}, ` +
    `${esc(fm.gueltig_ab || null)}, ${esc(fm.quelle || null)}, ${esc(dateipfad)});`,
  );

  // 2. source_projekte
  for (const p of projekte) {
    group.push(
      `INSERT INTO source_projekte (source_id, projekt) VALUES (${esc(sourceId)}, ${esc(p)});`,
    );
  }

  // 3. source_tocs (nur wenn TOC vorhanden)
  if (toc) {
    const tocId = `${sourceId}_toc`;
    group.push(
      `INSERT INTO source_tocs (id, source_id, toc_level, content) VALUES (${esc(tocId)}, ${esc(sourceId)}, 'gesamt', ${esc(toc)});`,
    );
  }

  // 4. source_sections
  const sectionIds = new Set<string>(); // Duplikate innerhalb einer Quelle verhindern

  for (const section of sections) {
    let sectionId = generateSectionId(sourceId, section.sectionRef);

    // Duplikat-Handling: Wenn gleiche Ref zweimal (z.B. § 1a + § 1a), Suffix anhängen
    if (sectionIds.has(sectionId)) {
      sectionId = `${sectionId}_${section.sortOrder}`;
    }
    sectionIds.add(sectionId);

    group.push(
      `INSERT INTO source_sections (id, source_id, section_ref, heading, body, section_type, sort_order) VALUES (` +
      `${esc(sectionId)}, ${esc(sourceId)}, ${esc(section.sectionRef)}, ${esc(section.heading || null)}, ` +
      `${esc(section.body)}, ${esc(section.sectionType)}, ${section.sortOrder});`,
    );

    sectionTotal++;
  }

  // 5. FTS5 für sections: direkt einfügen (kein content-sync hier, wir rebuilden am Ende)
  // sections_fts ist eine content-table → rebuild am Ende

  articleGroups.push(group);
}

// FTS5-Rebuild am Ende (muss nach allen Inserts kommen)
tailStatements.push("INSERT INTO sections_fts(sections_fts) VALUES('rebuild');");

console.log(`\n📊 Zusammenfassung:`);
console.log(`   ${imported} Quellen importiert, ${skipped} übersprungen`);
console.log(`   ${sectionTotal} Paragraphen/Abschnitte total`);
console.log(`   ${articleGroups.reduce((s, g) => s + g.length, 0) + tailStatements.length} SQL-Statements gesamt`);

// -----------------------------------------------------------------------
// Batching (Artikelgrenzen respektieren, wie v1)
// -----------------------------------------------------------------------

const batches: string[][] = [];
let currentBatch: string[] = [];

for (const group of articleGroups) {
  if (currentBatch.length > 0 && currentBatch.length + group.length > BATCH_SIZE) {
    batches.push(currentBatch);
    currentBatch = [];
  }
  currentBatch.push(...group);
}

// Tail-Statements (FTS-Rebuild) anhängen
if (currentBatch.length + tailStatements.length > BATCH_SIZE) {
  batches.push(currentBatch);
  batches.push(tailStatements);
} else {
  currentBatch.push(...tailStatements);
  batches.push(currentBatch);
}

console.log(`\n🚀 Führe SQL aus (${mode}) in ${batches.length} Batches à max. ${BATCH_SIZE} Statements...`);

const sqlFile = join(schemaDir, ".build-seed-v2.sql");
let batchNum = 0;

for (const batch of batches) {
  batchNum++;
  process.stdout.write(`  Batch ${batchNum}/${batches.length}... `);
  writeFileSync(sqlFile, batch.join("\n"), "utf-8");
  try {
    execSync(`npx wrangler d1 execute ${DB_NAME} ${mode} --config=${WRANGLER_CONFIG} --file=.build-seed-v2.sql`, {
      cwd: schemaDir,
      stdio: "pipe",
    });
    process.stdout.write("✅\n");
  } catch (e) {
    process.stdout.write("❌\n");
    console.error(`❌ Fehler in Batch ${batchNum}:`, e);
    if (existsSync(sqlFile)) unlinkSync(sqlFile);
    process.exit(1);
  }
}

if (existsSync(sqlFile)) unlinkSync(sqlFile);
console.log("\n✅ v2-Datenbank erfolgreich befüllt!");
