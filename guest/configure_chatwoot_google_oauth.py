#!/usr/bin/env python3
"""Configure the Dell Chatwoot Google login from a new private Google JSON.

Run only on the Dell guest as root. This program never changes Cloudflare Access,
does not print OAuth values, and refuses a JSON whose secret fingerprint is known
to have been exposed. The caller supplies the exposed fingerprint through stdin
or a private file; it is never stored in this source tree.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

HOST = "equipe-jp-dell.codigo5.com.br"
CALLBACK = f"https://{HOST}/omniauth/google_oauth2/callback"
PROJECT = "codigo5web"
ROOT = Path("/opt/atendimento-piloto/source")
COMPOSE = ROOT / "compose.yaml"
ENV = ROOT / "private/chat.env"
DEFAULT_CLIENT = Path("/etc/atendimento-piloto-integracao/google-oauth-client.json")


def require_mode(path: Path, mode: int = 0o600) -> None:
    stat = path.stat()
    if not path.is_file() or stat.st_mode & 0o777 != mode:
        raise ValueError(f"private_file_mode:{path}")


def load_client(path: Path, rejected_hash: str) -> dict:
    require_mode(path)
    value = json.loads(path.read_text())
    web = value.get("web")
    if not isinstance(web, dict):
        raise ValueError("expected_web_client")
    required = ("project_id", "client_id", "client_secret", "redirect_uris")
    if any(not web.get(key) for key in required):
        raise ValueError("missing_client_field")
    if web["project_id"] != PROJECT or web["redirect_uris"] != [CALLBACK]:
        raise ValueError("client_scope_mismatch")
    if not re.fullmatch(r"[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com", web["client_id"]):
        raise ValueError("unexpected_client_id")
    current_hash = hashlib.sha256(web["client_secret"].encode()).hexdigest()
    if not re.fullmatch(r"[a-f0-9]{64}", rejected_hash) or current_hash == rejected_hash:
        raise ValueError("rejected_or_invalid_secret")
    return web


def update_env(text: str, client: dict) -> str:
    wanted = {
        "GOOGLE_OAUTH_CLIENT_ID": client["client_id"],
        "GOOGLE_OAUTH_CLIENT_SECRET": client["client_secret"],
        "GOOGLE_OAUTH_REDIRECT_URI": CALLBACK,
        "GOOGLE_OAUTH_CALLBACK_URL": CALLBACK,
        "ENABLE_GOOGLE_OAUTH_LOGIN": "true",
    }
    found = set()
    lines = []
    for line in text.splitlines():
        key = line.split("=", 1)[0]
        if key in wanted:
            lines.append(key + "=" + wanted[key])
            found.add(key)
        else:
            lines.append(line)
    for key, value in wanted.items():
        if key not in found:
            lines.append(key + "=" + value)
    return "\n".join(lines) + "\n"


def write_private(path: Path, contents: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    with os.fdopen(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
        stream.write(contents)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, path)
    os.chmod(path, 0o600)


def run(command: list[str], **kwargs) -> None:
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kwargs)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--client-json", type=Path, default=DEFAULT_CLIENT)
    parser.add_argument("--rejected-secret-sha256", required=True)
    parser.add_argument("--operator-email", required=True)
    args = parser.parse_args()
    if (os.geteuid() != 0 or not COMPOSE.is_file() or not ENV.is_file()
            or f"FRONTEND_URL: https://{HOST}" not in COMPOSE.read_text()
            or not re.fullmatch(r"[^@\\s]+@[^@\\s]+", args.operator_email)):
        raise SystemExit("unexpected_guest_scope")
    client = load_client(args.client_json, args.rejected_secret_sha256)
    current = ENV.read_text()
    desired = update_env(current, client)
    if not args.apply:
        print(json.dumps({"mode": "plan", "host": HOST, "callback": CALLBACK,
                          "clientProject": PROJECT, "chatEnvWillChange": desired != current,
                          "cloudflareWillChange": False, "signupMustRemainDisabled": True}))
        return 0
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    backup = ENV.parent / ("chat-oauth-backup-" + stamp)
    backup.mkdir(mode=0o700)
    shutil.copy2(COMPOSE, backup / "compose.yaml")
    shutil.copy2(ENV, backup / "chat.env")
    os.chmod(backup / "compose.yaml", 0o600)
    os.chmod(backup / "chat.env", 0o600)
    write_private(ENV, desired)
    try:
        run(["docker", "compose", "-f", str(COMPOSE), "config", "-q"], cwd=ROOT)
        run(["docker", "compose", "-f", str(COMPOSE), "up", "-d", "chat", "worker"], cwd=ROOT)
        verify = """\
raise 'signup_enabled' unless ENV['ENABLE_ACCOUNT_SIGNUP'] == 'false'
raise 'oauth_disabled' unless ENV['ENABLE_GOOGLE_OAUTH_LOGIN'] == 'true'
raise 'callback_mismatch' unless ENV['GOOGLE_OAUTH_REDIRECT_URI'] == '%s'
raise 'login_callback_mismatch' unless ENV['GOOGLE_OAUTH_CALLBACK_URL'] == ENV['GOOGLE_OAUTH_REDIRECT_URI']
raise 'operator_missing' unless User.where(email: '%s').exists?
puts 'ok'
""" % (CALLBACK, args.operator_email)
        run(["docker", "exec", "atendimento-piloto-chat-1", "bundle", "exec", "rails", "runner", verify])
    except Exception:
        os.replace(backup / "chat.env", ENV)
        subprocess.run(["docker", "compose", "-f", str(COMPOSE), "up", "-d", "chat", "worker"], cwd=ROOT)
        raise
    print(json.dumps({"mode": "applied", "host": HOST, "backup": str(backup),
                      "cloudflareChanged": False, "signupDisabled": True,
                      "operatorExists": True, "humanOAuthReadbackRequired": True}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
