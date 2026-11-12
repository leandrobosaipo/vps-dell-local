"""Translate an inert n8n export into a uniquely named, inactive Dell draft."""
import copy
import re
from urllib.parse import urlsplit


def staged_graph(source_id, export):
    if not re.fullmatch(r'[A-Za-z0-9]{16}', source_id) or export.get('active') is not False:
        raise ValueError('invalid_inert_source')
    graph = copy.deepcopy(export)
    graph['name'] = 'JP Dell · '+source_id+' · '+graph['name']
    for node in graph['nodes']:
        if node.get('disabled') is not True or node.get('credentials') or node.get('webhookId'):
            raise ValueError('unexpected_live_node')
        params = node['parameters']
        if node['type'] == 'n8n-nodes-base.httpRequest':
            url = urlsplit(params['url'])
            if url.scheme != 'http' or url.netloc != 'jp-attendance-api:8791' or url.query or url.fragment or not re.fullmatch(r'/(api/[a-z0-9/-]+|healthz)',url.path):
                raise ValueError('unknown_service_route')
            params['url'] = 'http://jp-core-dell:8791'+url.path
        elif node['type'] == 'n8n-nodes-base.webhook':
            params['path'] = 'jp-dell-preparacao-'+source_id.lower()+'-'+node['id']
    if graph.get('staticData') or graph.get('pinData') or graph['settings'].get('errorWorkflow'):
        raise ValueError('unexpected_runtime_state')
    return {k:graph[k] for k in ('name','nodes','connections','settings')}
