"""Publish an owner-only n8n console route on the existing Dell tunnel."""
from copy import deepcopy
from pathlib import Path

from provision import save

HOST = "n8n-jp-dell.codigo5.com.br"
ORIGIN = "http://127.0.0.1:15678"
PANEL = "painel-dell.codigo5.com.br"
ENTRY = "entrada-jp-dell.codigo5.com.br"
TEAM = "equipe-jp-dell.codigo5.com.br"


def append_console(config, audience):
    entries = config.get("ingress")
    hosts = [item.get("hostname") for item in entries[:-1]] if isinstance(entries, list) else []
    if hosts != [PANEL, ENTRY, TEAM] or entries[-1:] != [{"service": "http_status:404"}]:
        raise ValueError("unexpected_existing_routes")
    if any(item.get("service") == ORIGIN for item in entries):
        raise ValueError("origin_already_routed")
    access = entries[0].get("originRequest", {}).get("access", {})
    if not access.get("required") or not access.get("teamName") or not audience:
        raise ValueError("verified_access_required")
    result = deepcopy(config)
    result["ingress"].insert(-1, {
        "hostname": HOST,
        "service": ORIGIN,
        "originRequest": {"access": {
            "required": True,
            "teamName": access["teamName"],
            "audTag": [audience],
        }},
    })
    return result


def apply(cf, ref, state_dir, email):
    if ref.get("hostname") != PANEL or not isinstance(email, str) or not email:
        raise ValueError("wrong_scope")
    root = Path(state_dir)
    account = "accounts/" + ref["account"]
    zone = "zones/" + ref["zone"]
    tunnel = account + "/cfd_tunnel/" + ref["tunnelId"]
    config = cf.request(tunnel + "/configurations")["config"]
    append_console(config, "preflight")
    apps = cf.request(account + "/access/apps?per_page=100")
    if (len(apps) >= 100 or any(app.get("domain") == HOST or app.get("name") == "Console n8n JP no Dell" for app in apps)
            or cf.request(zone + "/dns_records?name=" + HOST)):
        raise ValueError("reconcile_existing_scope")
    providers = cf.request(account + "/access/identity_providers")
    otp = [provider["id"] for provider in providers if provider.get("type") == "onetimepin"]
    if len(otp) != 1:
        raise ValueError("expected_one_time_pin")
    root.mkdir(mode=0o700)
    save(root / "intent.json", {"host": HOST, "origin": ORIGIN, "email": email, "before": config})
    app = cf.request(account + "/access/apps", "POST", {
        "name": "Console n8n JP no Dell",
        "type": "self_hosted",
        "domain": HOST,
        "session_duration": "2h",
        "allowed_idps": otp,
        "app_launcher_visible": False,
    })
    save(root / "app.json", {"id": app["id"], "aud": app["aud"]})
    policy_path = account + "/access/apps/" + app["id"] + "/policies"
    include = [{"email": {"email": email}}]
    policy = cf.request(policy_path, "POST", {
        "name": "Responsavel autorizado da JP",
        "decision": "allow",
        "include": include,
    })
    save(root / "policy.json", {"id": policy["id"]})
    policies = cf.request(policy_path)
    if len(policies) != 1 or policies[0].get("decision") != "allow" or policies[0].get("include") != include:
        raise ValueError("policy_drift")
    desired = append_console(config, app["aud"])
    if cf.request(tunnel + "/configurations")["config"] != config:
        raise ValueError("concurrent_tunnel_edit")
    cf.request(tunnel + "/configurations", "PUT", {"config": desired})
    if cf.request(tunnel + "/configurations")["config"] != desired:
        raise ValueError("route_readback_mismatch")
    if cf.request(zone + "/dns_records?name=" + HOST):
        raise ValueError("concurrent_dns_edit")
    target = ref["tunnelId"] + ".cfargotunnel.com"
    dns = cf.request(zone + "/dns_records", "POST", {
        "type": "CNAME", "name": HOST, "content": target, "proxied": True, "ttl": 1,
    })
    saved_dns = cf.request(zone + "/dns_records/" + dns["id"])
    if saved_dns.get("name") != HOST or saved_dns.get("content") != target or saved_dns.get("proxied") is not True:
        raise ValueError("dns_readback_mismatch")
    result = {"hostname": HOST, "origin": ORIGIN, "otpOnly": True, "operatorCount": 1,
              "sessionDuration": "2h", "oldRoutesPreserved": True}
    save(root / "readback.json", result)
    return result
