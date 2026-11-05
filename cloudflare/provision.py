"""Create only this project's new Access app, tunnel and DNS record. Plan by default."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    raw = value if isinstance(value, str) else json.dumps(value, indent=2) + "\n"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(raw)


class Cloudflare:
    def __init__(self, credentials):
        env = {}
        for line in credentials.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                env[key.strip()] = value.strip().strip("\"'")
        self.email = env["CLOUDFLARE_EMAIL"]
        self.headers = {"X-Auth-Email": self.email, "X-Auth-Key": env["CLOUDFLARE_API_KEY"],
                        "Content-Type": "application/json"}

    def request(self, path, method="GET", data=None):
        request = urllib.request.Request("https://api.cloudflare.com/client/v4/" + path,
            headers=self.headers, method=method,
            data=json.dumps(data).encode() if data is not None else None)
        try:
            with urllib.request.urlopen(request, timeout=35) as response:
                body = json.load(response)
        except urllib.error.HTTPError as error:
            # Never emit response bodies: policy or token errors may include supplied data.
            raise RuntimeError(f"Cloudflare HTTP {error.code}; inspect scoped state before retry") from None
        if body.get("success") is not True:
            codes = [x.get("code") for x in body.get("errors", [])]
            raise RuntimeError(f"Cloudflare refused request, error codes {codes}")
        return body["result"]


def inspect(cf, config):
    zones = cf.request("zones?name=" + config["zone"])
    if len(zones) != 1 or zones[0]["status"] != "active":
        raise ValueError("Expected exactly one active zone")
    zone, account = zones[0]["id"], zones[0]["account"]["id"]
    account_path = "accounts/" + account
    dns = cf.request("zones/" + zone + "/dns_records?name=" + config["hostname"])
    tunnels = cf.request(account_path + "/cfd_tunnel?is_deleted=false&name=" + config["tunnelName"])
    apps = cf.request(account_path + "/access/apps?per_page=100")
    tokens = cf.request(account_path + "/access/service_tokens?per_page=100")
    if dns or any(x["name"] == config["tunnelName"] for x in tunnels) or any(
        x.get("domain") == config["hostname"] for x in apps) or any(
        x.get("name") == config["serviceTokenName"] for x in tokens):
        raise ValueError("Project resources already exist; reconcile instead of adopting or recreating")
    idps = cf.request(account_path + "/access/identity_providers")
    otp = [x["id"] for x in idps if x["type"] == "onetimepin"]
    if len(otp) != 1:
        raise ValueError("Expected one existing one-time PIN identity provider")
    org = cf.request(account_path + "/access/organizations")
    return zone, account_path, otp[0], org["auth_domain"].split(".")[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--credentials", required=True, type=Path)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--state-dir", type=Path)
    parser.add_argument("--source-commit")
    parser.add_argument("--expected-script-sha256")
    parser.add_argument("--expected-config-sha256")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    if config.get("schema") != 1 or config.get("zone") != "codigo5.com.br" or config.get("hostname") != "painel-dell.codigo5.com.br" or config.get("tunnelName") != "vps-dell-local" or config.get("origin") != "http://127.0.0.1:9090":
        raise ValueError("Unexpected project scope")
    cf = Cloudflare(args.credentials)
    zone, ap, otp, team = inspect(cf, config)
    if not args.apply:
        print(json.dumps({"mode": "plan", "hostname": config["hostname"], "newResourcesOnly": True,
                          "humanAuth": "owner-email-OTP plus PAM", "automation": "app-scoped service token plus PAM"}))
        return
    if not re.fullmatch(r"[a-f0-9]{40}", args.source_commit or "") or sha(Path(__file__)) != args.expected_script_sha256 or sha(args.config) != args.expected_config_sha256 or args.state_dir is None:
        raise ValueError("Published source/config provenance required")
    args.state_dir.mkdir(mode=0o700)  # Exclusive stage; a partial attempt must be reconciled.
    root = args.state_dir
    save(root / "00-intent.json", {"sourceCommit": args.source_commit, "scriptSha256": args.expected_script_sha256,
        "configSha256": args.expected_config_sha256, "hostname": config["hostname"]})
    app = cf.request(ap + "/access/apps", "POST", {"name": config["applicationName"], "type": "self_hosted",
        "domain": config["hostname"], "session_duration": "12h", "allowed_idps": [otp],
        "app_launcher_visible": False})
    save(root / "01-app.json", {k: app[k] for k in ("id", "domain", "aud")})
    app_path = ap + "/access/apps/" + app["id"]
    owner = cf.request(app_path + "/policies", "POST", {"name": "Proprietario", "decision": "allow",
        "include": [{"email": {"email": cf.email}}]})
    token = cf.request(ap + "/access/service_tokens", "POST", {"name": config["serviceTokenName"],
        "duration": config["serviceTokenDuration"]})
    save(root / "02-service-token.json", token)  # Secret stays private, never printed.
    service = cf.request(app_path + "/policies", "POST", {"name": "Dot somente neste painel", "decision": "non_identity",
        "include": [{"service_token": {"token_id": token["id"]}}]})
    policies = cf.request(app_path + "/policies")
    if len(policies) != 2 or {x["id"] for x in policies} != {owner["id"], service["id"]}:
        raise ValueError("Unexpected Access policy readback")
    tunnel = cf.request(ap + "/cfd_tunnel", "POST", {"name": config["tunnelName"], "config_src": "cloudflare"})
    save(root / "03-tunnel.json", {k: tunnel[k] for k in ("id", "name", "config_src")})
    tunnel_path = ap + "/cfd_tunnel/" + tunnel["id"]
    ingress = [{"hostname": config["hostname"], "service": config["origin"], "originRequest": {
        "access": {"required": True, "teamName": team, "audTag": [app["aud"]]}}}, {"service": "http_status:404"}]
    cf.request(tunnel_path + "/configurations", "PUT", {"config": {"ingress": ingress}})
    current = cf.request(tunnel_path + "/configurations")
    if current["config"]["ingress"] != ingress:
        raise ValueError("Tunnel ingress readback mismatch")
    save(root / "tunnel.token", cf.request(tunnel_path + "/token") + "\n")
    dns = cf.request("zones/" + zone + "/dns_records", "POST", {"type": "CNAME", "name": config["hostname"],
        "content": tunnel["id"] + ".cfargotunnel.com", "proxied": True, "ttl": 1,
        "comment": "VPS Dell local source " + args.source_commit})
    live_dns = cf.request("zones/" + zone + "/dns_records/" + dns["id"])
    if live_dns["content"] != tunnel["id"] + ".cfargotunnel.com" or live_dns["proxied"] is not True:
        raise ValueError("DNS readback mismatch")
    result = {"state": "cloudflare-configured-connector-pending", "hostname": config["hostname"],
        "account": ap.split("/")[1], "zone": zone, "appId": app["id"], "tunnelId": tunnel["id"],
        "dnsId": dns["id"], "policyIds": [owner["id"], service["id"]], "sourceCommit": args.source_commit}
    save(root / "04-verified.json", result)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
