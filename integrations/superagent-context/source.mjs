/** Cordis SourceKind plugin. Uses the documented Super Agent source/channel contract. */
import {z} from 'zod';
import {setTimeout as delay} from 'node:timers/promises';
import {BOT,SOURCE,eligible,renderEvidence,triggerFor} from './protocol.mjs';

const localUrl=z.string().url().refine(value=>{const u=new URL(value);return !u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/'&&(u.protocol==='https:'||(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)));},'Bridge must use HTTPS or local loopback');
const Config=z.object({bridgeUrl:localUrl.default('http://127.0.0.1:3487/'),deviceId:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).default('android-owner'),pollSeconds:z.number().int().min(5).max(300).default(15)}).strict();
const person=z.object({id:z.string().min(1),name:z.string().optional()}).strict();
const policy=z.object({allowed:z.array(person).default([]),bots:z.array(person).default([])}).strict();

async function request(config,path,body,signal) {
  const token=process.env.AGENTONE_AGENT_TOKEN;
  if(!token||token.length<32)throw new Error('AGENTONE_AGENT_TOKEN is missing');
  const timeout=AbortSignal.timeout(20000);
  const response=await fetch(new URL(path,config.bridgeUrl),{
    method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,...body===undefined?{}:{'content-type':'application/json'}},
    ...body===undefined?{}:{body:JSON.stringify(body)},signal:signal?AbortSignal.any([signal,timeout]):timeout,
    redirect:'error',
  });
  if(!response.ok)throw new Error(`Context bridge HTTP ${response.status}`);
  return response.json();
}

export function makeKind(getConfig) {
  return {
    kind:SOURCE,title:{zh:'AgentOne 语音 Context',en:'AgentOne voice context'},
    description:{zh:'把有来源的语音交给现有 Super Agent 判断待办，结果回到配对手机。',en:'Evidence-backed voice intake and results for a paired phone.'},
    schema:Config,health:[SOURCE],
    fields:[{key:'bridgeUrl',type:'text',label:{zh:'Context 服务',en:'Context bridge'}},
      {key:'deviceId',type:'text',label:{zh:'已配对的手机',en:'Paired device'}},
      {key:'pollSeconds',type:'number',min:5,max:300,advanced:true,label:{zh:'接收间隔（秒）',en:'Poll seconds'}}],
    scope:({meta},config)=>eligible(meta,config.deviceId)?{listened:true,observed:true,row:config.deviceId}:{listened:false,reason:'owner_not_detected_or_unpaired'},
    policy:{schema:policy,fields:[
      {key:'allowed',type:'rows',label:{zh:'人工发送者',en:'Human senders'},columns:[{key:'id',type:'text',label:{zh:'ID',en:'ID'}}]},
      {key:'bots',type:'rows',label:{zh:'Context 采集器',en:'Context collectors'},columns:[{key:'id',type:'text',label:{zh:BOT,en:BOT}}]},
    ],explicit:{zh:'录音始终是模型生成的候选；只有已启用的推断规则可授权执行。',en:'Recordings are inferred candidates, never explicit human messages.'}},
    channel:{
      allowed:(address,config)=>address.device_id===config.deviceId&&/^[A-Za-z0-9_-]{1,100}$/.test(address.session_id??''),
      send:async(_host,message)=>{
        const config=getConfig();if(!config)throw new Error('Context Source is disabled');
        await request(config,'v1/reports',{id:message.id,...message.channel.address,text:message.text});return 'sent';
      },
      link:address=>({url:'',label:{zh:`手机录音 ${address.session_id}`,en:`Phone recording ${address.session_id}`}}),
    },
    threadContext:{
      messageId:trigger=>trigger.meta.event_id,
      read:async(_commands,trigger,part,cursor,config)=>{
        const offset=part==='thread'?Number(cursor??0):0;
        if(!Number.isSafeInteger(offset)||offset<0)throw new Error('Invalid context cursor');
        const {events}=await request(config,`v1/thread?session_id=${encodeURIComponent(trigger.meta.session_id)}&after=${offset}`);
        const messages=events.map(e=>({id:e.id,from:BOT,bot:true,at:new Date(e.metadata.ended_ms).toISOString(),text:renderEvidence(e)}));
        const gaps=[];for(let i=1;i<events.length;i++)if(events[i].metadata.sequence!==events[i-1].metadata.sequence+1)gaps.push({after:events[i-1].id,before:events[i].id});
        return {messages,...events.length===30?{next:String(offset+30)}:{},body:{events,gaps,note:'Gaps include untranscribed or missing chunks. No gaps does not prove complete physical capture. Read all pages and later changes.'}};
      },
    },
    environment:{variables:[{key:'DSH_SUPERAGENT_AGENTONE_SESSION',description:{zh:'原始语音会话 ID',en:'Originating recording session'}}],
      values:({trigger})=>({DSH_SUPERAGENT_AGENTONE_SESSION:trigger?.source===SOURCE?String(trigger.meta.session_id):''})},
  };
}

export const name='agentone-superagent-context';
export const inject=['orchestrator'];
export function apply(ctx) {
  let host;
  const kind=makeKind(()=>host?.config(SOURCE));
  ctx.effect(()=>ctx.orchestrator.sources.register(kind),'AgentOne: source kind');
  ctx.effect(()=>{
    host=ctx.orchestrator.context(kind);
    const controller=new AbortController();
    const running=(async()=>{
      await host.ready;
      if(!host.configured()){host.report(SOURCE,{state:'paused',detail:'Super Agent setup is incomplete; no work is accepted.'});return;}
      while(!controller.signal.aborted) {
        const config=host.config(SOURCE);
        try {
          if(!config)host.report(SOURCE,{state:'paused',detail:'Off'});
          else {
            const {events}=await request(config,'v1/events',undefined,controller.signal);
            for(const event of events) {
              if(controller.signal.aborted)break;
              const disposition=await host.receive(triggerFor(event));
              // Crash/retry before ACK is safe: the Engine deduplicates immutable trigger IDs.
              await request(config,'v1/events/ack',{id:event.id,disposition},controller.signal);
            }
            host.report(SOURCE,{state:'ready',detail:`${events.length} evidence events received; execution remains subject to policy.`});
          }
        } catch {if(!controller.signal.aborted)host.report(SOURCE,{state:'error',detail:'Context bridge unavailable. Inputs remain queued; check connection/credentials.'});}
        await delay((config?.pollSeconds??15)*1000,undefined,{signal:controller.signal}).catch(()=>{});
      }
    })().catch(()=>{if(!controller.signal.aborted)host.report(SOURCE,{state:'error',detail:'Context Source stopped; check runtime setup.'});});
    return async()=>{controller.abort();await running;};
  });
}
