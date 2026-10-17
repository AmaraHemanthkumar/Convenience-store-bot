@echo off
title Convenience Store Bot
cd /d "%~dp0"
where python >nul 2>nul || (echo Python is not installed. Get it from https://www.python.org/downloads/ and tick "Add python.exe to PATH". & pause & exit /b)
if not exist ".installed" (
  echo First run: installing what the bot needs. This takes a few minutes...
  python -m pip install -r requirements.txt || (pause & exit /b)
  python -m playwright install chromium || (pause & exit /b)
  echo ok> .installed
)
python bot.py
pause
