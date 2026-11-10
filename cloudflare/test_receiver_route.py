import unittest
from receiver_route import append_receiver

class ReceiverRouteTest(unittest.TestCase):
    def test_preserves_panel_and_fallback(self):
        config={'ingress':[{'hostname':'painel-dell.codigo5.com.br','service':'http://127.0.0.1:9090','originRequest':{'access':{'required':True,'teamName':'sample','audTag':['old']}}},{'service':'http_status:404'}]}
        result=append_receiver(config,'new')
        self.assertEqual([result['ingress'][0],result['ingress'][2]],config['ingress'])
        self.assertEqual(result['ingress'][1]['originRequest']['access']['audTag'],['new'])
        with self.assertRaises(ValueError):append_receiver(result,'new')
