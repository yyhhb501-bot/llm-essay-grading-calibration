$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$sharedFile = Join-Path $projectDir '.runtime\shared-model.json'
$logDir = Join-Path $projectDir 'output\playwright'
$sshExecutable = (Get-Command ssh).Source
$nodeExecutable = (Get-Command node).Source
if (-not (Test-Path -LiteralPath $sharedFile)) { throw '请先在本机设置页启用官方共享模型。' }
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$listener = Get-NetTCPConnection -State Listen -LocalPort 8788 -ErrorAction SilentlyContinue
if (-not $listener) {
  $env:PORT = '8788'
  $env:HOST = '127.0.0.1'
  Start-Process -FilePath $nodeExecutable -ArgumentList 'site-server.js' -WorkingDirectory $projectDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'site-server.log') -RedirectStandardError (Join-Path $logDir 'site-server-error.log')
}
$shareLog = Join-Path $logDir ('share-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
Start-Process -FilePath $sshExecutable -ArgumentList @('-T','-o','StrictHostKeyChecking=accept-new','-o','ServerAliveInterval=30','-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=20','-R','80:127.0.0.1:8788','nokey@localhost.run') -WindowStyle Hidden -RedirectStandardOutput $shareLog -RedirectStandardError ($shareLog + '.error')
Write-Output '正在创建手机测试链接…'
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  Start-Sleep -Seconds 2
  $log = Get-Content -LiteralPath $shareLog -Raw -ErrorAction SilentlyContinue
  $shareUrls = [regex]::Matches([string]$log, 'https://[a-zA-Z0-9.-]+\.lhr\.life')
  if ($shareUrls.Count -gt 0) {
    Write-Output ('测试网址：' + $shareUrls[$shareUrls.Count - 1].Value)
    $shared = Get-Content -LiteralPath $sharedFile -Raw | ConvertFrom-Json
    Write-Output ('测试口令：' + $shared.accessCode)
    Write-Output '测试期间请保持电脑开机、联网。临时网址可能到期，届时重新运行此脚本。'
    exit 0
  }
}
Write-Output ('暂未获得网址，请检查日志：' + $shareLog + '.error')
exit 1
