"""Add a private TLS relay for the two Google destinations used by Chatwoot."""
import ipaddress
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path("/opt/atendimento-piloto/source")
COMPOSE = ROOT / "compose.yaml"
RELAY = ROOT / "private/chatwoot-oauth-haproxy.cfg"
SUBNET = ipaddress.ip_network("10.244.238.0/29")
HOST = "10.244.238.2"
IMAGE = "haproxy@sha256:1c3568e520453cc8ba98c39501febcf450429c80e6cc27ecad779961d76e597c"


def run(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True, stderr=subprocess.PIPE)


def atomic(path, content, perms):
    fd, name = tempfile.mkstemp(dir=path.parent)
    with os.fdopen(fd, "w") as stream:
        os.fchmod(stream.fileno(), perms)
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(name, path)


def model(path):
    return json.loads(run("docker", "compose", "-f", str(path), "config", "--format", "json"))


def install():
    old = COMPOSE.read_text()
    initial = model(COMPOSE)
    assert initial["name"] == "atendimento-piloto" and set(initial["services"]["chat"]["networks"]) == {"pilot"}
    assert initial["networks"]["pilot"]["internal"] and not RELAY.exists()
    assert old.count("\n  chat:\n") == old.count("\nnetworks:\n") == 1
    routes = json.loads(run("ip", "-j", "-4", "route"))
    matches = [x for x in routes if x.get("dst", "default") != "default"
               and ipaddress.ip_network(x["dst"], strict=False).overlaps(SUBNET)]
    if matches:
        net, = json.loads(run("docker", "network", "inspect", "atendimento-piloto_oauth_private"))
        assert net["Internal"] and not net["Containers"] and net["Labels"]["com.docker.compose.project"] == initial["name"]
        assert len(matches) == 1 and matches[0]["dst"] == str(SUBNET) and matches[0]["dev"] == "br-" + net["Id"][:12]
    text = old.replace("\n  chat:\n", f"""
  chat:
    networks: [pilot, oauth_private]
    extra_hosts:
      - oauth2.googleapis.com:{HOST}
      - www.googleapis.com:{HOST}
""").replace("\nnetworks:\n", f"""
  oauth-relay:
    image: {IMAGE}
    restart: unless-stopped
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    sysctls: {{net.ipv4.ip_unprivileged_port_start: "0"}}
    mem_limit: 48m
    pids_limit: 32
    networks:
      oauth_egress: {{}}
      oauth_private: {{ipv4_address: {HOST}}}
    volumes: [./private/chatwoot-oauth-haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro]
networks:
  oauth_egress: {{}}
  oauth_private:
    internal: true
    ipam:
      config: [{{subnet: "{SUBNET}"}}]
""")
    backup = ROOT / "private" / time.strftime("chat-network-backup-%Y%m%dT%H%M%SZ", time.gmtime())
    backup.mkdir(mode=0o700)
    shutil.copy2(COMPOSE, backup / "compose.yaml")
    candidate = ROOT / ".chat-oauth-compose.candidate.yaml"
    assert not candidate.exists()
    candidate.write_text(text)
    try:
        checked = model(candidate)
        for name, service in initial["services"].items():
            updated = checked["services"][name].copy()
            if name == "chat":
                assert not service.get("extra_hosts")
                del updated["extra_hosts"]
                del updated["networks"]["oauth_private"]
            assert updated == service
        assert set(checked["services"]) == set(initial["services"]) | {"oauth-relay"}
        assert COMPOSE.read_text() == old
        atomic(RELAY, Path(__file__).with_name("chatwoot-oauth-haproxy.cfg").read_text(), 0o644)
        atomic(COMPOSE, text, COMPOSE.stat().st_mode & 0o777)
        run("docker", "compose", "up", "-d", "--no-deps", "oauth-relay")
        run("docker", "compose", "up", "-d", "--no-deps", "chat")
        for domain in ("oauth2.googleapis.com", "www.googleapis.com"):
            for attempt in range(6):
                try:
                    run("docker", "exec", "atendimento-piloto-chat-1", "ruby", "-rnet/http", "-ruri", "-e",
                        'r=Net::HTTP.get_response(URI("https://"+ARGV[0]+"/")); abort unless (200..499).cover?(r.code.to_i)', domain)
                    break
                except subprocess.CalledProcessError:
                    if attempt == 5:
                        raise
                    time.sleep(2)
    except Exception as exc:
        if COMPOSE.read_text() == text:
            relay = run("docker", "compose", "ps", "-aq", "oauth-relay").strip()
            if relay:
                diagnostic = subprocess.run(["docker", "logs", "--tail", "10", relay], capture_output=True, text=True)
                (backup / "relay-diagnostic.txt").write_text(diagnostic.stdout + diagnostic.stderr)
            if isinstance(exc, subprocess.CalledProcessError):
                (backup / "check-diagnostic.txt").write_text(exc.stderr or "")
            run("docker", "compose", "rm", "--stop", "--force", "oauth-relay")
            atomic(COMPOSE, old, COMPOSE.stat().st_mode & 0o777)
            run("docker", "compose", "up", "-d", "--no-deps", "chat")
            RELAY.unlink()
        raise
    finally:
        candidate.unlink(missing_ok=True)
    print("TLS verified for both destinations")


if __name__ == "__main__":
    install()
