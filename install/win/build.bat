@echo off
echo =======================================================
echo  Transcriptor -- Windows Build
echo =======================================================

cd /d "%~dp0\..\.."

echo [*] Building frontend and electron app for Windows...
cd desktop
call npm run dist:win

echo.
echo [*] Build Complete! Check desktop\dist for the .exe installer.
pause
