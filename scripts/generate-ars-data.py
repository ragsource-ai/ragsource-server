#!/usr/bin/env python3
"""
Generiert ragsource-website/ars_data.js aus gemeinden.json + GV100AD.

Struktur der Ausgabe (JS-Array):
  ["Name", "ARS", "type"]

Typen:
  "bund"      — Bundesrepublik Deutschland (ARS "00")
  "land"      — Bundesland (ARS 2-stellig, "01"–"16")
  "kreisfrei" — Kreisfreie Stadt / Stadtkreis (GV100AD KZ 41/42)
  "kreis"     — Landkreis / Kreis / Regionalverband (GV100AD KZ 43/44/45)
  "verband"   — Verwaltungsverband / GVV / VVG / Amt etc. (ARS 9-stellig)
  "gemeinde"  — Gemeinde (ARS 12-stellig, aus bestehendem ars_data.js)

Quellen:
  ragsource-server/data/gemeinden.json        — Bund, Länder, Kreise, Verbände
  ragsource-server/data/GV100AD_28022026.txt  — Kennzeichen für kreis/kreisfrei
  ragsource-website/ars_data.js               — bestehende Gemeinden (behalten)

Aufruf:
  python scripts/generate-ars-data.py [--dry-run]
"""

import json
import re
import sys
from pathlib import Path

DRY_RUN = "--dry-run" in sys.argv

BASE_SERVER = Path(__file__).parent.parent / "data"
BASE_WEBSITE = Path(__file__).parent.parent.parent.parent / "ragsource-website"

# ── Kennzeichen aus GV100AD laden ────────────────────────────────────────────

# Kennzeichen type-4 records: 41/42 = kreisfrei, 43/44/45 = kreis
kreis_kennzeichen: dict[str, str] = {}  # kreis_ars → "kreisfrei" | "kreis"

with open(BASE_SERVER / "GV100AD_28022026.txt", encoding="utf-8") as f:
    for line in f:
        if line[0] != "4":
            continue
        if len(line) < 124:
            continue
        kreis_ars = line[10:15]
        kz = line[122:124].strip()
        if kz in ("41", "42"):
            kreis_kennzeichen[kreis_ars] = "kreisfrei"
        elif kz in ("43", "44", "45"):
            kreis_kennzeichen[kreis_ars] = "kreis"

print(f"GV100AD: {sum(1 for v in kreis_kennzeichen.values() if v == 'kreisfrei')} kreisfrei, "
      f"{sum(1 for v in kreis_kennzeichen.values() if v == 'kreis')} kreis")

# ── gemeinden.json laden ─────────────────────────────────────────────────────

with open(BASE_SERVER / "gemeinden.json", encoding="utf-8") as f:
    gemeinden_json = json.load(f)

# ── Bestehende Gemeinden aus ars_data.js extrahieren ─────────────────────────

ARS_DATA_FILE = BASE_WEBSITE / "ars_data.js"
existing_gemeinden: list[tuple[str, str, str]] = []  # (name, ars, type)

if ARS_DATA_FILE.exists():
    content = ARS_DATA_FILE.read_text(encoding="utf-8")
    for m in re.finditer(r'\["([^"]+)","(\d+)","(\w+)"\]', content):
        name, ars, typ = m.group(1), m.group(2), m.group(3)
        if typ == "gemeinde":
            existing_gemeinden.append((name, ars, typ))
    print(f"ars_data.js: {len(existing_gemeinden)} bestehende Gemeinden übernommen")
else:
    print(f"WARNUNG: {ARS_DATA_FILE} nicht gefunden — keine Gemeinden")

# ── Einträge aufbauen ─────────────────────────────────────────────────────────

rows: list[tuple[str, str, str]] = []

# 1. Bundesrepublik Deutschland
bund = next((l for l in gemeinden_json["laender"] if l["ars"] == "00"), None)
if bund:
    rows.append((bund["name"], bund["ars"], "bund"))

# 2. Bundesländer
for land in gemeinden_json["laender"]:
    if land["ars"] == "00":
        continue
    rows.append((land["name"], land["ars"], "land"))

# 3. Landkreise (kreisfrei / kreis je nach GV100AD-Kennzeichen)
for kreis in gemeinden_json["landkreise"]:
    ars = kreis["ars"]
    kz_type = kreis_kennzeichen.get(ars, "kreis")  # Fallback: "kreis"
    rows.append((kreis["name"], ars, kz_type))

# 4. Verwaltungsverbände
for verband in gemeinden_json["verbaende"]:
    rows.append((verband["name"], verband["ars"], "verband"))

# 5. Gemeinden (bestehende)
rows.extend(existing_gemeinden)

# ── Statistik ─────────────────────────────────────────────────────────────────

from collections import Counter
type_counts = Counter(r[2] for r in rows)
print(f"\nErgebnis:")
for t, n in [("bund", type_counts.get("bund", 0)),
              ("land", type_counts.get("land", 0)),
              ("kreisfrei", type_counts.get("kreisfrei", 0)),
              ("kreis", type_counts.get("kreis", 0)),
              ("verband", type_counts.get("verband", 0)),
              ("gemeinde", type_counts.get("gemeinde", 0))]:
    print(f"  {t:12s}: {n:6d}")
print(f"  {'GESAMT':12s}: {len(rows):6d}")

if DRY_RUN:
    print("\n-- DRY RUN: ars_data.js wird nicht geschrieben.")
    sys.exit(0)

# ── ars_data.js schreiben ─────────────────────────────────────────────────────

def js_str(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')

lines_out = ["const ARS_RAW=["]
for i, (name, ars, typ) in enumerate(rows):
    comma = "," if i < len(rows) - 1 else ""
    lines_out.append(f'["{js_str(name)}","{ars}","{typ}"]{comma}')
lines_out.append("];")

out_path = ARS_DATA_FILE
out_path.write_text("\n".join(lines_out) + "\n", encoding="utf-8")
print(f"\nars_data.js geschrieben → {out_path}")
print(f"Dateigröße: {out_path.stat().st_size / 1024:.1f} KB")
