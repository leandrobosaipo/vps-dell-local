import unittest

from private_n8n_route import ENTRY, HOST, ORIGIN, PANEL, TEAM, append_console


class RouteTests(unittest.TestCase):
    def test_appends_only_after_current_routes(self):
        config = {"ingress": [
            {"hostname": PANEL, "service": "http://127.0.0.1:9090", "originRequest": {"access": {"required": True, "teamName": "codigo5", "audTag": ["panel"]}}},
            {"hostname": ENTRY, "service": "http://127.0.0.1:18787", "originRequest": {"access": {"required": True, "teamName": "codigo5", "audTag": ["entry"]}}},
            {"hostname": TEAM, "service": "http://127.0.0.1:13300", "originRequest": {"access": {"required": True, "teamName": "codigo5", "audTag": ["team"]}}},
            {"service": "http_status:404"},
        ]}
        result = append_console(config, "console")
        self.assertEqual([row.get("hostname") for row in result["ingress"]], [PANEL, ENTRY, TEAM, HOST, None])
        self.assertEqual(result["ingress"][3]["originRequest"]["access"]["audTag"], ["console"])
        self.assertEqual(result["ingress"][3]["service"], ORIGIN)
        self.assertEqual(config["ingress"][-1], {"service": "http_status:404"})

    def test_rejects_already_extended_routes(self):
        config = {"ingress": [{"hostname": PANEL, "service": "http://127.0.0.1:9090", "originRequest": {"access": {"required": True, "teamName": "codigo5"}}}, {"service": "http_status:404"}]}
        with self.assertRaisesRegex(ValueError, "unexpected"):
            append_console(config, "console")


if __name__ == "__main__":
    unittest.main()
