# Read-only Vihanga Pixhawk USB bench query. Does not issue flight commands.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)]
  [ValidateSet("FC_VERSION","STATUS","GPS","GPS2","EKF","RC","BATTERY",
    "HOME","EXTENDED_STATE","PARAMETER_LIST","PARAMETER_READ","MISSION_SUMMARY")]
  [string]$Query,
  [string]$AircraftId = "AH-HW-001",
  [string]$ParameterName = "GPS_TYPE",
  [switch]$PropellersRemoved
)

$ErrorActionPreference = "Stop"
if (-not $PropellersRemoved) {
  throw "Propeller-free bench confirmation required. Physically remove every propeller before continuing."
}
if ($AircraftId -notmatch '^[A-Z0-9][A-Z0-9_-]{2,31}$') {
  throw "Invalid aircraft identifier."
}
if ($Query -eq "PARAMETER_READ" -and $ParameterName -notmatch '^[A-Za-z][A-Za-z0-9_]{0,15}$') {
  throw "Invalid parameter name."
}

$api = "http://127.0.0.1:8010"
$id = [uri]::EscapeDataString($AircraftId)
$catalog = Invoke-RestMethod -Uri "$api/api/v1/operator/$id/catalog" -TimeoutSec 6
if ($catalog.physical_flight_control_enabled -ne $false -or
    $catalog.cloud_command_dispatch_enabled -ne $false) {
  throw "Unexpected command authority state. Stop and investigate."
}
if ($catalog.read_only_bench_enabled -ne $true) {
  throw "Bench read not ready. Enable VIHANGA_BENCH_READ_REQUESTS=1 before startup, connect the local USB serial receiver and confirm a fresh DISARMED FC heartbeat."
}
$entry = @($catalog.operations | Where-Object { $_.bench_query -eq $Query -and $_.enabled -eq $true })
if ($entry.Count -ne 1) {
  throw "Requested non-actuating query is not available for this aircraft."
}

$body = @{ query = $Query }
if ($Query -eq "PARAMETER_READ") { $body.parameter = $ParameterName.ToUpperInvariant() }
$json = $body | ConvertTo-Json -Compress
$headers = @{ "X-Vihanga-Bench-Read" = "confirm-non-actuating-request" }
$result = Invoke-RestMethod -Uri "$api/api/v1/operator/$id/bench-query" -Method POST -Headers $headers -ContentType "application/json" -Body $json -TimeoutSec 8
if ($result.result -ne "SERIAL_WRITE_COMPLETED" -or $result.fc_acknowledged -ne $false) {
  throw "Unexpected result. Never infer FC acknowledgement from serial write."
}
Write-Host "USB request written; actual FC response not yet verified." -ForegroundColor Cyan
$result | Select-Object vehicle_id,query,result,bytes_written,fc_acknowledged

if ($Query -in @("PARAMETER_LIST","PARAMETER_READ")) {
  Start-Sleep -Seconds 2
  $readback = Invoke-RestMethod -Uri "$api/api/v1/operator/$id/parameters" -TimeoutSec 8
  Write-Host "Observed $($readback.received) FC parameters; reported total: $($readback.reported_total)"
  if ($Query -eq "PARAMETER_READ") {
    $item = $readback.items.PSObject.Properties[$ParameterName.ToUpperInvariant()]
    if ($null -eq $item) {
      Write-Warning "No confirmed FC PARAM_VALUE response yet."
    } else {
      Write-Host ("{0}: {1}" -f $item.Name,$item.Value.value)
    }
  }
}
