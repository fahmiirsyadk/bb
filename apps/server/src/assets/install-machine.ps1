[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $JoinCode,
  [Parameter(Mandatory = $true)] [string] $HostId,
  [Parameter(Mandatory = $true)] [string] $Server,
  [string] $MachineCode,
  [int] $HostDaemonPort = 0
)

$ErrorActionPreference = "Stop"

function Fail([string] $Message) {
  Write-Error $Message
  exit 1
}

function Quote-PowerShell([string] $Value) {
  return "'$(($Value -replace "'", "''"))'"
}

function Test-PortAvailable([int] $Port) {
  $listener = [System.Net.Sockets.TcpListener]::new(
    [System.Net.IPAddress]::Loopback,
    $Port
  )
  try {
    $listener.Start()
    return $true
  } catch {
    return $false
  } finally {
    $listener.Stop()
  }
}

function Get-DaemonStatus([int] $Port) {
  try {
    return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/status" -TimeoutSec 2
  } catch {
    return $null
  }
}

try {
  $serverUri = [Uri]$Server
  if ($serverUri.Scheme -notin @("https", "http") -or [string]::IsNullOrWhiteSpace($serverUri.Host)) {
    Fail "Server must be an http(s) URL."
  }
} catch {
  Fail "Could not parse the server URL."
}

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
  Fail "bb-app requires Node.js 22.19 or newer, but node.exe is not on PATH."
}
$nodeVersion = (& $nodeCommand.Source --version).Trim().TrimStart("v").Split("-")[0]
try { $parsedNodeVersion = [Version]$nodeVersion } catch { Fail "Could not read the Node.js version." }
if ($parsedNodeVersion -lt [Version]"22.19.0") {
  Fail "Node.js $nodeVersion is too old; bb-app requires Node.js 22.19 or newer."
}

$serverHost = $serverUri.Host -replace "[^A-Za-z0-9.-]", "-"
$slug = $serverHost -replace "[^A-Za-z0-9-]", "-"
$taskName = "bb-host-daemon-$slug"
$dataRoot = if ($env:BB_DATA_DIR) { $env:BB_DATA_DIR } else { Join-Path $env:LOCALAPPDATA "bb\machines\$serverHost" }
$dataRoot = [IO.Path]::GetFullPath($dataRoot)
$logRoot = Join-Path $dataRoot "logs"
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null

$portFile = Join-Path $dataRoot "host-daemon-port"
$port = 0
if ($HostDaemonPort -gt 0) {
  $port = $HostDaemonPort
} elseif (Test-Path $portFile) {
  [int]::TryParse((Get-Content $portFile -TotalCount 1), [ref]$port) | Out-Null
}
if ($port -lt 1 -or $port -gt 65535 -or (-not (Test-PortAvailable $port) -and $null -eq (Get-DaemonStatus $port))) {
  $port = 0
  for ($candidate = 38888; $candidate -le 65535; $candidate++) {
    if (Test-PortAvailable $candidate) { $port = $candidate; break }
  }
}
if ($port -eq 0) { Fail "Could not find an available local host-daemon port." }
Set-Content -Path $portFile -Value $port -Encoding ascii

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($null -eq $npmCommand) { $npmCommand = Get-Command npm -ErrorAction SilentlyContinue }
if ($null -eq $npmCommand) { Fail "bb-app installation requires npm (bundled with Node.js)." }

$packagePath = Join-Path $env:TEMP ("bb-app-{0}.tgz" -f ([Guid]::NewGuid().ToString("N")))
$packageAvailable = $false
try {
  Invoke-WebRequest -UseBasicParsing -Uri "$($Server.TrimEnd('/'))/install/bb-app.tgz" -OutFile $packagePath
  $packageAvailable = $true
} catch {
  $statusCode = $_.Exception.Response.StatusCode.value__
  if ($statusCode -ne 404) { Fail "Could not download the server bb-app package (HTTP $statusCode)." }
}
if ($packageAvailable) {
  Write-Host "Installing the server's bb-app build..."
  & $npmCommand.Source install --global $packagePath
  if ($LASTEXITCODE -ne 0) { Fail "Could not install bb-app globally for this Windows user." }
} elseif ($null -eq (Get-Command bb-app.cmd -ErrorAction SilentlyContinue)) {
  Write-Host "The server does not provide a package; installing bb-app from npm..."
  & $npmCommand.Source install --global bb-app
  if ($LASTEXITCODE -ne 0) { Fail "Could not install bb-app from npm." }
}
Remove-Item -Force -ErrorAction SilentlyContinue $packagePath

