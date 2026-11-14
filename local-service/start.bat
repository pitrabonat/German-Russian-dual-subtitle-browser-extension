@echo off
rem Starts the Mitlesen local service on http://127.0.0.1:8765
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo The service is not set up yet. Run: powershell -ExecutionPolicy Bypass -File setup.ps1
  exit /b 1
)
".venv\Scripts\python.exe" mitlesen_service.py %*
