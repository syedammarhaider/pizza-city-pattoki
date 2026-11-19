@echo off
title Pizza City POS - Keep this window open
cd /d "%~dp0"
color 0A

echo.
echo  =====================================================
echo   PIZZA CITY POS
echo   Software by Ammar ^| 03214499478
echo  =====================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    color 0C
    echo  ERROR: Node.js is not installed.
    echo  Download LTS from https://nodejs.org
    pause
    exit /b 1
)

netstat -an 2>nul | findstr ":3000 " | findstr "LISTENING" >nul
if not errorlevel 1 (
    echo  Server already running. Opening browser...
    start "" "http://localhost:3000"
    pause
    exit /b 0
)

echo  Starting server...
echo  DO NOT close this window while working.
echo.

start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"
node server.js

echo.
echo  Server stopped. All data is saved permanently.
pause >nul
