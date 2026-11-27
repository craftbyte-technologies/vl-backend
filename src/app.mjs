import { publicPage } from './pages.mjs';
import { searchListings } from './search.mjs';
import { customerRoutes, currentCustomer } from './customers.mjs';
import {accountCookie, accountTokenHash, newAccountToken, revokeAccountSession} from './account-session.mjs';
import {createStaff, createFirstAdministrator} from './staff-accounts.mjs';
import {staffRecovery} from './staff-recovery.mjs';
import {distributionAllowed,startPdfScans} from './pdf-scans.mjs';
import {startUpdates} from './updates.mjs';
import { enquiryRoutes } from './enquiries.mjs';
import { ownerWorkflows } from './owners.mjs';
import { customerMailer } from './customer-mail.mjs';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, sep, extname } from 'node:path';
import sharp from 'sharp';
import {openStorage} from './storage.mjs';
import {renderConfig, renderShell} from './render-config.mjs';
import { openDatabase, transaction, audit, requireValue, text, HttpError, now } from './database.mjs';
import { listings, listing, saveListing, projects } from './inventory.mjs';
import {catalogue, validateAmenities} from './amenities.mjs';
import {localDataDirectory} from './local-paths.mjs';

const userShape=u=>({id:u.id,email:u.email,name:u.name,role:u.role,active:!!u.active});
export async function createApplication({directory=localDataDirectory(),serveStatic=false,uri,database,mail=customerMailer(),worker=false}={}) {
  const hosted=renderConfig();
  const origin=process.env.APP_ORIGIN,allowedHosts=(process.env.ALLOWED_HOSTS||'').split(',').filter(Boolean),secure=origin?.startsWith('https:');
  if(process.env.NODE_ENV==='production'&&(!secure||process.env.ALLOW_LOCAL_BOOTSTRAP==='1')){
    throw new Error('Production requires HTTPS and operator-only administrator setup.');
  }
  if(hosted) allowedHosts.push(hosted.api.host);
  const limits=new Map();
  let db,storage;
  try {
    db=await openDatabase(directory,{uri,database});
    storage=await openStorage(db,directory);
    if(hosted) await storage.ping();
    const pending=await db.raw.collection('workspace').findOne({_id:'import',complete:false});
    if(pending)throw new Error('An interrupted import must be completed before serving requests.');
  } catch(error) {
    storage?.close?.();
    await db?.close();
    throw error;
  }
  const staffCount=async()=>await db.count('staff_users');
  async function activeTeamSession(req) {
    const token_hash = accountTokenHash(req);
    if (!token_hash) return null;
    const session = await db.get('sessions', {token_hash, unified: true, expires_at: {$gt: Date.now()}});
    if (!session) return null;
    const user = await db.get('staff_users', {id: session.user_id, active: 1});
    return user ? {kind: 'team', user: userShape(user), expiresAt: session.expires_at} : null;
  }
  async function actor(req) { return (await activeTeamSession(req))?.user ?? null; }
  async function requireStaff(req,roles){const u=await actor(req);requireValue(u,'Staff sign-in required.',401);if(roles)requireValue(roles.includes(u.role),'You do not have permission for this operation.',403);return u;}
  function rate(req,key){
    const forwarded = req.headers['cf-connecting-ip'];
    const address = hosted && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : req.socket.remoteAddress;
    const id=`${address}:${key}`,entry=limits.get(id);
    if(!entry||entry.until<Date.now()){limits.set(id,{count:1,until:Date.now()+900000});return;}
    entry.count++;
    requireValue(entry.count<=8,'Too many attempts. Try again in 15 minutes.',429);
  }
  async function setSession(req, res, user) {
    await revokeAccountSession(db, req);
    const {token, token_hash} = newAccountToken();
    const expires_at = Date.now() + 8 * 3600000;
    await db.insert('sessions', {token_hash, unified: true, user_id: user.id, expires_at, expires: new Date(expires_at)});
    accountCookie(res, secure, token, 28800);
    return userShape(user);
  }
  async function readBody(req){let length=0;const chunks=[];for await(const chunk of req){length+=chunk.length;requireValue(length<=12*1024*1024,'Request is too large.',413);chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw new HttpError(400,'Malformed JSON request.');}}
  const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  const accountOptions = {db,mail,origin,secure,rate,readBody,send,localMail:process.env.CUSTOMER_MAIL_MODE==='capture'};
  const customer = customerRoutes(accountOptions);
  const recoverStaff = staffRecovery(accountOptions);
  const ownerAccount = customerRoutes(accountOptions,'owner');
  const owners = ownerWorkflows({db,readBody,send});
  const enquiries = enquiryRoutes({...accountOptions,actor});
  async function publishedFile(id, visibility){for(const link of await db.find('listing_media',{media_id:id,visibility}))if(await db.get('listings',{id:link.listing_id,publication:'Published'}))return true;return false;}
  async function publicProjects(){const out=[];for(const p of await projects(db))if(await db.get('listings',{project_id:p.id,publication:'Published'}))out.push({...p,amenities:p.amenities.filter(entry=>['Available','Planned'].includes(entry.state))});return out;}
  const server=createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('X-Frame-Options','DENY');
    try{
      requireValue(allowedHosts.length?allowedHosts.includes(req.headers.host):/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(req.headers.host||''),'Unrecognized host.',403);
      const url=new URL(req.url,`http://${req.headers.host}`),path=url.pathname,method=req.method;
      if(hosted&&path.startsWith('/api/')){
        res.setHeader('Vary','Origin');
        if(req.headers.origin===origin){
          res.setHeader('Access-Control-Allow-Origin',origin);
          res.setHeader('Access-Control-Allow-Credentials','true');
        }
        if(method==='OPTIONS'){
          requireValue(req.headers.origin===origin,'Cross-origin requests are not allowed.',403);
          res.writeHead(204,{
            'Access-Control-Allow-Methods':'GET, HEAD, POST, PUT, PATCH, DELETE',
            'Access-Control-Allow-Headers':'Content-Type, X-Forma-Request',
            'Cache-Control':'no-store',
          });
          return res.end();
        }
      }
      if(path.startsWith('/api/')&&!['GET','HEAD'].includes(method)){
        requireValue(req.headers['x-forma-request']==='1','Same-origin request marker required.',403);
        if(req.headers.origin)requireValue(req.headers.origin===(origin||`http://${req.headers.host}`),'Cross-origin requests are not allowed.',403);
        requireValue((req.headers['content-type']||'').startsWith('application/json'),'JSON content type required.',415);
      }
      if(path==='/api/health'&&method==='GET'){await db.ping();return send(res,200,{ok:true});}
      if (path === '/api/auth/session' && method === 'GET') {
        const token_hash = accountTokenHash(req);
        if (!token_hash) return send(res, 200, {session: null});
        const team = await activeTeamSession(req);
        if (team) return send(res, 200, {session: team});
        const session = await db.get('customer_sessions', {token_hash, unified: true, expires: {$gt: new Date()}});
        const account = session && await db.get('external_accounts', {id: session.account_id});
        return send(res, 200, {session: account ? {
          kind: account.kind, user: {id: account.id, name: account.name, email: account.email},
          expiresAt: session.expires.getTime(),
        } : null});
      }
      if (path === '/api/auth/logout' && method === 'POST') {
        await transaction(db, () => revokeAccountSession(db, req));
        accountCookie(res, secure);
        return send(res, 200, {ok: true});
      }
      const memberListing = /^\/api\/customer\/listings\/([a-zA-Z0-9-]{1,80})$/.exec(path);
      const memberFile = /^\/api\/customer\/files\/([a-zA-Z0-9-]{1,80})$/.exec(path);
      if(method==='GET'&&memberListing){
        requireValue(await currentCustomer(db,req),'Sign in for member details.',401);
        return send(res,200,{listing:await listing(db,memberListing[1],false,true)});
      }
      if(await recoverStaff(req,res,path)||await enquiries(req,res,path))return;
      if(path.startsWith('/api/customer/')&&!(method==='GET'&&memberFile))return await customer(req,res,path);
      if(path.startsWith('/api/owner/')){
        if(await owners(req,res,path))return;
        return await ownerAccount(req,res,path);
      }
      const originalReq=req;const dispatch=async(resOverride=res,payload)=>{const res=resOverride;const body=async()=>payload===undefined?readBody(originalReq):payload;
      if(path==='/api/admin/session'&&method==='GET')return send(res,200,{user:await actor(req),needsSetup:(await staffCount())===0});
      if(path==='/api/admin/bootstrap'&&method==='POST'){
        requireValue(process.env.ALLOW_LOCAL_BOOTSTRAP==='1','Public initialization is disabled.',403);requireValue((await staffCount())===0,'Workspace initialization is already complete.',409);const data=await body(req);
        const u=await createFirstAdministrator(db,data);return send(res,201,{user:await setSession(req,res,u)});
      }
      if(path==='/api/admin/login'&&method==='POST'){
        const data=await body(req),email=text(data.email,120).toLowerCase(),u=await db.get('staff_users',{email});
        const password=String(data.password||'').slice(0,200),digest=scryptSync(password,u?.salt||'forma-dummy-salt',64),expected=Buffer.from(u?.password_hash||'00'.repeat(64),'hex');
        requireValue(timingSafeEqual(digest,expected)&&u?.active,'Email or password is incorrect.',401);return send(res,200,{user:await setSession(req,res,u)});
      }
      if(path==='/api/admin/logout'&&method==='POST'){
        if (await actor(req)) {
          await revokeAccountSession(db, req);
          accountCookie(res, secure);
        }
        return send(res,200,{ok:true});
      }
      if(path==='/api/public/listings'&&method==='GET')return send(res,200,await searchListings(db,url.searchParams));
      if(/^\/api\/public\/listings\/[^/]+\/similar$/.test(path)&&method==='GET'){const p=await listing(db,path.split('/')[4]);return send(res,200,await searchListings(db,new URLSearchParams({type:p.type,transaction:p.transaction,exclude:p.id,limit:'3'})));}
      if(path.startsWith('/api/public/listings/')&&method==='GET')return send(res,200,{listing:await listing(db,path.split('/').at(-1))});
      if(path==='/api/public/catalogue'&&method==='GET')return send(res,200,{amenities:await catalogue(db)});
      if(path==='/api/public/projects'&&method==='GET')return send(res,200,{projects:await publicProjects()});
      if(method==='GET'&&(memberFile||/^\/api\/files\/[a-zA-Z0-9-]{1,80}$/.test(path))){
        const id=path.split('/').at(-1),m=await db.get('media',{id});requireValue(m,'File not found.',404);
        const safe=distributionAllowed(m);
        const allowed=(m.kind!=='document'||m.scan_status==='Ready')&&(memberFile
          ? safe&&await currentCustomer(db,req)&&await publishedFile(id,'member')
          : (safe&&await publishedFile(id,'public'))||await actor(req));
        requireValue(allowed,'File not found.',404);
        const file=await storage.read(m.stored_name);res.writeHead(200,{'Content-Type':m.mime,'Content-Length':file.length,'Cache-Control':'no-store','Content-Disposition':`${m.kind==='document'?'attachment':'inline'}; filename="${m.id}${extname(m.stored_name)}"`,'Content-Security-Policy':"default-src 'none'; sandbox"});return res.end(file);
      }
      if(path.startsWith('/api/admin/')){
        const u=await requireStaff(req);
        if(await owners(req,res,path,u,body))return;
        if(path==='/api/admin/listings'&&method==='GET')return send(res,200,{listings:await listings(db,true)});
        if(path==='/api/admin/listings'&&method==='POST')return send(res,201,{listing:await saveListing(db,u,null,await body(req))});
        if(/^\/api\/admin\/listings\/[^/]+$/.test(path)){
          const id=path.split('/').at(-1);
          if(method==='GET')return send(res,200,{listing:await listing(db,id,true)});
          if(method==='PUT')return send(res,200,{listing:await saveListing(db,u,id,await body(req))});
        }
        if(path==='/api/admin/catalogue'&&method==='GET')return send(res,200,{amenities:await catalogue(db)});
        if(path==='/api/admin/staff'&&method==='GET')return send(res,200,{staff:(await db.find('staff_users',{}, {name:1})).map(userShape)});
        if(path==='/api/admin/staff'&&method==='POST'){await requireStaff(req,['administrator']);const data=await body(req),created=await createStaff(db,data,data.role||'editor');await audit(db,u,created.id,'staff.created',created.role);return send(res,201,{user:userShape(created)});}
        if(/^\/api\/admin\/staff\/[^/]+$/.test(path)&&method==='PATCH'){
          await requireStaff(req,['administrator']);const id=path.split('/').at(-1),data=await body(req),other=await db.get('staff_users',{id});requireValue(other,'Staff member not found.',404);const role=data.role||other.role,active=data.active===undefined?other.active:data.active?1:0;
          requireValue(['administrator','editor','reviewer'].includes(role),'Invalid role.');if(other.role==='administrator'&&other.active&&(role!=='administrator'||!active))requireValue(await db.count('staff_users',{role:'administrator',active:1})>1,'Keep at least one active administrator.');
          await db.put('staff_users',{id},{role,active});await db.remove('sessions',{user_id:id});await db.remove('staff_recovery',{staff_id:id});
          for(const interest of await db.find('saved_interests',{'grant.staff_id':id})){
            await db.put('saved_interests',{id:interest.id},{grant:null});
          }
          for(const enquiry of await db.find('enquiries',{assigned_id:id})) {
            await db.put('enquiries',{id:enquiry.id},{contact_grant:null,...(!active?{assigned_id:null}:{})});
          }
          await audit(db,u,id,'staff.access.changed',role);return send(res,200,{ok:true});
        }
        if(path==='/api/admin/projects'&&method==='GET')return send(res,200,{projects:await projects(db)});
        if(path==='/api/admin/projects'&&method==='POST'){
          await requireStaff(req,['administrator','editor']);const data=await body(req);requireValue(text(data.name,100).length>=3&&text(data.location,200),'Add project name and location.');const id=data.id||randomUUID();if(data.id)requireValue(await db.get('projects',{id}),'Project not found.',404);
          const minor=data.startingPrice?Math.round(Number(data.startingPrice)*100):null;requireValue(minor===null||(Number.isSafeInteger(minor)&&minor>0),'Invalid project starting price.');requireValue(Array.isArray(data.configurations)&&data.configurations.length<=30,'Provide up to 30 configurations.');
          const catalog=await catalogue(db);
          await transaction(db,async()=>{
            const existing=await db.get('projects',{id});
            if(existing&&data.revision!==undefined) requireValue(data.revision===(existing.revision||0),'This project changed in another session. Reload before saving.',409);
            const amenities=data.amenities===undefined ? existing?.amenities||[] : validateAmenities(data.amenities,catalog,{project:true});
            await db.put('projects',{id},{id,amenities,revision:(existing?.revision||0)+1,name:text(data.name,100),location:text(data.location,200),description:text(data.description,4000),starting_minor:minor,currency:'INR'});for(const c of data.configurations){requireValue(text(c.label,100)&&text(c.area,100),'Each configuration needs a label and area basis.');const cid=c.id||randomUUID(),amount=c.from?Math.round(Number(c.from)*100):null;requireValue(amount===null||(Number.isSafeInteger(amount)&&amount>0),'Invalid configuration starting price.');if(c.id)requireValue(await db.get('configurations',{id:cid,project_id:id}),'Configuration not found.');await db.put('configurations',{id:cid},{id:cid,project_id:id,label:text(c.label,100),area_label:text(c.area,100),starting_minor:amount});}await audit(db,u,id,'project.saved');});return send(res,200,{projects:await projects(db)});
        }
        if(path==='/api/admin/media-review'&&method==='GET'){
          const files=[];
          for(const link of await db.find('listing_media',{visibility:{$in:['public','member']}},{listing_id:1,position:1})){
            const media=await db.get('media',{id:link.media_id});
            if(!media||media.review_status==='Reviewed')continue;
            const record=await db.get('listings',{id:link.listing_id});
            files.push({id:media.id,name:media.original_name,kind:media.kind,listingId:link.listing_id,title:record?.title,
              visibility:link.visibility,status:media.review_status||'Needs review',scan:media.kind==='document'?media.scan_status||'Checking':undefined});
          }
          return send(res,200,{files});
        }
        const review=/^\/api\/admin\/media-review\/([A-Za-z0-9-]{1,80})$/.exec(path);
        if(review&&method==='GET'){
          const media=await db.get('media',{id:review[1]});
          requireValue(media,'File not found.',404);
          return send(res,200,{scan:media.kind==='document'?media.scan_status||'Checking':undefined,review:media.review_status});
        }
        if(review&&method==='POST'){
          const {status}=await body(),id=review[1];
          const media=await db.get('media',{id});
          requireValue(media,'File not found.',404);
          requireValue(['Reviewed','Restricted'].includes(status),'Choose a review result.');
          requireValue(status==='Restricted'||media.kind!=='document'||media.scan_status==='Ready','Wait for the PDF scan before completing review.',409);
          await db.put('media',{id},{review_status:status});
          await audit(db,u,id,'media.privacy.reviewed',status);
          return send(res,200,{status});
        }
        if(path==='/api/admin/media'&&method==='POST'){
          await requireStaff(req,['administrator','editor','reviewer']);const data=await body(req);requireValue(['image','floorplan','document'].includes(data.kind),'Choose a file kind.');requireValue(typeof data.data==='string'&&data.data.length<=11*1024*1024&&/^[A-Za-z0-9+/]*={0,2}$/.test(data.data),'Invalid upload encoding.');const input=Buffer.from(data.data,'base64');requireValue(input.length>0&&input.length<=8*1024*1024,'Files must be at most 8 MB.');
          const id=randomUUID();let output,mime,extension;
          if(data.kind==='document'){requireValue(input.subarray(0,5).toString()==='%PDF-'&&/%%EOF\s*$/.test(input.toString('latin1')),'Upload a valid PDF document.');output=input;mime='application/pdf';extension='.pdf';}
          else{const jpeg=input[0]===255&&input[1]===216&&input[2]===255,png=input.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),webp=input.subarray(0,4).toString()==='RIFF'&&input.subarray(8,12).toString()==='WEBP';requireValue(jpeg||png||webp,'Upload a JPEG, PNG, or WebP image.');try{output=await sharp(input,{limitInputPixels:40_000_000,animated:false}).rotate().resize({width:2000,height:2000,fit:'inside',withoutEnlargement:true}).webp({quality:86}).toBuffer();}catch{throw new HttpError(400,'The image could not be decoded.');}mime='image/webp';extension='.webp';}
          const stored=id+extension;await storage.put(stored,output);try{await transaction(db,async()=>{await requireStaff(req,['administrator','editor','reviewer']);const startOfDay=new Date().toISOString().slice(0,10);
          requireValue(await db.count('media',{created_by:u.id,created_at:{$gte:startOfDay}})<100,'Daily upload limit reached. Try again tomorrow.',429);
          await db.insert('media',{id,stored_name:stored,original_name:text(data.name,150)||`upload${extension}`,mime,bytes:output.length,kind:data.kind,review_status:'Pending',...(data.kind==='document'?{scan_status:'Checking'}:{}),created_by:u.id,created_at:now()});await audit(db,u,id,'media.uploaded',data.kind);});}catch(e){await storage.delete(stored).catch(()=>{});throw e;}return send(res,201,{media:{id,url:`/api/files/${id}`,name:text(data.name,150),mime,kind:data.kind,review:'Pending',scan:data.kind==='document'?'Checking':undefined,visibility:data.kind==='document'?'internal':'public',caption:'',classification:'actual'}});
        }
        throw new HttpError(404,'API route not found.');
      }
      if(hosted&&method==='GET'&&/^(\/projects|\/(property|projects)\/[^/]+)$/.test(path)){
        const html=await renderShell(hosted.frontend);
        requireValue(html,'The frontend is temporarily unavailable. Try again shortly.',503);
        const page=await publicPage(db,path,origin,html,hosted.api.origin);
        res.writeHead(page.status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
        return res.end(page.html);
      }
      if(serveStatic&&method==='GET'&&!path.startsWith('/api/')){
        const base=resolve('dist'),target=resolve(base,`.${decodeURIComponent(path)}`);requireValue(target.startsWith(base+sep)||target===base,'Not found.',404);let file=target;if(!existsSync(file)||!extname(file))file=resolve(base,'index.html');requireValue(existsSync(file),'Build the frontend before starting this server.',404);if(extname(file)==='.html'){const page=await publicPage(db,path,origin||`http://${req.headers.host}`,readFileSync(file,'utf8'));res.writeHead(page.status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(page.html);}const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.jpg':'image/jpeg','.svg':'image/svg+xml','.ttf':'font/ttf'}[extname(file)]||'application/octet-stream';res.writeHead(200,{'Content-Type':mime});return res.end(readFileSync(file));
      }
      throw new HttpError(404,'Not found.');
      };
      if(path.startsWith('/api/admin/')&&!['GET','HEAD'].includes(method)&&path!=='/api/admin/media'){
        if(path==='/api/admin/bootstrap'||path==='/api/admin/login')rate(req,path);
        const payload=await readBody(req);let staged;const realSet=res.setHeader.bind(res);const headers=new Map();const shadow={setHeader:(k,v)=>headers.set(k,v),writeHead:(status,h)=>{staged={status,headers:h};},end:value=>{staged.value=value;}};
        const result=await transaction(db,async()=>{headers.clear();return dispatch(shadow,payload);});
        for(const [k,v] of headers)realSet(k,v);res.writeHead(staged.status,staged.headers);return res.end(staged.value);
      }
      return await dispatch();
    }catch(e){if(res.headersSent)return res.end();send(res,e.status||(e.code===11000?409:e.name?.startsWith('Mongo')?503:500),{error:e.status?e.message:e.code===11000?'A record with these values already exists.':e.name?.startsWith('Mongo')?'The database is unavailable. Try again.':'The server could not complete the request. Try again.',issues:e instanceof HttpError?e.issues:undefined});}
  });
  const stopWorker=worker ? startUpdates(db) : async()=>{};
  const stopScans=worker ? startPdfScans(db,storage,process.env.CLAMD_HOST) : async()=>{};
  return {server,db,close:async()=>{await Promise.all([stopWorker(),stopScans()]);await new Promise(r=>server.close(r));storage.close?.();await db.close();}};
}
