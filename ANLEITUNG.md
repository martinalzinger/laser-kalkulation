# Alzinger · Laser- & Abkant-Kalkulation

Browser-Tool zur Angebotskalkulation von Laser-/Abkantteilen aus
TruTops-Boost-Plänen – im Design des Lepton-5100-Konfigurators
(rotes Alzinger-Header, Hero, nummerierte Sektionen, dunkle Fußleiste).

## Starten
- **Lokal:** Doppelklick auf `Start_Laser-Kalkulation.bat` (oder `index.html`).
- **Online (empfohlen):** auf GitHub Pages stellen – siehe unten. Dort läuft
  das PDF-Lesen am zuverlässigsten (echter Worker, kein `file://`-Thema).

## Ablauf
1. **01 · Dokumentdaten** – Angebotsnummer, Datum, Ort, Verkäufer.
2. **02 · Kunde** – Rechnungsanschrift & Ansprechpartner.
3. **03 · Positionen** – Dateien ablegen/wählen (mehrere möglich):
   - **TruTops-Plan (PDF)** → alle Teile werden automatisch ausgelesen.
   - **CAD-Teil (STEP/STP)** → 3D-Körper, Gewicht aus dem Volumen.
   - **CAD-Teil (DXF)** → Flachteil, Gewicht/Schneidlänge/Laserzeit aus der
     Kontur berechnet.
   Pro Zeile **Material, Dicke, Menge, Biegungen** anpassen. Bei CAD-Teilen
   **👁 Ansehen** öffnet den Viewer: **STEP zum Drehen/Zoomen in 3D**, DXF als
   2D-Kontur (drehbar). Dort lassen sich Laserzeit & Biegungen je Teil setzen.
   Bei PDF-Plänen wird darunter der Original-Plan zum Durchblättern gezeigt.
4. **04 · Kalkulation** – Stundensätze, Marge, Rüstkosten, Materialpreise.
5. Unten **Angebot ansehen** → druckfertiges Angebot mit Briefkopf, dunkler
   Auftragsumfang-Box, Positionen und AGB → **Drucken / PDF**. Oder **CSV**.

## Preismodell (prozessbasiert, mit Mengen-Umlage)
Echte Zeiten je Prozess × Stundensatz; Fixkosten werden auf die Menge
umgelegt (→ Staffelpreise, wie bei 247TailorSteel).
```
Stückkosten (variabel):
  Material = Gewicht × €/kg
  Lasern   = Laserzeit(min) × Laser-€/h ÷ 60
             (Plan: exakte TruTops-Zeit · DXF: ΣKontur÷v + Einstiche
              + Eilgang, × Overhead · STEP: manuell im Viewer)
  Biegen   = (Handling/Teil + Biegungen × Zeit/Biegung) × Abkant-€/h ÷ 3600
Fixkosten je Position (÷ Menge):
  Programmieren = Prog-min × Prog-€/h ÷ 60
  Rüsten        = Laser-Rüst-min × Laser-€/h ÷ 60
                  (+ Biege-Rüst-min × Abkant-€/h ÷ 60, falls Biegung)
Selbstkosten/St = variabel + Fix ÷ Menge
VK/St           = Selbstkosten ÷ (1 − Marge%)
Position        = max( VK × Menge , Mindestposition )
Staffelpreis(Q) = (variabel + Fix ÷ Q) ÷ (1 − Marge%)
```
**Standard-Richtwerte** (editierbar unter „04 · Kalkulation"): Laser
134,17 €/h (TruLaser 5030) · Abkanten 85 €/h · Programmieren 60 €/h ·
Marge 30 % · Min. 15 € · Programmieren 12 min/Teil · Rüsten Laser 5 min ·
Rüsten Biegen 8 min · Handling 15 s/Teil · 20 s/Biegung · Laser-Overhead ×1,4.
Einstechzeit nach Dicke (0,4–2,5 s). **Bitte an die eigenen Maschinen/Zeiten
anpassen** – die Richtwerte ergeben andere Summen als eine Pauschale.
Materialpreise sind Schätzwerte – mit Einkaufspreisen prüfen.

## Auf GitHub Pages stellen (wie der Konfigurator)
1. Neues Repo anlegen, z. B. `laser-kalkulation`.
2. Inhalt dieses Ordners hochladen (`index.html`, `app.js`, `parser.js`,
   Ordner `lib/`).
3. Repo → Settings → Pages → Branch `main` / Root → Speichern.
4. Aufrufbar unter `https://<dein-name>.github.io/laser-kalkulation/`.

## CAD-Hinweise
- **DXF**: Gewicht = Konturfläche × Dicke × Dichte; Schneidlänge = Summe aller
  Konturen; Laserzeit grob geschätzt (Schneidlänge ÷ 2000 mm/min, im Viewer
  überschreibbar). Dichte automatisch nach Werkstoff (Stahl 7,85 · Edelstahl
  7,9 · Alu 2,7 · Kupfer 8,9 kg/dm³).
- **STEP**: Gewicht = Volumen × Dichte; Dicke = kleinste Bauteilabmessung.
  Laserzeit/Biegungen im Viewer eintragen. Sehr große Baugruppen (zig MB)
  brauchen zum Einlesen etwas – für einzelne Laser-Teile ist es sofort da.

## Dateien
`index.html` (Oberfläche) · `app.js` (Logik/Preise) · `parser.js`
(PDF-Auslesen) · `logo.png` · `lib/` (pdf.js, three.js, dxf-parser,
occt-import-js für STEP). Schriften: Manrope + IBM Plex Mono.
Beispiel `_sample.dxf` zum Ausprobieren liegt bei.
