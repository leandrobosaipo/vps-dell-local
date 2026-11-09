"""Add one dedicated machine policy to the existing Evolution app; never change routing."""
import argparse,hashlib,json,os,pathlib,subprocess
from provision import Cloudflare,save

DOMAIN='evolution.codigo5.com.br'
TOKEN_NAME='VPS Dell local - Evolution JP'
POLICY_NAME='Dell Evolution JP service authentication'

def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def app_core(app):return {k:v for k,v in app.items() if k not in ('policies','updated_at','updatedAt')}
def policy_core(policy):return {k:v for k,v in policy.items() if k not in ('created_at','updated_at','createdAt','updatedAt')}
def scoped(app):
    if app.get('domain')!=DOMAIN or app.get('type')!='self_hosted':raise ValueError('Unexpected Access application')
    domains=app.get('self_hosted_domains') or [DOMAIN]
    destinations=app.get('destinations') or [{'type':'public','uri':DOMAIN}]
    if domains!=[DOMAIN] or destinations!=[{'type':'public','uri':DOMAIN}]:raise ValueError('Shared application refused')

def inspect(cf,baseline):
    assert len(baseline['matches'])==1
    saved=baseline['matches'][0];scoped(saved['app'])
    ap='accounts/'+baseline['account'];route=ap+'/access/apps/'+saved['app']['id']
    app=cf.request(route);scoped(app)
    policies=cf.request(route+'/policies')
    if digest(app_core(app))!=digest(app_core(saved['app'])):raise ValueError('Application drift')
    if digest(sorted((policy_core(x) for x in policies),key=lambda x:x['id']))!=digest(sorted((policy_core(x) for x in saved['policies']),key=lambda x:x['id'])):raise ValueError('Policy drift')
    if not policies or not any(x['decision']=='allow' for x in policies):raise ValueError('Human policy missing')
    tokens=cf.request(ap+'/access/service_tokens?per_page=100')
    if any(x.get('name')==TOKEN_NAME for x in tokens):raise ValueError('Existing token requires reconciliation')
    if any(x.get('name')==POLICY_NAME for x in policies):raise ValueError('Existing policy requires reconciliation')
    return ap,route,app,policies

def provision(cf,baseline,root,apply=False,source=None):
    ap,route,app,policies=inspect(cf,baseline)
    plan={'domain':DOMAIN,'appId':app['id'],'mode':'apply' if apply else 'plan','newTokenName':TOKEN_NAME,'tokenDuration':'8760h','existingHumanPolicies':len(policies),'dnsChanged':False,'tunnelChanged':False,'webhookChanged':False}
    if not apply:return plan
    root.mkdir(mode=0o700)
    save(root/'00-intent.json',{**plan,'source':source,'oldAppHash':digest(app_core(app))})
    save(root/'01-app-before.json',app);save(root/'02-policies-before.json',policies)
    token=cf.request(ap+'/access/service_tokens','POST',{'name':TOKEN_NAME,'duration':'8760h'})
    save(root/'03-token-private.json',token)
    if not all(token.get(k) for k in ('id','client_id','client_secret')):raise ValueError('Incomplete token response; reconcile private receipt')
    policy=None
    try:
        body={'name':POLICY_NAME,'decision':'non_identity','precedence':max((int(x.get('precedence') or 0) for x in policies),default=0)+1,'include':[{'service_token':{'token_id':token['id']}}]}
        policy=cf.request(route+'/policies','POST',body);save(root/'04-policy-created.json',policy)
        actual=cf.request(route+'/policies');again=cf.request(route)
        old={x['id']:policy_core(x) for x in policies}
        retained={x['id']:policy_core(x) for x in actual if x['id'] in old}
        if retained!=old or len(actual)!=len(policies)+1 or digest(app_core(again))!=digest(app_core(app)):raise ValueError('Readback drift; remove only newly created resources')
        matching=[x for x in actual if x['id']==policy['id']]
        if len(matching)!=1 or matching[0]['decision']!='non_identity' or matching[0]['include']!=body['include']:raise ValueError('Service policy readback failed')
        save(root/'05-policies-after.json',actual)
        result={**plan,'verified':True,'source':source,'account':baseline['account'],'policyId':policy['id'],'tokenId':token['id'],'expiresAt':token.get('expires_at'),'humanPoliciesPreserved':True,'appCorePreserved':True,'tokenSecretPrinted':False}
        save(root/'06-verified.json',result)
        return result
    except Exception:
        # Never overwrite the application or human policies during rollback.
        removed=[]
        if policy and policy.get('id'):
            cf.request(route+'/policies/'+policy['id'],'DELETE');removed.append('own_service_policy')
        cf.request(ap+'/access/service_tokens/'+token['id'],'DELETE');removed.append('own_service_token')
        save(root/'rollback.json',{'removed':removed,'oldPoliciesOverwritten':False})
        raise

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--credentials',required=True,type=pathlib.Path);p.add_argument('--baseline',required=True,type=pathlib.Path)
    p.add_argument('--state-dir',type=pathlib.Path);p.add_argument('--source-commit');p.add_argument('--script-sha256');p.add_argument('--apply',action='store_true')
    a=p.parse_args();baseline=json.loads(a.baseline.read_text())
    if a.apply:
        repo=pathlib.Path(__file__).resolve().parents[1]
        head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()
        dirty=subprocess.check_output(['git','status','--porcelain'],cwd=repo,text=True).strip()
        if dirty or head!=a.source_commit or hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()!=a.script_sha256 or not a.state_dir:raise ValueError('Published clean source required')
    result=provision(Cloudflare(a.credentials),baseline,a.state_dir,a.apply,a.source_commit)
    print(json.dumps(result))

if __name__=='__main__':
    try:main()
    except Exception as e:
        # Library failures can contain policy subjects or supplied secret values.
        print(json.dumps({'verified':False,'errorType':type(e).__name__,'action':'reconcile_private_receipts_before_retry'}));raise SystemExit(1)
