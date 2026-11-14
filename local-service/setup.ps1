# One-time setup of the Mitlesen local service (Windows PowerShell).
# Creates a virtual environment next to this script, installs the three Python packages,
# the German spaCy model and the OPUS-MT translation model (242 MB, checked by SHA-256).
#
#   powershell -ExecutionPolicy Bypass -File setup.ps1
#
# This file is ASCII on purpose: Windows PowerShell 5.1 reads scripts without a BOM as ANSI.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$venv = Join-Path $here '.venv'
$py = Join-Path $venv 'Scripts\python.exe'

if (-not (Test-Path $py)) {
    Write-Host 'Creating virtual environment...'
    python -m venv $venv
}
& $py -m pip install --disable-pip-version-check --only-binary=:all: -r (Join-Path $here 'requirements.txt')
& $py -m spacy download de_core_news_md
& $py (Join-Path $here 'mitlesen_service.py') --download
Write-Host ''
Write-Host 'Done. Start the service with: start.bat'
