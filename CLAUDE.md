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

## Mengen-/Eingabelogik (große + kleine Teile)

- Jede Position hat eine **Menge**; die Schachtelung expandiert auf Einzel-Instanzen je Menge.
- Gruppierung nach **Werkstoff + Dicke** – nur so geschachtelt; PDF-Planteile bleiben gewichtsbasiert
  (Plan ist bereits geschachtelt).
- **Materialkosten = real benötigte Tafeln × Tafelgewicht × €/kg**, auf die Teile nach Gewicht verteilt
  (inkl. Verschnitt). Große + kleine Teile derselben Gruppe teilen sich also die Tafeln/Kosten.
- Datenquellen je Teil: **TruTops-Plan** → exakte Laserzeit; **STEP** → Kontur/Gewicht/Schneidlänge/
  Dicke (Dicke = Abstand Ober-/Unterseite der Hauptfläche, auch bei Biegeteilen); **Biegeprogramm
  (JUPIDU/HTML)** → exakte Biegungen/Material/Dicke, Zuordnung über die Teile-Nr.

## Deploy-Workflow

- Hosting: **GitHub Pages**, Repo `alzingermaschinenbau/laser-kalkulation`, Branch `main`, Root.
  Live-URL: **https://alzingermaschinenbau.github.io/laser-kalkulation/**
- Veröffentlichen: Änderungen committen und `git push origin main`. GitHub Pages baut automatisch
  (~1–2 min). Danach prüfen, dass die Datei live ist, und im Browser `Strg`+`F5`.
  Alternativ Doppelklick auf `Start_Laser-Kalkulation.bat` (committet + pusht automatisch).
- **Nicht veröffentlichen** (per `.gitignore`): echte Pläne/CAD (`*.pdf`, `*.stp`, `*.step`),
  Biegeprogramme, interne Screenshots, `.claude/`. Nur App-Code + Bibliotheken + Icons werden gepusht.
- Lokales Testen: Preview über `python -m http.server` (`.claude/launch.json`).
