# Laser-Kalkulation – Projektvorgaben

Lokale/Web-App zur Preiskalkulation von Laser-/Abkantteilen aus TruTops-Plänen (PDF),
STEP- und DXF-Dateien sowie Biegeprogrammen (JUPIDU/HTML). Dateien: `index.html`,
`app.js`, `parser.js`, `lib/` (pdf.js, three.js, occt-import-js, dxf-parser, jszip),
`manifest.webmanifest`, `icon-192/512.png`, `hero.jpg`.

## Schachtelung / Tafel-Optimierung (dauerhafte Vorgaben)

- **Blechtafel:** 3000 × 1500 mm. **Teileabstand = Blechstärke** (min. 1 mm), je Werkstoff+Dicke gruppiert.
- **Packer-Strategie: Echte Konturschachtelung (true-shape), First-Fit über ALLE Tafeln.** Jedes Teil
  wird aus seiner **echten Kontur** (`contourNorm` inkl. Löcher, evenodd) in eine Rasterbelegung
  (`NEST_CELL` = 4 mm) gerendert, um den Teileabstand erweitert (Dilatation) und per **Bottom-Left
  „Tetris-Drop" über eine Heightmap** an der tiefsten Stelle abgelegt — so verzahnen sich die Zacken
  eines Teils in den Lücken des Nachbarn (wie TruTops „Gitterfertigung"). **Drehwinkel** werden probiert,
  der dichteste gewinnt — per Einstellung umschaltbar (`NEST_MODE`/`NEST_ANGLE_SETS`): **schnell** 0/90°
  (Default, für symmetrische Teile dichteste + schnellste Variante), **mittel** 0/45/90°, **fein** 0–90°
  in 10°-Schritten (langsamer, hilft v. a. asymmetrischen/länglichen Teilen; bei symmetrischen Teilen
  bringt mehr Winkel nichts und packt eher lockerer). Jedes Teil füllt zuerst die
  Lücken bestehender Tafeln, bevor eine neue aufgemacht wird. Umsetzung: `maskFromContour` +
  `packTrueShapeGroup` in `app.js` (ersetzt den alten Rechteck-`packSheets`). Über die Heightmap ist
  **Überlappung ausgeschlossen**. Große Teile zuerst, kleine füllen die Zwischenräume.
- **Biegeteile = flacher Zuschnitt schachteln:** Gebogene STEP-Teile (erkannt an `bbox.dims[0] > Dicke·2,5`,
  d. h. deutlich aus der Ebene) werden **nicht** als gebogene 3D-Kontur, sondern als ihr **flaches
  Abwicklungs-Rechteck** (`fp.w × fp.h`, Fläche = Volumen/Dicke) geschachtelt **und** so gezeichnet
  (`p._nestRect`). Sonst würde der Packer das schmale gebogene Profil sehen, zu viele Teile auf die Tafel
  legen → zu wenige Tafeln → zu billig. Flache Teile (DXF, ungebogenes STEP) behalten ihre echte Kontur
  (Verzahnung). Die Tafel-Belegung wird zusätzlich hart auf **100 %** gedeckelt.
  **Gezeichnet** (`p._flatNorm`, unverzerrt mittig im Slot): erst **echte Abwicklung gerollter/gebogener
  Teile** (`unrollCylindrical` – Außenhaut über den Querschnitt-Bogen aufrollen, alle Ausschnitte, gegen
  Blechfläche geprüft; z. B. 0011813_1 → 1462×334 mm, 25 Löcher, 99 % Treffer), sonst **größte
  zusammenhängende flache Fläche** (`dominantFaceFlat`). **Die Abwicklungs-Zeichnung wird gegen die echte
  Blechfläche geprüft** (`_fl.w·_fl.h ≥ 0,5·Vol/Dicke`); deckt sie die Blechfläche nicht ab (nicht-zylindr.
  Biegeteil → nur schmale Teilfläche erkannt, z. B. 7×1977 statt 1990×113), wird `_flatNorm` verworfen und
  im Slot ein **sauberes Rechteck** (Abwicklungsmaß) gezeichnet statt eines degenerierten Strichs.
  **Hinweis:** STEP = nur 3D-Geometrie → Biegungszahl (`detectBends`) und Abwicklung sind **Schätzungen**;
  exakt nur via Biegeprogramm (JUPIDU/HTML) bzw. DXF-Zuschnitt.
- **Echte Abwicklung aus STEP (B-Rep):** Der STEP-Import (`occt.ReadStepFile`) liefert `brep_faces`
  (Dreieck→CAD-Fläche). Daraus echte Abwicklung — Reihenfolge in `loadStep`, jeweils gegen die Blechfläche
  (Σ Dreiecke ≈ Vol/Dicke) geprüft, sonst verworfen: 1) `unrollCylindrical` (gerollte/zylindrische Teile,
  Kreis-Fit), 2) `unfoldSurface` (allgemein: jede Fläche isometrisch in 2D – Ebene projizieren, Zylinder
  aufrollen – und per Baum entlang **positions-basierter** gemeinsamer Kanten gegenüberliegend vernähen;
  Vertices sind pro Fläche dupliziert, daher Positions-Schlüssel), 3) `dominantFaceFlat` (Hauptfläche).
  Beispiele: 0011813_1 (gerollt) 1462×330 mm, 0012954_0 (7 Kanten) 634×391-Netz mit allen Ausschnitten.
  Nur Darstellung (`p._flatNorm`); Schachtelung/Preis bleiben das Abwicklungs-Rechteck.
