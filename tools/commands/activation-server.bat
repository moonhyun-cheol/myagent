@echo off
setlocal
for %%I in ("%~dp0..\..") do set "ROOT=%%~fI"
cd /d "%ROOT%"
echo MY Agent Activation Server (port 10201)
node tools\activation-server.mjs
pause
