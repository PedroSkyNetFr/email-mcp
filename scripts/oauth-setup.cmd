@echo off
REM ---------------------------------------------------------------------------
REM Double-clickable launcher for the OAuth2 setup helper (Windows).
REM
REM Opens a console, runs scripts/oauth-setup.ts, and keeps the window open at
REM the end so the printed refresh token can be read and copied.
REM
REM Any argument passed here is forwarded to the script; with none, the script
REM asks for the provider, client ID and client secret interactively.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0.."

if not exist "node_modules\" (
  echo.
  echo Dependencies are not installed yet.
  echo Run "pnpm install" in this folder first, then start this script again.
  echo.
  pause
  exit /b 1
)

call npx tsx scripts/oauth-setup.ts %*
set EXITCODE=%ERRORLEVEL%

echo.
echo Press any key to close this window...
pause >nul
exit /b %EXITCODE%
