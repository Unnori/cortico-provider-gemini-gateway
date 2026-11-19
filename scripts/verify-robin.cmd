@echo off
cd /d "%~dp0.."
set "EP=%CD%\test-endpoint"
if not exist "%EP%" mkdir "%EP%"
if not exist "%EP%\desktop-oauth.json" copy /Y "resources\desktop-oauth.example.json" "%EP%\desktop-oauth.json" >nul
if not exist "%EP%\config.json" copy /Y "resources\provider.example.json" "%EP%\config.json" >nul

if not exist "%EP%\oauth-tokens.json" (
    echo [Step 1] Starting Google OAuth login inside workspace: %EP%
    echo A browser window will open automatically for Google authorization...
    echo.
    node --experimental-strip-types "scripts\run-robin-test.ts" login "%EP%"
    echo.
)

if not exist "%EP%\oauth-tokens.json" (
    echo Login did not complete or oauth-tokens.json was not written.
    pause
    exit /b 1
)

echo [Step 2] Found oauth-tokens.json! Testing RobinService/StreamGenerate (9 * 7)...
echo.
node --experimental-strip-types "scripts\run-robin-test.ts" test "%EP%"
echo.
pause
