import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from configure_chatwoot_google_oauth import CALLBACK, load_client, update_env


class GoogleClientTests(unittest.TestCase):
    def client_file(self, secret="new-secret"):
        folder = tempfile.TemporaryDirectory()
        path = Path(folder.name) / "client.json"
        path.write_text(json.dumps({"web": {"project_id": "codigo5web", "client_id": "303491380903-newclient.apps.googleusercontent.com", "client_secret": secret, "redirect_uris": [CALLBACK]}}))
        os.chmod(path, 0o600)
        return folder, path

    def test_accepts_only_new_scoped_web_client(self):
        folder, path = self.client_file()
        self.addCleanup(folder.cleanup)
        result = load_client(path, hashlib.sha256(b"old-secret").hexdigest())
        self.assertEqual(result["project_id"], "codigo5web")

    def test_rejects_reused_secret(self):
        folder, path = self.client_file("old-secret")
        self.addCleanup(folder.cleanup)
        with self.assertRaisesRegex(ValueError, "rejected"):
            load_client(path, hashlib.sha256(b"old-secret").hexdigest())

    def test_rewrites_only_oauth_keys(self):
        text = "ENABLE_ACCOUNT_SIGNUP=false\nKEEP=this\nGOOGLE_OAUTH_CLIENT_ID=old\n"
        client = {"client_id": "new", "client_secret": "secret"}
        output = update_env(text, client)
        self.assertIn("GOOGLE_OAUTH_CALLBACK_URL=" + CALLBACK, output.splitlines())
        self.assertIn("ENABLE_ACCOUNT_SIGNUP=false", output)
        self.assertIn("KEEP=this", output)
        self.assertIn("GOOGLE_OAUTH_CLIENT_ID=new", output)
        self.assertIn("GOOGLE_OAUTH_REDIRECT_URI=" + CALLBACK, output)


if __name__ == "__main__":
    unittest.main()
