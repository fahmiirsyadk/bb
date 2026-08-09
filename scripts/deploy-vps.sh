#!/usr/bin/env bash
set -Eeuo pipefail

action=deploy
host_name=""
user_name=ubuntu
ssh_port=22
install_dir=/opt/bb
data_dir=/var/lib/bb
app_url=http://127.0.0.1:38886
local_port=38886
remote_port=38886

usage() {
  cat <<'EOF'
Usage:
  scripts/deploy-vps.sh --host <host> [options]
  scripts/deploy-vps.sh status --host <host> [options]
  scripts/deploy-vps.sh tunnel --host <host> [options]

Options:
  --user <user>          SSH user (default: ubuntu)
  --port <port>          SSH port (default: 22)
  --install-dir <path>   Release root on the VPS (default: /opt/bb)
  --data-dir <path>      Persistent data directory (default: /var/lib/bb)
  --app-url <url>        Browser-facing app URL
  --local-port <port>    Local tunnel port (default: 38886)
  --remote-port <port>   Remote tunnel port (default: 38886)

Deploy builds a self-contained Linux artifact locally. The VPS does not run
pnpm, install npm dependencies, clone the repository, or build application code.
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command '$1' was not found"
}

shell_quote() {
  printf "'%s'" "${1//\'/\'\"\'\"\'}"
}

if [[ ${1:-} == deploy || ${1:-} == status || ${1:-} == tunnel ]]; then
  action=$1
  shift
fi

while (($# > 0)); do
  case "$1" in
    --host) host_name=${2:?missing value for --host}; shift 2 ;;
    --user) user_name=${2:?missing value for --user}; shift 2 ;;
    --port) ssh_port=${2:?missing value for --port}; shift 2 ;;
    --install-dir) install_dir=${2:?missing value for --install-dir}; shift 2 ;;
    --data-dir) data_dir=${2:?missing value for --data-dir}; shift 2 ;;
    --app-url) app_url=${2:?missing value for --app-url}; shift 2 ;;
    --local-port) local_port=${2:?missing value for --local-port}; shift 2 ;;
    --remote-port) remote_port=${2:?missing value for --remote-port}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n $host_name ]] || die "--host is required"
[[ $ssh_port =~ ^[0-9]+$ ]] || die "--port must be numeric"
[[ $local_port =~ ^[0-9]+$ ]] || die "--local-port must be numeric"
[[ $remote_port =~ ^[0-9]+$ ]] || die "--remote-port must be numeric"
[[ $install_dir =~ ^/[A-Za-z0-9._/-]+$ ]] || die "--install-dir must be a simple absolute path"
[[ $data_dir =~ ^/[A-Za-z0-9._/-]+$ ]] || die "--data-dir must be a simple absolute path"
[[ $app_url != *$'\n'* && $app_url != *$'\r'* ]] || die "--app-url cannot contain newlines"

require_command ssh
remote="$user_name@$host_name"
ssh_options=(-o StrictHostKeyChecking=accept-new -p "$ssh_port")

case "$action" in
  status)
    exec ssh "${ssh_options[@]}" "$remote" 'sudo systemctl status bb.service --no-pager'
    ;;
  tunnel)
    printf 'Opening http://127.0.0.1:%s -> VPS 127.0.0.1:%s. Press Ctrl+C to close it.\n' "$local_port" "$remote_port"
    exec ssh "${ssh_options[@]}" -N -L "$local_port:127.0.0.1:$remote_port" "$remote"
    ;;
esac

require_command git
require_command node
require_command npm
require_command pnpm
require_command scp
require_command tar

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

[[ $(node -p 'process.platform') == linux ]] || die "deployment artifacts must be built on Linux (WSL is supported)"
[[ $(node -p 'process.arch') == x64 ]] || die "this deployer currently targets Linux x64 VPS hosts"

node_major=$(node -p 'process.versions.node.split(".")[0]')
node_abi=$(node -p 'process.versions.modules')
revision=$(git rev-parse --short=12 HEAD)
release_id="${revision}-$(date -u +%Y%m%d%H%M%S)"
if [[ -n $(git status --porcelain) ]]; then
  release_id="${release_id}-dirty"
  printf 'warning: the artifact includes local uncommitted changes\n' >&2
fi

work_dir=$(mktemp -d)
remote_archive="/tmp/bb-release-${release_id}.tar.gz"
remote_script="/tmp/bb-activate-${release_id}.sh"
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

printf '[deploy] Building production package locally.\n'
NODE_ENV=production pnpm exec turbo run build \
  --filter=@bb/scripts \
  --filter=@bb/app \
  --filter=@bb/server \
  --filter=@bb/host-daemon \
  --filter=@bb/cli \
  --filter=bb-app

printf '[deploy] Packing bb-app and installing production dependencies locally.\n'
pack_json=$(npm pack ./packages/bb-app --pack-destination "$work_dir" --cache "$work_dir/npm-cache" --json)
tarball_name=$(node -e 'const fs=require("node:fs"); const rows=JSON.parse(fs.readFileSync(0,"utf8")); if(rows.length!==1) process.exit(1); process.stdout.write(rows[0].filename)' <<<"$pack_json")
staging_dir="$work_dir/staging"
mkdir -p "$staging_dir"
npm install --prefix "$staging_dir" --omit=dev --no-audit --no-fund --cache "$work_dir/npm-cache" "$work_dir/$tarball_name"

