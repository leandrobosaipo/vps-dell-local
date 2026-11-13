"""Bind the four cloned inbound nodes to the Dell queue without changing the graph topology."""
import copy
import re
import uuid
from urllib.parse import urlsplit


def with_receipt_resume(graph):
    """Add the private n8n continuation stage to an already bound four-node candidate."""
    if graph.get('active') or len(graph['nodes'])!=4:raise ValueError('expected_inactive_four_node_inbound')
    bound=copy.deepcopy(graph)
    process,=[n for n in bound['nodes'] if n['type']=='n8n-nodes-base.httpRequest']
    params=process['parameters']
    origin=urlsplit(params['url'])
    if origin.scheme!='http' or origin.port!=8787 or not re.fullmatch(r'jp-[a-z0-9-]+',origin.hostname or '') or origin.path!='/process' or origin.query or origin.fragment or origin.username or origin.password:
        raise ValueError('unexpected_process_target')
    if params['method']!='POST' or set(process['credentials'])!={'httpHeaderAuth'}:raise ValueError('unbound_consumer')
    edges=bound['connections'][process['name']]['main']
    if len(edges)!=2 or any(len(branch)!=1 for branch in edges):raise ValueError('unexpected_process_edges')
    stage=copy.deepcopy(process)
    stage['id']=str(uuid.uuid5(uuid.NAMESPACE_URL,process['id']+'/receipt-resume'))
    stage['name']='Retomar arte após recibo e conferir pausa humana'
    stage['position']=[process['position'][0]+210,process['position'][1]]
    stage['parameters']['url']=origin._replace(path='/resume').geturl()
    if params.get('options',{}).get('response',{}).get('response',{}).get('fullResponse') is not True:
        raise ValueError('expected_full_http_response')
    stage['parameters']['jsonBody']='={{ {record_id:$json.body.record_id} }}'
    stage['retryOnFail']=False
    guard={'id':str(uuid.uuid5(uuid.NAMESPACE_URL,process['id']+'/check-confirmation')),
           'name':'Há uma continuação autorizável?', 'type':'n8n-nodes-base.if','typeVersion':2.2,
           'position':[process['position'][0]+105,process['position'][1]],
           'parameters':{'conditions':{'options':{'caseSensitive':True,'leftValue':'','typeValidation':'strict','version':2},
                'conditions':[{'id':str(uuid.uuid4()),'leftValue':'={{ $json.statusCode === 200 && $json.body?.resume_pending === true }}',
                    'rightValue':'','operator':{'type':'boolean','operation':'true','singleValue':True}}],
                'combinator':'and'},'options':{}}}
    bound['nodes'].extend([guard,stage]);bound['connections'][stage['name']]={'main':copy.deepcopy(edges)}
    bound['connections'][guard['name']]={'main':[[{'node':stage['name'],'type':'main','index':0}],copy.deepcopy(edges[0])]}
    edges[0]=[{'node':guard['name'],'type':'main','index':0}]
    return bound


def bind_incoming(row, trigger, consumer, hook):
    if row['active'] or row.get('activeVersionId') or row.get('pinData') or row.get('staticData'):
        raise ValueError('expected_inactive_draft')
    if not re.fullmatch('[a-zA-Z0-9-]{12,150}', hook) or trigger['id'] == consumer['id']:
        raise ValueError('invalid_binding')
    nodes = copy.deepcopy(row['nodes'])
    types = []
    for node in nodes:
        if node.pop('disabled', None) is not True or node.get('credentials'):
            raise ValueError('draft_already_bound')
        kind = node['type'].split('.')[-1]
        types.append(kind)
        params = node['parameters']
        if kind == 'webhook':
            params.update(httpMethod='POST', path=hook, authentication='headerAuth', responseMode='responseNode')
            node.pop('webhookId', None)
            node['credentials'] = {'httpHeaderAuth':trigger}
        elif kind == 'httpRequest':
            url = urlsplit(params['url'])
            if url.hostname != 'jp-core-dell' or url.path != '/api/n8n/inbound' or url.query or url.fragment:
                raise ValueError('unexpected_original_route')
            params.update(url='http://jp-entrada-operacional:8787/process', method='POST',
                authentication='genericCredentialType', genericAuthType='httpHeaderAuth', sendBody=True,
                specifyBody='json', jsonBody='={{ $json.body }}', sendHeaders=True,
                headerParameters={'parameters':[
                    {'name':'X-JP-n8n-workflow-id','value':'={{ $workflow.id }}'},
                    {'name':'X-JP-n8n-execution-id','value':'={{ $execution.id }}'}]})
            params['options']={'timeout':135000, 'redirect':{'redirect':{'followRedirects':False}},
                'response':{'response':{'responseFormat':'json','fullResponse':True,'neverError':True}}}
            node['credentials'] = {'httpHeaderAuth':consumer}
        elif kind != 'respondToWebhook':
            raise ValueError('unexpected_node')
    if sorted(types) != sorted(['webhook','httpRequest','respondToWebhook','respondToWebhook']):
        raise ValueError('unexpected_graph')
    settings=copy.deepcopy(row['settings'])
    if any(settings.get(k) != v for k,v in {'saveExecutionProgress':False,'saveManualExecutions':False,
        'saveDataErrorExecution':'none','saveDataSuccessExecution':'none'}.items()):
        raise ValueError('retention_mismatch')
    return {k:copy.deepcopy(row[k]) for k in ('name','connections','versionId')} | {'nodes':nodes,'settings':settings}
