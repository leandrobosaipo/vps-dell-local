#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077
mode=${1:---plan}
[[ $mode == --plan || $mode == --apply ]] || exit 2
[[ $(systemd-detect-virt) == microsoft && $(hostnamectl --static) == agentes-lab ]] || exit 2
! getent passwd delladmin >/dev/null || { echo 'Existing account; reconcile before proceeding' >&2; exit 2; }
[[ -f /var/lib/vps-dell-local-cockpit/02-ready && ! -e /var/lib/vps-dell-local-login ]] || exit 2
[[ $EUID == 0 ]] || { echo 'Run on the identified guest as root.' >&2; exit 2; }
policy=$(sshd -T -C user=delladmin,host=localhost,addr=127.0.0.1)
grep -qx 'passwordauthentication no' <<< "$policy"
grep -qx 'kbdinteractiveauthentication no' <<< "$policy"
if [[ $mode == --plan ]]; then printf 'mode=plan\nlogin=delladmin\nauthentication=PAM\nrole=guest-admin\n'; exit; fi
[[ ${SOURCE_COMMIT:-} =~ ^[0-9a-f]{40}$ && ${EXPECTED_SCRIPT_SHA256:-} =~ ^[0-9a-f]{64}$ &&
   ${EXPECTED_MACHINE_ID:-} =~ ^[0-9a-f]{32}$ && $(cat /etc/machine-id) == "$EXPECTED_MACHINE_ID" &&
   $(sha256sum "$0" | cut -d' ' -f1) == "$EXPECTED_SCRIPT_SHA256" ]] || exit 2
# Standard input is the private SHA-512 crypt hash; stdout never contains it.
IFS= read -r hashed || [[ -n ${hashed:-} ]]
[[ $hashed =~ ^\$6\$(rounds=[0-9]{4,9}\$)?[./A-Za-z0-9]{1,16}\$[./A-Za-z0-9]{86}$ ]] || { echo 'Invalid hash encoding' >&2; exit 2; }
receipt=/var/lib/vps-dell-local-login
mkdir -m 700 "$receipt"
printf 'source=%s\nscript_sha256=%s\n' "$SOURCE_COMMIT" "$EXPECTED_SCRIPT_SHA256" > "$receipt/01-intent"
useradd --create-home --shell /bin/bash --groups sudo --password '!' delladmin
printf 'delladmin:%s\n' "$hashed" | chpasswd --encrypted
[[ $(getent shadow delladmin | cut -d: -f2) == "$hashed" ]]
unset hashed
id -nG delladmin | tr ' ' '\n' | grep -qx sudo
[[ $(passwd -S delladmin | awk '{print $2}') == P ]]
printf 'state=local-login-ready\nuser=delladmin\n' > "$receipt/02-ready"
cat "$receipt/02-ready"
