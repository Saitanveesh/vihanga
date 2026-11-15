# Vihanga read-only operator verification. No aircraft or cloud commands.
[CmdletBinding()]
param(
    [string]$AircraftId = "AH-HW-001",
    [string]$ApiOrigin = "http://127.0.0.1:8010",
    [switch]$RequireLive
)

$ErrorActionPreference = "Stop"
if ($ApiOrigin -notmatch '^http://(127\.0\.0\.1|localhost):8010$') {
    throw "The operator API must be the loopback development endpoint on port 8010."
}
if ($AircraftId -notmatch '^[A-Z0-9][A-Z0-9_-]{2,31}$') {
    throw "Invalid aircraft identifier."
}

Write-Host "VIHANGA / READ-ONLY OPERATOR CHECK" -ForegroundColor Cyan
Write-Host "Local API: $ApiOrigin"
$health = Invoke-RestMethod -Uri "$ApiOrigin/api/v1/health" -TimeoutSec 8
if ($health.status -ne "ok" -or $health.physical_flight_control -ne $false) {
    throw "Unexpected development API health or physical control state."
}

$clock = [System.Diagnostics.Stopwatch]::StartNew()
$overview = Invoke-RestMethod -Uri "$ApiOrigin/api/v1/fleet/telemetry" -TimeoutSec 8
$clock.Stop()
$all = @($overview.PSObject.Properties)
$entry = $overview.PSObject.Properties[$AircraftId]
if ($null -eq $entry) {
    throw "Aircraft $AircraftId is not registered. Check FLEET and its exact ID."
}

$state = $entry.Value
if ($state.flight_control_enabled -ne $false) {
    throw "Flight control was unexpectedly reported as enabled. Stop and investigate."
}
Write-Host ("Registered aircraft: {0} | API read: {1:N0} ms" -f $all.Count, $clock.Elapsed.TotalMilliseconds)
Write-Host ("Aircraft: {0} | Transport: {1} | Link: {2}" -f $AircraftId, $state.transport, $state.status)
Write-Host ("FC HEARTBEAT fresh: {0} | ATTITUDE fresh: {1}" -f $state.heartbeat_fresh, $state.attitude_fresh)
Write-Host ("Packets received: {0} | Rejected: {1} | 5s rate: {2} Hz" -f $state.frames_total, $state.rejected_frames, $state.frame_rate_5s_hz)
Write-Host ("GPS1 fix: {0} | GPS2 fix: {1} | Last packet age: {2} ms" -f $state.gps_fix_type, $state.gps2_fix_type, $state.age_ms)
Write-Host "No MAVLink commands were sent."

if ($RequireLive -and ($state.status -ne "LIVE" -or
    $state.heartbeat_fresh -ne $true -or $state.attitude_fresh -ne $true)) {
    Write-Error "Live telemetry acceptance failed: check Oracle/Pi/FC link before evaluating HUD."
    exit 2
}
Write-Host "PASS: local API and aircraft identity consistency" -ForegroundColor Green
