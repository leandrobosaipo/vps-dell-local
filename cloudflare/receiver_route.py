"""Add a service-only hostname to the existing Dell tunnel without changing its panel."""
import copy
import json
from pathlib import Path
from provision import save

HOST='entrada-jp-dell.codigo5.com.br'
PANEL='painel-dell.codigo5.com.br'


def append_receiver(config,audience):
    entries=config['ingress']
    if len(entries)!=2 or entries[0].get('hostname')!=PANEL or entries[0].get('service')!='http://127.0.0.1:9090' or entries[1]!={'service':'http_status:404'}:
        raise ValueError('unexpected_existing_routes')
    prior=entries[0]['originRequest']['access']
    if not prior['required'] or not prior['teamName'] or not audience:
        raise ValueError('verified_access_required')
    desired=copy.deepcopy(config)
    desired['ingress'].insert(-1,dict(hostname=HOST,service='http://127.0.0.1:18787',originRequest={
        'access':{'required':True,'teamName':prior['teamName'],'audTag':[audience]}}))
    return desired


def apply(cf,ref,state_dir):
    if ref['hostname']!=PANEL:raise ValueError('wrong_tunnel')
    root=Path(state_dir);ap='accounts/'+ref['account'];z='zones/'+ref['zone'];t=ap+'/cfd_tunnel/'+ref['tunnelId']
    config=cf.request(t+'/configurations')['config'];append_receiver(config,'preflight')
    apps=cf.request(ap+'/access/apps?per_page=100');tokens=cf.request(ap+'/access/service_tokens?per_page=100')
    label='Coletor JP no Dell'
    if len(apps)>=100 or len(tokens)>=100 or any(a.get('domain')==HOST or a.get('name')==label for a in apps) or any(x['name']==label for x in tokens) or cf.request(z+'/dns_records?name='+HOST):
        raise ValueError('reconcile_existing_scope')
    root.mkdir(mode=0o700)
    save(root/'intent.json',dict(host=HOST,tunnelId=ref['tunnelId'],before=config))
    app=cf.request(ap+'/access/apps','POST',dict(name=label,type='self_hosted',domain=HOST,session_duration='12h',app_launcher_visible=False))
    save(root/'app.json',{'id':app['id'],'aud':app['aud']})
    token=cf.request(ap+'/access/service_tokens','POST',dict(name=label,duration='8760h'))
    save(root/'service-token.private.json',token)
    policy_path=ap+'/access/apps/'+app['id']+'/policies'
    condition=[{'service_token':{'token_id':token['id']}}]
    policy=cf.request(policy_path,'POST',dict(name='Somente origem JP',decision='non_identity',include=condition))
    save(root/'policy.json',{'id':policy['id']})
    policies=cf.request(policy_path)
    if len(policies)!=1 or policies[0]['decision']!='non_identity' or policies[0]['include']!=condition:raise ValueError('policy_drift')
    desired=append_receiver(config,app['aud'])
    if cf.request(t+'/configurations')['config']!=config:raise ValueError('concurrent_tunnel_edit')
    cf.request(t+'/configurations','PUT',{'config':desired})
    if cf.request(t+'/configurations')['config']!=desired:raise ValueError('route_readback_mismatch')
    if cf.request(z+'/dns_records?name='+HOST):raise ValueError('concurrent_dns_edit')
    target=ref['tunnelId']+'.cfargotunnel.com'
    dns=cf.request(z+'/dns_records','POST',dict(type='CNAME',name=HOST,content=target,proxied=True,ttl=1))
    save(root/'dns.json',{'id':dns['id']})
    live=cf.request(z+'/dns_records/'+dns['id'])
    if live['content']!=target or live['name']!=HOST or not live['proxied']:raise ValueError('dns_drift')
    save(root/'verified.json',dict(host=HOST,panelRoutePreserved=True,scope='service-only',realWebhookChanged=False))
