@echo off
setlocal
title Laser-Kalkulation veroeffentlichen (GitHub Pages)
set "GH=C:\Program Files\GitHub CLI\gh.exe"
cd /d "%~dp0"

echo ============================================================
echo  Laser-Kalkulation  -  Veroeffentlichung auf GitHub Pages
echo ============================================================
echo.

if not exist "%GH%" (
  echo FEHLER: GitHub CLI nicht gefunden unter "%GH%".
  echo Bitte zuerst installieren: winget install GitHub.cli
  pause & exit /b 1
)

rem --- 1) Anmeldung (nur falls noch nicht angemeldet) ---
"%GH%" auth status >nul 2>nul
if errorlevel 1 (
  echo SCHRITT 1: Anmeldung bei GitHub
  echo   Bitte waehle:  GitHub.com  -  HTTPS  -  "Yes"  -  Login with a web browser
  echo   und melde dich mit dem Konto  martinalzinger  an.
  echo.
  "%GH%" auth login
  if errorlevel 1 ( echo. & echo Anmeldung abgebrochen. & pause & exit /b 1 )
) else (
  echo SCHRITT 1: bereits angemeldet - ok
)
echo.

rem --- Konto-Namen ermitteln ---
for /f "delims=" %%U in ('"%GH%" api user --jq .login') do set "OWNER=%%U"
echo Angemeldet als: %OWNER%
echo.

rem --- 2) Repository anlegen und hochladen ---
echo SCHRITT 2: Repository "laser-kalkulation" anlegen und hochladen ...
"%GH%" repo create laser-kalkulation --public --source="%~dp0." --remote=origin --push
if errorlevel 1 (
  echo.
  echo Repo existiert evtl. schon - versuche nur hochzuladen ...
  git remote add origin https://github.com/%OWNER%/laser-kalkulation.git 2>nul
  git push -u origin main
)
echo.

rem --- 3) GitHub Pages aktivieren ---
echo SCHRITT 3: GitHub Pages aktivieren ...
"%GH%" api -X POST repos/%OWNER%/laser-kalkulation/pages -f "source[branch]=main" -f "source[path]=/" 2>nul
if errorlevel 1 "%GH%" api -X PUT repos/%OWNER%/laser-kalkulation/pages -f "source[branch]=main" -f "source[path]=/" 2>nul
echo.

echo ============================================================
echo  FERTIG!
echo  Deine App (in ~1 Minute online):
echo     https://%OWNER%.github.io/laser-kalkulation/
echo ============================================================
echo.
echo Spaeter aktualisieren: Aenderungen mit  git add -A ^&^& git commit ^&^& git push
pause
