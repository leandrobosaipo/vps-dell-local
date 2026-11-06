// Preparation-stage report only. This tool has no cutover or production action.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {digest} from './snapshot.mjs';

export function assess(dir) {
  const read = name => JSON.parse(fs.readFileSync(path.join(dir, name)));
  const capture = read('capture.json'), restore = read('restore-readback.json');
  const sources = read('runtime-source-manifest.json');
  assert.equal(capture.source_image, restore.sourceImage, 'source_image_drift');
  assert.equal(sources.image, restore.sourceImage, 'source_manifest_image_drift');
  assert.equal(digest(fs.readFileSync(path.join(dir, 'state-A.encrypted.json'))), capture.state_sha256, 'snapshot_artifact_changed');
  assert.equal(restore.restore.sourceSha256, capture.state_sha256, 'snapshot_proof_changed');
  for (const row of sources.files) {
    assert.match(row.name, /^[a-zA-Z0-9_.-]+$/);
    assert.equal(digest(fs.readFileSync(path.join(dir, 'active-runtime/scripts', row.name))), row.sha256, 'captured_source_changed');
  }
  const workflows = read('inert-workflows/manifest.json');
  assert.equal(workflows.imported, false, 'unexpected_workflow_import');
  for (const row of workflows.workflows) {
    const artifact = read('inert-workflows/' + row.id + '.json');
    assert.equal(artifact.active, false, 'workflow_activation_refused');
    assert.equal(artifact.nodes.every(n => n.disabled === true && !n.credentials), true, 'workflow_effect_surface_refused');
  }
  const dell = read('dell-inventory.json');
  return {stage: 'prepare_only', decision: 'NO_GO', productionMutations: 0,
    proven: {sourceImage: restore.sourceImage, sourceFiles: sources.files.length,
      stateRestoredUsingCapturedConsumer: restore.restore.capturedConsumerLoad,
      recordsReconciled: restore.restore.arrayRecordsVerified, workflowsPrepared: workflows.workflows.length,
      workflowsImported: false, sourceCheckoutDifferences: restore.checkoutDifferentFiles.length,
      dellMemoryBytes: dell.memory.MemTotal, dellDiskFreeBytes: dell.disk.free},
    blockers: ['target_attendance_pilot_not_installed_or_approved',
      'no_exact_target_image_consumer_proof', 'no_service_wide_consistent_backup_restore',
      'no_writer_fence_and_final_delta_capture', 'no_cross_host_authenticated_evolution_integration',
      'no_target_group_protocol_e2e', 'native_group_receipt_handler_no_webhook_updates', 'no_host_reboot_recovery_proof',
      'no_deploy_enforcement_proof', 'no_windows_update_coverage_proof',
      'no_new_events_rollback_rehearsal'],
    limitations: ['snapshot restore ran offline on the Mac, not in the target service',
      'published workflows are inert artifacts, not imported instances',
      'execution rows marked new do not prove current queue health',
      'receipts and unknown outcomes remain unchanged; no replay is authorized'],
    next: 'complete isolated target pilot and its proofs before requesting cutover authorization'};
}

if (process.argv[1]?.endsWith('/preflight.mjs')) {
  try {console.log(JSON.stringify(assess(path.resolve(process.argv[2])), null, 2));}
  catch (error) {
    console.log(JSON.stringify({stage: 'prepare_only', decision: 'NO_GO', errorType: error.name}));
    process.exitCode = 1;
  }
}
