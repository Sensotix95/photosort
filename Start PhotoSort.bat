@echo off
echo Starting PhotoSort...

:: Try node from PATH first, fall back to default install location
where node >nul 2>&1
if %errorlevel% == 0 (
    set NODE=node
) else (
    set NODE="C:\Program Files\nodejs\node.exe"
)

:: 1. Start the Node server
start "PhotoSort Server" cmd /k "cd /d "%~dp0" && %NODE% server/index.js"

:: 2. Start Stripe webhook forwarder (forwards Stripe events to localhost)
::    First run will ask you to log in with your Stripe account — do it once.
start "Stripe Webhooks" cmd /k "stripe listen --forward-to localhost:3000/api/auth/webhook"

:: 3. Wait for server to start, then open browser
timeout /t 3 /nobreak >nul
start "" "http://localhost:3000"
