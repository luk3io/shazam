@echo off
REM Double-click this to launch the Shazam demo locally in your browser.
REM It builds the demo if needed, starts a local web server, and opens the page.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not on your PATH.
  echo Install it from https://nodejs.org/ then double-click this again.
  echo.
  pause
  exit /b 1
)

REM Build the single-file demo the first time (needs MP3s in .\songs\).
if not exist "shazam-demo.html" (
  echo Building shazam-demo.html for the first time...
  call npm run build
  if errorlevel 1 (
    echo.
    echo Build failed. Make sure there are .mp3 files in the "songs" folder.
    pause
    exit /b 1
  )
)

REM Start the server in its own window (close that window to stop it).
start "Shazam demo server (close to stop)" cmd /k node "%~dp0serve.mjs"

REM Give the server a moment, then open the browser.
ping -n 3 127.0.0.1 >nul
start "" "http://localhost:8000/"

exit /b 0