- **Walzrichtung je Teil:** Pro Position wählbar (`p.walz`: `egal`/`laengs`/`quer`) – beliebig = freie Winkel,
  Walzrichtung = nur 0°, Gegen Walzrichtung = nur 90°. Steuert die erlaubten Drehwinkel beim Schachteln
  (`walzAngles` je Item). Auswahl + **Einzel-Löschen** (✕) sitzen in der Werkzeug-Leiste jeder Positionszeile.
- **Loch-Schachtelung:** Passt ein kleineres Teil (inkl. Abstand) in das größte Loch eines größeren
  Teils derselben Gruppe, wird es dort eingeschachtelt (ein Teil pro Loch) statt eigene Fläche zu belegen.
- **Auslastung = echte Metallfläche (kein >100 %):** Angezeigt wird der reale Metallanteil der Tafel
  (Summe der Teil-Abwicklungsflächen ÷ Tafelfläche, auf 100 % gedeckelt). DXF = Konturfläche,
  STEP = Volumen/Dicke. Bei stark gelochten/sternförmigen Teilen ist das bewusst **niedriger** (z. B.
  ~37–47 %) — entspricht dem TruTops-„Verschnitt" (z. B. 65,88 % Verschnitt = ~34 % Metall) und ist
  **kein** Fehler, sondern formbedingt. Solide/eckige Teile erreichen weiterhin ~85–95 %.
  In Löchern geschachtelte Teile werden nicht doppelt gezählt.
- **Resttafel-Schalter:** „Resttafel verrechnen" an/aus. Aus = letzte Tafel per Trennschnitt geteilt,
  Rest nicht berechnet (Schnitt in die Richtung mit größerem Rest). Beeinflusst die Materialkosten.
- **Tafel-Detailansicht:** Klick auf eine Tafel öffnet sie groß (`buildSheetSvg`/`openSheetModal`).

## DXF-Import

- **Blöcke rekursiv auflösen:** CAD-Exporte (z. B. Solid Edge) verpacken die Geometrie in
  INSERT→Block-Ketten (SE, SE1, …) statt sie auf oberster Ebene abzulegen. `parseDxfGeom` löst INSERTs
  rekursiv mit Affintransformation (Verschiebung/Drehung/Skalierung/Spiegelung) auf. Anmerkungs-Blöcke
  (`*ANNOT*`) und Layer `H` (Hilfslinien/Ballons) werden verworfen; TEXT/DIMENSION etc. übersprungen.
- **Segmente verketten:** Lose Linien/Bögen/Splines werden an den Endpunkten (Toleranz 0,05 mm) zu
  geschlossenen Konturen verkettet — erst dadurch stimmen Fläche (statt Bounding-Box), Einstiche,
  Loch-Erkennung und die Füllung beim Schachteln. Bögen/Ellipsen werden dafür als Punktketten abgetastet.
- **Material/Dicke-Dialog beim Import:** DXF enthält kein Material und keine Dicke → `askDxfMeta` fragt
  **einmal pro Import** (gilt für alle DXFs des Drops) Material + Dicke ab; zuletzt gewählte Werte werden
  vorbelegt (`localStorage: alz_dxf_mat/alz_dxf_dicke`). Je Position bleibt beides änderbar.
