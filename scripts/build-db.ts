/**
 * Build-Pipeline: Markdown → D1
 *
 * Liest alle .md-Dateien mit gültigem RAGSource-Frontmatter,
 * parsed sie mit gray-matter und generiert SQL-Statements
 * für die D1-Datenbank.
 *
 * Nutzung:
 *   npx tsx scripts/build-db.ts --local    # Lokale D1
 *   npx tsx scripts/build-db.ts --remote   # Remote D1
 */

import { readFileSync, readdirSync, statSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { join, relative } from "path";
import matter from "gray-matter";
import { execSync } from "child_process";

const DB_NAME = "ragsource-db";

// gemeinden.json laden (für QA-Validierung)
const gemeindenData = JSON.parse(
  readFileSync(join(import.meta.dirname!, "..", "data", "gemeinden.json"), "utf-8"),
) as {
  laender: Array<{ ars: string; name: string; kuerzel: string; aliases: string[] }>;
  landkreise: Array<{ ars: string; name: string; land_ars: string; aliases: string[] }>;
  verbaende: Array<{ ars: string; name: string; kreis_ars: string; aliases: string[] }>;
  gemeinden: Array<{ ars: string; name: string; verband_ars: string; slug: string; aliases: string[] }>;
};

// QA-Lookup: ARS → Name (für Klartext-Validierung)
const ARS_TO_NAME = new Map<string, string>();
for (const l of gemeindenData.laender) ARS_TO_NAME.set(l.ars, l.name);
for (const k of gemeindenData.landkreise) ARS_TO_NAME.set(k.ars, k.name);
for (const v of gemeindenData.verbaende) ARS_TO_NAME.set(v.ars, v.name);
for (const g of gemeindenData.gemeinden) ARS_TO_NAME.set(g.ars, g.name);

// Welcher Modus?
const args = process.argv.slice(2);
const isRemote = args.includes("--remote");
const mode = isRemote ? "--remote" : "--local";

// Content-Roots: mehrere --content-root=... Parameter möglich
const contentRoots = args
  .filter((a) => a.startsWith("--content-root="))
  .map((a) => a.split("=")[1]);

// Fallback: test-articles (nur wenn kein --content-root angegeben)
if (contentRoots.length === 0) {
  contentRoots.push(join(import.meta.dirname!, "..", "test-articles"));
}

console.log(`📂 Content-Roots: ${contentRoots.join(", ")}`);
console.log(`💾 Modus: ${mode}`);

// Alle .md-Dateien rekursiv finden
function findMarkdownFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Ausschlüsse
      if (
        ["node_modules", ".obsidian", ".git", ".github", "server"].includes(
          entry,
        )
      )
        continue;
      files.push(...findMarkdownFiles(full));
    } else if (entry.endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * SQL-Escaping: Zwei bekannte wrangler-Parser-Bugs werden umgangen:
 *
 * 1. '' → char(39): wrangler's splitSqlIntoStatements behandelt '' falsch
 *    → Statements werden zusammengemergt → SQLITE_TOOBIG.
 *
 * 2. -- → char(45,45): wrangler's Parser behandelt -- als Kommentar-Start,
 *    auch innerhalb quoted strings (betrifft deutsche Rechtstexte mit
 *    Bereichsangaben wie "§§ 1 -- 3" oder Leerparagraphen "----").
 *
 * Lineare || -Ketten würden bei Texten mit vielen Sonderzeichen SQLite's
 * SQLITE_EXPR_DEPTH_MAX (100) überschreiten.
 * Fix: balancierter Binärbaum → Tiefe O(log N) statt O(N).
 */
function buildConcatTree(tokens: string[]): string {
  if (tokens.length === 0) return "''";
  if (tokens.length === 1) return tokens[0];
  const mid = Math.floor(tokens.length / 2);
  return `(${buildConcatTree(tokens.slice(0, mid))} || ${buildConcatTree(tokens.slice(mid))})`;
}

function esc(val: unknown): string {
  if (val == null) return "NULL";
  const s = val instanceof Date ? val.toISOString().slice(0, 10) : String(val);
  if (!s.includes("'") && !s.includes("--")) return "'" + s + "'";

  // Token-Liste: Textteile + char(39) für ' + char(45,45) für --
  const tokens: string[] = [];
  const dashParts = s.split("--");
  for (let i = 0; i < dashParts.length; i++) {
    if (i > 0) tokens.push("char(45,45)");
    const apoParts = dashParts[i].split("'");
    for (let j = 0; j < apoParts.length; j++) {
      if (j > 0) tokens.push("char(39)");
      tokens.push(`'${apoParts[j]}'`);
    }
  }
  return buildConcatTree(tokens);
}

// Alle Dateien aus allen Content-Roots sammeln (mit zugehörigem Root)
const mdFilesWithRoot: Array<{ file: string; root: string }> = [];
for (const root of contentRoots) {
  const files = findMarkdownFiles(root);
  for (const file of files) {
    mdFilesWithRoot.push({ file, root });
  }
}
console.log(`📄 ${mdFilesWithRoot.length} Markdown-Dateien gefunden (aus ${contentRoots.length} Root(s))`);

// Schema anwenden: DROP + CREATE (idempotent, Schema immer aktuell)
console.log("\n🗃️  Schema anwenden (DROP + CREATE)...");

const schemaDrop = [
  "DROP TABLE IF EXISTS article_projekte;",
  "DROP TABLE IF EXISTS relations;",
  "DROP TABLE IF EXISTS questions;",
  "DROP TABLE IF EXISTS keywords;",
  "DROP TABLE IF EXISTS articles_fts;",
  "DROP TABLE IF EXISTS keywords_fts;",
  "DROP TABLE IF EXISTS questions_fts;",
  "DROP TABLE IF EXISTS articles;",
  "DROP TABLE IF EXISTS gemeinden;",
  "DROP TABLE IF EXISTS geo_aliases;",
].join("\n");

const schemaFile = join(import.meta.dirname!, "..", "schema.sql");
const schemaSql = readFileSync(schemaFile, "utf-8");

// DROP alte Tabellen
const dropFile = join(import.meta.dirname!, "..", ".build-drop.sql");
writeFileSync(dropFile, schemaDrop, "utf-8");
try {
  execSync(
    `npx wrangler d1 execute ${DB_NAME} ${mode} --file=.build-drop.sql`,
    { cwd: join(import.meta.dirname!, ".."), stdio: "pipe" },
  );
  console.log("  DROP ✅");
} catch (e) {
  console.error("❌ Fehler beim DROP", e);
  if (existsSync(dropFile)) unlinkSync(dropFile);
  process.exit(1);
}
if (existsSync(dropFile)) unlinkSync(dropFile);

// CREATE neues Schema + Seed-Daten (gemeinden, geo_aliases)
const schemaOutFile = join(import.meta.dirname!, "..", ".build-schema.sql");
writeFileSync(schemaOutFile, schemaSql, "utf-8");
try {
  execSync(
    `npx wrangler d1 execute ${DB_NAME} ${mode} --file=.build-schema.sql`,
    { cwd: join(import.meta.dirname!, ".."), stdio: "pipe" },
  );
  console.log("  CREATE + SEED ✅");
} catch (e) {
  console.error("❌ Fehler beim Schema-Anlegen", e);
  if (existsSync(schemaOutFile)) unlinkSync(schemaOutFile);
  process.exit(1);
}
if (existsSync(schemaOutFile)) unlinkSync(schemaOutFile);

// SQL-Statements sammeln, gruppiert pro Artikel (nie über Artikelgrenzen batchen)
const articleGroups: string[][] = [];
const tailStatements: string[] = []; // FTS-Rebuild am Ende

let imported = 0;

for (const { file, root } of mdFilesWithRoot) {
  const raw = readFileSync(file, "utf-8");

  let parsed;
  try {
    parsed = matter(raw);
  } catch {
    console.log(`  ⏭️  Übersprungen (kein gültiges Frontmatter): ${file}`);
    continue;
  }

  const fm = parsed.data;

  // Pflichtfelder prüfen
  if (!fm.titel || !fm.ebene || !fm.saule) {
    console.log(
      `  ⏭️  Übersprungen (fehlt titel/ebene/saule): ${file}`,
    );
    continue;
  }

  if (fm.status && fm.status !== "published") {
    console.log(`  ⏭️  Übersprungen (status=${fm.status}): ${file}`);
    continue;
  }

  const content = parsed.content.trim();
  const tokenCount = Math.round(content.length / 4);
  const dateipfad = relative(root, file).replace(/\\/g, "/");

  // Geo-Felder: direkt aus Frontmatter (ARS = Wahrheit seit Migration)
  const land_ars: string | null = fm.land_ars || null;
  const kreis_ars: string | null = fm.kreis_ars || null;
  const verband_ars: string | null = fm.verband_ars || null;
  const gemeinde_ars: string | null = fm.gemeinde_ars || null;

  // QA-Validierung: ARS gegen gemeinden.json prüfen
  if (gemeinde_ars && !ARS_TO_NAME.has(gemeinde_ars)) {
    console.log(`  ⚠️  QA: gemeinde_ars "${gemeinde_ars}" nicht in gemeinden.json: ${file}`);
  }
  if (verband_ars && !ARS_TO_NAME.has(verband_ars)) {
    console.log(`  ⚠️  QA: verband_ars "${verband_ars}" nicht in gemeinden.json: ${file}`);
  }
  if (kreis_ars && !ARS_TO_NAME.has(kreis_ars)) {
    console.log(`  ⚠️  QA: kreis_ars "${kreis_ars}" nicht in gemeinden.json: ${file}`);
  }
  if (land_ars && !ARS_TO_NAME.has(land_ars)) {
    console.log(`  ⚠️  QA: land_ars "${land_ars}" nicht in gemeinden.json: ${file}`);
  }
  // Konsistenz-Check: ARS-Hierarchie passt zusammen?
  if (gemeinde_ars && kreis_ars && !gemeinde_ars.startsWith(kreis_ars)) {
    console.log(`  ⚠️  QA: gemeinde_ars "${gemeinde_ars}" passt nicht zu kreis_ars "${kreis_ars}": ${file}`);
  }
  if (kreis_ars && land_ars && !kreis_ars.startsWith(land_ars)) {
    console.log(`  ⚠️  QA: kreis_ars "${kreis_ars}" passt nicht zu land_ars "${land_ars}": ${file}`);
  }

  // Wiki-Artikel ohne projekte-Feld: Warnung
  const projekte: string[] = fm.projekte || [];
  if (fm.saule === "wiki" && projekte.length === 0) {
    console.log(`  ⚠️  Warnung: Wiki-Artikel ohne projekte-Feld: ${file}`);
  }

  // Ebene normalisieren: gvv → verband (Rückwärtskompatibilität)
  const ebene = fm.ebene === "gvv" ? "verband" : fm.ebene;

  imported++;
  console.log(`  ✅ ${fm.titel} (${tokenCount} Tokens, land=${land_ars || '-'}, kreis=${kreis_ars || '-'}, verband=${verband_ars || '-'}, gemeinde=${gemeinde_ars || '-'}, proj=[${projekte.join(',')}])`);

  // Alle Statements dieses Artikels als Gruppe sammeln (nie über Artikelgrenzen batchen)
  const group: string[] = [];

  // Article einfügen (mit ARS-Spalten)
  group.push(
    `INSERT INTO articles (titel, land_ars, kreis_ars, verband_ars, gemeinde_ars, ebene, saule, content, gueltig_ab, status, dateipfad, quelle, token_count) VALUES (${esc(fm.titel)}, ${esc(land_ars)}, ${esc(kreis_ars)}, ${esc(verband_ars)}, ${esc(gemeinde_ars)}, ${esc(ebene)}, ${esc(fm.saule)}, ${esc(content)}, ${esc(fm.gueltig_ab)}, ${esc(fm.status || "published")}, ${esc(dateipfad)}, ${esc(fm.quelle)}, ${tokenCount});`,
  );

  // Projekte (Junction-Tabelle)
  for (const p of projekte) {
    group.push(
      `INSERT INTO article_projekte (article_id, projekt) VALUES ((SELECT MAX(id) FROM articles), ${esc(p)});`,
    );
  }

  // Keywords
  const keywords: string[] = fm.keywords || [];
  for (const kw of keywords) {
    group.push(
      `INSERT INTO keywords (article_id, keyword) VALUES ((SELECT MAX(id) FROM articles), ${esc(kw)});`,
    );
  }

  // Fragen
  const fragen: string[] = fm.fragen || [];
  for (const f of fragen) {
    group.push(
      `INSERT INTO questions (article_id, question) VALUES ((SELECT MAX(id) FROM articles), ${esc(f)});`,
    );
  }

  // Querverweise
  const querverweise: string[] = fm.querverweise || [];
  for (const qv of querverweise) {
    group.push(
      `INSERT INTO relations (article_id, related_titel) VALUES ((SELECT MAX(id) FROM articles), ${esc(qv)});`,
    );
  }

  // FTS5: articles_fts befüllen (rowid = articles.id)
  group.push(
    `INSERT INTO articles_fts (rowid, titel, content) VALUES ((SELECT MAX(id) FROM articles), ${esc(fm.titel)}, ${esc(content)});`,
  );

  articleGroups.push(group);
}

// keywords_fts und questions_fts rebuilden (content-sync tables)
tailStatements.push("INSERT INTO keywords_fts(keywords_fts) VALUES('rebuild');");
tailStatements.push("INSERT INTO questions_fts(questions_fts) VALUES('rebuild');");

const totalStatements = articleGroups.reduce((sum, g) => sum + g.length, 0) + tailStatements.length;
console.log(`\n📊 ${imported} Artikel importiert`);
console.log(`📝 ${totalStatements} SQL-Statements generiert`);

// SQL in Batches aufteilen — Artikelgrenzen respektieren UND Byte-Limit einhalten
// (Nie einen Artikel über zwei Batches splitten, da child-Inserts
//  via SELECT MAX(id) auf den Parent angewiesen sind)
// D1 Remote API hat ein Limit für SQL-Datei-Größe — wir bleiben deutlich darunter.
const BATCH_SIZE = 100;            // Max. Statements pro Batch (Statement-Grenze)
const BATCH_MAX_BYTES = 4_000_000; // Max. ~4 MB pro Batch-Datei (Byte-Grenze)
const batches: string[][] = [];
let currentBatch: string[] = [];
let currentBatchBytes = 0;

for (const group of articleGroups) {
  const groupBytes = group.reduce((sum, s) => sum + Buffer.byteLength(s, "utf8"), 0);
  // Neuen Batch starten wenn Statement- oder Byte-Limit überschritten würde
  // (außer der Batch ist noch leer — dann passt die Gruppe immer rein)
  if (
    currentBatch.length > 0 &&
    (currentBatch.length + group.length > BATCH_SIZE ||
      currentBatchBytes + groupBytes > BATCH_MAX_BYTES)
  ) {
    batches.push(currentBatch);
    currentBatch = [];
    currentBatchBytes = 0;
  }
  currentBatch.push(...group);
  currentBatchBytes += groupBytes;
}

// Tail-Statements (FTS-Rebuild) an letzten Batch anhängen oder neuen erstellen
const tailBytes = tailStatements.reduce((sum, s) => sum + Buffer.byteLength(s, "utf8"), 0);
if (
  currentBatch.length + tailStatements.length > BATCH_SIZE ||
  currentBatchBytes + tailBytes > BATCH_MAX_BYTES
) {
  batches.push(currentBatch);
  batches.push(tailStatements);
} else {
  currentBatch.push(...tailStatements);
  batches.push(currentBatch);
}

console.log(`\n🚀 Führe SQL aus (${mode}) in ${batches.length} Batches (max. ${BATCH_SIZE} Statements / ${BATCH_MAX_BYTES / 1_000_000} MB pro Batch)...`);

const sqlFile = join(import.meta.dirname!, "..", ".build-seed.sql");

let batchNum = 0;
for (const batch of batches) {
  batchNum++;
  process.stdout.write(`  Batch ${batchNum}/${batches.length}... `);
  writeFileSync(sqlFile, batch.join("\n"), "utf-8");
  try {
    execSync(
      `npx wrangler d1 execute ${DB_NAME} ${mode} --file=.build-seed.sql`,
      {
        cwd: join(import.meta.dirname!, ".."),
        stdio: "pipe",
      },
    );
    process.stdout.write("✅\n");
  } catch (e) {
    process.stdout.write("❌\n");
    console.error("❌ Fehler in Batch", batchNum, e);
    if (existsSync(sqlFile)) unlinkSync(sqlFile);
    process.exit(1);
  }
}

if (existsSync(sqlFile)) unlinkSync(sqlFile);
console.log("✅ Datenbank erfolgreich befüllt!");
