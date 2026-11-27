import {createConnection} from 'node:net';
import {now} from './database.mjs';

export function scanPdf(bytes,host){
  return new Promise(resolve=>{
    const socket=createConnection({host,port:3310});
    let reply='';
    const timer=setTimeout(()=>finish('Retry'),25_000);
    function finish(status){
      clearTimeout(timer);
      socket.destroy();
      resolve(status);
    }
    socket.on('error',()=>finish('Retry'));
    socket.on('connect',()=>{
      socket.write('zINSTREAM\0');
      for(let offset=0;offset<bytes.length;offset+=64*1024){
        const chunk=bytes.subarray(offset,offset+64*1024);
        const size=Buffer.alloc(4);
        size.writeUInt32BE(chunk.length);
        socket.write(size);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
    socket.on('data',chunk=>{
      reply+=chunk.toString('utf8');
      if(reply.length>4096)return finish('Retry');
      const end=reply.indexOf('\0');
      if(end<0)return;
      const result=reply.slice(0,end);
      finish(result==='stream: OK'?'Ready':/^stream: .+ FOUND$/.test(result)?'Blocked':'Retry');
    });
    socket.on('close',()=>finish('Retry'));
  });
}

export async function processPdfScan(db,storage,scan){
  const media=await db.raw.collection('media').findOne({kind:'document',
    scan_status:{$nin:['Ready','Blocked']},$or:[{scan_retry_at:{$exists:false}},{scan_retry_at:{$lte:new Date()}}]},
  {sort:{created_at:1}});
  if(!media)return;
  let status='Retry';
  try {status=await scan(await storage.read(media.stored_name));}catch{}
  await db.raw.collection('media').updateOne({id:media.id,stored_name:media.stored_name,scan_status:{$nin:['Ready','Blocked']}},
    {$set:{scan_status:status,scanned_at:now(),scan_retry_at:status==='Retry'?new Date(Date.now()+60_000):null}});
}

export function startPdfScans(db,storage,host){
  if(!host)return async()=>{};
  let pending;
  const tick=()=>{
    if(!pending)pending=processPdfScan(db,storage,bytes=>scanPdf(bytes,host))
      .catch(()=>console.error('PDF scan queue could not be processed.')).finally(()=>{pending=undefined;});
  };
  tick();
  const timer=setInterval(tick,5000);
  timer.unref();
  return async()=>{clearInterval(timer);await pending;};
}

export function distributionAllowed(media){
  return !['Restricted','Pending'].includes(media.review_status)&&(media.kind!=='document'||media.scan_status==='Ready');
}
