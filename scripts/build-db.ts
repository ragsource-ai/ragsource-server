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

// gemeinden.json laden (Single Source of Truth)
const gemeindenData = JSON.parse(
  readFileSync(join(import.meta.dirname!, "..", "data", "gemeinden.json"), "utf-8"),
) as {
  laender: Array<{ ars: string; name: string; kuerzel: string; aliases: string[] }>;
  landkreise: Array<{ ars: string; name: string; land_ars: string; aliases: string[] }>;
  verbaende: Array<{ ars: string; name: string; kreis_ars: string; aliases: string[] }>;
  gemeinden: Array<{ ars: string; name: string; verband_ars: string; slug: string; aliases: string[] }>;
};

// Slug → ARS-Lookup aufbauen (für Frontmatter-Auflösung)
const SLUG_TO_ARS: Record<string, {
  ars: string;
  verband_ars: string;
  kreis_ars: string;
  land_ars: string;
}> = {};

for (const g of gemeindenData.gemeinden) {
  const verband = gemeindenData.verbaende.find(v => v.ars === g.verband_ars);
  const kreis_ars = verband
    ? verband.kreis_ars
    : g.ars.substring(0, 5);
  const land_ars = g.ars.substring(0, 2);

  SLUG_TO_ARS[g.slug] = {
    ars: g.ars,
    verband_ars: g.verband_ars,
    kreis_ars,
    land_ars,
  };
}

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

// SQL-Escaping
function esc(val: unknown): string {
  if (val == null) return "NULL";
  const s = val instanceof Date ? val.toISOString().slice(0, 10) : String(val);
  return "'" + s.replace(/'/g, "''") + "'";
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

// SQL-Statements sammeln (nur Artikel-Daten, Schema ist schon angelegt)
const statements: string[] = [];

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

  // Geo-Felder: ARS aus gemeinden.json auflösen
  let land_ars: string | null = null;
  let kreis_ars: string | null = null;
  let verband_ars: string | null = null;
  let gemeinde_ars: string | null = null;

  if (fm.gemeinde && SLUG_TO_ARS[fm.gemeinde]) {
    const geo = SLUG_TO_ARS[fm.gemeinde];
    gemeinde_ars = geo.ars;
    verband_ars = geo.verband_ars || null;
    kreis_ars = geo.kreis_ars;
    land_ars = geo.land_ars;
  } else {
    // Bundesland/Landkreis aus Frontmatter (für kreis/land-Ebene)
    if (fm.bundesland) {
      const land = gemeindenData.laender.find(l =>
        l.kuerzel.toLowerCase() === fm.bundesland.toLowerCase() ||
        l.aliases.includes(fm.bundesland.toLowerCase())
      );
      if (land) land_ars = land.ars;
    }
    if (fm.landkreis) {
      const kreis = gemeindenData.landkreise.find(k =>
        k.aliases.includes(fm.landkreis.toLowerCase())
      );
      if (kreis) {
        kreis_ars = kreis.ars;
        if (!land_ars) land_ars = kreis.land_ars;
      }
    }
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

  // Article einfügen (mit ARS-Spalten)
  statements.push(
    `INSERT INTO articles (titel, land_ars, kreis_ars, verband_ars, gemeinde_ars, ebene, saule, content, gueltig_ab, status, dateipfad, quelle, token_count) VALUES (${esc(fm.titel)}, ${esc(land_ars)}, ${esc(kreis_ars)}, ${esc(verband_ars)}, ${esc(gemeinde_ars)}, ${esc(ebene)}, ${esc(fm.saule)}, ${esc(content)}, ${esc(fm.gueltig_ab)}, ${esc(fm.status || "published")}, ${esc(dateipfad)}, ${esc(fm.quelle)}, ${tokenCount});`,
  );

  // Projekte (Junction-Tabelle)
  for (const p of projekte) {
    statements.push(
      `INSERT INTO article_projekte (article_id, projekt) VALUES ((SELECT MAX(id) FROM articles), ${esc(p)});`,
    );
  }

  // Keywords
  const keywords: string[] = fm.keywords || [];
  for (const kw of keywords) {
    statements.push(
      `INSERT INTO keywords (article_id, keyword) VALUES ((SELECT MAX(id) FROM articles), ${esc(kw)});`,
    );
  }

  // Fragen
  const fragen: string[] = fm.fragen || [];
  for (const f of fragen) {
    statements.push(
      `INSERT INTO questions (article_id, question) VALUES ((SELECT MAX(id) FROM articles), ${esc(f)});`,
    );
  }

  // Querverweise
  const querverweise: string[] = fm.querverweise || [];
  for (const qv of querverweise) {
    statements.push(
      `INSERT INTO relations (article_id, related_titel) VALUES ((SELECT MAX(id) FROM articles), ${esc(qv)});`,
    );
  }

  // FTS5: articles_fts befüllen (rowid = articles.id)
  statements.push(
    `INSERT INTO articles_fts (rowid, titel, content) VALUES ((SELECT MAX(id) FROM articles), ${esc(fm.titel)}, ${esc(content)});`,
  );
}

// keywords_fts und questions_fts rebuilden (content-sync tables)
statements.push("INSERT INTO keywords_fts(keywords_fts) VALUES('rebuild');");
statements.push("INSERT INTO questions_fts(questions_fts) VALUES('rebuild');");

console.log(`\n📊 ${imported} Artikel importiert`);
console.log(`📝 ${statements.length} SQL-Statements generiert`);

// SQL in Batches aufteilen und nacheinander ausführen
// (Wrangler crasht bei sehr großen SQL-Dateien lokal)
const BATCH_SIZE = 100;
const batches: string[][] = [];
for (let i = 0; i < statements.length; i += BATCH_SIZE) {
  batches.push(statements.slice(i, i + BATCH_SIZE));
}

console.log(`\n🚀 Führe SQL aus (${mode}) in ${batches.length} Batches à max. ${BATCH_SIZE} Statements...`);

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
