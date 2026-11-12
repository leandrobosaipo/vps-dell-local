#!/usr/bin/python3
"""Attach the Dell tunnel's loopback socket to the receive-only listener."""
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess

pin=Path("/etc/jp-entrada-dell/forward.json")
if pin.is_symlink() or pin.stat().st_uid!=0 or pin.stat().st_mode&0o022:
    raise SystemExit("Invalid receiver pin")
expected=json.loads(pin.read_bytes())
if not re.fullmatch(r"[a-f0-9]{64}",expected["id"]):
    raise SystemExit("Invalid container ID")
row=json.loads(subprocess.check_output(["/usr/bin/docker","inspect",expected["id"]],timeout=5))[0]
peers=row["NetworkSettings"]["Networks"]
if (row["Id"]!=expected["id"] or row["Name"]!="/jp-entrada-operacional" or not row["State"]["Running"] or
        row["Image"]!=expected["image"] or set(peers)!={"atendimento-piloto_pilot"} or row["HostConfig"]["PortBindings"]):
    raise SystemExit("Unexpected receiver")
addr=ipaddress.IPv4Address(peers["atendimento-piloto_pilot"]["IPAddress"])
if not addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_unspecified:
    raise SystemExit("Unexpected receiver address")
os.execv("/usr/bin/setpriv",["setpriv","--reuid=nobody","--regid=nogroup","--clear-groups","--no-new-privs",
    "/usr/lib/systemd/systemd-socket-proxyd","--exit-idle-time=10s",f"{addr}:8790"])
