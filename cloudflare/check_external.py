"""Read-only remote probe: Access, PAM and three fixed Cockpit terminal commands."""
import argparse
import http.cookiejar
import base64
import json
from pathlib import Path
import urllib.error
import urllib.request
import websocket


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def verify(credentials):
    if credentials['url'] != 'https://painel-dell.codigo5.com.br' or credentials['username'] != 'delladmin':
        raise ValueError('Unexpected probe destination or account')
    base = credentials['url']
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPCookieProcessor(jar))
    def get(path, headers):
        try:
            with opener.open(urllib.request.Request(base + path, headers=headers), timeout=25) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, {}
    unauth, _ = get('/ping', {})
    if unauth not in (302, 401, 403):
        raise ValueError('Anonymous access was not blocked')
    headers = {'CF-Access-Client-Id': credentials['cloudflare']['clientId'],
               'CF-Access-Client-Secret': credentials['cloudflare']['clientSecret']}
    status, ping = get('/ping', headers)
    if status != 200 or ping.get('service') != 'cockpit':
        raise ValueError('Authenticated tunnel probe failed')
    login_headers = {**headers, 'Authorization': 'Basic ' + base64.b64encode(
        (credentials['username'] + ':' + credentials['password']).encode()).decode()}
    status, _ = get('/cockpit/login', login_headers)
    if status != 200:
        raise ValueError('PAM authentication did not succeed')
    cookies = '; '.join(c.name + '=' + c.value for c in jar
                        if 'painel-dell.codigo5.com.br'.endswith(c.domain.lstrip('.')))
    socket = websocket.create_connection(base.replace('https:', 'wss:') + '/cockpit/socket',
        header=[k + ': ' + v for k, v in headers.items()], cookie=cookies,
        origin=base, subprotocols=['cockpit1'], timeout=25)
    try:
        def control(obj):
            socket.send('\n' + json.dumps(obj))
        def read():
            frame = socket.recv()
            if isinstance(frame, bytes):
                frame = frame.decode()
            if not frame or len(frame) > 131072:
                raise ValueError('Invalid bounded protocol frame')
            return frame.split('\n', 1)
        control({'command': 'init', 'version': 1})
        channel, frame = read()
        init = json.loads(frame)
        if channel or init.get('command') != 'init' or init.get('problem'):
            raise ValueError('Cockpit protocol did not initialize')
        checks = [('user', ['/usr/bin/id', '-un'], 'delladmin'),
                  ('host', ['/usr/bin/hostname'], 'agentes-lab'),
                  ('display', ['/usr/bin/hostnamectl', '--pretty'], 'VPS Dell local')]
        result = {}
        for index, (name, command, expected) in enumerate(checks):
            ident = str(init.get('channel-seed', '')) + 'probe' + str(index)
            control({'command': 'open', 'channel': ident, 'payload': 'stream', 'spawn': command})
            output = ''
            for _ in range(50):
                channel, frame = read()
                if channel == ident:
                    output += frame
                    if len(output) > 4096:
                        raise ValueError('Probe output exceeded bound')
                elif not channel:
                    message = json.loads(frame)
                    if message.get('command') == 'close' and message.get('channel') == ident:
                        if message.get('problem') or message.get('exit-status') != 0 or output.strip() != expected:
                            raise ValueError('Terminal consumer result differs')
                        result[name] = expected
                        break
            else:
                raise ValueError('Terminal probe did not finish')
        return {'state': 'external-terminal-verified', 'anonymousStatus': unauth,
                'accessServiceAuth': True, 'pamLogin': True, 'websocket': True, **result}
    finally:
        socket.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--credentials', required=True, type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(verify(json.loads(args.credentials.read_text()))))
    except Exception as error:
        # Library exceptions may contain response headers/cookies. Never print them.
        print(json.dumps({'state': 'verification-failed', 'errorType': type(error).__name__}))
        raise SystemExit(1)
