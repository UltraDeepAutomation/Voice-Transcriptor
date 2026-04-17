@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

REM ============================================================================
REM  Transcriptor — One-command Setup for Windows
REM  ----------------------------------------------------------------------------
REM  Uses ``winget`` (Windows Package Manager, ships with Win 10+ / Win 11
REM  Store pre-installed) to auto-install Python 3, Node.js LTS, and ffmpeg.
REM  Then creates a Python venv, installs deps, builds the Electron app,
REM  runs the NSIS installer, and launches.
REM
REM  Usage: right-click setup.bat → "Run as administrator" OR just double-click.
REM         (winget installs don't require admin on Win 11; on Win 10 they
REM          prompt via UAC per package.)
REM ============================================================================

echo.
echo   =========================================
echo     Transcriptor -- Windows Setup
echo   =========================================
echo.

cd /d "%~dp0\..\.."
set "ROOT_DIR=%cd%"

REM ── 1. winget pre-flight ─────────────────────────────────────────────────
REM winget is bundled with Windows 10 1809+ (via the App Installer) and
REM every Win 11 install. If the user somehow disabled it or runs an
REM ancient build, we surface an actionable error.
where winget >nul 2>nul
if %errorlevel% neq 0 (
    echo   [X] winget not found. Install "App Installer" from the Microsoft Store:
    echo       ms-windows-store://pdp/?productid=9NBLGGH4NNS1
    echo.
    echo       Or update to Windows 11 / Windows 10 22H2.
    pause
    exit /b 1
)
echo   [OK] winget present

REM ── 2. Install Python 3.12 via winget ────────────────────────────────────
REM winget is idempotent: ``install -e --id Python.Python.3.12`` is a no-op
REM if Python.Python.3.12 is already present. ``--silent`` prevents GUI
REM prompts; ``--accept-source-agreements`` and ``--accept-package-agree
REM ments`` skip the interactive Y/N prompts that fail in CI-style runs.
where python >nul 2>nul
if %errorlevel% neq 0 (
    echo   [*] Installing Python 3.12 via winget...
    winget install -e --id Python.Python.3.12 --silent --accept-source-agreements --accept-package-agreements
    if !errorlevel! neq 0 (
        echo   [X] Python install failed.
        pause
        exit /b 1
    )
    REM PATH is not refreshed within the current cmd session — point to
    REM the standard winget install location for the rest of this run.
    set "PATH=%LOCALAPPDATA%\Programs\Python\Python312;%LOCALAPPDATA%\Programs\Python\Python312\Scripts;%PATH%"
)
echo   [OK] Python:
python --version
if %errorlevel% neq 0 (
    echo   [X] python reports error after install. Try closing this window and rerunning.
    pause
    exit /b 1
)

REM ── 3. Install Node.js LTS via winget ────────────────────────────────────
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo   [*] Installing Node.js LTS via winget...
    winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
    if !errorlevel! neq 0 (
        echo   [X] Node install failed.
        pause
        exit /b 1
    )
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
)
echo   [OK] Node:
node --version

REM ── 4. Install ffmpeg via winget (Gyan.FFmpeg is the canonical static build) ─
where ffmpeg >nul 2>nul
if %errorlevel% neq 0 (
    echo   [*] Installing ffmpeg via winget (Gyan.FFmpeg)...
    winget install -e --id Gyan.FFmpeg --silent --accept-source-agreements --accept-package-agreements
    if !errorlevel! neq 0 (
        echo   [!] ffmpeg install failed -- audio conversion will be limited.
        echo       You can install it manually later.
    )
)

REM ── 5. Create app-scoped venv ────────────────────────────────────────────
REM Matches the Windows userData location that Electron's
REM ``app.getPath('userData')`` resolves to on Win (=%APPDATA%\transcriptor).
REM We lowercase ``transcriptor`` to match Electron's productName-derived
REM path; setup puts venv in ``%APPDATA%\Transcriptor\.venv`` today but
REM we use lowercase here to keep symmetry with the rest of the stack.
set "DATA_DIR=%APPDATA%\transcriptor"
set "APP_VENV=%DATA_DIR%\.venv"
if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"

