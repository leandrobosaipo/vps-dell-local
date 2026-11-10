import copy
import unittest
from staged_graph import staged_graph


class StagedGraphTest(unittest.TestCase):
    def test_draft_remaps_only_recognised_http_and_webhook_nodes(self):
        key='0123456789abcdef'
        graph={'name':'Fixture','active':False,'settings':{},'connections':{},'nodes':[
            {'type':'n8n-nodes-base.httpRequest','id':'node-a','parameters':{'url':'http://jp-attendance-api:8791/api/n8n/inbound'},'disabled':True},
            {'type':'n8n-nodes-base.webhook','id':'node-b','parameters':{'path':'existing'},'disabled':True}]}
        original=copy.deepcopy(graph)
        draft=staged_graph(key,graph)
        self.assertEqual(graph,original)
        self.assertTrue(draft['nodes'][0]['parameters']['url'].startswith('http://jp-core-dell:8791/'))
        self.assertTrue(draft['nodes'][1]['parameters']['path'].endswith('node-b'))
        for modification in [{'disabled':False},{'credentials':{'x':'fixture'}},{'parameters':{'url':'https://example.invalid/send'}}]:
            invalid=copy.deepcopy(graph)
            invalid['nodes'][0].update(modification)
            with self.assertRaises(ValueError):staged_graph(key,invalid)
