// Build an inert, selective migration artifact. Does not call n8n or import it.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {digest, canonical} from './snapshot.mjs';

export function publishedGraph(workflow) {
  assert.equal(typeof workflow.activeVersionId, 'string', 'published_version_missing');
  const active = workflow.activeVersion;
  if (active?.versionId === workflow.activeVersionId) return active;
  assert.equal(workflow.versionId, workflow.activeVersionId, 'published_graph_unavailable');
  return workflow;
}

export function inertCopy(workflow) {
  const source = publishedGraph(workflow);
  assert.equal(Array.isArray(source.nodes), true, 'published_nodes_missing');
  const credentials = source.nodes.flatMap(n => Object.entries(n.credentials || {}).map(([type, ref]) => ({node: n.name, type, id: ref.id})));
  const nodes = structuredClone(source.nodes).map(node => {
    delete node.credentials;
    delete node.webhookId;
    node.disabled = true;
    return node;
  });
  const settings = {timezone: 'America/Cuiaba', saveExecutionProgress: false, saveManualExecutions: false,
    saveDataErrorExecution: 'none', saveDataSuccessExecution: 'none'};
  return {artifact: {name: workflow.name, active: false, nodes, connections: source.connections || {}, settings,
    staticData: null, pinData: {}}, provenance: {id: workflow.id, publishedVersion: workflow.activeVersionId,
    draftVersion: workflow.versionId, graphSha256: digest(canonical({nodes: source.nodes, connections: source.connections || {}})),
    draftDiffers: workflow.activeVersionId !== workflow.versionId, credentialReferences: credentials,
    imported: false, allNodesDisabled: true, endpointsRemapped: false}};
}

if (process.argv[1]?.endsWith('/workflows.mjs')) {
  try {
    const [sourceDir, manifestFile, outputDir] = process.argv.slice(2);
    const rows = JSON.parse(fs.readFileSync(manifestFile)).workflows;
    assert.equal(rows.length > 0, true, 'workflow_allowlist_empty');
    assert.equal(new Set(rows.map(r => r.id)).size, rows.length, 'workflow_allowlist_ambiguous');
    fs.mkdirSync(outputDir, {mode: 0o700});
    const results = [];
    for (const row of rows) {
      assert.match(row.id, /^[A-Za-z0-9_-]+$/);
      const workflow = JSON.parse(fs.readFileSync(path.join(sourceDir, row.id + '.json')));
      assert.equal(workflow.id, row.id);
      assert.equal(workflow.activeVersionId, row.published, 'workflow_published_drift');
      const {artifact, provenance} = inertCopy(workflow);
      fs.writeFileSync(path.join(outputDir, row.id + '.json'), JSON.stringify(artifact, null, 2), {mode: 0o600, flag: 'wx'});
      results.push(provenance);
    }
    fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify({productionMutations: 0, imported: false, workflows: results}, null, 2), {mode: 0o600, flag: 'wx'});
    console.log(JSON.stringify({prepared: results.length, imported: false, allNodesDisabled: true, publishedDraftDifferences: results.filter(r => r.draftDiffers).length}));
  } catch (error) {
    console.log(JSON.stringify({state: 'workflow_artifact_failed', errorType: error.name}));
    process.exitCode = 1;
  }
}
