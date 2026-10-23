# Register/reschedule the nightly one-shot crawl task at the next 00:05.
# Re-running this script with -Force moves the same task forward; the wrapper
# (run-crawl-once.js) deletes the task once the crawl fully completes.
# NOTE: this file MUST stay UTF-8 WITH BOM (PowerShell 5.1 mis-reads BOM-less UTF-8 as GBK).
$ErrorActionPreference = 'Stop'
$node = (Get-Command node).Source

$at = Get-Date -Hour 0 -Minute 5 -Second 0
if ($at -lt (Get-Date)) { $at = $at.AddDays(1) }

$action = New-ScheduledTaskAction -Execute $node -Argument '"E:\Vscode\申论批改app\tools\run-crawl-once.js"' -WorkingDirectory 'E:\Vscode\申论批改app'
$trigger = New-ScheduledTaskTrigger -Once -At $at
$settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 8)
Register-ScheduledTask -TaskName 'ShenlunCrawlNightly' -Action $action -Trigger $trigger -Settings $settings -Description 'Overnight shenlun paper crawl (65s per request, self-removing when done)' -Force | Out-Null

$t = Get-ScheduledTask -TaskName 'ShenlunCrawlNightly'
Write-Output ("registered: " + $t.TaskName + " state=" + $t.State + " at=" + ($t.Triggers | ForEach-Object { $_.StartBoundary }))
