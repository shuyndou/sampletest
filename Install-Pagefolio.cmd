@echo off
setlocal
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0Install-Pagefolio.ps1"
if errorlevel 1 (
    echo.
    echo Setup failed. See the message above.
    pause
    exit /b 1
)
