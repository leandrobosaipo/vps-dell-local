"""Publish only the Dell Chatwoot origin, requiring the specified operator's Cloudflare login."""
from copy import deepcopy
from pathlib import Path
from provision import save

HOST='equipe-jp-dell.codigo5.com.br'

def apply(cf,ref,state,email):
    root=Path(state);ap='accounts/'+ref['account'];zone='zones/'+ref['zone'];t=ap+'/cfd_tunnel/'+ref['tunnelId']+'/configurations'
    cfg=cf.request(t)['config'];rules=cfg['ingress']
    if [r.get('hostname') for r in rules]!=['painel-dell.codigo5.com.br','entrada-jp-dell.codigo5.com.br',None] or rules[-1]!={'service':'http_status:404'}:
        raise ValueError('tunnel_route_drift')
    apps=cf.request(ap+'/access/apps?per_page=100')
    if len(apps)>=100 or any(a.get('domain')==HOST for a in apps) or cf.request(zone+'/dns_records?name='+HOST):
        raise ValueError('host_not_available')
    otp,=[r['id'] for r in cf.request(ap+'/access/identity_providers') if r.get('type')=='onetimepin']
    root.mkdir(mode=0o700)
    save(root/'intent.json',dict(before=cfg,domain=HOST))
    app=cf.request(ap+'/access/apps','POST',dict(domain=HOST,name='Equipe JP no Dell',type='self_hosted',allowed_idps=[otp],session_duration='8h',app_launcher_visible=False))
    save(root/'app.json',{'id':app['id'],'aud':app['aud']})
    path=ap+'/access/apps/'+app['id']+'/policies';include=[{'email':{'email':email}}]
    policy=cf.request(path,'POST',dict(name='Operador autorizado da JP',decision='allow',include=include))
    save(root/'policy.json',{'id':policy['id']});policies=cf.request(path)
    if len(policies)!=1 or policies[0]['decision']!='allow' or policies[0]['include']!=include:
        raise ValueError('policy_not_exclusive')
    before=rules[0]['originRequest']['access']
    if not before['required'] or not before['teamName']:raise ValueError('access_unverified')
    desired=deepcopy(cfg);desired['ingress'].insert(-1,dict(hostname=HOST,service='http://127.0.0.1:13300',originRequest={'access':dict(required=True,teamName=before['teamName'],audTag=[app['aud']])}))
    if cf.request(t)['config']!=cfg:raise ValueError('concurrent_tunnel_edit')
    cf.request(t,'PUT',{'config':desired})
    if cf.request(t)['config']!=desired:raise ValueError('tunnel_readback')
    if cf.request(zone+'/dns_records?name='+HOST):raise ValueError('concurrent_dns_edit')
    target=ref['tunnelId']+'.cfargotunnel.com'
    rr=cf.request(zone+'/dns_records','POST',dict(name=HOST,type='CNAME',content=target,proxied=True,ttl=1))
    save(root/'dns.json',{'id':rr['id']});rr=cf.request(zone+'/dns_records/'+rr['id'])
    if rr['name']!=HOST or rr['content']!=target or not rr['proxied']:raise ValueError('dns_readback')
    result={'hostname':HOST,'otpOnly':True,'operatorCount':1,'oldRoutesPreserved':True}
    save(root/'readback.json',result);return result
