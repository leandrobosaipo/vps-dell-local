import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publishedGraph, inertCopy} from './workflows.mjs';
const fixture = {id: 'fictional', name: 'Test', versionId: 'draft', activeVersionId: 'published', nodes: [{name: 'wrong-draft'}],
  activeVersion: {versionId: 'published', nodes: [{name: 'timer', type: 'schedule', parameters: {}, credentials: {header: {id: 'test-ref'}}}], connections: {}}};
test('uses published graph even when newer draft exists', () => {
  assert.equal(publishedGraph(fixture).nodes[0].name, 'timer');
  const result = inertCopy(fixture);
  assert.equal(result.artifact.active, false);
  assert.equal(result.artifact.nodes[0].disabled, true);
  assert.equal(result.artifact.nodes[0].credentials, undefined);
  assert.equal(result.artifact.settings.errorWorkflow, undefined);
  assert.equal(result.provenance.credentialReferences[0].id, 'test-ref');
});
test('does not silently export a draft when published graph is absent', () => {
  assert.throws(() => publishedGraph({...fixture, activeVersion: null}), /published_graph_unavailable/);
});
