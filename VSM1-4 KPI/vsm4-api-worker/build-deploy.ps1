# Deploy vsm4-api: copy หน้าแอปล่าสุดจาก repo root มา bundle แล้ว wrangler deploy
# ใช้:  powershell -File build-deploy.ps1
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Copy-Item (Join-Path $here "..\..\index.html") (Join-Path $here "index.html") -Force
Set-Location $here
npx wrangler deploy
