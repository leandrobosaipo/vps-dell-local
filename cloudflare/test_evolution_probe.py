import io,json,unittest,urllib.error
from evolution_probe import probe

class Tests(unittest.TestCase):
    def config(self):return {'origin':'https://evolution.codigo5.com.br','instance':'fixture','token':'fixture-key','client_id':'fixture-id','client_secret':'fixture-secret'}
    def test_every_operation_is_get_with_both_layers_of_auth(self):
        requests=[]
        class Opener:
            def open(self,r,timeout):
                requests.append(r);value=io.BytesIO(json.dumps({'instance':{'state':'open'}}).encode());value.status=200;return value
        result=probe(self.config(),opener=Opener())
        self.assertEqual(len(requests),2)
        self.assertTrue(all(r.get_method()=='GET' and r.get_header('Apikey')=='fixture-key' and r.get_header('Cf-access-client-secret')=='fixture-secret' for r in requests))
        self.assertEqual(result['sessionActions'],0);self.assertNotIn('fixture-secret',json.dumps(result))
    def test_redirect_is_failure_not_login_or_secret_forward(self):
        calls=[]
        class Opener:
            def open(self,r,timeout):calls.append(r);raise urllib.error.HTTPError(r.full_url,302,'redirect',{},io.BytesIO(b''))
        result=probe(self.config(),opener=Opener());self.assertEqual([r['http'] for r in result['results']],[302,302]);self.assertEqual(len(calls),2)
    def test_other_host_and_unverified_instance_are_refused(self):
        for change in ({'origin':'https://other.invalid'},{'instance':'../other'}):
            with self.assertRaises(ValueError):probe({**self.config(),**change})
    def test_group_requires_configured_id_and_preserves_connection_error(self):
        with self.assertRaises(ValueError):probe(self.config(),True)
        class Opener:
            def open(self,r,timeout):raise urllib.error.HTTPError(r.full_url,404,'group',{},io.BytesIO(b'{"message":"Connection Closed"}'))
        result=probe({**self.config(),'group_jid':'123456789@g.us'},True,Opener())
        self.assertEqual(result['results'][-1]['reason'],'connection_closed')

if __name__=='__main__':unittest.main()