printf '[deploy] Verifying Linux native dependencies.\n'
node --input-type=module --eval '
  import { createRequire } from "node:module";
  import { resolve } from "node:path";
  const require = createRequire(resolve(process.argv[1], "node_modules/bb-app/package.json"));
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  db.close();
  require("node-pty");
  require("@parcel/watcher");
' "$staging_dir"

cat >"$staging_dir/bb-release.json" <<EOF
{"revision":"$revision","releaseId":"$release_id","nodeMajor":$node_major,"nodeAbi":$node_abi,"platform":"linux","arch":"x64"}
EOF
archive="$work_dir/bb-release-${release_id}.tar.gz"
tar -C "$staging_dir" -czf "$archive" .

cat >"$work_dir/activate.sh" <<'REMOTE_SCRIPT'
#!/usr/bin/env bash
set -Eeuo pipefail

archive=$1
install_dir=$2
data_dir=$3
app_url=$4
release_id=$5
node_major=$6
node_abi=$7
app_user=bb
service_name=bb
release_dir="$install_dir/releases/$release_id"
current_link="$install_dir/current"

log() {
  printf '[%s] [deploy] %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$*"
}

node_is_compatible() {
  command -v node >/dev/null 2>&1 &&
    [[ $(node -p 'process.platform') == linux ]] &&
    [[ $(node -p 'process.arch') == x64 ]] &&
    [[ $(node -p 'process.versions.node.split(".")[0]') == "$node_major" ]] &&
    [[ $(node -p 'process.versions.modules') == "$node_abi" ]]
}

if ! node_is_compatible; then
  log "Installing Node.js $node_major to match the uploaded artifact."
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl
  curl -fsSL "https://deb.nodesource.com/setup_${node_major}.x" | bash -
  DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades nodejs
fi
node_is_compatible || {
  echo "VPS Node runtime is incompatible with artifact ABI $node_abi" >&2
  exit 1
}

if ! id -u "$app_user" >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/bash "$app_user"
fi

install -d -o "$app_user" -g "$app_user" "$install_dir/releases" "$data_dir" /etc/bb
[[ ! -e $release_dir ]] || {
  echo "Release already exists: $release_dir" >&2
  exit 1
}

log "Extracting uploaded release $release_id."
mkdir "$release_dir"
tar -xzf "$archive" -C "$release_dir"
chown -R "$app_user:$app_user" "$release_dir" "$data_dir"

node "$release_dir/node_modules/bb-app/dist/bb-app.js" --help >/dev/null
previous_target=$(readlink "$current_link" 2>/dev/null || true)
ln -sfn "$release_dir" "$current_link"

cat >/etc/bb/bb.env <<EOF
NODE_ENV=production
BB_DATA_DIR=$data_dir
BB_APP_URL=$app_url
BB_SERVER_BIND_HOST=127.0.0.1
BB_SERVER_PORT=38886
EOF
chown root:"$app_user" /etc/bb/bb.env
chmod 640 /etc/bb/bb.env

cat >/etc/systemd/system/$service_name.service <<EOF
[Unit]
Description=bb server and host daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$app_user
Group=$app_user
WorkingDirectory=$current_link
EnvironmentFile=/etc/bb/bb.env
ExecStart=$(command -v node) $current_link/node_modules/bb-app/dist/bb-app.js
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$service_name.service"
systemctl restart "$service_name.service"

healthy=0
for attempt in $(seq 1 60); do
  if systemctl is-active --quiet "$service_name.service" && node -e 'fetch("http://127.0.0.1:38886/health").then(response => process.exit(response.ok ? 0 : 1), () => process.exit(1))'; then
    healthy=1
    break
  fi
  sleep 1
done

if [[ $healthy != 1 ]]; then
  echo "bb did not become healthy; rolling back activation" >&2
  systemctl status "$service_name.service" --no-pager || true
  journalctl -u "$service_name.service" -n 100 --no-pager || true
  if [[ -n $previous_target ]]; then
    ln -sfn "$previous_target" "$current_link"
    systemctl restart "$service_name.service" || true
  else
    systemctl stop "$service_name.service" || true
  fi
  exit 1
fi

rm -f "$archive"
log "Deployment complete: $release_id"
echo "Service: $(systemctl is-active "$service_name.service")"
echo "Logs: journalctl -u $service_name -f"
REMOTE_SCRIPT

printf '[deploy] Uploading release artifact to %s.\n' "$remote"
scp -o StrictHostKeyChecking=accept-new -P "$ssh_port" "$archive" "$remote:$remote_archive"
scp -o StrictHostKeyChecking=accept-new -P "$ssh_port" "$work_dir/activate.sh" "$remote:$remote_script"

remote_command="sudo bash $(shell_quote "$remote_script") $(shell_quote "$remote_archive") $(shell_quote "$install_dir") $(shell_quote "$data_dir") $(shell_quote "$app_url") $(shell_quote "$release_id") $(shell_quote "$node_major") $(shell_quote "$node_abi"); rc=\$?; rm -f $(shell_quote "$remote_script"); exit \$rc"
printf '[deploy] Activating release on the VPS.\n'
ssh "${ssh_options[@]}" "$remote" "$remote_command"

printf '\nOpen a second WSL terminal and run:\n'
printf '  scripts/deploy-vps.sh tunnel --host %q --user %q\n' "$host_name" "$user_name"
printf 'Then open http://127.0.0.1:%s in your browser.\n' "$local_port"
