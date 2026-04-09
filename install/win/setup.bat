@echo off
setlocal enabledelayedexpansion

echo =======================================================
echo  Transcriptor -- Windows Setup
echo =======================================================
echo.

cd /d "%~dp0\..\.."
set "ROOT_DIR=%cd%"

:: 1. Check Python
where python >nul 2>nul
if %errorlevel% neq 0 (
    echo [X] Python 3 not found in PATH. Please install from python.org.
    pause
    exit /b 1
)

:: 2. Check Node
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [X] Node.js not found in PATH. Please install from nodejs.org.
    pause
    exit /b 1
)

:: 3. Setup Venv
set "VENV_DIR=%APPDATA%\Transcriptor\.venv"
if not exist "%VENV_DIR%\Scripts\python.exe" (
    echo [*] Creating virtual environment at %VENV_DIR%...
    python -m venv "%VENV_DIR%"
)

echo [*] Installing python dependencies...
"%VENV_DIR%\Scripts\python.exe" -m pip install --upgrade pip
"%VENV_DIR%\Scripts\pip.exe" install -r "%ROOT_DIR%\requirements.txt"

:: 4. Install npm dependencies
echo [*] Installing frontend dependencies...
cd frontend
call npm install
echo [*] Building frontend...
call npm run build
cd ..

echo [*] Installing desktop dependencies...
cd desktop
call npm install
cd ..

echo.
echo =======================================================
echo  Setup Complete! 
echo  You can now run 'install\win\run.bat' for development
echo  or 'install\win\build.bat' to package the application.
echo =======================================================
pause
