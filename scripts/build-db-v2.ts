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
 *   npx tsx scripts/build-db-v2.ts --local                              # Vollst. Rebuild (lokal)
 *   npx tsx scripts/build-db-v2.ts --remote                             # Vollst. Rebuild (remote)
 *   npx tsx scripts/build-db-v2.ts --remote --incremental               # Nur geänderte Quellen
 *   npx tsx scripts/build-db-v2.ts --local --content-root=/pfad         # Custom Content-Root
 *
 * --incremental (Option B, Phase 4a):
 *   Überspringt DROP/CREATE. Berechnet SHA-256 je Datei, lädt bestehende Hashes
 *   aus der DB, verarbeitet nur neue/geänderte/gelöschte Quellen.
 *   Erwartet: content_hash-Spalte in sources (wird per Migration angelegt falls fehlend).
 *   Erster Lauf nach Upgrade: alle Quellen gelten als "geändert" (content_hash=NULL) →
 *   vollständiger Re-Insert ohne DROP/CREATE. Ab dem zweiten Lauf echter Inkrementalbetrieb.
 *
 * (Dateiname build-db-v2.ts bleibt fuer Rueckwaertskompatibilitaet mit CI/CD bestehen)
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
import { createHash } from "crypto";
import matter from "gray-matter";
import { execSync } from "child_process";
import { esc, buildConcatTree } from "./sql-utils.js";

// -----------------------------------------------------------------------
// Parameterized Statement Type (für D1 REST API ohne Statement-Size-Limit)
// -----------------------------------------------------------------------

interface SqlStmt {
  sql: string;
  params: unknown[];
}

/** Konvertiert ein parameterized Statement in Inline-SQL (für --local File-Execution). */
function stmtToInlineSql(stmt: SqlStmt): string {
  if (stmt.params.length === 0) return stmt.sql;
  let idx = 0;
  return stmt.sql.replace(/\?/g, () => esc(stmt.params[idx++]));
}

// -----------------------------------------------------------------------
// Konfiguration
// -----------------------------------------------------------------------

const DB_NAME = "ragsource-db-v2";
const SCHEMA_FILE = "schema.sql";
const WRANGLER_CONFIG = "wrangler.jsonc";
const BATCH_SIZE = 80; // Statements pro Batch

// D1 REST API (für --remote, ersetzt wrangler-CLI-Spawn pro Batch)
const D1_DB_ID = "55d4deda-60c5-4b70-a6d1-2b76f43e5715"; // aus wrangler.jsonc
const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const API_CONCURRENCY = 5; // max. parallele D1-API-Anfragen

// Token-Schwellen für size_class
const TOKEN_SMALL = 3_000;
const TOKEN_LARGE = 15_000;

// Regex für strukturierte Heading-Extraktion (sectionRef + heading):
//   - §: § N, § Na (z.B. § 12a)
//   - Artikel: Artikel N, Art. N
//   - Erwägungsgrund / EG
//   - Kapitel N, Anhang N
//   - Plain-numerisch: N, N.M, N.M.K (z.B. IndBauRL, VwVen)
// Wird nur zur Extraktion von sectionRef/heading genutzt, nicht mehr als Gate.
const SECTION_HEADING_MATCH_RE = /^(#{2,6})\s+(§\s*\d+(?:\s*[a-z](?![a-z]))?|Artikel\s+\d+[a-z]?|Art\.\s*\d+[a-z]?|Erwägungsgrund\s+\d+|EG\s+\d+|Kapitel\s+\d+[a-z]?|Anhang\s+\d+[a-z]?|\d+(?:\.\d+)*[a-z]?)\s*(?:[—–-]\s*)?(.*)?$/i;
// Jedes ### -Heading ist eine Section-Grenze (unabhängig vom Inhalt).
// Fallback: Dateien ohne ###-Headings erhalten einen zweiten Parsing-Durchlauf.
const SECTION_START_RE = /^###\s+\S/;

// -----------------------------------------------------------------------
// CLI-Argumente
// -----------------------------------------------------------------------

const args = process.argv.slice(2);
const isRemote = args.includes("--remote");
const mode = isRemote ? "--remote" : "--local";
const skipGemeinden = args.includes("--skip-gemeinden");
const isIncremental = args.includes("--incremental");

const contentRoots = args
  .filter((a) => a.startsWith("--content-root="))
  .map((a) => a.split("=")[1]);

if (contentRoots.length === 0) {
  // Fallback: test-articles
  contentRoots.push(join(import.meta.dirname!, "..", "test-articles"));
}

console.log(`📂 Content-Roots: ${contentRoots.join(", ")}`);
console.log(`💾 Modus: ${mode}${isIncremental ? " (inkrementell)" : ""}`);
console.log(`🗄️  Datenbank: ${DB_NAME}`);
if (skipGemeinden) console.log(`⏭️  --skip-gemeinden: Gemeinden-Tabelle wird nicht angefasst.`);

// Basisverzeichnis (ragsource-server/) — wird in schema-, seed- und execute-Schritten gebraucht
const schemaDir = join(import.meta.dirname!, "..");

// -----------------------------------------------------------------------
// Hilfsfunktionen
// -----------------------------------------------------------------------

// esc() und buildConcatTree() sind in scripts/sql-utils.ts definiert (importiert oben).

/** Schätzt Token-Anzahl: 1 Token ≈ 4 Zeichen (englisch/deutsch) */
function estimateTokens(text: string): number {
  return Math.round(text.length / 4);
}

/** Führt einen Shell-Befehl aus, mit bis zu `retries` Versuchen bei Fehler. */
function execWithRetry(cmd: string, opts: Parameters<typeof execSync>[1], retries = 3): void {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      execSync(cmd, opts);
      return;
    } catch (e) {
      if (attempt === retries) throw e;
      process.stdout.write(` ↩ Retry ${attempt}/${retries - 1}... `);
      // Kurze Pause (2 s) via SharedArrayBuffer — Node.js sync sleep ohne externe Deps
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    }
  }
}

