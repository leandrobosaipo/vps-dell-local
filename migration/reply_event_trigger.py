"""Add a second trigger to the current reply graph, preserving every admission node."""
import copy
import re
import uuid


def add_reply_event(graph, intake, path):
    if not re.fullmatch(r"jp-reply-events-[0-9a-f]{32}", path):
        raise ValueError("invalid_reply_path")
    result = copy.deepcopy(graph)
    clock, = [n for n in graph["nodes"] if n["type"] == "n8n-nodes-base.scheduleTrigger"]
    trigger, = [n for n in intake["nodes"] if n["type"] == "n8n-nodes-base.webhook"]
    params = trigger["parameters"]
    if (params.get("httpMethod") != "POST" or params.get("authentication") != "headerAuth"
            or not trigger.get("credentials", {}).get("httpHeaderAuth")
            or any(n["type"] == trigger["type"] for n in graph["nodes"])):
        raise ValueError("unexpected_reply_graph")
    target, = graph["connections"][clock["name"]]["main"][0]
    capture, = [n for n in graph["nodes"] if n["name"] == target["node"]]
    if capture["type"] != "n8n-nodes-base.httpRequest" or not capture["parameters"]["url"].endswith("/tick"):
        raise ValueError("capture_edge_changed")
    event = copy.deepcopy(trigger)
    event.update(id=str(uuid.uuid4()), webhookId=str(uuid.uuid4()),
                 name="Receber nova mensagem da Evolution",
                 position=[clock["position"][0], clock["position"][1] - 180])
    event["parameters"] = dict(httpMethod="POST", path=path, authentication="headerAuth",
                               responseMode="lastNode", responseData="noData", options={})
    result["nodes"].append(event)
    result["connections"][event["name"]] = copy.deepcopy(graph["connections"][clock["name"]])
    return result
