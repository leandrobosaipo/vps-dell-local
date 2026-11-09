import copy,json,tempfile,unittest
from pathlib import Path
from evolution_access import DOMAIN,POLICY_NAME,TOKEN_NAME,provision

class Fake:
    def __init__(self):
        self.app={'id':'app','domain':DOMAIN,'type':'self_hosted','self_hosted_domains':[DOMAIN],'destinations':[{'type':'public','uri':DOMAIN}]}
        self.policies=[{'id':'human','name':'human','decision':'allow','precedence':1,'include':[{'email':{'email':'fixture@example.invalid'}}]}]
        self.baseline={'account':'account','matches':[{'app':copy.deepcopy(self.app),'policies':copy.deepcopy(self.policies)}]};self.calls=[]
    def request(self,path,method='GET',data=None):
        self.calls.append((method,path,data))
        if method=='GET':return copy.deepcopy(self.policies if path.endswith('/policies') else [] if '/service_tokens?' in path else self.app)
        if path.endswith('/service_tokens') and method=='POST':return {'id':'new-token','client_id':'fixture-id','client_secret':'fixture-secret','expires_at':'fixture-expiry'}
        if path.endswith('/policies') and method=='POST':
            value={'id':'new-policy',**data};self.policies.append(value);return copy.deepcopy(value)
        if method=='DELETE' and path.endswith('/policies/new-policy'):
            self.policies=[p for p in self.policies if p['id']!='new-policy'];return None
        if method=='DELETE' and path.endswith('/service_tokens/new-token'):return None
        raise AssertionError('Unexpected mutation')

class Tests(unittest.TestCase):
    def test_plan_is_get_only(self):
        cf=Fake();result=provision(cf,cf.baseline,None)
        self.assertEqual(result['mode'],'plan');self.assertTrue(all(x[0]=='GET' for x in cf.calls))
    def test_only_one_new_token_and_policy_preserves_human_access(self):
        cf=Fake();old=copy.deepcopy(cf.policies)
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)/'new';r=provision(cf,cf.baseline,root,True,'source')
            self.assertTrue(r['humanPoliciesPreserved']);self.assertEqual(cf.policies[:1],old)
            self.assertEqual([x[0] for x in cf.calls if x[0]!='GET'],['POST','POST'])
            self.assertEqual((root/'03-token-private.json').stat().st_mode&0o777,0o600)
            self.assertNotIn('client_secret',json.dumps(r))
    def test_shared_app_is_refused_before_creation(self):
        cf=Fake();cf.app['self_hosted_domains'].append('other.example.invalid');cf.baseline['matches'][0]['app']=copy.deepcopy(cf.app)
        with self.assertRaisesRegex(ValueError,'Shared'):provision(cf,cf.baseline,None)
        self.assertFalse(any(x[0]!='GET' for x in cf.calls))
    def test_drift_is_refused_before_creation(self):
        cf=Fake();cf.policies[0]['include']=[]
        with self.assertRaisesRegex(ValueError,'drift'):provision(cf,cf.baseline,None)
        self.assertFalse(any(x[0]!='GET' for x in cf.calls))
    def test_failed_readback_removes_only_own_resources_and_keeps_concurrent_human_edit(self):
        class Changed(Fake):
            def request(self,path,method='GET',data=None):
                if method=='GET' and path.endswith('/policies') and len(self.policies)>1:self.policies[0]['name']='concurrent-human-edit'
                return super().request(path,method,data)
        cf=Changed()
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)/'new'
            with self.assertRaisesRegex(ValueError,'Readback drift'):provision(cf,cf.baseline,root,True,'source')
            self.assertEqual(cf.policies,[{'id':'human','name':'concurrent-human-edit','decision':'allow','precedence':1,'include':[{'email':{'email':'fixture@example.invalid'}}]}])
            self.assertEqual([x[1].split('/')[-1] for x in cf.calls if x[0]=='DELETE'],['new-policy','new-token'])
            self.assertFalse(any(x[0]=='PUT' for x in cf.calls))

if __name__=='__main__':unittest.main()