if exist "%APP_VENV%\Scripts\python.exe" (
    echo   [OK] Venv already present: %APP_VENV%
) else (
    echo   [*] Creating venv: %APP_VENV%
    python -m venv "%APP_VENV%"
    if !errorlevel! neq 0 (
        echo   [X] venv creation failed.
        pause
        exit /b 1
    )
)

REM ── 6. Install Python dependencies ───────────────────────────────────────
echo   [*] Upgrading pip...
"%APP_VENV%\Scripts\python.exe" -m pip install --upgrade pip --quiet

echo   [*] Installing Python dependencies from requirements.txt...
"%APP_VENV%\Scripts\pip.exe" install -r "%ROOT_DIR%\requirements.txt" --quiet
if %errorlevel% neq 0 (
    echo   [X] pip install failed. See output above.
    pause
    exit /b 1
)

"%APP_VENV%\Scripts\python.exe" -c "import fastapi, uvicorn, cryptography" 2>nul
if %errorlevel% neq 0 (
    echo   [!] Critical imports failed -- will retry at app launch.
) else (
    echo   [OK] Python packages verified
)

REM ── 7. Frontend + desktop npm deps ───────────────────────────────────────
echo   [*] Installing frontend npm deps...
cd frontend
call npm install --silent
if %errorlevel% neq 0 (
    echo   [X] frontend npm install failed.
    cd "%ROOT_DIR%"
    pause
    exit /b 1
)

echo   [*] Building frontend...
call npm run build
if %errorlevel% neq 0 (
    echo   [X] frontend build failed.
    cd "%ROOT_DIR%"
    pause
    exit /b 1
)
cd "%ROOT_DIR%"

echo   [*] Installing desktop npm deps...
cd desktop
call npm install --silent
if %errorlevel% neq 0 (
    echo   [X] desktop npm install failed.
    cd "%ROOT_DIR%"
    pause
    exit /b 1
)

REM ── 8. Build NSIS installer ──────────────────────────────────────────────
echo   [*] Building NSIS .exe installer...
if exist "dist\win-unpacked" rmdir /s /q "dist\win-unpacked" 2>nul
del /q "dist\*.exe" 2>nul

call npm run dist:win
if %errorlevel% neq 0 (
    echo   [X] NSIS build failed.
    cd "%ROOT_DIR%"
    pause
    exit /b 1
)
cd "%ROOT_DIR%"

REM ── 9. Run the NSIS installer ────────────────────────────────────────────
REM  Our ``build.nsis`` config sets ``oneClick: true`` + ``runAfterFinish:
REM  true`` so this single command installs into
REM  ``%LOCALAPPDATA%\Programs\Transcriptor``, creates Desktop + Start Menu
REM  shortcuts, and launches the app.
set "SETUP_EXE="
for %%f in ("%ROOT_DIR%\desktop\dist\Transcriptor Setup *.exe") do set "SETUP_EXE=%%f"
if "%SETUP_EXE%"=="" (
    for %%f in ("%ROOT_DIR%\desktop\dist\*.exe") do set "SETUP_EXE=%%f"
)
if "%SETUP_EXE%"=="" (
    echo   [X] Could not find Transcriptor Setup .exe in desktop\dist\
    pause
    exit /b 1
)
echo   [*] Running installer: %SETUP_EXE%
start "" "%SETUP_EXE%"

echo.
echo   =========================================
echo     Setup complete!
echo   =========================================
echo.
echo   The installer will open shortly. It will:
echo     * Install Transcriptor to %%LOCALAPPDATA%%\Programs\Transcriptor
echo     * Create Desktop and Start Menu shortcuts
echo     * Launch the app after install
echo.
echo   First-time permissions Windows will prompt for:
echo     * Microphone access
echo     * (optional) Firewall rule for localhost backend
echo.
pause
