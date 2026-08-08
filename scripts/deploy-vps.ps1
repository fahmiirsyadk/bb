[CmdletBinding()]
param(
    [ValidateSet("Deploy", "Status", "Tunnel")]
    [string]$Action = "Deploy",
    [string]$HostName,
    [string]$UserName,
    [int]$Port = 22,
    [string]$Branch,
    [string]$RepositoryUrl,
    [string]$InstallDir = "/opt/bb",
    [string]$DataDir = "/var/lib/bb",
    [string]$AppUrl,
    [int]$LocalPort = 38886,
    [int]$RemotePort = 38886
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-Command {
    param([Parameter(Mandatory)][string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found in PATH."
    }
}

function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]$Command,
        [Parameter(Mandatory)][string[]]$Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE."
    }
}

function ConvertTo-BashLiteral {
    param([Parameter(Mandatory)][string]$Value)

    if ($Value.Contains("`n") -or $Value.Contains("`r")) {
        throw "Values passed to the VPS cannot contain newlines."
    }

    $replacement = "'" + '"' + "'" + '"' + "'"
    return "'" + $Value.Replace("'", $replacement) + "'"
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Assert-Command "git"
Assert-Command "ssh"
Assert-Command "scp"

if ([string]::IsNullOrWhiteSpace($HostName)) {
    $HostName = Read-Host "VPS IP address or hostname"
}

if ([string]::IsNullOrWhiteSpace($HostName)) {
    throw "A VPS IP address or hostname is required."
}

if ([string]::IsNullOrWhiteSpace($UserName)) {
    $UserName = Read-Host "VPS username [ubuntu]"
    if ([string]::IsNullOrWhiteSpace($UserName)) {
        $UserName = "ubuntu"
    }
}

if ([string]::IsNullOrWhiteSpace($Branch)) {
    $Branch = (& git -C $repoRoot branch --show-current).Trim()
    if ([string]::IsNullOrWhiteSpace($Branch)) {
        throw "The current checkout is detached; pass -Branch explicitly."
    }
}

if ([string]::IsNullOrWhiteSpace($RepositoryUrl)) {
    $RepositoryUrl = (& git -C $repoRoot remote get-url origin).Trim()
}

if ([string]::IsNullOrWhiteSpace($RepositoryUrl)) {
    throw "Could not determine the origin repository URL. Pass -RepositoryUrl explicitly."
}

if ($RepositoryUrl -match "(?i)github\.com[/:]get-bb/bb(?:\.git)?$") {
    throw "Refusing to deploy the upstream get-bb/bb repository. Use your fork URL instead."
}

$remote = "$UserName@$HostName"
$sshOptions = @(
    "-o", "StrictHostKeyChecking=accept-new",
    "-p", $Port.ToString()
)

Write-Host "Target: $remote"
Write-Host "Repository: $RepositoryUrl"
Write-Host "Branch: $Branch"
Write-Host "Password entry is handled by OpenSSH and is never stored by this script."

if ($Action -eq "Status") {
    Invoke-Native "ssh" ($sshOptions + @($remote, "sudo systemctl status bb.service --no-pager"))
    exit 0
}

if ($Action -eq "Tunnel") {
    Write-Host "Opening http://127.0.0.1:$LocalPort -> VPS 127.0.0.1:$RemotePort. Press Ctrl+C to close it."
    Invoke-Native "ssh" ($sshOptions + @(
        "-N",
        "-L", "$LocalPort`:127.0.0.1`:$RemotePort",
        $remote
    ))
    exit 0
}

$dirty = (& git -C $repoRoot status --porcelain)
if (-not [string]::IsNullOrWhiteSpace(($dirty -join "`n"))) {
    Write-Warning "The local checkout has uncommitted changes. The VPS will clone origin/$Branch and will not receive those changes."
}

if ([string]::IsNullOrWhiteSpace($AppUrl)) {
    $AppUrl = Read-Host "BB_APP_URL [http://127.0.0.1:38886]"
    if ([string]::IsNullOrWhiteSpace($AppUrl)) {
        $AppUrl = "http://127.0.0.1:38886"
    }
}

$remoteScript = @'
#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL=__REPO_URL__
BRANCH=__BRANCH__
INSTALL_DIR=__INSTALL_DIR__
DATA_DIR=__DATA_DIR__
APP_URL=__APP_URL__
APP_USER=bb
SERVICE_NAME=bb

sudo -v
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates \
  curl \
  git \
  build-essential \
  python3

node_is_supported() {
  node -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    const supported = (major === 22 && minor >= 19) || major === 24 || major >= 26;
    process.exit(supported ? 0 : 1);
  '
}

if ! command -v node >/dev/null 2>&1 || ! node_is_supported; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi

sudo npm install --global pnpm@9.15.0
PNPM_BIN="$(command -v pnpm)"

if ! id -u "$APP_USER" >/dev/null 2>&1; then
  sudo useradd --system --create-home --shell /bin/bash "$APP_USER"
fi

if [ -e "$INSTALL_DIR" ] && [ ! -d "$INSTALL_DIR/.git" ] && [ -n "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
  echo "Refusing to use non-empty non-git path: $INSTALL_DIR" >&2
  exit 1
fi

sudo install -d -o "$APP_USER" -g "$APP_USER" "$INSTALL_DIR"

if [ ! -d "$INSTALL_DIR/.git" ]; then
  sudo -u "$APP_USER" git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
else
  sudo -u "$APP_USER" git -C "$INSTALL_DIR" remote set-url origin "$REPO_URL"
  sudo -u "$APP_USER" git -C "$INSTALL_DIR" fetch --prune origin
  sudo -u "$APP_USER" git -C "$INSTALL_DIR" checkout "$BRANCH"
  sudo -u "$APP_USER" git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
fi

sudo chown -R "$APP_USER:$APP_USER" "$INSTALL_DIR"
sudo -u "$APP_USER" env HOME="/home/$APP_USER" bash -s -- "$INSTALL_DIR" "$PNPM_BIN" <<'BB_INSTALL'
set -Eeuo pipefail
cd "$1"
rm -rf node_modules
"$2" install --frozen-lockfile \
  --filter "." \
  --filter "bb-app..." \
  --filter "...@bb/scripts" \
  --filter "...@bb/plugin-sdk" \
  --filter "...@bb/app" \
  --filter "...@bb/server" \
  --filter "...@bb/host-daemon" \
  --filter "...{./plugins/**}"
BB_INSTALL

sudo mkdir -p "$DATA_DIR" /etc/bb
sudo chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
sudo tee /etc/bb/bb.env >/dev/null <<BB_ENV
NODE_ENV=production
BB_DATA_DIR=$DATA_DIR
BB_APP_URL=$APP_URL
BB_SERVER_BIND_HOST=127.0.0.1
BB_SERVER_PORT=38886
BB_BUILD_CONCURRENCY=1
BB_ENV
sudo chown root:"$APP_USER" /etc/bb/bb.env
sudo chmod 640 /etc/bb/bb.env

sudo tee /etc/systemd/system/$SERVICE_NAME.service >/dev/null <<BB_SERVICE
[Unit]
Description=bb server and host daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=/etc/bb/bb.env
ExecStart=$PNPM_BIN start
Restart=always
RestartSec=5
LimitNOFILE=65536
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
BB_SERVICE

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME.service"
sudo systemctl restart "$SERVICE_NAME.service"

healthy=0
for attempt in $(seq 1 300); do
  if sudo systemctl is-active --quiet "$SERVICE_NAME.service" && curl --fail --silent http://127.0.0.1:38886/health >/dev/null; then
    healthy=1
    break
  fi
  sleep 1
done

if [ "$healthy" -ne 1 ]; then
  echo "bb did not become healthy on http://127.0.0.1:38886/health" >&2
  sudo systemctl status "$SERVICE_NAME.service" --no-pager || true
  sudo journalctl -u "$SERVICE_NAME.service" -n 100 --no-pager || true
  exit 1
fi

echo "Deployment complete."
echo "Revision: $(sudo -u "$APP_USER" git -C "$INSTALL_DIR" rev-parse --short HEAD)"
echo "Service: $(sudo systemctl is-active "$SERVICE_NAME.service")"
echo "Logs: journalctl -u $SERVICE_NAME -f"
echo "SSH tunnel: ssh -N -L 38886:127.0.0.1:38886 $USER_PLACEHOLDER"
'@

$remoteScript = $remoteScript.Replace("__REPO_URL__", (ConvertTo-BashLiteral $RepositoryUrl))
$remoteScript = $remoteScript.Replace("__BRANCH__", (ConvertTo-BashLiteral $Branch))
$remoteScript = $remoteScript.Replace("__INSTALL_DIR__", (ConvertTo-BashLiteral $InstallDir))
$remoteScript = $remoteScript.Replace("__DATA_DIR__", (ConvertTo-BashLiteral $DataDir))
$remoteScript = $remoteScript.Replace("__APP_URL__", (ConvertTo-BashLiteral $AppUrl))
$remoteScript = $remoteScript.Replace('$USER_PLACEHOLDER', $remote)

$tempScript = Join-Path ([System.IO.Path]::GetTempPath()) ("bb-deploy-{0}.sh" -f ([Guid]::NewGuid().ToString("N")))
$remoteScriptName = "bb-deploy-$([Guid]::NewGuid().ToString('N')).sh"
$remoteTempPath = "/tmp/$remoteScriptName"

try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($tempScript, $remoteScript, $utf8NoBom)

    Write-Host "Uploading deployment script. OpenSSH may prompt for the password now."
    Invoke-Native "scp" (@(
        "-o", "StrictHostKeyChecking=accept-new",
        "-P", $Port.ToString(),
        $tempScript,
        ("{0}:{1}" -f $remote, $remoteTempPath)
    ))

    Write-Host "Running deployment on the VPS. OpenSSH may prompt again if it did not reuse the session."
    $remoteCommand = "sudo bash '$remoteTempPath'; rc=`$?; rm -f '$remoteTempPath'; exit `$rc"
    Invoke-Native "ssh" ($sshOptions + @($remote, $remoteCommand))
}
finally {
    Remove-Item -LiteralPath $tempScript -Force -ErrorAction SilentlyContinue
}

Write-Host "Open a second terminal and run:"
Write-Host "  .\scripts\deploy-vps.ps1 -Action Tunnel -HostName $HostName -UserName $UserName"
Write-Host "Then open http://127.0.0.1:$LocalPort in your browser."
