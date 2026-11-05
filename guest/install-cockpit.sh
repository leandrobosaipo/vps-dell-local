#!/usr/bin/env bash
# Configure only a fresh project panel. The executor verifies the canonical release.
set -euo pipefail
umask 077
mode=${1:---plan}
[[ $mode == --plan || $mode == --apply ]] || exit 2
# shellcheck disable=SC1091
. /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 && $(systemd-detect-virt) == microsoft ]] || exit 2
[[ $(hostnamectl --static) == agentes-lab && -z $(hostnamectl --pretty) ]] || { echo 'Unexpected guest identity or display name' >&2; exit 2; }
[[ ! -e /etc/cockpit/cockpit.conf && ! -e /etc/systemd/system/cockpit.socket.d ]] || { echo 'Panel configuration exists' >&2; exit 2; }
[[ -z $(ss -Hltn 'sport = :9090') ]] || { echo 'Port 9090 already in use' >&2; exit 2; }
for p in cockpit-ws cockpit-system cockpit-bridge; do
    [[ $(dpkg-query -W -f='${db:Status-Status}' "$p" 2>/dev/null || :) != installed ]] || { echo 'Cockpit already present' >&2; exit 2; }
    [[ $(LC_ALL=C apt-cache policy "$p" | awk '/Candidate:/ {print $2}') == 314-1 ]] || { echo 'Unexpected Cockpit candidate' >&2; exit 2; }
done
(( $(df -B1 --output=avail / | tail -1) >= 2 * 1024 * 1024 * 1024 )) || exit 2
if [[ $mode == --plan ]]; then
    printf 'mode=plan\nversion=314-1\nlisten=127.0.0.1:9090\ndisplay=VPS Dell local\n'
    exit
fi
[[ $EUID == 0 && ${SOURCE_COMMIT:-} =~ ^[0-9a-f]{40}$ && ${EXPECTED_SCRIPT_SHA256:-} =~ ^[0-9a-f]{64}$ &&
   ${EXPECTED_MACHINE_ID:-} =~ ^[0-9a-f]{32}$ && $(cat /etc/machine-id) == "$EXPECTED_MACHINE_ID" &&
   $(sha256sum "$0" | cut -d' ' -f1) == "$EXPECTED_SCRIPT_SHA256" ]] || exit 2
receipt=/var/lib/vps-dell-local-cockpit
mkdir -m 700 "$receipt"
printf 'source=%s\nscript_sha256=%s\n' "$SOURCE_COMMIT" "$EXPECTED_SCRIPT_SHA256" > "$receipt/01-intent"
# Preseed the override before apt's postinst can start the distribution socket.
install -d -m 755 /etc/systemd/system/cockpit.socket.d
printf '[Socket]\nListenStream=\nListenStream=127.0.0.1:9090\n' > /etc/systemd/system/cockpit.socket.d/10-loopback.conf
chmod 644 /etc/systemd/system/cockpit.socket.d/10-loopback.conf
systemctl daemon-reload
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends cockpit-ws=314-1 cockpit-system=314-1 cockpit-bridge=314-1
[[ ! -e /etc/cockpit/cockpit.conf ]] || { echo 'Package provided an unexpected configuration' >&2; exit 2; }
install -d -m 755 /etc/cockpit
(set -o noclobber; cat > /etc/cockpit/cockpit.conf <<'CFG'
[WebService]
Origins = https://painel-dell.codigo5.com.br
ProtocolHeader = X-Forwarded-Proto
AllowUnencrypted = true
LoginTo = false
CFG
)
chmod 644 /etc/cockpit/cockpit.conf
hostnamectl --pretty set-hostname 'VPS Dell local'
systemctl enable --now cockpit.socket
mapfile -t sockets < <(ss -Hltn 'sport = :9090' | awk '{print $4}')
[[ ${#sockets[@]} == 1 && ${sockets[0]} == '127.0.0.1:9090' && $(hostnamectl --static) == agentes-lab &&
   $(hostnamectl --pretty) == 'VPS Dell local' ]] || { echo 'Panel bind/name readback failed' >&2; exit 2; }
curl -fsS --max-time 12 --header 'X-Forwarded-Proto: https' --header 'Host: painel-dell.codigo5.com.br' \
  http://127.0.0.1:9090/ping | python3 -c 'import json,sys; assert json.load(sys.stdin)["service"]=="cockpit"'
printf 'state=loopback-ready\nbind=%s\n' "${sockets[0]}" > "$receipt/02-ready"
cat "$receipt/02-ready"
