"""Prepare the receiver from its inspected Docker settings. Only emit creation arguments."""
import re
from pathlib import PurePosixPath


def create_args(old, prepared):
    root = "/var/lib/jp-migracao-revisao"
    release = PurePosixPath(prepared)
    if release.parent != PurePosixPath(root) or not re.fullmatch(r"entrada-candidata-[a-f0-9]{12}", release.name):
        raise ValueError("unexpected_release")
    if (old["Name"] != "/jp-entrada-operacional" or not old["State"]["Running"] or
            old["Config"]["User"] != "65534:65534" or old["Config"]["Cmd"] != ["node", "/app/receive_service.mjs"]):
        raise ValueError("unexpected_receiver")
    image = old["Image"]
    config = old["HostConfig"]
    if (not re.fullmatch(r"sha256:[a-f0-9]{64}", image) or config["PortBindings"] or
            not config["ReadonlyRootfs"] or config.get("Privileged") or
            set(old["NetworkSettings"]["Networks"]) != {"atendimento-piloto_pilot"}):
        raise ValueError("unexpected_container_scope")
    mounts = {m["Destination"]: (m["Source"], m["RW"]) for m in old["Mounts"]}
    expected = {"/data": (root+"/entrada-operacional/data", True),
                "/access": (root+"/entrada-operacional/access", False),
                "/app": (root+"/entrada-operacional/src", False)}
    if mounts != expected:
        raise ValueError("prior_mount_drift")
    # Keep the staged container stopped across reboot. The approved handover
    # selects the permanent restart policy after checking the previous owner.
    args = ["docker", "create", "--pull=never", "--name", "jp-"+release.name,
            "--network", "atendimento-piloto_pilot", "--restart", "no", "--read-only",
            "--user", "65534:65534", "--group-add", "64681", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--log-driver", "none"]
    for key, flag in [("Memory","--memory"),("PidsLimit","--pids-limit")]:
        if not isinstance(config[key], int) or config[key] <= 0:
            raise ValueError("prior_limit_missing")
        args.extend([flag,str(config[key])])
    if config["NanoCpus"] <= 0:
        raise ValueError("prior_cpu_limit_missing")
    args.extend(["--cpus",str(config["NanoCpus"] / 1_000_000_000)])
    for source, destination, mode in [(mounts["/data"][0],"/data","rw"),
            (release/"access","/access","ro"),(release/"src","/app","ro"),
            (release/"contract","/contract","ro"),("/run/jp-dispatch","/dispatch","ro")]:
        args.extend(["--mount",f"type=bind,src={source},dst={destination}"+(",readonly" if mode=="ro" else "")])
    return args+[image,"node","/app/receive_service.mjs"]
