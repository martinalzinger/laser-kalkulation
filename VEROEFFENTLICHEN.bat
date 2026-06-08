@echo off
setlocal
title Laser-Kalkulation veroeffentlichen / aktualisieren
set "GH=C:\Program Files\GitHub CLI\gh.exe"
cd /d "%~dp0"

echo ============================================================
echo  Laser-Kalkulation  -  veroeffentlichen / aktualisieren
echo ============================================================
echo.

if not exist "%GH%" (
  echo FEHLER: GitHub CLI nicht gefunden unter "%GH%".
  echo Bitte installieren: winget install GitHub.cli
  pause & exit /b 1
)

rem --- 1) Anmeldung (nur falls noetig) ---
"%GH%" auth status >nul 2>nul
if errorlevel 1 (
  echo SCHRITT 1: Anmeldung bei GitHub  ^(GitHub.com - HTTPS - Yes - Web-Browser^)
  echo   Konto:  martinalzinger
  echo.
  "%GH%" auth login
  if errorlevel 1 ( echo Anmeldung abgebrochen. & pause & exit /b 1 )
) else ( echo SCHRITT 1: angemeldet - ok )

for /f "delims=" %%U in ('"%GH%" api user --jq .login') do set "OWNER=%%U"
echo   angemeldet als: %OWNER%
echo.

rem --- 2) Repo sicherstellen ---
git remote get-url origin >nul 2>nul
if errorlevel 1 (
  echo SCHRITT 2: Repository anlegen ...
  "%GH%" repo create laser-kalkulation --public --source="%~dp0." --remote=origin
)

rem --- 3) Aenderungen committen + hochladen ---
echo SCHRITT 3: Aenderungen hochladen ...
git add -A
git diff --cached --quiet
if errorlevel 1 (
  git -c user.name="Alzinger Maschinenbau" -c user.email="info@alzinger-maschinenbau.de" commit -m "Update via VEROEFFENTLICHEN.bat"
) else (
  echo   keine neuen Aenderungen
)
git push -u origin main
echo.

rem --- 4) GitHub Pages sicherstellen ---
"%GH%" api repos/%OWNER%/laser-kalkulation/pages >nul 2>nul
if errorlevel 1 "%GH%" api -X POST repos/%OWNER%/laser-kalkulation/pages -f "source[branch]=main" -f "source[path]=/" >nul 2>nul

echo ============================================================
echo  FERTIG!  In ~1 Minute aktualisiert:
echo     https://%OWNER%.github.io/laser-kalkulation/
echo  Tipp: im Browser Strg+F5 druecken.
echo ============================================================
pause
