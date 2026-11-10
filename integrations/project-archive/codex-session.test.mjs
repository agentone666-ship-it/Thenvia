import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { queueCodex } from './codex-session.mjs';
const threadId = '11111111-1111-4111-8111-111111111111';
const messageId = '22222222-2222-4222-8222-222222222222';
test('event uses the exact existing visible chat, queues a literal prompt without inference or shell', async () => {
  let seen;
  const result = await queueCodex({binary:'codex',threadId,prompt:'idea $HOME `text`',execute:(file,args,options,done)=>{
    seen={file,args,options};done(null,`Queued message ${messageId} for thread ${threadId}.`);
  }});
  assert.deepEqual(seen.args,['queue','--thread',threadId,'--message','idea $HOME `text`']);
  assert.equal(seen.options.shell,undefined);
  assert.equal(result.message_id,messageId);assert.equal(result.status,'queued');
});
test('queue command is exercised against a real child process; unknown output is not a delivery receipt', async t => {
  const root=mkdtempSync(join(tmpdir(),'agentone-queue-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const binary=join(root,'fake-codex');
  writeFileSync(binary,`#!${process.execPath}\nconsole.log('exited successfully without acknowledgement')`,{mode:0o700});
  await assert.rejects(queueCodex({binary,threadId,prompt:'test'}),/did not acknowledge/);
});
test('queue failure cannot be upgraded to delivery success', async () => {
  await assert.rejects(queueCodex({binary:'codex',threadId,prompt:'test',execute:(_f,_a,_o,done)=>done(new Error('closed'))}),/delivery failed/);
});
