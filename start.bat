@echo off
cd /d "%~dp0"
echo Starting LMS at http://localhost:3000
node server.js
pause
