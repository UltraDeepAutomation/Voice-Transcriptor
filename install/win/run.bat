@echo off
setlocal enabledelayedexpansion

echo =======================================================
echo  Transcriptor -- Quick Launch Windows
echo =======================================================

cd /d "%~dp0\..\.."
set "ROOT_DIR=%cd%"

set "VENV_DIR=%APPDATA%\Transcriptor\.venv"
set "VENV_PY=%VENV_DIR%\Scripts\python.exe"

if not exist "%VENV_PY%" (
    echo [X] Python virtual environment not found. Please run setup.bat first.
    pause
    exit /b 1
)

:: Export env vars so Electron's main.js picks up the venv python
:: on its first ``findSystemPython`` probe (desktop/main.js:3727) and
:: writes data to the same dir setup.bat provisioned.
::
:: We deliberately do NOT spawn our own uvicorn here. Electron's
:: main process already owns backend lifecycle end-to-end:
::
::   * ``pickBackendPort`` in desktop/main.js:3699 selects a free port
::     (default 8321, iterates if taken — so no collision with
::     whatever else might be on 8321).
::   * ``startBackend`` in desktop/main.js:3905 spawns Python with
::     ``stdio: ["pipe", ...]``; the parent-death watchdog thread in
::     backend/main.py:90-128 sees EOF on stdin when Electron dies
::     for ANY reason (SIGKILL, crash, Taskmgr "End task", BSOD
::     reboot) and calls ``os._exit(0)``. Zero orphans guaranteed.
::
:: The prior code path spawned uvicorn ourselves on hard-coded 8321,
:: then ``npm start`` Electron which spawned ANOTHER uvicorn via
:: pickBackendPort (found 8321 taken by us, fell through to 8322).
:: Result: two Python processes per launch, frontend only talked to
:: Electron's on 8322, ours on 8321 sat orphan until the taskkill
:: at the end of this script. Plus the final
:: ``netstat | find "8321" | taskkill`` killed WHATEVER was on 8321,
:: including unrelated processes.
set "TRANSCRIPTOR_DATA_DIR=%APPDATA%\Transcriptor"
set "PYTHONPATH=%ROOT_DIR%;%PYTHONPATH%"
set "PYTHON=%VENV_PY%"

echo [*] Starting Electron (backend spawned by main process)...
cd desktop
call npm start

echo [*] Exiting.
