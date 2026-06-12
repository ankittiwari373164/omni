@echo off
:: ================================================================
:: run-worker.bat — runs the Flow worker once on your PC
:: A real Chrome window opens, generates videos, uploads, exits.
:: Uses your home residential IP + real browser → no flagging.
:: ================================================================
cd /d "%~dp0"

echo [%date% %time%] Worker starting >> worker.log

:: Pull latest code (optional — comment out if not using git locally)
:: git pull

:: Run the worker (browser path — GEMINI/CAPTCHA keys must NOT be set in .env)
node worker.js >> worker.log 2>&1

echo [%date% %time%] Worker finished (exit %errorlevel%) >> worker.log