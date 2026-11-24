import unittest

from reply_event_trigger import add_reply_event


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
