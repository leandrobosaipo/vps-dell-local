import unittest

from reply_event_trigger import add_reply_event, recheck_after_triage


class ReplyTriggerTests(unittest.TestCase):
    def test_event_and_recovery_share_original_capture(self):
        graph = dict(nodes=[
            dict(name="clock", type="n8n-nodes-base.scheduleTrigger", position=[0, 0]),
            dict(name="read", type="n8n-nodes-base.httpRequest", parameters={"url": "http://fixture/tick"}),
        ], connections={"clock": {"main": [[{"node": "read", "index": 0, "type": "main"}]]}})
        source = dict(nodes=[dict(type="n8n-nodes-base.webhook", typeVersion=2.1,
                                  parameters=dict(httpMethod="POST", authentication="headerAuth"),
                                  credentials={"httpHeaderAuth": {"id": "fixture"}})])
        path = "jp-reply-events-" + "a" * 32
        new = add_reply_event(graph, source, path)
        event = new["nodes"][-1]
        self.assertEqual(new["nodes"][:-1], graph["nodes"])
        self.assertEqual(new["connections"][event["name"]], graph["connections"]["clock"])
        self.assertEqual(event["parameters"]["responseData"], "noData")
        self.assertEqual(event["credentials"], source["nodes"][0]["credentials"])
        with self.assertRaises(ValueError):
            add_reply_event(new, source, path)
        with self.assertRaises(ValueError):
            add_reply_event(graph, source, "https://invalid")

    def test_only_new_review_cases_can_take_a_second_pass(self):
        edge=lambda n: {"main":[[{"node":n,"type":"main","index":0}]]}
        graph={"nodes":[
            dict(name="event",type="n8n-nodes-base.webhook",parameters={"responseMode":"lastNode"},position=[0,0]),
            dict(name="clock",type="n8n-nodes-base.scheduleTrigger"),
            dict(name="capture",type="n8n-nodes-base.httpRequest",parameters={"url":"http://fixture/tick"}),
            dict(name="pending",type="n8n-nodes-base.if",parameters={"conditions":{"conditions":[{"leftValue":"actionPending"}]}})],
            "connections":{"event":edge("capture"),"clock":edge("capture"),"capture":edge("pending")}}
        fixed=recheck_after_triage(graph)
        check=fixed["nodes"][-1];condition=check["parameters"]["conditions"]["conditions"][0]["leftValue"]
        self.assertIn("actionPending === false",condition)
        self.assertIn("triage?.ready === true",condition)
        self.assertEqual([b[0]["node"] for b in fixed["connections"][check["name"]]["main"]],["capture","pending"])
        self.assertEqual(fixed["connections"]["clock"],graph["connections"]["clock"])
        self.assertEqual(fixed["connections"]["capture"],graph["connections"]["capture"])
        with self.assertRaises(ValueError):
            recheck_after_triage(fixed)
