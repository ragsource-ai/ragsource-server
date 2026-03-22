/**
 * SQL-Hilfsfunktionen für den D1-Build-Prozess.
 *
 * Ausgelagert aus build-db-v2.ts damit sie isoliert testbar sind.
 */

/**
 * Baut einen balancierten Binärbaum aus SQL-Konkatenations-Tokens.
 *
 * Hintergrund: Wrangler's D1-Batch-Parser hat Probleme mit langen linearen
 * || -Ketten bei Texten mit vielen Sonderzeichen (z.B. "§§ 178 ----" in VwGO-Sections).
 * Lineare || -Ketten würden bei Texten mit vielen Sonderzeichen SQLite's
 * SQLITE_EXPR_DEPTH_MAX (100) überschreiten.
 * Fix: balancierter Binärbaum → Tiefe O(log N) statt O(N).
 */
export function buildConcatTree(tokens: string[]): string {
  if (tokens.length === 0) return "''";
  if (tokens.length === 1) return tokens[0];
  const mid = Math.floor(tokens.length / 2);
  return `(${buildConcatTree(tokens.slice(0, mid))} || ${buildConcatTree(tokens.slice(mid))})`;
}

/**
 * Escapet einen Wert für die direkte Einbettung in SQL-Strings (nicht für Prepared Statements).
 *
 * Wird im Build-Script benötigt, da Wrangler's D1-Batch-API bei großen Batches
 * keine Prepared Statements unterstützt. Verwendet char()-Ausdrücke statt
 * Standard-SQL-Escaping (''), um Parser-Bugs in Wrangler zu umgehen.
 */
export function esc(val: unknown): string {
  if (val == null) return "NULL";
  const s = String(val);
  // Null-Bytes verhindern (könnten SQLite-Parser-Verhalten beeinflussen)
  if (s.includes("\x00")) throw new Error(`Null-Byte in SQL-Wert gefunden: ${JSON.stringify(s.slice(0, 50))}`);
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
