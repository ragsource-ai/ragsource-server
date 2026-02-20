/**
 * Einmal-Migrations-Skript: Frontmatter Slug-Felder → ARS + Klartext
 *
 * Migriert alle Artikel von:
 *   bundesland: bw / landkreis: goeppingen / gemeinde: bad-boll (Slugs)
 * nach:
 *   land_ars: "08" / kreis_ars: "08117" / verband_ars: "081175009" / gemeinde_ars: "081175009012"
 *   land: Baden-Württemberg / kreis: Göppingen / verband: GVV Raum Bad Boll / gemeinde: Bad Boll
 *
 * Nutzung:
 *   npx tsx scripts/migrate-frontmatter.ts --dry-run          # Nur anzeigen, nichts schreiben
 *   npx tsx scripts/migrate-frontmatter.ts                    # Migration ausführen
 *
 * Ziel-Verzeichnisse:
 *   --content-root=<pfad>   (mehrfach möglich; Default: test-articles/)
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join, relative } from "path";

// ── gemeinden.json laden ──────────────────────────────────────────────

const gemeindenData = JSON.parse(
  readFileSync(join(import.meta.dirname!, "..", "data", "gemeinden.json"), "utf-8"),
) as {
  laender: Array<{ ars: string; name: string; kuerzel: string; aliases: string[] }>;
  landkreise: Array<{ ars: string; name: string; land_ars: string; aliases: string[] }>;
  verbaende: Array<{ ars: string; name: string; kreis_ars: string; aliases: string[] }>;
  gemeinden: Array<{ ars: string; name: string; verband_ars: string; slug: string; aliases: string[] }>;
};

// ── Lookup-Maps aufbauen ──────────────────────────────────────────────

// Slug → Gemeinde-Daten (für gemeinde: bad-boll)
const SLUG_TO_GEMEINDE = new Map<string, {
  ars: string;
  name: string;
  verband_ars: string;
  verband_name: string;
  kreis_ars: string;
  kreis_name: string;
  land_ars: string;
  land_name: string;
}>();

for (const g of gemeindenData.gemeinden) {
  const verband = gemeindenData.verbaende.find(v => v.ars === g.verband_ars);
  const kreis_ars = verband ? verband.kreis_ars : g.ars.substring(0, 5);
  const kreis = gemeindenData.landkreise.find(k => k.ars === kreis_ars);
  const land_ars = kreis ? kreis.land_ars : g.ars.substring(0, 2);
  const land = gemeindenData.laender.find(l => l.ars === land_ars);

  SLUG_TO_GEMEINDE.set(g.slug, {
    ars: g.ars,
    name: g.name,
    verband_ars: g.verband_ars,
    verband_name: verband?.name ?? "",
    kreis_ars,
    kreis_name: kreis?.name ?? "",
    land_ars,
    land_name: land?.name ?? "",
  });
}

// Kürzel/Alias → Land
const ALIAS_TO_LAND = new Map<string, { ars: string; name: string }>();
for (const l of gemeindenData.laender) {
  ALIAS_TO_LAND.set(l.kuerzel.toLowerCase(), { ars: l.ars, name: l.name });
  for (const a of l.aliases) {
    ALIAS_TO_LAND.set(a.toLowerCase(), { ars: l.ars, name: l.name });
  }
}

// Alias → Landkreis
const ALIAS_TO_KREIS = new Map<string, {
  ars: string;
  name: string;
  land_ars: string;
  land_name: string;
}>();
for (const k of gemeindenData.landkreise) {
  const land = gemeindenData.laender.find(l => l.ars === k.land_ars);
  const entry = { ars: k.ars, name: k.name, land_ars: k.land_ars, land_name: land?.name ?? "" };
  for (const a of k.aliases) {
    ALIAS_TO_KREIS.set(a.toLowerCase(), entry);
  }
}

// Alias → Verband
const ALIAS_TO_VERBAND = new Map<string, {
  ars: string;
  name: string;
  kreis_ars: string;
  kreis_name: string;
  land_ars: string;
  land_name: string;
}>();
for (const v of gemeindenData.verbaende) {
  const kreis = gemeindenData.landkreise.find(k => k.ars === v.kreis_ars);
  const land_ars = kreis ? kreis.land_ars : v.ars.substring(0, 2);
  const land = gemeindenData.laender.find(l => l.ars === land_ars);
  const entry = {
    ars: v.ars,
    name: v.name,
    kreis_ars: v.kreis_ars,
    kreis_name: kreis?.name ?? "",
    land_ars,
    land_name: land?.name ?? "",
  };
  for (const a of v.aliases) {
    ALIAS_TO_VERBAND.set(a.toLowerCase(), entry);
  }
}

// ── CLI-Argumente ─────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

const contentRoots = args
  .filter(a => a.startsWith("--content-root="))
  .map(a => a.split("=")[1]);

if (contentRoots.length === 0) {
  contentRoots.push(join(import.meta.dirname!, "..", "test-articles"));
}

console.log(`🔄 Frontmatter-Migration: Slugs → ARS + Klartext`);
console.log(`📂 Content-Roots: ${contentRoots.join(", ")}`);
console.log(`📝 Modus: ${dryRun ? "DRY-RUN (keine Änderungen)" : "LIVE (schreibt Dateien)"}`);
console.log();

// ── Dateien finden ────────────────────────────────────────────────────

function findMarkdownFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (["node_modules", ".obsidian", ".git", ".github"].includes(entry)) continue;
      files.push(...findMarkdownFiles(full));
    } else if (entry.endsWith(".md") && entry !== "README.md") {
      files.push(full);
    }
  }
  return files;
}

// ── Frontmatter-Zeilen manipulieren (Reihenfolge erhalten) ────────────

interface MigrationResult {
  file: string;
  status: "migrated" | "skipped" | "already-migrated" | "error";
  message: string;
}

function migrateFile(filePath: string, root: string): MigrationResult {
  const relPath = relative(root, filePath).replace(/\\/g, "/");
  const raw = readFileSync(filePath, "utf-8");

  // Frontmatter-Grenzen finden
  const fmStart = raw.indexOf("---");
  if (fmStart !== 0) {
    return { file: relPath, status: "skipped", message: "Kein Frontmatter gefunden" };
  }
  const fmEnd = raw.indexOf("---", 3);
  if (fmEnd === -1) {
    return { file: relPath, status: "skipped", message: "Frontmatter nicht geschlossen" };
  }

  const fmBlock = raw.substring(fmStart + 3, fmEnd).trim();
  const bodyAfterFm = raw.substring(fmEnd); // ab dem schließenden ---

  // Bereits migriert? (hat schon land_ars)
  if (fmBlock.includes("land_ars:")) {
    return { file: relPath, status: "already-migrated", message: "Bereits migriert (land_ars vorhanden)" };
  }

  // Frontmatter-Zeilen parsen
  const lines = fmBlock.split("\n");

  // Alte Werte extrahieren
  let oldBundesland: string | null = null;
  let oldLandkreis: string | null = null;
  let oldGemeinde: string | null = null;
  let ebene: string | null = null;

  for (const line of lines) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (!match) continue;
    const [, key, val] = match;
    const cleanVal = val.replace(/^["']|["']$/g, "").trim();
    if (key === "bundesland") oldBundesland = cleanVal;
    if (key === "landkreis") oldLandkreis = cleanVal;
    if (key === "gemeinde") oldGemeinde = cleanVal === "null" ? null : cleanVal;
    if (key === "ebene") ebene = cleanVal;
  }

  if (!ebene) {
    return { file: relPath, status: "skipped", message: "Kein ebene-Feld" };
  }

  // ── Neue ARS- und Klartext-Werte bestimmen ─────────────────────────

  let land_ars: string | null = null;
  let land_name: string | null = null;
  let kreis_ars: string | null = null;
  let kreis_name: string | null = null;
  let verband_ars: string | null = null;
  let verband_name: string | null = null;
  let gemeinde_ars: string | null = null;
  let gemeinde_name: string | null = null;

  if (ebene === "bund") {
    // Bund-Artikel: keine Geo-Felder
  } else if (ebene === "gemeinde" && oldGemeinde && SLUG_TO_GEMEINDE.has(oldGemeinde)) {
    const g = SLUG_TO_GEMEINDE.get(oldGemeinde)!;
    land_ars = g.land_ars;
    land_name = g.land_name;
    kreis_ars = g.kreis_ars;
    kreis_name = g.kreis_name;
    verband_ars = g.verband_ars;
    verband_name = g.verband_name;
    gemeinde_ars = g.ars;
    gemeinde_name = g.name;
  } else if ((ebene === "verband" || ebene === "gvv") && oldGemeinde && SLUG_TO_GEMEINDE.has(oldGemeinde)) {
    // Verband-Artikel nutzen aktuell gemeinde: bad-boll als Proxy
    const g = SLUG_TO_GEMEINDE.get(oldGemeinde)!;
    land_ars = g.land_ars;
    land_name = g.land_name;
    kreis_ars = g.kreis_ars;
    kreis_name = g.kreis_name;
    verband_ars = g.verband_ars;
    verband_name = g.verband_name;
    // Verband-Artikel: KEINE gemeinde_ars (Artikel gehört zum Verband, nicht zur Gemeinde)
  } else if (ebene === "kreis" && oldLandkreis) {
    const k = ALIAS_TO_KREIS.get(oldLandkreis.toLowerCase());
    if (k) {
      land_ars = k.land_ars;
      land_name = k.land_name;
      kreis_ars = k.ars;
      kreis_name = k.name;
    }
  } else if (ebene === "land" && oldBundesland) {
    const l = ALIAS_TO_LAND.get(oldBundesland.toLowerCase());
    if (l) {
      land_ars = l.ars;
      land_name = l.name;
    }
  } else if (ebene === "tarifrecht") {
    // Tarifrecht: keine Geo-Felder (eigener Rechtskreis)
  } else {
    return {
      file: relPath,
      status: "error",
      message: `Kann Geo nicht auflösen: ebene=${ebene}, bundesland=${oldBundesland}, landkreis=${oldLandkreis}, gemeinde=${oldGemeinde}`,
    };
  }

  // ── Frontmatter-Zeilen transformieren ───────────────────────────────

  // Strategie: Alte Geo-Felder entfernen, neue nach `saule:` einfügen
  const newLines: string[] = [];
  let geoInserted = false;

  for (const line of lines) {
    // Alte Geo-Felder überspringen
    if (/^bundesland:\s/.test(line)) continue;
    if (/^landkreis:\s/.test(line)) continue;
    if (/^gemeinde:\s/.test(line)) continue;

    // ebene normalisieren: gvv → verband
    if (/^ebene:\s/.test(line) && ebene === "gvv") {
      newLines.push("ebene: verband");
      continue;
    }

    newLines.push(line);

    // Nach saule: die neuen Geo-Felder einfügen
    if (/^saule:\s/.test(line) && !geoInserted) {
      geoInserted = true;

      // ARS-Felder (nur wenn Wert vorhanden)
      if (land_ars) newLines.push(`land_ars: "${land_ars}"`);
      if (kreis_ars) newLines.push(`kreis_ars: "${kreis_ars}"`);
      if (verband_ars) newLines.push(`verband_ars: "${verband_ars}"`);
      if (gemeinde_ars) newLines.push(`gemeinde_ars: "${gemeinde_ars}"`);

      // Klartext-Felder (nur wenn Wert vorhanden)
      if (land_name) newLines.push(`land: ${land_name}`);
      if (kreis_name) newLines.push(`kreis: ${kreis_name}`);
      if (verband_name) newLines.push(`verband: ${verband_name}`);
      if (gemeinde_name) newLines.push(`gemeinde: ${gemeinde_name}`);
    }
  }

  // Sicherheit: Falls saule: nie kam (sollte nicht passieren)
  if (!geoInserted && (land_ars || kreis_ars)) {
    return { file: relPath, status: "error", message: "Kein saule:-Feld gefunden zum Einfügen" };
  }

  // ── Datei zusammenbauen ─────────────────────────────────────────────

  const newFm = newLines.join("\n");
  const newContent = `---\n${newFm}\n${bodyAfterFm}`;

  if (!dryRun) {
    writeFileSync(filePath, newContent, "utf-8");
  }

  // Zusammenfassung
  const arsInfo = [
    land_ars ? `land=${land_ars}` : null,
    kreis_ars ? `kreis=${kreis_ars}` : null,
    verband_ars ? `verband=${verband_ars}` : null,
    gemeinde_ars ? `gemeinde=${gemeinde_ars}` : null,
  ].filter(Boolean).join(", ");

  return {
    file: relPath,
    status: "migrated",
    message: arsInfo || "keine Geo-Felder (Bund/Tarifrecht)",
  };
}

// ── Hauptprogramm ─────────────────────────────────────────────────────

const results: MigrationResult[] = [];

for (const root of contentRoots) {
  const files = findMarkdownFiles(root);
  console.log(`📂 ${root}: ${files.length} Dateien`);

  for (const file of files) {
    const result = migrateFile(file, root);
    results.push(result);

    const icon = {
      migrated: "✅",
      skipped: "⏭️",
      "already-migrated": "🔄",
      error: "❌",
    }[result.status];

    console.log(`  ${icon} ${result.file}: ${result.message}`);
  }
}

// ── Zusammenfassung ───────────────────────────────────────────────────

console.log("\n" + "═".repeat(60));
console.log("📊 Zusammenfassung:");
const migrated = results.filter(r => r.status === "migrated").length;
const skipped = results.filter(r => r.status === "skipped").length;
const alreadyMigrated = results.filter(r => r.status === "already-migrated").length;
const errors = results.filter(r => r.status === "error").length;

console.log(`  ✅ Migriert:          ${migrated}`);
console.log(`  ⏭️  Übersprungen:      ${skipped}`);
console.log(`  🔄 Bereits migriert:  ${alreadyMigrated}`);
console.log(`  ❌ Fehler:            ${errors}`);
console.log(`  📄 Gesamt:            ${results.length}`);

if (dryRun) {
  console.log("\n⚠️  DRY-RUN: Keine Dateien wurden verändert.");
  console.log("   Starte ohne --dry-run für die tatsächliche Migration.");
}

if (errors > 0) {
  console.log("\n❌ Fehler-Details:");
  for (const r of results.filter(r => r.status === "error")) {
    console.log(`  ${r.file}: ${r.message}`);
  }
  process.exit(1);
}