/**
 * Sendet einen Batch von SQL-Statements direkt an die D1 REST API (nur --remote).
 *
 * Hybrid-Strategie:
 *   - Kleine Statements (alle Params < 50 KB): zusammen als ein konkatenierter SQL-String
 *     (wie bisher, effizient bei vielen kleinen INSERTs).
 *   - Große Statements (ein Param ≥ 50 KB): einzeln mit Bind-Parametern senden.
 *     Bind-Parameter zählen nicht zum SQLITE_MAX_SQL_LENGTH, wodurch auch große
 *     Inhalte (>100 KB, z.B. § 52 EStG) eingefügt werden können.
 *
 * Gibt bis zu 3 Versuche bei Fehlern.
 */
const PARAM_SIZE_THRESHOLD = 50_000; // Zeichen — ab dieser Größe einzeln senden

async function fetchD1Batch(statements: SqlStmt[]): Promise<void> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error(
      "Für --remote werden CLOUDFLARE_ACCOUNT_ID und CLOUDFLARE_API_TOKEN als Env-Variablen benötigt.",
    );
  }
  const url = `${CF_API_BASE}/accounts/${accountId}/d1/database/${D1_DB_ID}/query`;

  // Statements aufteilen: klein (konkatenierbar) vs. groß (einzeln mit Params)
  const small: SqlStmt[] = [];
  const large: SqlStmt[] = [];
  for (const s of statements) {
    const maxParamLen = Math.max(0, ...s.params.map((p) => String(p ?? "").length));
    if (maxParamLen >= PARAM_SIZE_THRESHOLD) {
      large.push(s);
    } else {
      small.push(s);
    }
  }

  /** Sendet ein {sql, params}-Objekt an die D1 REST API mit Retry. */
  async function sendOne(body: { sql: string; params: unknown[] }): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await res.json()) as { success: boolean; errors: { message: string }[] };
        if (!res.ok || !data.success) {
          throw new Error(`D1 API HTTP ${res.status}: ${JSON.stringify(data.errors ?? data)}`);
        }
        return;
      } catch (e) {
        if (attempt === 3) throw e;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  // 1. Kleine Statements gebatcht (konkatenierter SQL-String, keine Params)
  if (small.length > 0) {
    const sql = small.map((s) => stmtToInlineSql(s).trimEnd().replace(/;$/, "")).join(";\n") + ";";
    await sendOne({ sql, params: [] });
  }

  // 2. Große Statements einzeln mit Bind-Parametern
  for (const s of large) {
    await sendOne({ sql: s.sql.trimEnd().replace(/;$/, ""), params: s.params });
  }
}

/**
 * Führt mehrere Statement-Batches mit max. `concurrency` parallelen API-Anfragen aus.
 * Reihenfolge der Batches untereinander ist nicht garantiert — nur für unabhängige INSERTs nutzen.
 */
async function executeBatchesConcurrent(batches: SqlStmt[][], concurrency: number): Promise<void> {
  let completed = 0;
  const total = batches.length;
  for (let i = 0; i < batches.length; i += concurrency) {
    const group = batches.slice(i, Math.min(i + concurrency, batches.length));
    await Promise.all(
      group.map(async (batch) => {
        await fetchD1Batch(batch);
        completed++;
        process.stdout.write(`\r  ${completed}/${total} Batches ✅ `);
      }),
    );
  }
  process.stdout.write("\n");
}

