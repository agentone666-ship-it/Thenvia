import {createServer} from 'node:http';
/** A tunnel can expose device routes only. Agent/ASR credentials stay on loopback. */
export function publicGateway(target) {
  const allowed=new Set(['POST /v1/pair/redeem','POST /v1/segments','GET /v1/reports','GET /v1/health']);
  return createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(!allowed.has(`${req.method} ${url.pathname}`)||req.headers.origin){res.writeHead(403);res.end();return;}
    import('node:http').then(({request})=>{
      const upstream=request(new URL(req.url,target),{method:req.method,headers:{...req.headers,host:new URL(target).host}},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
      upstream.setTimeout(30000,()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(upstream);
    });
  });
}
