# setup-task.ps1 — registers a daily Windows Task that wakes the PC
# and runs the Flow worker automatically at 8:00 AM.
# Run ONCE in PowerShell as Administrator.

$ProjectDir = "C:\flow-studio"          # <-- change if your project is elsewhere
$BatFile    = "$ProjectDir\run-worker.bat"
$TaskName   = "FlowStudioWorker"
$RunTime    = "08:00"                     # daily run time (24h)

if (-not (Test-Path $BatFile)) {
    Write-Host "ERROR: $BatFile not found. Put run-worker.bat in $ProjectDir" -ForegroundColor Red
    exit 1
}

# Action: run the bat file
$action = New-ScheduledTaskAction -Execute $BatFile -WorkingDirectory $ProjectDir

# Trigger: daily at RunTime
$trigger = New-ScheduledTaskTrigger -Daily -At $RunTime

# Settings: wake the computer to run, run even on battery, start if missed
$settings = New-ScheduledTaskSettingsSet `
    -WakeToRun `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1)

# Run whether logged in or not
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType S4U -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName `
    -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description "Runs Flow Studio video worker daily" -Force

Write-Host ""
Write-Host "Task '$TaskName' registered. Runs daily at $RunTime and wakes the PC." -ForegroundColor Green
Write-Host "Test it now with:  Start-ScheduledTask -TaskName $TaskName" -ForegroundColor Cyan