/** Leitet Rechtsrang + Label aus dem ebene-Feld ab.
 *
 * Gespeicherte Kurzform-Werte: "eu" | "bund" | "land" | "kreis" | "verband" | "gemeinde"
 * Alte Langform (Fallback):    "bundesrecht" | "landesrecht-bw" | "kreisrecht" | "ortsrecht-*" | "tarifrecht"
 */
function getRechtsrang(ebene: string | null): { rechtsrang: number | null; rechtsrang_label: string | null } {
  if (!ebene) return { rechtsrang: null, rechtsrang_label: null };
  // Kurzform (aktuell im Content)
  if (ebene === "eu")             return { rechtsrang: 0, rechtsrang_label: "EU-Recht" };
  if (ebene === "bund")           return { rechtsrang: 1, rechtsrang_label: "Bundesrecht" };
  if (ebene === "land")           return { rechtsrang: 2, rechtsrang_label: "Landesrecht BW" };
  if (ebene === "kreis")          return { rechtsrang: 3, rechtsrang_label: "Kreisrecht" };
  if (ebene === "verband")        return { rechtsrang: 4, rechtsrang_label: "Verbandsrecht" };
  if (ebene === "gemeinde")       return { rechtsrang: 5, rechtsrang_label: "Ortsrecht" };
  if (ebene === "tarifrecht")     return { rechtsrang: 6, rechtsrang_label: "Tarifrecht" };
  // Langform-Fallback (ältere Dateien)
  if (ebene === "bundesrecht")    return { rechtsrang: 1, rechtsrang_label: "Bundesrecht" };
  if (ebene === "landesrecht-bw") return { rechtsrang: 2, rechtsrang_label: "Landesrecht BW" };
  if (ebene === "kreisrecht")     return { rechtsrang: 3, rechtsrang_label: "Kreisrecht" };
  if (ebene === "gvv")            return { rechtsrang: 4, rechtsrang_label: "Verbandsrecht" };
  if (ebene.startsWith("ortsrecht")) return { rechtsrang: 5, rechtsrang_label: "Ortsrecht" };
  return { rechtsrang: null, rechtsrang_label: null };
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

/** Berechnet SHA-256-Hash des Dateiinhalts (für inkrementelle Updates) */
function computeHash(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Liest Daten aus D1 Remote via REST API (für --remote + --incremental).
 * Gibt bei transientem Fehler eine leere Liste zurück (graceful degradation).
 */
async function queryD1Remote(sql: string): Promise<Record<string, unknown>[]> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error(
      "Für --remote werden CLOUDFLARE_ACCOUNT_ID und CLOUDFLARE_API_TOKEN als Env-Variablen benötigt.",
    );
  }
  const url = `${CF_API_BASE}/accounts/${accountId}/d1/database/${D1_DB_ID}/query`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sql, params: [] as never[] }),
      });
      const data = (await res.json()) as {
        success: boolean;
        result?: Array<{ results: Record<string, unknown>[] }>;
        errors?: { message: string }[];
      };
      if (!res.ok || !data.success) {
        throw new Error(`D1 Query-Fehler HTTP ${res.status}: ${JSON.stringify(data.errors ?? data)}`);
      }
      return data.result?.[0]?.results ?? [];
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return [];
}

/**
 * Liest Daten aus lokaler D1 via wrangler CLI (für --local + --incremental).
 * Schreibt SQL in Temp-Datei um Shell-Escaping-Probleme zu vermeiden.
 * Gibt bei Fehler (z.B. Spalte noch nicht vorhanden) eine leere Liste zurück.
 */
