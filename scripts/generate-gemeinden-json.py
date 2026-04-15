#!/usr/bin/env python3
"""
Generiert data/gemeinden.json aus GV100AD_28022026.txt.

Enthält:
  - Bundesrepublik Deutschland ("00")
  - alle 16 Bundesländer (ARS 01–16)
  - alle Landkreise + kreisfreie Städte (GV100AD Satzart 4)
  - alle Verwaltungsverbände (GV100AD Satzart 5)
  - Gemeinden: nur die bereits in gemeinden.json vorhandenen (manuell gepflegt)

Bestehende Einträge behalten ihre Aliases; neue bekommen Auto-Aliases.

Aufruf:
  python scripts/generate-gemeinden-json.py [--dry-run]
"""

import json
import re
import sys
from pathlib import Path

DRY_RUN = "--dry-run" in sys.argv

BASE = Path(__file__).parent.parent / "data"

LAND_KUERZEL = {
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


def deumlaute(s: str) -> str:
    for a, b in [("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss")]:
        s = s.replace(a, b)
    return s


def make_slug(name: str) -> str:
    s = deumlaute(name.lower())
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


def auto_aliases_land(name: str, kuerzel: str) -> list[str]:
    low = name.lower()
    deu = deumlaute(low)
    aliases = []
    for a in [kuerzel.lower(), low, deu]:
        if a not in aliases:
            aliases.append(a)
    # Leerzeichen entfernen
    nospace = deu.replace(" ", "")
    if nospace not in aliases:
        aliases.append(nospace)
    return aliases


def auto_aliases_kreis(name: str) -> list[str]:
    low = name.lower()
    deu = deumlaute(low)
    # Ggf. ", Stadt" / ", Hansestadt" etc. abschneiden für Kurznamen
    base = re.sub(r",\s*\w+$", "", low).strip()
    base_deu = deumlaute(base)
    aliases = []
    for a in [low, deu, base, base_deu]:
        if a and a not in aliases:
            aliases.append(a)
    for prefix in ["landkreis", "lkr", "kreis"]:
        for b in [base, base_deu]:
            if b:
                a = f"{prefix} {b}"
                if a not in aliases:
                    aliases.append(a)
    return aliases


def auto_aliases_verband(name: str) -> list[str]:
    low = name.lower()
    deu = deumlaute(low)
    aliases = []
    for a in [low, deu]:
        if a not in aliases:
            aliases.append(a)
    return aliases


# ── Bestehende gemeinden.json laden ──────────────────────────────────────────

with open(BASE / "gemeinden.json", encoding="utf-8") as f:
    existing = json.load(f)

existing_laender: dict[str, dict] = {e["ars"]: e for e in existing.get("laender", [])}
existing_kreise: dict[str, dict] = {e["ars"]: e for e in existing.get("landkreise", [])}
existing_verbaende: dict[str, dict] = {e["ars"]: e for e in existing.get("verbaende", [])}
existing_gemeinden: list[dict] = existing.get("gemeinden", [])

# ── GV100AD einlesen ──────────────────────────────────────────────────────────

gv_laender: dict[str, str] = {}    # land_ars (2) → Name
gv_kreise: dict[str, str] = {}     # kreis_ars (5) → Name
gv_verbaende: dict[str, str] = {}  # verband_ars (9) → Name
gv_kreis_land: dict[str, str] = {} # kreis_ars → land_ars

GV100_FILE = BASE / "GV100AD_28022026.txt"
with open(GV100_FILE, encoding="utf-8") as f:
    for line in f:
        if len(line) < 72:
            continue
        satzart = line[0]
        name_raw = line[22:72].strip()

        if satzart == "1":
            land_ars = line[10:12]
            if land_ars.strip() and name_raw:
                gv_laender[land_ars] = name_raw

        elif satzart == "4":
            kreis_ars = line[10:15]
            if kreis_ars.strip() and name_raw:
                gv_kreise[kreis_ars] = name_raw
                gv_kreis_land[kreis_ars] = kreis_ars[:2]

        elif satzart == "5":
            kreis_ars = line[10:15]
            verband_id = line[18:22]
            if kreis_ars.strip() and verband_id.strip() and name_raw:
                verband_ars = kreis_ars + verband_id
                gv_verbaende[verband_ars] = name_raw

print(f"GV100AD: {len(gv_laender)} Länder, {len(gv_kreise)} Kreise, {len(gv_verbaende)} Verbände")

# ── Bundesrepublik Deutschland ────────────────────────────────────────────────

BUND_ARS = "00"
if BUND_ARS in existing_laender:
    bund_entry = existing_laender[BUND_ARS]
else:
    bund_entry = {
        "ars": BUND_ARS,
        "name": "Bundesrepublik Deutschland",
        "kuerzel": "DE",
        "aliases": ["de", "deutschland", "bundesrepublik deutschland", "bundesrepublik"],
    }

# ── Bundesländer zusammenführen ───────────────────────────────────────────────

laender_out: list[dict] = [bund_entry]

for ars, name_gv in sorted(gv_laender.items()):
    if ars in existing_laender:
        laender_out.append(existing_laender[ars])
    else:
        land_name, kuerzel = LAND_KUERZEL.get(ars, (name_gv, "??"))
        laender_out.append({
            "ars": ars,
            "name": land_name,
            "kuerzel": kuerzel,
            "aliases": auto_aliases_land(land_name, kuerzel),
        })

# GV100AD-Länder und LAND_KUERZEL abgleichen (Warnung bei Abweichungen)
for ars, (expected_name, kuerzel) in LAND_KUERZEL.items():
    gv_name = gv_laender.get(ars, "")
    if gv_name and gv_name != expected_name:
        print(f"  WARNUNG Land {ars}: GV100AD='{gv_name}' ≠ LAND_KUERZEL='{expected_name}'")

# ── Kreise zusammenführen ─────────────────────────────────────────────────────

kreise_out: list[dict] = []

for ars, name_gv in sorted(gv_kreise.items()):
    if ars in existing_kreise:
        kreise_out.append(existing_kreise[ars])
    else:
        land_ars = gv_kreis_land.get(ars, ars[:2])
        kreise_out.append({
            "ars": ars,
            "name": name_gv,
            "land_ars": land_ars,
            "aliases": auto_aliases_kreis(name_gv),
        })

# ── Verbände zusammenführen ───────────────────────────────────────────────────

verbaende_out: list[dict] = []

for ars, name_gv in sorted(gv_verbaende.items()):
    if ars in existing_verbaende:
        verbaende_out.append(existing_verbaende[ars])
    else:
        kreis_ars = ars[:5]
        verbaende_out.append({
            "ars": ars,
            "name": name_gv,
            "kreis_ars": kreis_ars,
            "aliases": auto_aliases_verband(name_gv),
        })

# ── Ausgabe ───────────────────────────────────────────────────────────────────

print(f"\nErgebnis:")
print(f"  Bundesrepublik + Bundesländer : {len(laender_out)} (1 + {len(laender_out)-1})")
print(f"  Landkreise                     : {len(kreise_out)}")
print(f"  Verwaltungsverbände            : {len(verbaende_out)}")
print(f"  Gemeinden (manuell)            : {len(existing_gemeinden)}")

if DRY_RUN:
    print("\n-- DRY RUN: gemeinden.json wird nicht geschrieben.")
    sys.exit(0)

out = {
    "laender": laender_out,
    "landkreise": kreise_out,
    "verbaende": verbaende_out,
    "gemeinden": existing_gemeinden,
}

out_path = BASE / "gemeinden.json"
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
    f.write("\n")

print(f"\ngemeinden.json geschrieben → {out_path}")
