import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {bindWorkflows} from './bind_workflows.mjs';

test('preserve source-role boundaries while changing installation IDs',()=>{
 const ids=['qbTGp8gNxPaVp9GS','uAqdthOzrSBC9nQx','E0Ck1S5fr4fLpdfb',...Array.from({length:9},(_,i)=>String(i).padStart(16,'a'))];
 const rows=ids.map((sourceId,i)=>({sourceId,dellId:String(i).padStart(16,'b')}));
 const source="const n8nInboundWorkflowId='';function canReply(identity,workflowId){return !(identity.workflowId!=='E0Ck1S5fr4fLpdfb')&&workflowId==='E0Ck1S5fr4fLpdfb'}";
 const digest=createHash('sha256').update(source).digest('hex');
 const old={JP_N8N_STAGE_WORKFLOW_IDS:ids.slice(0,4).join(','),JP_N8N_INBOUND_WORKFLOW_ID:ids[6],JP_BRAND_N8N_WORKFLOW_ID:ids[8]};
 const {env,candidate}=bindWorkflows(rows,old,source,digest);
 assert.equal(env.JP_N8N_STAGE_WORKFLOW_IDS,rows.slice(0,4).map(r=>r.dellId).join(','));
 const run=Function('process','identity','workflowId',candidate+';return canReply(identity,workflowId)');
 assert.equal(run({env},{workflowId:rows[2].dellId},rows[2].dellId),true);
 assert.equal(run({env},{workflowId:ids[2]},ids[2]),false);
 assert.throws(()=>bindWorkflows(rows,{...old,JP_N8N_INBOUND_WORKFLOW_ID:'foreign'},source,digest));
 assert.throws(()=>bindWorkflows(rows,old,source+';',digest));
});