function queryD1Local(sql: string): Record<string, unknown>[] {
  const queryFile = join(schemaDir, ".build-query-v2.sql");
  writeFileSync(queryFile, sql, "utf-8");
  try {
    const out = execSync(
      `npx wrangler d1 execute ${DB_NAME} --local --config=${WRANGLER_CONFIG} --file=.build-query-v2.sql --json`,
      { cwd: schemaDir, stdio: "pipe" },
    ).toString();
    if (existsSync(queryFile)) unlinkSync(queryFile);
    const parsed = JSON.parse(out) as Array<{ results?: Record<string, unknown>[] }>;
    return parsed[0]?.results ?? [];
  } catch {
    if (existsSync(queryFile)) unlinkSync(queryFile);
    return []; // Tabelle/Spalte existiert noch nicht → leere Liste
  }
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
 * Parst eine Markdown-Datei (nach dem Frontmatter) in TOC + Abschnitte.
 *
 * Erwartet die v2-Struktur:
 *   ## Inhaltsverzeichnis
 *   ...TOC-Inhalt...
 *
 *   ## ERSTER TEIL / ## Abschnitt... (optional, wird in Body absorbiert)
 *   ### § 1 Titel          ← §-Paragraph
 *   ### 7 Anforderungen... ← plain-numerischer Abschnitt (z.B. IndBauRL, VwVen)
 *   ### Vorwort            ← beliebiges ### -Heading
 *   ...
 *
 * Trennregel: Jedes ### -Heading öffnet einen neuen Abschnitt.
 * ## -Headings (außer Inhaltsverzeichnis) werden in den Body des laufenden Abschnitts absorbiert.
 * #### und tiefer werden ebenfalls als Body behandelt.
 *
 * Wenn kein TOC-Block vorhanden: toc = null.
 * Wenn keine ### -Headings vorhanden: Fallback auf alle ##/###-Headings.
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

    const body = currentSectionLines.join("\n").trim();
    let sectionRef: string;
    let headingText: string;

    const headingMatch = currentHeadingLine.match(SECTION_HEADING_MATCH_RE);
    if (headingMatch) {
      // Strukturiertes Heading: §, Art., Kapitel, Anhang, plain-numerisch
      sectionRef = headingMatch[2].trim();
      headingText = (headingMatch[3] || "").trim();
    } else {
      // Generisches Heading (z.B. "### Vorwort", "### A. Einkommensteuergesetz")
      const m = currentHeadingLine.match(/^###\s+(.+?)(?:\s+[-—–]\s+(.*?))?$/);
      if (!m) return;
      sectionRef = m[1].trim();
      headingText = (m[2] || "").trim();
    }

    // Section-Type bestimmen
    let sectionType = "paragraph";
    if (/^Artikel\s/i.test(sectionRef) || /^Art\./i.test(sectionRef)) sectionType = "artikel";
    else if (/^Erwägungs/i.test(sectionRef) || /^EG\s/i.test(sectionRef)) sectionType = "erwaegungsgrund";
    else if (/^Kapitel/i.test(sectionRef)) sectionType = "kapitel";
    else if (/^Anhang/i.test(sectionRef)) sectionType = "anhang";
    else if (/^\d/.test(sectionRef)) sectionType = "abschnitt";

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

  // Fallback-Parser: Falls keine ###-Headings vorhanden sind
  // (z.B. Gebührenverzeichnisse mit ausschließlich ##-Headings),
  // alle ##/###-Headings als Abschnittsgrenzen behandeln.
  if (sections.length === 0) {
    const FALLBACK_HEADING_RE = /^(#{2,6})\s+(.+?)(?:\s+[-—–]\s+(.*?))?$/;
    let fbLines: string[] = [];
    let fbHeading: string | null = null;

    const flushFallback = () => {
      if (!fbHeading) return;
      const m = fbHeading.match(FALLBACK_HEADING_RE);
      if (!m) return;
      const sectionRef = m[2].trim();
      const headingText = (m[3] || "").trim();
      const body = fbLines.join("\n").trim();
      sections.push({
        sectionRef,
        heading: headingText,
        body,
        sectionType: "eintrag",
        sortOrder: sortOrder++,
      });
      fbLines = [];
      fbHeading = null;
    };

    for (const line of lines) {
      if (/^#{2,6}\s+\S/.test(line)) {
        flushFallback();
        fbHeading = line;
      } else if (fbHeading !== null) {
        fbLines.push(line);
      }
    }
    flushFallback();
  }

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
// Schema anwenden: DROP + CREATE (idempotent, nur bei vollständigem Rebuild)
// -----------------------------------------------------------------------

if (!isIncremental) {
  console.log("🗃️  Schema anwenden (DROP + CREATE)...");

  const schemaDrop = [
    "DROP TABLE IF EXISTS sections_fts;",
    "DROP TABLE IF EXISTS source_relations;",
    "DROP TABLE IF EXISTS source_sections;",
    "DROP TABLE IF EXISTS source_tocs;",
    "DROP TABLE IF EXISTS source_extensions;",
    "DROP TABLE IF EXISTS source_endpoints;",
    "DROP TABLE IF EXISTS source_sammlungen;",  // Legacy-Cleanup
    "DROP TABLE IF EXISTS source_projekte;",    // Legacy-Cleanup
    "DROP TABLE IF EXISTS sources;",
    ...(skipGemeinden ? [] : [
      "DROP TABLE IF EXISTS gemeinden;",
      "DROP TABLE IF EXISTS geo_aliases;",
    ]),
  ].join("\n");

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

  // Remote D1 benötigt nach DROP etwas Zeit, um den Durable Object zurückzusetzen
  if (isRemote) {
    console.log("  ⏳ Warte 10s auf D1 DO-Reset...");
    execSync("sleep 10");
  }

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

  // Remote D1: Nach CREATE noch sichtbare Altdaten (DO-Replikation) → UNIQUE constraint.
  // Polling bis sources leer (max. 40s), robuster als hardcodiertes sleep.
  if (isRemote) {
    console.log("  ⏳ Warte auf D1 DO-Replikation (sources muss leer sein)...");
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      const rows = await queryD1Remote("SELECT COUNT(*) as cnt FROM sources");
      const cnt = (rows[0]?.cnt as number) ?? -1;
      if (cnt === 0) break;
      process.stdout.write(`\r  ⏳ sources: noch ${cnt} Zeilen, warte 3s...  `);
      await new Promise((r) => setTimeout(r, 3000));
    }
    process.stdout.write("\r  D1 DO-Replikation abgeschlossen ✅              \n");
  }
}

// -----------------------------------------------------------------------
// Gemeinde-Seed: alle 10.944 deutschen Gemeinden aus Destatis GV-ISys
// (nur bei vollständigem Rebuild)
// -----------------------------------------------------------------------

if (!isIncremental) {
  if (skipGemeinden) {
    console.log("⏭️  Gemeinden-Seed übersprungen (--skip-gemeinden).\n");
  } else {
    const gemeindenSeedFile = join(schemaDir, "data", "seed-gemeinden-all.sql");
    if (existsSync(gemeindenSeedFile)) {
      const gemeindenSql = readFileSync(gemeindenSeedFile, "utf-8");
      const gemeindenStatements = gemeindenSql
        .split("\n")
        .filter((l) => l.startsWith("INSERT"));

      const gemeindenBatchesRaw: string[][] = [];
      for (let i = 0; i < gemeindenStatements.length; i += BATCH_SIZE) {
        gemeindenBatchesRaw.push(gemeindenStatements.slice(i, i + BATCH_SIZE));
      }

      console.log(`\n🏘️  Gemeinden-Seed (${gemeindenStatements.length} Einträge, ${gemeindenBatchesRaw.length} Batches)...`);
      if (isRemote) {
        // Raw SQL-Strings → SqlStmt[] für die API
        const gemeindenBatches = gemeindenBatchesRaw.map((b) => b.map((s) => ({ sql: s, params: [] as unknown[] })));
        try {
          await executeBatchesConcurrent(gemeindenBatches, API_CONCURRENCY);
        } catch (e) {
          console.error("\n❌ Fehler beim Gemeinden-Seed:", e);
          process.exit(1);
        }
      } else {
        const gemeindenFile = join(schemaDir, ".build-gemeinden-v2.sql");
        let gBatchNum = 0;
        for (const batch of gemeindenBatchesRaw) {
          gBatchNum++;
          process.stdout.write(`  Batch ${gBatchNum}/${gemeindenBatchesRaw.length}... `);
          writeFileSync(gemeindenFile, batch.join("\n"), "utf-8");
          try {
            execWithRetry(
              `npx wrangler d1 execute ${DB_NAME} ${mode} --config=${WRANGLER_CONFIG} --file=.build-gemeinden-v2.sql`,
              { cwd: schemaDir, stdio: "pipe" },
            );
            process.stdout.write("✅\n");
          } catch (e) {
            process.stdout.write("❌\n");
            console.error(`❌ Fehler in Gemeinden-Batch ${gBatchNum}:`, e);
            if (existsSync(gemeindenFile)) unlinkSync(gemeindenFile);
            process.exit(1);
          }
        }
        if (existsSync(gemeindenFile)) unlinkSync(gemeindenFile);
      }
      console.log("  Gemeinden-Seed ✅\n");
    } else {
      console.log("  ⚠️  data/seed-gemeinden-all.sql nicht gefunden — nur die 7 Einträge aus schema.sql.\n");
    }
  }
}

// -----------------------------------------------------------------------
// Inkrementeller Modus: Migration + bestehende Hashes laden
// -----------------------------------------------------------------------

// existingHashes: sourceId → content_hash (null = Spalte noch nicht befüllt → gilt als geändert)
const existingHashes = new Map<string, string | null>();
// seenIdsForDiff: alle Source-IDs aus dem File-Scan (nur in --incremental befüllt)
const seenIdsForDiff = new Set<string>();

if (isIncremental) {
  console.log("⚡ Inkrementeller Modus: Prüfe Migration...");

  // content_hash-Spalte anlegen, falls noch nicht vorhanden (erste Nutzung nach Upgrade)
  const migrateSQL = "ALTER TABLE sources ADD COLUMN content_hash TEXT;";
  if (isRemote) {
    try {
      await fetchD1Batch([{ sql: migrateSQL, params: [] }]);
      console.log("  content_hash-Spalte angelegt ✅");
    } catch {
      console.log("  content_hash-Spalte bereits vorhanden.");
    }
  } else {
    const migrateFile = join(schemaDir, ".build-migrate-v2.sql");
    writeFileSync(migrateFile, migrateSQL, "utf-8");
    try {
      execSync(
        `npx wrangler d1 execute ${DB_NAME} --local --config=${WRANGLER_CONFIG} --file=.build-migrate-v2.sql`,
        { cwd: schemaDir, stdio: "pipe" },
      );
      console.log("  content_hash-Spalte angelegt ✅");
    } catch {
      console.log("  content_hash-Spalte bereits vorhanden.");
    } finally {
      if (existsSync(migrateFile)) unlinkSync(migrateFile);
    }
  }

  // Bestehende Hashes aus DB laden
  console.log("  Lade bestehende Hashes aus DB...");
  const rows = isRemote
    ? await queryD1Remote("SELECT id, content_hash FROM sources")
    : queryD1Local("SELECT id, content_hash FROM sources");

  for (const row of rows) {
    existingHashes.set(row.id as string, (row.content_hash as string | null) ?? null);
  }
  console.log(`  ${existingHashes.size} bestehende Quellen geladen.\n`);
}

// -----------------------------------------------------------------------
// Dateien verarbeiten und SQL-Statements erzeugen
// -----------------------------------------------------------------------

// Artikel-Gruppen: Pro Quelldatei ein Array von Statements (nie über Dateigrenzen batchen)
const articleGroups: SqlStmt[][] = [];
const tailStatements: SqlStmt[] = [];

let imported = 0;
let skipped = 0;
let skippedUnchanged = 0;
let newCount = 0;
let changedCount = 0;
let sectionTotal = 0;
const deleteIds: string[] = []; // IDs die gelöscht/überschrieben werden (--incremental)

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

  // Hash berechnen (immer — für inkrementelle Updates und full-rebuild content_hash-Seeding)
  const fileHash = computeHash(raw);

  // Inkrementeller Modus: nur geänderte/neue Dateien verarbeiten
  if (isIncremental) {
    seenIdsForDiff.add(sourceId);
    const existingHash = existingHashes.get(sourceId);
    if (existingHash === fileHash) {
      // Unverändert — überspringen
      skippedUnchanged++;
      continue;
    }
    if (existingHashes.has(sourceId)) {
      // Geändert → erst löschen, dann neu einfügen (CASCADE-Delete entfernt Sections + TOC)
      deleteIds.push(sourceId);
      changedCount++;
    } else {
      // Neue Quelle
      newCount++;
    }
  }

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
  const { rechtsrang, rechtsrang_label } = getRechtsrang(ebene);

  // Dateipfad relativ zum Content-Root
  const dateipfad = relative(root, file).replace(/\\/g, "/");

  // Endpoints (Tenancy) + Extensions (Themen), mit Legacy-Fallback
  const endpoints: string[] = fm.endpoints ?? fm.sammlungen ?? fm.projekte ?? [];
  const extensions: string[] = fm.extensions ?? [];

  imported++;
  console.log(
    `  ✅ ${fm.titel} (${totalTokens} Token, ${sizeClass}, ${sections.length} §§, ` +
    `land=${land_ars || "-"}, kreis=${kreis_ars || "-"}, verband=${verband_ars || "-"}, gemeinde=${gemeinde_ars || "-"})`,
  );

  // --- SQL-Gruppe für diese Quelle ---
  const group: SqlStmt[] = [];

  // 1. sources-Eintrag (inkl. content_hash für spätere inkrementelle Updates)
  group.push({
    sql: `INSERT INTO sources (id, titel, kurzbezeichnung, typ, ebene, land_ars, kreis_ars, verband_ars, gemeinde_ars, section_count, total_tokens, size_class, gueltig_ab, quelle, dateipfad, url, beschreibung, stand, rechtsrang, rechtsrang_label, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    params: [
      sourceId, fm.titel, fm.kurzbezeichnung || null, fm.typ || null, ebene,
      land_ars, kreis_ars, verband_ars, gemeinde_ars,
      sections.length, totalTokens, sizeClass,
      fm.gueltig_ab || null, fm.quelle || null, dateipfad,
      fm.url || null, fm.beschreibung || null, fm.stand || null,
      rechtsrang ?? null, rechtsrang_label, fileHash,
    ],
  });

  // 2. source_endpoints + source_extensions
  for (const e of endpoints) {
    group.push({
      sql: `INSERT INTO source_endpoints (source_id, endpoint) VALUES (?, ?);`,
      params: [sourceId, e],
    });
  }
  for (const x of extensions) {
    group.push({
      sql: `INSERT INTO source_extensions (source_id, extension) VALUES (?, ?);`,
      params: [sourceId, x],
    });
  }

  // 3. source_tocs (nur wenn TOC vorhanden)
  if (toc) {
    const tocId = `${sourceId}_toc`;
    group.push({
      sql: `INSERT INTO source_tocs (id, source_id, toc_level, content) VALUES (?, ?, 'gesamt', ?);`,
      params: [tocId, sourceId, toc],
    });
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

    group.push({
      sql: `INSERT INTO source_sections (id, source_id, section_ref, heading, body, section_type, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?);`,
      params: [sectionId, sourceId, section.sectionRef, section.heading || null, section.body, section.sectionType, section.sortOrder],
    });

    sectionTotal++;
  }

  // 5. FTS5 für sections: direkt einfügen (kein content-sync hier, wir rebuilden am Ende)
  // sections_fts ist eine content-table → rebuild am Ende

  articleGroups.push(group);
}

// FTS5-Rebuild am Ende (muss nach allen Inserts kommen)
tailStatements.push({ sql: "INSERT INTO sections_fts(sections_fts) VALUES('rebuild');", params: [] });

// Gelöschte Quellen identifizieren (im DB vorhanden, aber keine Datei mehr)
let deletedCount = 0;
if (isIncremental) {
  for (const [id] of existingHashes) {
    if (!seenIdsForDiff.has(id)) {
      deleteIds.push(id);
      deletedCount++;
      console.log(`  🗑️  Quelle nicht mehr vorhanden: ${id}`);
    }
  }
}

console.log(`\n📊 Zusammenfassung:`);
if (isIncremental) {
  console.log(`   ${newCount} neu, ${changedCount} geändert, ${skippedUnchanged} unverändert, ${deletedCount} gelöscht`);
  console.log(`   ${sectionTotal} Paragraphen/Abschnitte (neu/geändert)`);
  console.log(`   ${articleGroups.reduce((s, g) => s + g.length, 0)} SQL-Statements (INSERT)`);
  const totalChanges = newCount + changedCount + deletedCount;
  if (totalChanges === 0) {
    console.log("\n✅ Keine Änderungen — Datenbank ist aktuell.");
    process.exit(0);
  }
} else {
  console.log(`   ${imported} Quellen importiert, ${skipped} übersprungen`);
  console.log(`   ${sectionTotal} Paragraphen/Abschnitte total`);
  console.log(`   ${articleGroups.reduce((s, g) => s + g.length, 0) + tailStatements.length} SQL-Statements gesamt`);
}

// -----------------------------------------------------------------------
// Batching (Artikelgrenzen respektieren, wie v1)
// -----------------------------------------------------------------------

const batches: SqlStmt[][] = [];
let currentBatch: SqlStmt[] = [];

for (const group of articleGroups) {
  if (currentBatch.length > 0 && currentBatch.length + group.length > BATCH_SIZE) {
    batches.push(currentBatch);
    currentBatch = [];
  }
  currentBatch.push(...group);
}

// Letzten Batch pushen (tailStatements immer separat — FTS5-Rebuild muss nach allen INSERTs kommen)
if (currentBatch.length > 0) {
  batches.push(currentBatch);
}

// -----------------------------------------------------------------------
// Ausführen
// -----------------------------------------------------------------------

if (isIncremental) {
  // Inkrementell: 1. DELETE geänderte+gelöschte → 2. INSERT neue+geänderte → 3. FTS5-Rebuild

  // 1. DELETE (sequentiell, vor den INSERTs — CASCADE entfernt Sections + TOCs automatisch)
  if (deleteIds.length > 0) {
    const deleteStatements: SqlStmt[] = deleteIds.map((id) => ({ sql: `DELETE FROM sources WHERE id = ?;`, params: [id] }));
    console.log(`\n🗑️  Lösche ${deleteIds.length} Quelle(n) (${mode})...`);
    if (isRemote) {
      try {
        await fetchD1Batch(deleteStatements);
        console.log("  DELETE ✅");
      } catch (e) {
        console.error("❌ Fehler beim DELETE:", e);
        process.exit(1);
      }
    } else {
      const delFile = join(schemaDir, ".build-delete-v2.sql");
      writeFileSync(delFile, deleteStatements.map(stmtToInlineSql).join("\n"), "utf-8");
      try {
        execWithRetry(
          `npx wrangler d1 execute ${DB_NAME} ${mode} --config=${WRANGLER_CONFIG} --file=.build-delete-v2.sql`,
          { cwd: schemaDir, stdio: "pipe" },
        );
        console.log("  DELETE ✅");
      } catch (e) {
        console.error("❌ Fehler beim DELETE:", e);
        if (existsSync(delFile)) unlinkSync(delFile);
        process.exit(1);
      }
      if (existsSync(delFile)) unlinkSync(delFile);
    }
  }

  // 2. INSERT neue + geänderte Quellen
  if (batches.length > 0) {
    console.log(`\n📥 Füge ${imported} Quelle(n) ein (${batches.length} Batch(es), ${mode})...`);
    if (isRemote) {
      try {
        await executeBatchesConcurrent(batches, API_CONCURRENCY);
      } catch (e) {
        console.error("\n❌ Fehler beim Content-Insert:", e);
        process.exit(1);
      }
    } else {
      const sqlFile = join(schemaDir, ".build-seed-v2.sql");
      let batchNum = 0;
      for (const batch of batches) {
        batchNum++;
        process.stdout.write(`  Batch ${batchNum}/${batches.length}... `);
        writeFileSync(sqlFile, batch.map(stmtToInlineSql).join("\n"), "utf-8");
        try {
          execWithRetry(
            `npx wrangler d1 execute ${DB_NAME} ${mode} --config=${WRANGLER_CONFIG} --file=.build-seed-v2.sql`,
            { cwd: schemaDir, stdio: "pipe" },
          );
          process.stdout.write("✅\n");
        } catch (e) {
          process.stdout.write("❌\n");
          console.error(`❌ Fehler in Batch ${batchNum}:`, e);
          if (existsSync(sqlFile)) unlinkSync(sqlFile);
          process.exit(1);
        }
      }
      if (existsSync(sqlFile)) unlinkSync(sqlFile);
    }
  }

  // 3. FTS5-Rebuild (stellt Konsistenz nach DELETE+INSERT sicher; FTS5-Trigger pflegen
  //    automatisch, aber expliziter Rebuild ist idempotent und zuverlässiger)
  process.stdout.write("\n  FTS5-Rebuild... ");
  if (isRemote) {
    try {
      await fetchD1Batch(tailStatements);
      process.stdout.write("✅\n");
    } catch (e) {
      process.stdout.write("❌\n");
      console.error("❌ Fehler beim FTS5-Rebuild:", e);
      process.exit(1);
    }
  } else {
    const ftsFile = join(schemaDir, ".build-fts-v2.sql");
    writeFileSync(ftsFile, tailStatements.map(stmtToInlineSql).join("\n"), "utf-8");
    try {
      execWithRetry(
        `npx wrangler d1 execute ${DB_NAME} ${mode} --config=${WRANGLER_CONFIG} --file=.build-fts-v2.sql`,
        { cwd: schemaDir, stdio: "pipe" },
      );
      process.stdout.write("✅\n");
    } catch (e) {
      process.stdout.write("❌\n");
      console.error("❌ Fehler beim FTS5-Rebuild:", e);
      if (existsSync(ftsFile)) unlinkSync(ftsFile);
      process.exit(1);
    }
    if (existsSync(ftsFile)) unlinkSync(ftsFile);
  }

} else {
  // Vollständiger Rebuild: gleiche Logik wie bisher
  console.log(`\n🚀 Führe SQL aus (${mode}) in ${batches.length} Content-Batches + FTS5-Rebuild...`);

  if (isRemote) {
    // Remote: D1 REST API mit Parallelität (kein wrangler-CLI-Spawn pro Batch)
    try {
      await executeBatchesConcurrent(batches, API_CONCURRENCY);
      process.stdout.write("  FTS5-Rebuild... ");
      await fetchD1Batch(tailStatements);
      process.stdout.write("✅\n");
    } catch (e) {
      console.error("\n❌ Fehler beim Content-Seed:", e);
      process.exit(1);
    }
  } else {
    // Local: wrangler CLI (kein API-Token nötig)
    const sqlFile = join(schemaDir, ".build-seed-v2.sql");
    let batchNum = 0;
    for (const batch of [...batches, tailStatements]) {
      batchNum++;
      process.stdout.write(`  Batch ${batchNum}/${batches.length + 1}... `);
      writeFileSync(sqlFile, batch.map(stmtToInlineSql).join("\n"), "utf-8");
      try {
        execWithRetry(
          `npx wrangler d1 execute ${DB_NAME} ${mode} --config=${WRANGLER_CONFIG} --file=.build-seed-v2.sql`,
          { cwd: schemaDir, stdio: "pipe" },
        );
        process.stdout.write("✅\n");
      } catch (e) {
        process.stdout.write("❌\n");
        console.error(`❌ Fehler in Batch ${batchNum}:`, e);
        if (existsSync(sqlFile)) unlinkSync(sqlFile);
        process.exit(1);
      }
    }
    if (existsSync(sqlFile)) unlinkSync(sqlFile);
  }
}

console.log("\n✅ Datenbank erfolgreich aktualisiert!");