- **Bearbeitung je Kontur (wie TruTops Boost):** Jedes `p.dxf`-Element hat `kind`: `cut`/`mark`/`skip`.
  Default: geschlossene Konturen = Schneiden, Layer-`H`-Linien (Solid Edge Biege-/Markierlinien) = Gravur.
  Im DXF-Viewer („Ansehen") ist **jede Kontur klickbar** und schaltet Schneiden→Gravieren→Ignorieren
  (Farben rot/blau/grau, `KIND_COLOR`). `recomputeDxfPart` rechnet danach Schnitt-/Gravurlänge
  (`marklen_mm`, Gravur mit `PARAMS.grav_m` m/min in der Laserzeit — Default 20, kalibriert an
  TruTops-Bearbeitungszeiten, einstellbar im Menü), Fläche, Einstiche und die Schachtel-Kontur (nur `cut`) neu.

## Mengen-/Eingabelogik (große + kleine Teile)

- Jede Position hat eine **Menge**; die Schachtelung expandiert auf Einzel-Instanzen je Menge.
- Gruppierung nach **Werkstoff + Dicke** – nur so geschachtelt; PDF-Planteile bleiben gewichtsbasiert
  (Plan ist bereits geschachtelt).
- **Materialkosten = real benötigte Tafeln × Tafelgewicht × €/kg**, auf die Teile nach Gewicht verteilt
  (inkl. Verschnitt). Große + kleine Teile derselben Gruppe teilen sich also die Tafeln/Kosten.
- **Schnittgeschwindigkeit (`SPEED`, `effCutSpeed`):** Stahl 1–5 mm = echte TruTops-LTT-Werte (Konturart
  „Gross", S355MC/6 kW/TC41, aus der hauseigenen Schneidtabelle gemessen). Bis 5 mm N2: 1mm 51 · 2mm 30,5 ·
  3mm 17 · 4mm 9,5 · 5mm 7 m/min; ab 6 mm O2: 6mm 3 · 8mm 2,6 · 10mm 2,38 · 12mm 2 · 15mm 1,62 · 20mm 1,2 ·
  25mm 0,94 m/min (Stahl 1–25 mm komplett echt). Edelstahl/Alu noch Richtwerte
  (2 mm Edelstahl ≈ 19 m/min am realen Plan). **Konturgröße (Klein↔Gross):** Tabellenwerte = GROSSKONTUR;
  Kleinkontur = echte 4,5 m/min (Stahl N2 1–5 mm, dickenunabhängig — beschleunigungslimitiert), in
  `SPEED.stahl.klein`. `effCutSpeed`/`konturSpeed` interpolieren je nach mittlerem Konturumfang (Schnitt ÷
  Konturen) konkav zwischen Klein und Gross; Konturgröße zusätzlich auf die **Teilgröße** (`partMaxDim`)
  gedeckelt (kurze Geraden → nie Topspeed). **Gas-abhängig:** dünn N2 (≤5 mm) Klein 4,5 m/min, sanfte Kurve
  bis Gross ~600 mm; mitteldick O2 (6–8 mm) **Mittel = Gross** und Klein 0,1 m/min (O2 kann winzige Löcher
  in 6–8 mm kaum) — fast Stufe; dick O2 (≥10 mm) **Klein ≈ Gross** (~0,9×, kein Tempoverlust mehr — kriecht
  ohnehin). Alle drei Konturklassen je Dicke an der echten Schneidtabelle geprüft. Nur Gross-Gruppen (bis `maxT`).
  Gravur läuft mit `grav_m`
  (Default 20 m/min) **ohne** Schneid-Overhead (Faktor 1,05), Schneiden/Einstiche/Eilgang mit
  `laser_overhead`. Dünne gravur-lastige Teile bleiben Schätzung (echte TruTops-Werte teils widersprüchlich).
- Datenquellen je Teil: **TruTops-Plan** → exakte Laserzeit; **STEP** → Kontur/Gewicht/Schneidlänge/
  Dicke (Dicke = Abstand Ober-/Unterseite der Hauptfläche, auch bei Biegeteilen); **Biegeprogramm
  (JUPIDU/HTML)** → exakte Biegungen/Material/Dicke, Zuordnung über die Teile-Nr.

## Deploy-Workflow

- Hosting: **GitHub Pages**, Repo `alzingermaschinenbau/laser-kalkulation`, Branch `main`, Root.
  Live-URL: **https://alzingermaschinenbau.github.io/laser-kalkulation/**
- **Cache-Busting:** In `index.html` sind `app.js?v=…` und `parser.js?v=…` versioniert. Bei **jedem
  Deploy die Versionsnummer hochzählen** (z. B. `20260609b`→`20260609c`), sonst lädt der Browser/CDN evtl.
  die alte Datei trotz `Strg`+`F5`.
- **Sichtbare App-Version:** Unten in der Bottom-Bar steht `<span class="appver">v1</span>`. Bei jedem
  Deploy mit Funktionsänderung **hochzählen** (v1→v2…) — daran erkennt der Nutzer sofort, ob er die
  aktuelle Version vor sich hat.
- Veröffentlichen: Änderungen committen und `git push origin main`. GitHub Pages baut automatisch
  (~1–2 min). Danach prüfen, dass die Datei live ist, und im Browser `Strg`+`F5`.
  Alternativ Doppelklick auf `Start_Laser-Kalkulation.bat` (committet + pusht automatisch).
- **Nicht veröffentlichen** (per `.gitignore`): echte Pläne/CAD (`*.pdf`, `*.stp`, `*.step`),
  Biegeprogramme, interne Screenshots, `.claude/`. Nur App-Code + Bibliotheken + Icons werden gepusht.
- Lokales Testen: Preview über `python -m http.server` (`.claude/launch.json`).
