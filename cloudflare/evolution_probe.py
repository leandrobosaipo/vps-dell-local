"""Root-only, allowlisted GET client; has no send, session or configuration action."""
import argparse,json,os,pathlib,re,stat,urllib.error,urllib.parse,urllib.request

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args):return None

def validate(config):
    if config.get('origin')!='https://evolution.codigo5.com.br' or not re.fullmatch(r'[A-Za-z0-9_-]{1,96}',config.get('instance','')):raise ValueError('Unexpected target')
    if not all(isinstance(config.get(k),str) and 1<len(config[k])<1024 for k in ('token','client_id','client_secret')):raise ValueError('Missing authentication')

def probe(config,include_group=False,opener=None):
    validate(config);opener=opener or urllib.request.build_opener(NoRedirect())
    prefixes=['/instance/connectionState/','/webhook/find/']
    if include_group:
        if not re.fullmatch(r'[0-9-]{5,40}@g\.us',config.get('group_jid','')):raise ValueError('Verified configured group required')
        prefixes.append('/group/findGroupInfos/')
    rows=[]
    for prefix in prefixes:
        url=config['origin']+prefix+urllib.parse.quote(config['instance'],safe='')
        if prefix.startswith('/group/'):url+='?'+urllib.parse.urlencode({'groupJid':config['group_jid']})
        request=urllib.request.Request(url,method='GET',headers={'apikey':config['token'],'CF-Access-Client-Id':config['client_id'],'CF-Access-Client-Secret':config['client_secret']})
        try:
            with opener.open(request,timeout=20) as response:
                body=response.read(131072);row={'operation':prefix+'[configured-instance]','http':response.status}
                try:data=json.loads(body)
                except (ValueError,UnicodeError):data=None
                row['json']=isinstance(data,dict)
                if row['json'] and prefix.startswith('/instance/'):row['state']=data.get('instance',{}).get('state',data.get('state'))
                elif row['json'] and prefix.startswith('/webhook/'):
                    hook=data.get('webhook',data);row.update(enabled=hook.get('enabled'),events=hook.get('events'),url=hook.get('url'))
                elif row['json']:
                    members=[m.get('id') for m in data.get('participants',[])];allowed=config.get('allowed_members',[])
                    row.update(identityMatches=data.get('id')==config['group_jid'] and data.get('subject')==config.get('group_subject'),memberCount=len(members),authorizedMembersPresent=sum(m in members for m in allowed),configuredAuthorizedMembers=len(allowed))
                rows.append(row)
        except urllib.error.HTTPError as error:
            body=error.read(65536);error.close();reason='connection_closed' if b'Connection Closed' in body else 'http_error'
            rows.append({'operation':prefix+'[configured-instance]','http':error.code,'reason':reason})
        except Exception as error:rows.append({'operation':prefix+'[configured-instance]','errorType':type(error).__name__})
    return {'origin':config['origin'],'methods':['GET'],'results':rows,'sendActions':0,'sessionActions':0,'configurationActions':0}

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--group',action='store_true');args=parser.parse_args()
    path=pathlib.Path('/etc/jp-evolution-readonly/access.json');s=path.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or stat.S_IMODE(s.st_mode)!=0o600 or s.st_nlink!=1:raise ValueError('Private root credentials required')
    print(json.dumps(probe(json.loads(path.read_text()),args.group)))

if __name__=='__main__':
    try:main()
    except Exception as error:print(json.dumps({'verified':False,'errorType':type(error).__name__}));raise SystemExit(1)
