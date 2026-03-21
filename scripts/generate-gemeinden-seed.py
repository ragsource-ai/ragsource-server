#!/usr/bin/env python3
"""
Generiert data/seed-gemeinden-all.sql aus der Destatis-Datei ars_2026-01-31.json.

Quellen:
  data/ars_2026-01-31.json  — Destatis Gemeindeverzeichnis (11.227 Gemeinden)
  data/gemeinden.json       — Manuell gepflegte Einträge (Verband/Kreis-Namen)

Ausgabe:
  data/seed-gemeinden-all.sql  — INSERT OR REPLACE für alle Gemeinden

Aufruf:
  python scripts/generate-gemeinden-seed.py [--dry-run]
"""

import json
import re
import sys
from pathlib import Path

DRY_RUN = "--dry-run" in sys.argv

BASE = Path(__file__).parent.parent / "data"

LAENDER = {
    "01": ("Schleswig-Holstein", "SH"),
    "02": ("Hamburg", "HH"),
    "03": ("Niedersachsen", "NI"),
    "04": ("Bremen", "HB"),
    "05": ("Nordrhein-Westfalen", "NW"),
    "06": ("Hessen", "HE"),
    "07": ("Rheinland-Pfalz", "RP"),
    "08": ("Baden-Württemberg", "BW"),
    "09": ("Bayern", "BY"),
    "10": ("Saarland", "SL"),
    "11": ("Berlin", "BE"),
    "12": ("Brandenburg", "BB"),
    "13": ("Mecklenburg-Vorpommern", "MV"),
    "14": ("Sachsen", "SN"),
    "15": ("Sachsen-Anhalt", "ST"),
    "16": ("Thüringen", "TH"),
}


def make_slug(name: str) -> str:
    s = name.lower()
    for a, b in [("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss")]:
        s = s.replace(a, b)
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


def sql_str(val) -> str:
    if val is None:
        return "NULL"
    return "'" + str(val).replace("'", "''") + "'"


# ── Daten laden ──────────────────────────────────────────────────────────────

with open(BASE / "ars_2026-01-31.json", encoding="utf-8") as f:
    destatis = json.load(f)

with open(BASE / "gemeinden.json", encoding="utf-8") as f:
    manual = json.load(f)

manual_map = {g["ars"]: g for g in manual["gemeinden"]}
verbaende_map = {v["ars"]: v for v in manual["verbaende"]}
kreise_map = {k["ars"]: k for k in manual["landkreise"]}

# ── Verarbeitung ─────────────────────────────────────────────────────────────

rows = []
skipped_hinweis = 0
skipped_length = 0

for entry in destatis["daten"]:
    ars, name, hinweis = entry[0], entry[1], entry[2]

    # Stadtstaaten-Untereinheiten (Bezirke, Ortsteile) überspringen
    if hinweis:
        skipped_hinweis += 1
        continue

    if len(ars) != 12:
        skipped_length += 1
        continue

    land_ars = ars[:2]
    kreis_ars = ars[:5]
    verband_ars_raw = ars[:9]

    land, land_kurz = LAENDER.get(land_ars, ("", ""))

    # Kreis-Name aus manuellem Mapping, sonst leer
    kreis = kreise_map.get(kreis_ars, {}).get("name", "")

    # Verband: Stellen 6–9 des ARS; wenn alle "0" → kein Verband
    has_verband = verband_ars_raw[5:] != "0000"
    verband_ars = verband_ars_raw if has_verband else None
    verband = verbaende_map.get(verband_ars_raw, {}).get("name") if has_verband else None

    # Manuell gepflegte Daten bevorzugen
    if ars in manual_map:
        m = manual_map[ars]
        name = m["name"]
        verband = m.get("verband") or verband
        verband_ars = m.get("verband_ars") or verband_ars
        kreis = kreise_map.get(kreis_ars, {}).get("name", kreis)

    slug = make_slug(name)

    rows.append((ars, slug, name, verband, verband_ars, kreis, kreis_ars, land, land_ars, land_kurz))

# ── Statistik ────────────────────────────────────────────────────────────────

from collections import Counter

print(f"Gesamt Einträge in Destatis-Datei : {len(destatis['daten'])}")
print(f"Übersprungen (Hinweis/Untereinheit): {skipped_hinweis}")
print(f"Übersprungen (ungültige ARS-Länge) : {skipped_length}")
print(f"Zu insertierende Gemeinden         : {len(rows)}")
print()

by_land = Counter(r[8] for r in rows)
for ars2, n in sorted(by_land.items()):
    land_name, kurz = LAENDER.get(ars2, ("?", "?"))
    print(f"  {ars2} {kurz:2s}  {land_name:25s}: {n:5d} Gemeinden")

print()
print("Beispiele (erste 3):")
for r in rows[:3]:
    print(f"  {r[0]} | {r[2]:35s} | kreis_ars={r[6]} | land={r[9]} | verband_ars={r[4]}")

print()
print("Manuell angereicherte Einträge:")
for r in rows:
    if r[0] in manual_map:
        print(f"  {r[0]} | {r[2]:35s} | kreis={r[5]} | verband={r[3]}")

if DRY_RUN:
    print()
    print("-- DRY RUN: SQL-Datei wird nicht geschrieben.")
    sys.exit(0)

# ── SQL generieren ───────────────────────────────────────────────────────────

out = BASE / "seed-gemeinden-all.sql"
with open(out, "w", encoding="utf-8") as f:
    f.write("-- Generiert von scripts/generate-gemeinden-seed.py\n")
    f.write("-- Quelle: Destatis GV-ISys ars_2026-01-31 + manuelle Anreicherung\n")
    f.write(f"-- Gemeinden gesamt: {len(rows)}\n\n")
    for r in rows:
        ars, slug, name, verband, verband_ars, kreis, kreis_ars, land, land_ars, land_kurz = r
        f.write(
            f"INSERT OR REPLACE INTO gemeinden "
            f"(ars, slug, name, verband, verband_ars, kreis, kreis_ars, land, land_ars, land_kurz) VALUES "
            f"({sql_str(ars)}, {sql_str(slug)}, {sql_str(name)}, "
            f"{sql_str(verband)}, {sql_str(verband_ars)}, {sql_str(kreis)}, "
            f"{sql_str(kreis_ars)}, {sql_str(land)}, {sql_str(land_ars)}, {sql_str(land_kurz)});\n"
        )

print(f"\nSQL-Datei geschrieben: {out}")
print(f"Dateigröße: {out.stat().st_size / 1024:.0f} KB")
