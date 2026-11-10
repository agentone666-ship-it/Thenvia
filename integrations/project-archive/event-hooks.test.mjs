import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventDispatch, watchChanges, pendingEvents } from './event-hooks.mjs';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'agentone-hooks-'));
  mkdirSync(join(root, 'SessionInbox'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
test('idle filesystem watcher never dispatches; actual events are debounced and filename-filtered', async t => {
  const root = fixture(t); let calls = 0, models = 0;
  const dispatch = new EventDispatch(root, async () => { models++; });
  const close = watchChanges([{ path: root, accept: name => name === 'ready.json' }], () => { calls++; dispatch.enqueue([{id:"same-recording"}]); }, 30);
  t.after(close);
  await sleep(120); assert.equal(calls, 0);
  writeFileSync(join(root, 'unrelated.log'), 'ignore'); await sleep(100); assert.equal(calls, 0);
  for (let i=0; i<10; i++) writeFileSync(join(root, 'ready.json'), String(i));
  await sleep(350); assert.ok(calls >= 1);
  await dispatch.completion; assert.equal(models, 1);
  await sleep(120); assert.equal(models, 1);
});
test('duplicate events and daemon restart never reinvoke a delivered recording', async t => {
  const root = fixture(t); let calls = 0;
  const send = async () => { calls++; return { status: 'completed' }; };
  const dispatch = new EventDispatch(root, send);
  await dispatch.enqueue([]); assert.equal(calls, 0);
  await dispatch.enqueue([{id:'recording:a'}, {id:'recording:a'}]);
  await dispatch.enqueue([{id:'recording:a'}]);
  await new EventDispatch(root, send).enqueue([{id:'recording:a'}]);
  assert.equal(calls, 1);
});
test('new content arriving during an active turn is serialized in one next batch', async t => {
  const root = fixture(t); let release; const batches=[];
  const dispatch = new EventDispatch(root, async batch => {
    batches.push(batch.map(e=>e.id));
    if (batches.length === 1) await new Promise(resolve => release=resolve);
  });
  const done=dispatch.enqueue([{id:'a'}]);
  dispatch.enqueue([{id:'a'},{id:'b'}]); dispatch.enqueue([{id:'c'}]);
  release(); await done;
  assert.deepEqual(batches,[['a'],['b','c']]);
});
test('uncertain or failed invocation is durable needs_attention, never automatic token retry loop', async t => {
  const root = fixture(t); let calls=0;
  const dispatch = new EventDispatch(root, async () => { calls++; throw new Error('connection lost'); });
  await dispatch.enqueue([{id:'a'}]); await dispatch.enqueue([{id:'a'}]);
  assert.equal(calls,1);
  assert.equal(JSON.parse(readFileSync(join(root,'hook-receipts.json'),'utf8')).a.state,'needs_attention');
});
test('request/response writes do not create duplicate model events', t => {
  const root=fixture(t), id='a'.repeat(64), base=join(root,'SessionInbox',id);
  writeFileSync(base+'.request.json','{}');
  const event=pendingEvents(root)[0];
  writeFileSync(base+'.response.json','{}');
  assert.equal(pendingEvents(root)[0].id,event.id);
  writeFileSync(base+'.opportunities.json','{}'); assert.deepEqual(pendingEvents(root),[]);
});

test('completion events only include bound active workers and terminal turns after registration', async t => {
  const {DatabaseSync}=await import('node:sqlite');
  const {workerEvents}=await import('./event-hooks.mjs');
  const root=fixture(t), now=Date.now();
  const orders=new DatabaseSync(join(root,'work-orders.sqlite'));
  orders.exec('CREATE TABLE work_orders(id,thread_id,host_id,state,created_ms)');
  orders.prepare('INSERT INTO work_orders VALUES(?,?,?,?,?)').run('order','worker','local','running',now-5000);
  const history=new DatabaseSync(join(root,'thread_history_1.sqlite'));
  history.exec('CREATE TABLE thread_turns(thread_id,turn_id,status,started_at,completed_at,error_json,rollout_ordinal)');
  const insert=history.prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?,?)');
  insert.run('unrelated','other','completed',now-1000,now,null,1);
  insert.run('worker','old','completed',Math.floor(now/1000)-100,Math.floor(now/1000)-90,null,1);
  assert.deepEqual(workerEvents(root,root),[]);
  insert.run('worker','latest','inProgress',Math.floor(now/1000),null,null,2);
  assert.deepEqual(workerEvents(root,root),[]);
  history.prepare("UPDATE thread_turns SET status='completed',completed_at=? WHERE turn_id='latest'").run(Math.floor(now/1000));
  assert.deepEqual(workerEvents(root,root).map(e=>[e.thread_id,e.turn_id,e.status]),[['worker','latest','completed']]);
  const dispatch=new EventDispatch(root,async()=>({status:'queued'}));
  await dispatch.enqueue(workerEvents(root,root));
  let count=0; const restarted=new EventDispatch(root,async()=>count++);
  await restarted.enqueue(workerEvents(root,root));assert.equal(count,0);
  for (const status of ['failed','interrupted']) {
    history.prepare("UPDATE thread_turns SET status=? WHERE turn_id='latest'").run(status);
    assert.equal(workerEvents(root,root)[0].status,status);
  }
  orders.prepare("UPDATE work_orders SET state='accepted'").run();
  assert.deepEqual(workerEvents(root,root),[]);
  history.close();orders.close();
});
