#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077
mode=${1:---plan}
[[ $mode == --plan || $mode == --install || $mode == --connect ]] || exit 2
# shellcheck disable=SC1091
. /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 && $(dpkg --print-architecture) == amd64 &&
   $(systemd-detect-virt) == microsoft && $(hostnamectl --static) == agentes-lab ]] || exit 2
version=2026.10.7
expected=70b1a1e0f46033ffc8d90b406e554044ba6cbf2e4360295ef1163aed31e09393
unit=/etc/systemd/system/vps-dell-cloudflared.service
receipt=/var/lib/vps-dell-local-connector
if [[ $mode == --plan ]]; then
    printf 'mode=plan\nversion=%s\nmetrics=127.0.0.1:49312\norigin=http://127.0.0.1:9090\n' "$version"
    exit
fi
[[ ${2:-} == --apply && $EUID == 0 && ${SOURCE_COMMIT:-} =~ ^[0-9a-f]{40}$ &&
   ${EXPECTED_MACHINE_ID:-} =~ ^[0-9a-f]{32}$ && $(cat /etc/machine-id) == "$EXPECTED_MACHINE_ID" &&
   ${EXPECTED_SCRIPT_SHA256:-} =~ ^[0-9a-f]{64}$ && $(sha256sum "$0" | cut -d' ' -f1) == "$EXPECTED_SCRIPT_SHA256" ]] || exit 2
if [[ $mode == --install ]]; then
    for obj in /usr/bin/cloudflared /usr/local/bin/cloudflared /usr/local/etc/cloudflared /etc/cloudflared /etc/systemd/system/cloudflared.service "$unit" "$receipt"; do
        [[ ! -e $obj && ! -L $obj ]] || { echo 'Connector object already exists' >&2; exit 2; }
    done
    ! command -v cloudflared >/dev/null || exit 2
    mkdir -m 700 "$receipt"
    printf 'source=%s\nscript_sha256=%s\n' "$SOURCE_COMMIT" "$EXPECTED_SCRIPT_SHA256" > "$receipt/01-intent"
    pkg=$receipt/cloudflared-linux-amd64.deb
    curl -fsSL --proto '=https' --proto-redir '=https' --max-time 300 --max-filesize 19925068 \
      "https://github.com/cloudflare/cloudflared/releases/download/$version/cloudflared-linux-amd64.deb" -o "$pkg"
    [[ $(stat -c %s "$pkg") == 19925068 && $(sha256sum "$pkg" | cut -d' ' -f1) == "$expected" &&
       $(dpkg-deb -f "$pkg" Package) == cloudflared && $(dpkg-deb -f "$pkg" Architecture) == amd64 ]] || exit 2
    dpkg -i "$pkg"
    /usr/bin/cloudflared --version | grep -Fq "cloudflared version $version "
    printf 'installed=%s\nsha256=%s\n' "$version" "$expected" > "$receipt/02-installed"
    cat "$receipt/02-installed"
    exit
fi
# Access policy and managed ingress must have been applied by the separate cloud executor.
[[ -f $receipt/02-installed && -f /var/lib/vps-dell-local-login/02-ready && ! -e $unit &&
   ! -e /etc/vps-dell-local && ! -e $receipt/03-connect-intent && -z $(ss -Hltn 'sport = :49312') &&
   ${EXPECTED_TUNNEL_ID:-} =~ ^[a-fA-F0-9-]{36}$ ]] || { echo 'Connector preflight failed; reconcile state' >&2; exit 2; }
[[ $(ss -Hltn 'sport = :9090' | awk '{print $4}') == 127.0.0.1:9090 ]] || exit 2
printf 'tunnel_id=%s\nsource=%s\n' "$EXPECTED_TUNNEL_ID" "$SOURCE_COMMIT" > "$receipt/03-connect-intent"
install -d -m 700 /etc/vps-dell-local
# Read the tunnel credential from stdin; compare only its tunnel ID with the release input.
python3 -c '
import base64,json,os,sys,uuid
try:
    token=sys.stdin.buffer.read(16385).strip()
    assert 0 < len(token) <= 16384
    payload=json.loads(base64.b64decode(token+b"="*(-len(token)%4),altchars=b"-_",validate=True))
    assert uuid.UUID(payload["t"])==uuid.UUID(os.environ["EXPECTED_TUNNEL_ID"]) and payload["s"] and payload["a"]
    with open("/etc/vps-dell-local/connector.token","xb") as f: f.write(token)
except Exception:
    sys.exit("Invalid tunnel credential or occupied target")
'
[[ $(stat -c '%a:%U' /etc/vps-dell-local/connector.token) == 600:root ]]
(set -o noclobber; cat > "$unit" <<'UNIT'
[Unit]
Description=Cloudflare Tunnel - VPS Dell local
After=network-online.target cockpit.socket
Wants=network-online.target
Requires=cockpit.socket

[Service]
Type=simple
DynamicUser=yes
LoadCredential=tunnel-token:/etc/vps-dell-local/connector.token
ExecStart=/usr/bin/cloudflared tunnel --no-autoupdate --metrics 127.0.0.1:49312 run --token-file %d/tunnel-token
Restart=on-failure
RestartSec=5s
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
UNIT
)
chmod 644 "$unit"
systemd-analyze verify "$unit"
systemctl daemon-reload
systemctl enable --now vps-dell-cloudflared.service
for _ in {1..35}; do
    if curl -fsS --max-time 2 http://127.0.0.1:49312/ready >/dev/null 2>&1; then
        [[ $(systemctl is-active vps-dell-cloudflared.service) == active && $(systemctl is-enabled vps-dell-cloudflared.service) == enabled ]]
        printf 'state=connector-ready\norigin=http://127.0.0.1:9090\n' > "$receipt/04-ready"
        cat "$receipt/04-ready"
        exit
    fi
    sleep 2
done
echo 'Connector readiness pending; inspect the same connector before retrying.' >&2
exit 1
