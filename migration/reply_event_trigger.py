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


def recheck_after_triage(graph):
    """Let the same incoming execution see the case created by its first capture."""
    result = copy.deepcopy(graph)
    nodes, edges = result["nodes"], result["connections"]
    event, = [n for n in nodes if n["type"] == "n8n-nodes-base.webhook"]
    clock, = [n for n in nodes if n["type"] == "n8n-nodes-base.scheduleTrigger"]
    if edges[event["name"]] != edges[clock["name"]] or event["parameters"].get("responseMode") != "lastNode":
        raise ValueError("unexpected_event_path")
    capture_name = edges[clock["name"]]["main"][0][0]["node"]
    capture, = [n for n in nodes if n["name"] == capture_name]
    decision_name = edges[capture_name]["main"][0][0]["node"]
    decision, = [n for n in nodes if n["name"] == decision_name]
    if not capture["parameters"]["url"].endswith("/tick") or decision["type"] != "n8n-nodes-base.if":
        raise ValueError("unexpected_capture")
    def wire(name):
        return [{"node":name,"type":"main","index":0}]
    def place(n, name, x):
        n.update(name=name,id=str(uuid.uuid4()),position=[x,event["position"][1]])
        nodes.append(n)
        return name
    x=event["position"][0]
    first=place(copy.deepcopy(capture),"Conferir a nova mensagem",x+230)
    ack=place(dict(type="n8n-nodes-base.respondToWebhook",typeVersion=1.4,
                   parameters=dict(respondWith="noData",options=dict(responseCode=204))),
              "Confirmar a captura ao receptor",x+460)
    test=copy.deepcopy(decision)
    condition,=test["parameters"]["conditions"]["conditions"]
    condition["id"]=str(uuid.uuid4())
    condition["leftValue"]=("={{ $json.actionPending === false && $json.triage?.ready === true && "
        "(($json.linked?.outcomes?.identity_review ?? 0) + ($json.linked?.outcomes?.visit_review ?? 0)) > 0 }}")
    check=place(test,"A triagem pode liberar esta resposta?",x+690)
    event["parameters"]["responseMode"]="responseNode"
    event["parameters"].pop("responseData",None)
    edges[event["name"]]={"main":[wire(first)]}
    edges[first]={"main":[wire(ack)]}
    edges[ack]={"main":[wire(check)]}
    # Reuse the existing capture and all the existing permission checks, once.
    edges[check]={"main":[wire(capture_name),wire(decision_name)]}
    return result
