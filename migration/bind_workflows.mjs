// Map workflow permissions to the Dell's new IDs. Historical records keep their original identifiers.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export function bindWorkflows(rows,oldConfig,source,expectedDigest){
  assert.equal(createHash('sha256').update(source).digest('hex'),expectedDigest,'unexpected_runtime_source');
  const roles=new Map(rows.map(r=>[r.sourceId,r.dellId]));
  assert.equal(roles.size,12);
  assert.equal(new Set(roles.values()).size,12);
  for(const [old,next] of roles)assert(/^[a-zA-Z0-9]{16}$/.test(old)&&/^[a-zA-Z0-9]{16}$/.test(next)&&!roles.has(next));
  const resolve=id=>{assert(roles.has(id),'unknown_source_workflow');return roles.get(id)};
  const env={
    JP_N8N_STAGE_WORKFLOW_IDS:oldConfig.JP_N8N_STAGE_WORKFLOW_IDS.split(',').map(id=>resolve(id.trim())).join(','),
    JP_N8N_INBOUND_WORKFLOW_ID:resolve(oldConfig.JP_N8N_INBOUND_WORKFLOW_ID),
    JP_BRAND_N8N_WORKFLOW_ID:resolve(oldConfig.JP_BRAND_N8N_WORKFLOW_ID),
    JP_N8N_BATCH_WORKFLOW_ID:resolve(oldConfig.JP_N8N_BATCH_WORKFLOW_ID||'qbTGp8gNxPaVp9GS'),
    JP_N8N_REACTIVATION_WORKFLOW_ID:resolve(oldConfig.JP_N8N_REACTIVATION_WORKFLOW_ID||'uAqdthOzrSBC9nQx'),
    JP_N8N_REPLY_WORKFLOW_ID:resolve('E0Ck1S5fr4fLpdfb'),
  };
  const anchor="const n8nInboundWorkflowId=";
  assert.equal(source.split(anchor).length,2);
  const literal="'E0Ck1S5fr4fLpdfb'";
  assert.equal(source.split(literal).length,3);
  for(const check of ['identity.workflowId!==','workflowId==='])assert(source.includes(check+literal));
  const candidate=source.replaceAll(literal,'n8nReplyWorkflowId')
    .replace(anchor,"const n8nReplyWorkflowId=process.env.JP_N8N_REPLY_WORKFLOW_ID||"+literal+";\n"+anchor);
  return {env,candidate};
}
