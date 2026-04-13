@echo off
REM ============================================================================
REM  Transcriptor - Windows Build
REM  Builds the Electron app as an NSIS .exe installer for Windows x64.
REM  Usage: double-click build.bat or run from cmd/PowerShell
REM ============================================================================
setlocal enabledelayedexpansion

echo.
echo   ========================================
echo     Transcriptor - Windows Build
echo   ========================================
echo.

cd /d "%~dp0\..\.."
set ROOT_DIR=%CD%

REM ── Pre-flight ─────────────────────────────────────────────────────────
echo [1/6] Pre-flight checks...
where node >nul 2>&1 || (echo ERROR: Node.js not found. Install from https://nodejs.org && pause && exit /b 1)
where npm >nul 2>&1 || (echo ERROR: npm not found. Install Node.js from https://nodejs.org && pause && exit /b 1)
for /f "tokens=*" %%v in ('node --version') do echo   Node.js %%v

REM ── Clean ──────────────────────────────────────────────────────────────
echo [2/6] Cleaning stale builds...
if exist "%ROOT_DIR%\desktop\dist\win-unpacked" rmdir /s /q "%ROOT_DIR%\desktop\dist\win-unpacked" 2>nul
del /q "%ROOT_DIR%\desktop\dist\*.exe" 2>nul
del /q "%ROOT_DIR%\desktop\dist\*.exe.blockmap" 2>nul

REM ── Frontend deps ──────────────────────────────────────────────────────
echo [3/6] Checking frontend dependencies...
if not exist "%ROOT_DIR%\frontend\node_modules" (
    echo   Installing frontend npm deps...
    cd /d "%ROOT_DIR%\frontend" && call npm install --silent
)

REM ── Desktop deps ───────────────────────────────────────────────────────
echo [4/6] Checking desktop dependencies...
if not exist "%ROOT_DIR%\desktop\node_modules" (
    echo   Installing desktop npm deps...
    cd /d "%ROOT_DIR%\desktop" && call npm install --silent
)

REM ── Build ──────────────────────────────────────────────────────────────
echo [5/6] Building Electron app + NSIS installer...
cd /d "%ROOT_DIR%\desktop"
call npm run dist:win
if errorlevel 1 (
    echo.
    echo   ERROR: Build failed. See output above.
    pause
    exit /b 1
)

REM ── Collect ────────────────────────────────────────────────────────────
echo [6/6] Collecting installer...
if not exist "%ROOT_DIR%\dist" mkdir "%ROOT_DIR%\dist"
del /q "%ROOT_DIR%\dist\Transcriptor-*.exe" 2>nul
del /q "%ROOT_DIR%\dist\*Setup*.exe" 2>nul
for %%f in ("%ROOT_DIR%\desktop\dist\*.exe") do (
    copy /y "%%f" "%ROOT_DIR%\dist\" >nul
    echo   %%~nxf
)

REM ── Cleanup ────────────────────────────────────────────────────────────
rmdir /s /q "%ROOT_DIR%\desktop\dist\win-unpacked" 2>nul
del /q "%ROOT_DIR%\desktop\dist\*.exe.blockmap" 2>nul
del /q "%ROOT_DIR%\desktop\dist\builder-debug.yml" 2>nul

echo.
echo   ========================================
echo     Build complete!
echo   ========================================
echo.
echo   Installer: dist\Transcriptor Setup 1.0.0.exe
echo.
echo   Double-click the .exe to install:
echo     - Installs to %%LOCALAPPDATA%%\Programs\Transcriptor
echo     - Creates Desktop + Start Menu shortcuts
echo     - Launches Transcriptor after install
echo.
echo   Uninstall: Settings ^> Apps ^> Transcriptor ^> Uninstall
echo.
pause
