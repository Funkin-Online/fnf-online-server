@echo off
REM Starts the FNF Online server locally on http://localhost:8080
cd /d "%~dp0server"
node server.js
pause
