import {createServer} from 'node:http';
import {timingSafeEqual,randomBytes,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
import {ContextStore} from './store.mjs';

const equal=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function makeServer({store,deviceToken,agentToken,workerToken}) {
  const tickets=new Map();
  let lastAgentPoll=0;
  const digest=value=>createHash('sha256').update(value).digest('hex');
  for(const t of [deviceToken,agentToken,workerToken]) if(typeof t!=='string'||t.length<32) throw new Error('Use three separate tokens of at least 32 characters');
  if(new Set([deviceToken,agentToken,workerToken]).size!==3) throw new Error('Device, agent and analysis credentials must differ');
  return createServer(async(req,res)=>{
    const json=(code,value)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
    try {
      const url=new URL(req.url,'http://localhost');
      if(req.headers.origin) return json(403,{error:'Browser origins are not accepted'});
      if(req.method==='POST'&&url.pathname==='/v1/pair/redeem') {
        let raw='';for await(const c of req){raw+=c;if(raw.length>2048)return json(413,{error:'Invalid pairing request'});}
        const code=JSON.parse(raw).code;
        if(typeof code!=='string'||code.length!==64)return json(400,{error:'Invalid pairing code'});
        const ticket=tickets.get(digest(code));
        if(!ticket||ticket.until<Date.now())return json(410,{error:'配对链接已失效，请在 Mac 重新连接'});
        tickets.delete(digest(code));
        return json(200,{device_id:store.deviceId,device_token:deviceToken});
      }
      const role=equal(req.headers.authorization,`Bearer ${deviceToken}`)?'device':equal(req.headers.authorization,`Bearer ${agentToken}`)?'agent':equal(req.headers.authorization,`Bearer ${workerToken}`)?'worker':null;
      if(!role) return json(401,{error:'Unauthenticated'});
      if(req.method==='POST'&&url.pathname==='/v1/pair/create'&&role==='agent') {
        const code=randomBytes(32).toString('hex');
        for(const [key,t] of tickets)if(t.until<Date.now())tickets.delete(key);
        if(tickets.size>20)return json(429,{error:'Too many pairing requests'});
        tickets.set(digest(code),{until:Date.now()+120000});
        return json(200,{code,expires_in:120});
      }
      // No browser cookies/CORS, proxy credentials, filesystem paths, or command execution surface.
      if(req.headers.origin) return json(403,{error:'Browser origins are not accepted'});
      const expected={
        'POST /v1/segments':'device','GET /v1/reports':'device','GET /v1/health':'device',
        'GET /v1/events':'agent','POST /v1/events/ack':'agent','GET /v1/thread':'agent','POST /v1/reports':'agent',
        'POST /v1/jobs/claim':'worker','GET /v1/jobs/audio':'worker','POST /v1/jobs/complete':'worker'}[`${req.method} ${url.pathname}`];
      if(!expected) return json(404,{error:'Unknown endpoint'});
      if(role!==expected) return json(403,{error:'Credential cannot perform this operation'});
      let body={};
      if(req.method==='POST') {
        if(req.headers['content-type']!=='application/json') return json(415,{error:'Expected application/json'});
        const chunks=[];let size=0;
        for await(const c of req) {size+=c.length;if(size>7*1024*1024) return json(413,{error:'Upload too large'});chunks.push(c);}
        body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
      }
      const after=Number(url.searchParams.get('after')??0);
      if(!Number.isSafeInteger(after)||after<0) return json(400,{error:'Invalid cursor'});
      switch(`${req.method} ${url.pathname}`) {
        case 'POST /v1/segments':return json(200,store.ingest(body));
        case 'GET /v1/health':return json(200,{...store.health(),agent_connected:Date.now()-lastAgentPoll<45000});
        case 'GET /v1/events':lastAgentPoll=Date.now();return json(200,{events:store.pendingEvents()});
        case 'POST /v1/events/ack':store.acknowledge(body.id,body.disposition);return json(200,{accepted:true});
        case 'GET /v1/thread':return json(200,{events:store.thread(url.searchParams.get('session_id'),after)});
        case 'POST /v1/jobs/claim':return json(200,{job:store.claim()});
        case 'GET /v1/jobs/audio':{const bytes=store.audio(url.searchParams.get('id'),url.searchParams.get('lease'));res.writeHead(200,{'content-type':'audio/mp4','cache-control':'no-store'});return res.end(bytes);}
        case 'POST /v1/jobs/complete':return json(200,store.analyze(body));
        case 'POST /v1/reports':return json(200,store.report(body));
        case 'GET /v1/reports':return json(200,{reports:store.reports(after)});
      }
    } catch(e) {if(!res.headersSent)json(400,{error:String(e.message).slice(0,300)});else res.destroy();}
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const store=new ContextStore(process.env.AGENTONE_CONTEXT_HOME??resolve(homedir(),'Library/Application Support/AgentOne/MobileContext'),process.env.AGENTONE_DEVICE_ID);
  const server=makeServer({store,deviceToken:process.env.AGENTONE_DEVICE_TOKEN,agentToken:process.env.AGENTONE_AGENT_TOKEN,workerToken:process.env.AGENTONE_WORKER_TOKEN});
  server.requestTimeout=30000;server.headersTimeout=15000;
  server.listen(Number(process.env.AGENTONE_CONTEXT_PORT??3487),'127.0.0.1',()=>console.log('AgentOne Context bridge listening on loopback. Use an authenticated HTTPS reverse proxy/VPN for the phone.'));
  for(const event of ['SIGINT','SIGTERM'])process.on(event,()=>server.close(()=>{store.close();process.exit(0);}));
}
