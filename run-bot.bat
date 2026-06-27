rem @echo off
cd /d "%~dp0"

:loop
echo ----- Starting bot at %DATE% %TIME% ----- >> bot.log
node scripts\timer-script.js >> bot.log 2>&1
echo ----- Bot exited (code %ERRORLEVEL%) at %DATE% %TIME% ----- >> bot.log
timeout /t 5 /nobreak > nul
goto loop