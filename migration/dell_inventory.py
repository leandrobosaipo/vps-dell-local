"""Fixed, read-only Dell inventory through the authenticated Cockpit protocol."""
import base64
import http.cookiejar
import json
from pathlib import Path
import sys
import urllib.request
import websocket

CODE = r'''import json,os,shutil,subprocess
def run(args):
 p=subprocess.run(args,capture_output=True,text=True,timeout=20)
 if p.returncode: return {'error':'command_failed','exit':p.returncode}
 try:return json.loads(p.stdout)
 except ValueError:return p.stdout.strip()
d=shutil.disk_usage('/')
print(json.dumps({'hostname':run(['hostname']),'memory':dict((a.rstrip(':'),int(b.split()[0])*1024) for a,b in (l.split(':',1) for l in open('/proc/meminfo')) if a in ['MemTotal','MemAvailable']),'disk':{'total':d.total,'free':d.free},'containers':run(['docker','ps','-a','--format','{{json .}}']),'docker_images':run(['docker','image','ls','--format','{{json .}}']),'services':run(['systemctl','is-active','docker','cockpit.socket','vps-dell-cloudflared.service'])}))'''


def inventory(credentials):
    if credentials['url'] != 'https://painel-dell.codigo5.com.br' or credentials['username'] != 'delladmin':
        raise ValueError('inventory_destination_refused')
    base = credentials['url']
    jar = http.cookiejar.CookieJar()
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args):
            return None
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPCookieProcessor(jar))
    headers = {'CF-Access-Client-Id': credentials['cloudflare']['clientId'],
               'CF-Access-Client-Secret': credentials['cloudflare']['clientSecret']}
    auth = base64.b64encode((credentials['username'] + ':' + credentials['password']).encode()).decode()
    with opener.open(urllib.request.Request(base + '/cockpit/login', headers={**headers, 'Authorization': 'Basic ' + auth}), timeout=25) as response:
        if response.status != 200:
            raise ValueError('inventory_login_failed')
    cookies = '; '.join(c.name + '=' + c.value for c in jar
                        if 'painel-dell.codigo5.com.br'.endswith(c.domain.lstrip('.')))
    ws = websocket.create_connection(base.replace('https:', 'wss:') + '/cockpit/socket',
        header=[k + ': ' + v for k, v in headers.items()], cookie=cookies,
        origin=base, subprotocols=['cockpit1'], timeout=30)
    def control(value):
        ws.send('\n' + json.dumps(value))
    def frame():
        value = ws.recv()
        if isinstance(value, bytes):
            value = value.decode()
        if not value or len(value) > 131072:
            raise ValueError('inventory_frame_refused')
        return value.split('\n', 1)
    try:
        control({'command': 'init', 'version': 1})
        _, raw = frame()
        init = json.loads(raw)
        if init.get('command') != 'init' or init.get('problem'):
            raise ValueError('inventory_protocol_failed')
        ident = init.get('channel-seed', '') + 'readonly-inventory'
        control({'command': 'open', 'channel': ident, 'payload': 'stream',
                 'spawn': ['sudo', '-S', '-p', '', '/usr/bin/python3', '-c', CODE], 'err': 'ignore'})
        # Password is sent only in the encrypted channel, never argv or a file.
        ws.send(ident + '\n' + credentials['password'] + '\n')
        control({'command': 'done', 'channel': ident})
        output = ''
        for _ in range(100):
            channel, value = frame()
            if channel == ident:
                output += value
                if len(output) > 65536:
                    raise ValueError('inventory_output_refused')
            elif not channel:
                message = json.loads(value)
                if message.get('command') == 'close' and message.get('channel') == ident:
                    if message.get('problem') or message.get('exit-status') != 0:
                        raise ValueError('inventory_command_failed')
                    return json.loads(output)
        raise ValueError('inventory_incomplete')
    finally:
        ws.close()


if __name__ == '__main__':
    try:
        print(json.dumps(inventory(json.loads(Path(sys.argv[1]).read_text()))))
    except Exception as error:
        print(json.dumps({'state': 'inventory-failed', 'errorType': type(error).__name__}))
        raise SystemExit(1)
