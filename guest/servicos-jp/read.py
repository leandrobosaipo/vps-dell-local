"""On-demand, read-only Cockpit inventory. No credentials, schedulers or API writes."""
import json
import os
import shutil
import subprocess
import time
from pathlib import Path


def cmd(*args):
    return subprocess.check_output(args, text=True, timeout=15).strip()


expected = {"atendimento-piloto-" + s + "-1" for s in ("chat", "worker", "clock", "flow", "postgres", "redis")}
expected.update(("jp-entrada-operacional", "jp-core-operacional", "jp-speech-dell", "jp-core-transacional-dell", "jp-core-dell"))
states = {}
ids = []
for line in cmd("/usr/bin/docker", "ps", "-a", "--format", "{{.ID}} {{.Names}} {{.State}}").splitlines():
    ident, name, state = line.split()
    if state == "running" or name in expected:
        states[name] = state
        if state == "running":
            ids.append(ident)
if ids:
    for line in cmd("/usr/bin/docker", "inspect", "--format", "{{.Name}} {{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", *ids).splitlines():
        name, state = line.split()
        states[name.lstrip("/")] = state
stats = {}
if ids:
    for line in cmd("/usr/bin/docker", "stats", "--no-stream", "--format", "{{json .}}", *ids).splitlines():
        v = json.loads(line)
        stats[v["Name"]] = (v["CPUPerc"], v["MemUsage"].split(" / ")[0], v["BlockIO"])
apps = []
for name in sorted(expected | states.keys()):
    cpu, mem, io = stats.get(name, ("—", "—", "—"))
    apps.append(dict(name=name, state=states.get(name, "missing"), cpu=cpu, mem=mem, io=io))
units = []
raw = cmd("/usr/bin/systemctl", "show", "-p", "Id,ActiveState,SubState,MemoryCurrent",
          "jp-*.service", "jp-*.socket", "atendimento-*.service", "vps-dell-cloudflared.service")
data = [dict(line.split("=", 1) for line in group.splitlines() if "=" in line) for group in raw.split("\n\n")]
active = {d["Id"] for d in data if d.get("ActiveState") == "active" and "Id" in d}
for d in sorted(data, key=lambda x: x.get("Id","")):
    name = d.get("Id","")
    if not name or name.endswith(".socket"):
        continue
    state = d["ActiveState"] + "/" + d["SubState"]
    state = {"active/running":"Em execução", "active/exited":"Tarefa concluída", "inactive/dead":"Parado"}.get(state,state)
    if state == "Parado" and name.replace(".service",".socket") in active:
        state = "Aguardando chamada (socket ativo)"
    m = d.get("MemoryCurrent","")
    units.append(dict(name=name,state=state,mem=f"{int(m)/1048576:.1f} MiB" if m.isdigit() and int(m)<2**63 else "—"))
ram = {r.split(":")[0]:int(r.split()[1])*1024 for r in Path("/proc/meminfo").read_text().splitlines()}
usage = shutil.disk_usage("/")
print(json.dumps(dict(apps=apps,units=units,cores=os.cpu_count(),total=ram["MemTotal"],avail=ram["MemAvailable"],
                      disk=dict(free=usage.free,total=usage.total),time=time.time())))
