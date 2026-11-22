[CmdletBinding()]
param(
    [string]$AircraftId = "AH-HW-001",
    [ValidateSet(30,60,120,300)]
    [int]$Seconds = 120,
    [string]$Port = "COM6",
    [pscredential]$Credential,
    [string]$ReportPath
)

$ErrorActionPreference = "Stop"
if ($AircraftId -cnotmatch '^[A-Z0-9][A-Z0-9_-]{2,31}$') { throw "Invalid aircraft ID." }
if ($Port -cnotmatch '^COM[1-9][0-9]{0,2}$') { throw "Expected a COM port." }
$origin = "http://127.0.0.1:8010"
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession

function Invoke-Station([string]$Path, [string]$Method = "Get", $Data = $null) {
    $options = @{ Uri = "$origin/api/v1/$Path"; Method = $Method; WebSession = $session; TimeoutSec = 8 }
    if ($null -ne $Data) {
        $options.ContentType = "application/json"
        $options.Body = $Data | ConvertTo-Json -Compress
    }
    Invoke-RestMethod @options
}

$access = Invoke-Station "station/session"
if ($access.required) {
    if (-not $Credential) { throw "Pass a station operator credential using -Credential (Get-Credential)." }
    $null = Invoke-Station "station/login" "Post" @{
        username = $Credential.UserName
        password = $Credential.GetNetworkCredential().Password
    }
}

$capturePath = $null
$report = $null
try {
    $portList = Invoke-Station "serial/ports"
    if ($Port -notin $portList.ports) { throw "The station host did not report $Port." }
    $before = Invoke-Station "telemetry/$AircraftId"
    if ($before.primary_transport -notin @("PRIVATE_CLOUD_WSS", "VIHANGA_CLOUD_V2") -or
        $before.backup_transport -ne "LOCAL_SERIAL_RECEIVE" -or
        $before.primary_status -ne "LIVE" -or $before.backup_status -ne "LIVE" -or
        $before.active_source -ne "PRIMARY" -or
        $before.backup_serial_port -ne $Port -or
        $null -eq $before.primary_system_id -or $before.primary_system_id -ne $before.backup_system_id) {
        throw "Start with the selected cloud primary and Server USB backup both LIVE for the same SYSID and using $Port."
    }
    $capture = Invoke-Station "bench/captures/$AircraftId" "Post" @{ duration_seconds = $Seconds }
    $capturePath = "bench/captures/$AircraftId/$($capture.capture_id)"
    Write-Host "Capture started for $AircraftId. Leave the initial state in place for at least two seconds."
    Write-Host "Interrupt the primary data path, observe it lose freshness, and manually select the live backup in Vihanga."
    Write-Host "Restore the primary data path and select it once LIVE. Hold each state at least two seconds for sampling."
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    do {
        Start-Sleep -Seconds 2
        $report = Invoke-Station $capturePath
        if ($deadline.Elapsed.TotalSeconds -gt ($Seconds + 20)) { throw "Timed out waiting for the station capture." }
    } while ($report.capture.status -eq "RECORDING")
    $phase = 0
    foreach ($sample in $report.samples) {
        if ($phase -eq 0 -and $sample.primary.status -eq "LIVE" -and $sample.backup.status -eq "LIVE" -and $sample.active_source -eq "PRIMARY") { $phase = 1 }
        elseif ($phase -eq 1 -and $sample.primary.status -ne "LIVE" -and $sample.backup.status -eq "LIVE" -and $sample.active_source -eq "PRIMARY") { $phase = 2 }
        elseif ($phase -eq 2 -and $sample.primary.status -ne "LIVE" -and $sample.backup.status -eq "LIVE" -and $sample.active_source -eq "BACKUP") { $phase = 3 }
        elseif ($phase -eq 3 -and $sample.primary.status -eq "LIVE" -and $sample.backup.status -eq "LIVE" -and $sample.active_source -eq "BACKUP") { $phase = 4 }
        elseif ($phase -eq 4 -and $sample.primary.status -eq "LIVE" -and $sample.active_source -eq "PRIMARY") { $phase = 5 }
    }
    $result = [pscustomobject]@{
        passed = $phase -eq 5 -and $report.capture.status -eq "COMPLETE"
        observed_phases = $phase
        expected_phases = 5
        serial_port = $Port
        capture = $report
    }
    if ($ReportPath) {
        $file = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ReportPath)
        $stream = [IO.File]::Open($file, [IO.FileMode]::CreateNew)
        try {
            $writer = New-Object IO.StreamWriter($stream)
            try { $writer.Write(($result | ConvertTo-Json -Depth 20)) } finally { $writer.Dispose() }
        } finally { $stream.Dispose() }
    }
    $result
    if (-not $result.passed) { throw "Bench sequence incomplete. Observed $phase of 5 required states." }
} finally {
    if ($capturePath -and (-not $report -or $report.capture.status -eq "RECORDING")) {
        try { $null = Invoke-Station "$capturePath/stop" "Post" @{} } catch {}
    }
    if ($access.required) {
        try { $null = Invoke-Station "station/logout" "Post" @{} } catch {}
    }
}
