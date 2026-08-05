@echo off
REM ===========================================================================
REM  Nova Android app - one-time setup
REM ---------------------------------------------------------------------------
REM  Double-click this file. It pulls down the pieces Android Studio needs to
REM  build the app. You only have to run it once, and again any time the
REM  Capacitor plugins change.
REM ===========================================================================
setlocal
cd /d "%~dp0"

echo.
echo   Nova Android app - setup
echo   ------------------------
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed on this machine.
  echo.
  echo   Install the LTS version from  https://nodejs.org
  echo   then double-click this file again.
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do echo   Node %%v found.
echo.
echo   Downloading the app's building blocks. This takes a minute the first time.
echo.

call npm install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo   That did not finish cleanly. Check the messages above.
  pause
  exit /b 1
)

echo.
echo   Wiring the native project up.
call npx cap sync android
if errorlevel 1 (
  echo.
  echo   Sync failed. Check the messages above.
  pause
  exit /b 1
)

echo.
echo   ============================================================
echo    Done. Now open Android Studio and choose:
echo.
echo        Open  ^>  %~dp0android
echo.
echo    Let it finish "Gradle sync", plug in a phone with USB
echo    debugging on, and press the green Run arrow.
echo   ============================================================
echo.
pause