$bbCommand = Get-Command bb-app.cmd -ErrorAction SilentlyContinue
if ($null -eq $bbCommand) { $bbCommand = Get-Command bb-app -ErrorAction SilentlyContinue }
if ($null -eq $bbCommand) { Fail "bb-app was installed, but its npm bin directory is not on PATH." }
$bbApp = if ($bbCommand.Source) { $bbCommand.Source } else { $bbCommand.Path }

if ($MachineCode) {
  $labels = $serverUri.Host.Split('.')
  if ($labels.Count -lt 3) { Fail "Could not derive the bb connect domain from the server URL." }
  $connectOrigin = "$($serverUri.Scheme)://$($labels[1..($labels.Count - 1)] -join '.')"
  try {
    $redeemed = Invoke-RestMethod -Method Post -Uri "$connectOrigin/api/connect/redeem-machine" -ContentType "application/json" -Body (@{ code = $MachineCode } | ConvertTo-Json -Compress)
    if (-not $redeemed.credential -or -not $redeemed.machineId) { Fail "The bb connect machine-code response was invalid." }
    $configPath = Join-Path $dataRoot "config.json"
    $config = if (Test-Path $configPath) { Get-Content $configPath -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
    $config | Add-Member -NotePropertyName serverUrl -NotePropertyValue $Server -Force
    $config | Add-Member -NotePropertyName machineCredential -NotePropertyValue $redeemed.credential -Force
    $config | Add-Member -NotePropertyName connectMachineId -NotePropertyValue $redeemed.machineId -Force
    $configJson = $config | ConvertTo-Json -Depth 4
    [IO.File]::WriteAllText($configPath, $configJson, [Text.UTF8Encoding]::new($false))
  } catch { Fail "Could not redeem the bb connect machine code." }
}

$authPath = Join-Path $dataRoot "auth.json"
$alreadyJoined = $false
if (Test-Path $authPath) {
  try {
    $auth = Get-Content $authPath -Raw | ConvertFrom-Json
    if ($auth.hostId -eq $HostId) {
      $alreadyJoined = $true
    } else {
      Write-Host "Replacing the previous enrollment for $Server..."
      Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
      Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
          $_.ProcessId -ne $PID -and
          ([string]$_.CommandLine).Contains("host-daemon") -and
          ([string]$_.CommandLine).Contains($Server)
        } |
        ForEach-Object {
          Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
      Start-Sleep -Milliseconds 250
      Remove-Item -Force $authPath
    }
  } catch { Fail "Could not read the existing bb enrollment in $dataRoot." }
}

$joinProcess = $null
$oldDataDir = $env:BB_DATA_DIR
$env:BB_DATA_DIR = $dataRoot
if (-not $alreadyJoined) {
  $joinLog = Join-Path $dataRoot "install-join.log"
  $joinErrorLog = Join-Path $dataRoot "install-join-error.log"
  Write-Host "Joining $Server as $HostId..."
  $joinArgs = @("host-daemon", "join", "--auto-update", "--host-daemon-port", "$port", "--join-code", $JoinCode, "--host-id", $HostId, "--server-url", $Server)
  $joinProcess = Start-Process -FilePath $bbApp -ArgumentList $joinArgs -WorkingDirectory $dataRoot -RedirectStandardOutput $joinLog -RedirectStandardError $joinErrorLog -PassThru -WindowStyle Hidden
  $connected = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Seconds 1
    $status = Get-DaemonStatus $port
    if ($status -and $status.hostId -eq $HostId -and $status.connected -eq $true) { $connected = $true; break }
    if ($joinProcess.HasExited) { break }
  }
  if (-not $connected) {
    if (-not $joinProcess.HasExited) { $joinProcess.Kill() }
    Fail "Timed out waiting for the host daemon to connect. See $joinLog."
  }
  Write-Host "Joined successfully."
}
if ($joinProcess -and -not $joinProcess.HasExited) { $joinProcess.Kill() }
if ($null -eq $oldDataDir) { Remove-Item Env:BB_DATA_DIR -ErrorAction SilentlyContinue } else { $env:BB_DATA_DIR = $oldDataDir }

$runnerPath = Join-Path $dataRoot "run-host-daemon.ps1"
$runner = @"
`$env:BB_DATA_DIR = $(Quote-PowerShell $dataRoot)
& $(Quote-PowerShell $bbApp) host-daemon --auto-update --host-daemon-port $port --server-url $(Quote-PowerShell $Server)
"@
Set-Content -Path $runnerPath -Value $runner -Encoding utf8
$taskAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File $(Quote-PowerShell $runnerPath)"
$taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$taskSettings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host "Installed per-user scheduled task: $taskName"
Write-Host "Host daemon local API: http://127.0.0.1:$port"
Write-Host "Uninstall: Stop-ScheduledTask -TaskName '$taskName' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false -ErrorAction SilentlyContinue; Remove-Item -Recurse -Force $(Quote-PowerShell $dataRoot)"
