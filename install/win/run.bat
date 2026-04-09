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

echo [*] Starting Backend via uvicorn...
set "TRANSCRIPTOR_DATA_DIR=%APPDATA%\Transcriptor"
set "PYTHONPATH=%ROOT_DIR%;%PYTHONPATH%"

:: Kill existing uvicorn on port 8321 if possible (using bare bone python if needed, or simply let it fail gracefully)
:: It's hard to reliably kill by port in bash-less Windows cleanly without external tools, 
:: so we just rely on uvicorn taking it over or user closing old console.

start "Transcriptor Backend" /b "%VENV_PY%" -m uvicorn backend.main:app --host 127.0.0.1 --port 8321 --log-level warning

echo [*] Waiting for backend to initialize...
timeout /t 3 /nobreak >nul

echo [*] Starting Electron...
cd desktop
call npm start

:: Clean up backend process bound to port 8321
for /f "tokens=5" %%a in ('netstat -aon ^| find "8321" ^| find "LISTENING"') do taskkill /F /PID %%a 2>nul

echo [*] Exiting.
