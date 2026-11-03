import {readFileSync} from 'node:fs';
import {eligible} from '../../integrations/superagent-context/protocol.mjs';
const cases=JSON.parse(readFileSync(new URL('./cases.json',import.meta.url)));
const routing=cases.map(c=>({id:c.id,passed:eligible({device_id:'android-owner',intent:c.intent,owner_voice:c.owner},'android-owner')===c.route}));
if(routing.some(c=>!c.passed))throw new Error('Source routing contract regressed');
const path=process.argv[2];
if(!path) {
  console.log(JSON.stringify({routing_contract:{passed:routing.length,total:cases.length},task_decision_benchmark:{status:'not_run',reason:'No real Super Agent predictions/evidence supplied. Contract tests do not measure model task accuracy.'}},null,2));
} else {
  const results=JSON.parse(readFileSync(path,'utf8'));
  if(!Array.isArray(results)||results.length!==cases.length||new Set(results.map(r=>r.id)).size!==cases.length)throw new Error('Need exactly one actual result per case');
  const graded=cases.map(c=>{
    const r=results.find(r=>r.id===c.id);
    if(!r||typeof r.evidence!=='string'||!r.evidence.trim())throw new Error(`Missing independent result evidence: ${c.id}`);
    return {id:c.id,passed:r.decision===c.expected,expected:c.expected,actual:r.decision,evidence:r.evidence};
  });
  console.log(JSON.stringify({routing_contract:{passed:routing.length,total:cases.length},task_decisions:{passed:graded.filter(r=>r.passed).length,total:graded.length,results:graded}},null,2));
  if(graded.some(r=>!r.passed))process.exitCode=1;
}
