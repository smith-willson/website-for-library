@echo off
cd /d "C:\Users\%USERNAME%\lms"
echo Starting LMS at http://localhost:3000
node server.js
pause