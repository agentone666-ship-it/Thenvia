import {randomBytes} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,openSync,existsSync,chmodSync,copyFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,dirname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {publicGateway} from './gateway.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const root=join(homedir(),'Library/Application Support/AgentOne/MobileConnect');mkdirSync(root,{recursive:true,mode:0o700});
const configPath=join(root,'connection.json');
let config;
try{config=JSON.parse(readFileSync(configPath));}catch(e){if(e.code!=='ENOENT')throw e;config={device:'android-owner',deviceToken:randomBytes(32).toString('hex'),agentToken:randomBytes(32).toString('hex'),workerToken:randomBytes(32).toString('hex')};writeFileSync(configPath,JSON.stringify(config),{mode:0o600});}
const url='http://127.0.0.1:3487/';
if(process.argv.includes('--gateway')){publicGateway(url).listen(3488,'127.0.0.1');}
else {
  const log=name=>{const p=isAbsolute(name)?name:join(root,name);const fd=openSync(p,'a',0o600);chmodSync(p,0o600);return fd;};
  const launch=(command,args,env=process.env,name='service.log')=>{const fd=log(name);const p=spawn(command,args,{env,stdio:['ignore',fd,fd],detached:true});p.on('error',()=>{});p.unref();return p;};
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  async function request(path,body){const r=await fetch(url+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+(body?config.agentToken:config.deviceToken),...body?{'content-type':'application/json'}:{}},...body?{body:JSON.stringify(body)}:{},signal:AbortSignal.timeout(1500)});if(!r.ok)throw new Error('服务未就绪或正在使用另一套连接配置');return r.json();}
  try{await request('v1/health');}catch{
    launch(process.execPath,[join(here,'server.mjs')],{...process.env,AGENTONE_CONTEXT_HOME:join(root,'Context'),AGENTONE_DEVICE_ID:config.device,AGENTONE_DEVICE_TOKEN:config.deviceToken,AGENTONE_AGENT_TOKEN:config.agentToken,AGENTONE_WORKER_TOKEN:config.workerToken},'bridge.log');
    let ready=false;for(let i=0;i<30;i++){await sleep(200);try{await request('v1/health');ready=true;break;}catch{}}
    if(!ready)throw new Error('本机 Context 服务未能启动，请检查端口占用');
  }
  let endpoint=config.endpoint;
  // Reuse a live private deployment URL when supplied; otherwise prepare a device-only quick tunnel.
  if(process.env.AGENTONE_PUBLIC_URL)endpoint=process.env.AGENTONE_PUBLIC_URL;
  else {
    let usable=false;if(endpoint)try{const r=await fetch(endpoint+'/v1/health',{headers:{authorization:'Bearer '+config.deviceToken},signal:AbortSignal.timeout(2500)});usable=r.ok;}catch{}
    if(!usable){
      const binary=['/opt/homebrew/bin/cloudflared','/usr/local/bin/cloudflared'].find(existsSync);if(!binary)throw new Error('没有发现安全连接组件 cloudflared；安装后再次连接');
      launch(process.execPath,[fileURLToPath(import.meta.url),'--gateway'],process.env,'gateway.log');
      const tunnelLog=join(root,'tunnel-'+Date.now()+'.log');launch(binary,['tunnel','--url','http://127.0.0.1:3488','--no-autoupdate'],process.env,tunnelLog);
      endpoint=null;
      for(let i=0;i<90;i++){await sleep(500);const text=readFileSync(tunnelLog,'utf8');const match=text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);if(match){endpoint=match[0];break;}}
      if(!endpoint)throw new Error('安全连接暂未就绪，请检查网络后重试');
      config.endpoint=endpoint;writeFileSync(configPath,JSON.stringify(config),{mode:0o600});
    }
  }
  const parsed=new URL(endpoint);if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.search||parsed.hash||parsed.pathname!=='/')throw new Error('配对地址必须为 HTTPS 根地址');
  let runtimeReady=false;
  try{const response=await fetch('http://127.0.0.1:3082/orchestrator/api/state',{headers:{'x-orchestrator-request':'1'},signal:AbortSignal.timeout(2000)});const state=await response.json();runtimeReady=response.ok&&state.health?.runtime?.state==='ready'&&!state.setup?.problem&&!state.paused;}catch{}

  let sourceInstalled=false;
  if(runtimeReady&&!(await request('v1/health')).agent_connected) {
    const dsh=[join(homedir(),'.npm-global/bin/dsh'),'/opt/homebrew/bin/dsh','/usr/local/bin/dsh'].find(existsSync);
    const npm=join(dirname(process.execPath),'npm');
    if(dsh&&existsSync(npm)) {
      const adapter=join(root,'Source');mkdirSync(adapter,{recursive:true,mode:0o700});
      for(const file of ['source.mjs','protocol.mjs','package.json','package-lock.json','cordis.patch.yml'])copyFileSync(join(here,file),join(adapter,file));
      const ready=spawnSync(npm,['ci','--prefix',adapter,'--ignore-scripts','--no-audit','--no-fund'],{timeout:60000,encoding:'utf8',env:{...process.env,PATH:dirname(process.execPath)+':'+process.env.PATH}});
      if(ready.status===0)sourceInstalled=spawnSync(dsh,['plugin','--profile','superagent','add','link:'+adapter],{timeout:20000,encoding:'utf8',env:{...process.env,PATH:dirname(process.execPath)+':'+process.env.PATH}}).status===0;
    }
  }
  if(sourceInstalled)for(let i=0;i<30;i++){if((await request('v1/health')).agent_connected)break;await sleep(500);}
  const ticket=await request('v1/pair/create',{});
  const link='agentone://pair?'+new URLSearchParams({server:parsed.origin,code:ticket.code});
  const health=await request('v1/health');
  const hostReady=runtimeReady&&health.agent_connected===true;
  console.log(JSON.stringify({link,expires_in:ticket.expires_in,host_ready:hostReady,source_installed:sourceInstalled,note:hostReady?'手机与 Agent 通路已就绪；任务仍遵循宿主规则':'手机配对入口已准备好；Agent 尚未接入或未就绪，不会声称已经能接单'}));
}
