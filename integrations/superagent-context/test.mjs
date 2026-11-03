import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {ContextStore,sha} from './store.mjs';
import {makeServer} from './server.mjs';
import {makeKind,apply} from './source.mjs';
import {SOURCE,BOT,triggerFor,eligible} from './protocol.mjs';

const deviceToken='d'.repeat(40),agentToken='a'.repeat(40),workerToken='w'.repeat(40);
const audio=Buffer.concat([Buffer.from([0,0,0,32]),Buffer.from('ftypM4A '),Buffer.alloc(30)]);
const now=1800000000000;
function fixture(id='chunk-1',changes={}) {
  return {metadata:{id,device_id:'android-owner',session_id:'discussion-1',intent:'ambient',started_ms:now-60000,ended_ms:now,time_zone:'Asia/Shanghai',mime_type:'audio/mp4',sequence:0,location:null,...changes},audio_base64:audio.toString('base64')};
}
function analysis(job,changes={}) {return {...job,model:'test-timed-ASR',utterances:[{start_ms:100,end_ms:10000,text:'Agent，帮我把云端工作台的需求整理成方案。'}],owner_voice:{status:'detected',intervals:[{start_ms:100,end_ms:9000,score:.9}]},...changes};}
function setup(t) {
  const root=mkdtempSync(join(tmpdir(),'agentone-context-test-'));let clock=now;
  const store=new ContextStore(root,'android-owner',()=>clock);
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  return {store,root,advance:n=>clock+=n};
}
async function serving(t,store) {
  const server=makeServer({store,deviceToken,agentToken,workerToken});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const base=`http://127.0.0.1:${server.address().port}/`;
  const call=async(role,path,body)=>{
    const response=await fetch(new URL(path,base),{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${{device:deviceToken,agent:agentToken,worker:workerToken}[role]}`,...body===undefined?{}:{'content-type':'application/json'}},...body===undefined?{}:{body:JSON.stringify(body)}});
    return {status:response.status,body:await response.json()};
  };
  return {base,call};
}

test('immutable ingest retries preserve source; conflicting replay cannot overwrite audio',t=>{
  const {store}=setup(t);assert.equal(store.ingest(fixture()).duplicate,false);assert.equal(store.ingest(fixture()).duplicate,true);
  assert.throws(()=>store.ingest(fixture('chunk-1',{intent:'command'})),/different content/);
  const job=store.claim();assert.equal(sha(store.audio(job.id,job.lease)),job.sha256);
});
test('device binding, invalid intervals, timezone, fake audio and oversized input are rejected',t=>{
  const {store}=setup(t);
  for(const changes of [{device_id:'other'},{session_id:'../../evil'},{ended_ms:now+1000000},{started_ms:now-200000},{time_zone:'invalid'},{location:{source:'manual',latitude:1,longitude:2,accuracy_m:10,sampled_ms:now}}])assert.throws(()=>store.ingest(fixture('bad',changes)));
  assert.throws(()=>store.ingest({...fixture(),audio_base64:Buffer.alloc(100).toString('base64')}),/container/);
});
test('stale leases cannot submit; failed ASR remains queued, not an empty successful transcript',t=>{
  const {store,advance}=setup(t);store.ingest(fixture());const old=store.claim();advance(600001);const current=store.claim();
  assert.throws(()=>store.analyze(analysis(old)),/expired/);
  assert.deepEqual(store.analyze({...current,error:'ASR failed'}),{accepted:false,retry:true});assert.equal(store.events().length,0);assert.equal(store.health().failed,1);
  assert.equal(store.claim(),null);advance(60001);const retry=store.claim();assert.ok(retry);store.analyze(analysis(retry));assert.equal(store.health().failed,0);
});
test('analysis requires matching audio hash, bounded text offsets and timed owner evidence',t=>{
  const {store}=setup(t);store.ingest(fixture());const job=store.claim();
  assert.throws(()=>store.analyze(analysis(job,{sha256:'wrong'})),/hash/);
  assert.throws(()=>store.analyze(analysis(job,{utterances:[{start_ms:0,end_ms:100000,text:'x'}]})),/utterance/);
  assert.throws(()=>store.analyze(analysis(job,{owner_voice:{status:'detected',intervals:[]}})),/timed evidence/);
});
test('out of order ASR completion never drops an earlier event behind a global cursor',t=>{
  const {store}=setup(t);store.ingest(fixture('first'));store.ingest(fixture('second',{sequence:1}));
  const a=store.claim(),b=store.claim();store.analyze(analysis(b));store.acknowledge(b.id,'stored');store.analyze(analysis(a));
  assert.deepEqual(store.pendingEvents().map(e=>e.id),['first']);
});
test('only public voice provenance crosses into context; embeddings/private paths are stripped',t=>{
  const {store}=setup(t);store.ingest(fixture());
  store.analyze(analysis(store.claim(),{owner_voice:{status:'detected',intervals:[{start_ms:0,end_ms:9000,score:.9,private_path:'/private/profile'}],profile_id:'profile-generation-1',embedding:[.1,.2,.3],profile:'/private/owner.json'}}));
  const result=JSON.stringify(store.events());assert.equal(result.includes('embedding'),false);assert.equal(result.includes('/private/'),false);assert.equal(store.events()[0].analysis.owner_voice.profile_id,'profile-generation-1');
});
test('restart preserves incoming audio, leases, intake receipts and idempotent results',t=>{
  const {store,root}=setup(t);store.ingest(fixture());const job=store.claim();store.analyze(analysis(job));store.acknowledge(job.id,'stored');
  const body={id:'report-1',session_id:'discussion-1',device_id:'android-owner',text:'方案草稿已生成，尚未发布。'};
  store.report(body);const reopened=new ContextStore(root,'android-owner',()=>now);t.after(()=>reopened.close());
  assert.equal(reopened.pendingEvents().length,0);assert.equal(reopened.report(body).duplicate,true);assert.equal(reopened.reports().length,1);
  assert.throws(()=>reopened.report({...body,text:'different'}),/different content/);
  assert.throws(()=>reopened.report({...body,id:'new',session_id:'other'}),/Unknown result/);
});
test('derived recordings never impersonate human/direct-message authorization',t=>{
  const {store}=setup(t);store.ingest(fixture('command',{intent:'command'}));store.analyze(analysis(store.claim()));
  const event=store.events()[0],trigger=triggerFor(event);
  assert.equal(trigger.human,false);assert.equal(trigger.addressed,undefined);assert.equal(trigger.actor.id,BOT);
  assert.deepEqual(triggerFor(event),trigger);assert.ok(trigger.text.includes(event.sha256));assert.ok(trigger.text.includes('machine'));
});
test('ambient owner-unknown is archived but not routed; command is still an inferred candidate',()=>{
  for(const status of ['uncertain','not_detected','not_enrolled','pending'])assert.equal(eligible({device_id:'android-owner',intent:'ambient',owner_voice:status},'android-owner'),false);
  assert.equal(eligible({device_id:'android-owner',intent:'ambient',owner_voice:'detected'},'android-owner'),true);
  assert.equal(eligible({device_id:'other',intent:'command',owner_voice:'detected'},'android-owner'),false);
  assert.equal(eligible({device_id:'android-owner',intent:'command',owner_voice:'uncertain'},'android-owner'),true);
});
test('HTTP roles keep a phone from forging transcripts or agent reports',async t=>{
  const {store}=setup(t);const {call}=await serving(t,store);
  assert.equal((await call('device','v1/segments',fixture())).status,200);
  assert.equal((await call('device','v1/jobs/complete',{})).status,403);
  assert.equal((await call('device','v1/reports',{})).status,403);
  assert.equal((await call('agent','v1/jobs/claim',{})).status,403);
  assert.equal((await call('worker','v1/events')).status,403);
  assert.equal((await call('device','v1/reports?after=-1')).status,400);
  assert.equal((await call('device','v1/health')).body.pending,1);
});
test('Source registration, SourceHost intake stub, thread evidence and Channel report round trip',async t=>{
  const {store}=setup(t);store.ingest(fixture());store.analyze(analysis(store.claim()));const {base,call}=await serving(t,store);
  const saved=process.env.AGENTONE_AGENT_TOKEN;process.env.AGENTONE_AGENT_TOKEN=agentToken;t.after(()=>{if(saved===undefined)delete process.env.AGENTONE_AGENT_TOKEN;else process.env.AGENTONE_AGENT_TOKEN=saved;});
  const disposers=[];let kind,received;
  const config={bridgeUrl:base,deviceId:'android-owner',pollSeconds:5};
  const host={ready:Promise.resolve(),configured:()=>true,config:()=>config,report:()=>{},receive:async trigger=>{received=trigger;return 'stored';}};
  apply({effect:fn=>disposers.push(fn()),orchestrator:{sources:{register:value=>{kind=value;return()=>{};}},context:()=>host}});
  t.after(async()=>{for(const dispose of disposers.reverse())if(typeof dispose==='function')await dispose();});
  for(let i=0;i<100&&store.pendingEvents().length;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(received.source,SOURCE);assert.equal(store.pendingEvents().length,0);
  const scope=kind.scope(received,config);assert.equal(scope.listened,true);assert.equal(scope.observed,true);
  const page=await kind.threadContext.read(null,received,'thread',undefined,config);assert.equal(page.messages[0].bot,true);assert.equal(page.body.events[0].id,'chunk-1');
  await kind.channel.send(null,{id:'engine-report',channel:received.channel,text:'已完成草稿并验证文件；等待你查看。'});
  const result=await call('device','v1/reports');assert.equal(result.body.reports[0].text,'已完成草稿并验证文件；等待你查看。');
});
test('source settings refuse insecure remote URLs and default to no bot authority',()=>{
  const kind=makeKind(()=>null);
  assert.throws(()=>kind.schema.parse({bridgeUrl:'http://192.168.1.2:3487/'}));
  assert.throws(()=>kind.schema.parse({bridgeUrl:'https://a:b@example.com/'}));
  assert.deepEqual(kind.policy.schema.parse({}).bots,[]);
});

test('pair links are short lived, single use and cannot expose agent credentials',async t=>{
  const {store}=setup(t);const {base,call}=await serving(t,store);
  assert.notEqual((await call('device','v1/pair/create',{})).status,200);
  const created=await call('agent','v1/pair/create',{});assert.equal(created.status,200);assert.equal(created.body.expires_in,120);
  const redeem=()=>fetch(base+'v1/pair/redeem',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:created.body.code})});
  const results=await Promise.all([redeem(),redeem()]);assert.deepEqual(results.map(r=>r.status).sort(),[200,410]);
  const paired=await results.find(r=>r.status===200).json();assert.equal(paired.device_token,deviceToken);assert.equal(paired.agentToken,undefined);assert.equal(paired.workerToken,undefined);
  assert.equal(JSON.stringify(created.body).includes(deviceToken),false);
});
test('public phone gateway refuses source, worker and forged report writes',async t=>{
  const {publicGateway}=await import('./gateway.mjs');const {store}=setup(t);const {base}=await serving(t,store);
  const gateway=publicGateway(base);gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
  t.after(()=>new Promise(resolve=>{gateway.close(resolve);gateway.closeAllConnections();}));
  const url=`http://127.0.0.1:${gateway.address().port}`;
  for(const [method,path] of [['GET','/v1/events'],['POST','/v1/jobs/claim'],['POST','/v1/reports'],['POST','/v1/pair/create']])assert.equal((await fetch(url+path,{method,headers:{authorization:'Bearer '+agentToken}})).status,403);
  assert.equal((await fetch(url+'/v1/health',{headers:{authorization:'Bearer '+deviceToken}})).status,200);
});
test('paired transport and actual agent polling are distinct readiness states',async t=>{
  const {store}=setup(t);const {call}=await serving(t,store);
  assert.equal((await call('device','v1/health')).body.agent_connected,false);
  await call('agent','v1/events');assert.equal((await call('device','v1/health')).body.agent_connected,true);
});
