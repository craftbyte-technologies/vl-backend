import brand from './brand.json' with { type: 'json' };
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {audit, HttpError, now, requireValue, text, transaction} from './database.mjs';
import {currentCustomer} from './customers.mjs';
import {savedInterestRoute} from './saved-interests.mjs';
import {queueUpdate} from './updates.mjs';

const idPattern = /^[a-zA-Z0-9-]{1,80}$/;
const tokenPattern = /^[a-f0-9]{64}$/;
const hour = 3_600_000;
const digest = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('hex');
const types = ['Interest','Callback','Visit'];
const stageOf = row => row.stage || 'New';
const indiaDay = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(new Date());
const closeReasons = ['Request completed','Customer withdrew','Property unavailable','No response'];
const grantFields = ['email','phone'];
const emailPattern = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,63}$/;

function screen(value) {
  const original=text(value,2000);
  const screened=original.normalize('NFKC')
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,63}/gi,'[email removed]')
    .replace(/(?:\+?\d[\s().-]*){7,}\d/g,'[number removed]')
    .replace(/(?:(?:https?:\/\/|www\.)\S+|@[\p{L}\d_]{2,})/giu,'[contact link removed]');
  const held=/[\p{Cf}]|\b(?:whatsapp|telegram|instagram|gmail|contact me|call me|at\s+\w+\s+dot)\b|(?:\p{Nd}\D*){7,}/iu.test(screened);
  return {original,body:held?'':screened,held};
}

function csvCell(value) {
  const plain=String(value??'').replace(/\u0000/g,'');
  const safe=/^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/u.test(plain) ? "'"+plain : plain;
  return '"'+safe.replaceAll('"','""')+'"';
}

export function enquiryRoutes({db,mail,origin,secure,rate,readBody,send,actor}) {
  async function target(kind,id) {
    if(kind==='Listing'){
      const listing=await db.get('listings',{id,publication:'Published',availability:'Available'});
      requireValue(listing,'This listing is unavailable for new enquiries.',404);
      return {id,kind,title:listing.title,project_id:listing.project_id||null,responsible_id:listing.responsible_id};
    }
    const project=await db.get('projects',{id});
    const offers=project?await db.find('listings',{project_id:id,publication:'Published',availability:'Available'}):[];
    requireValue(offers.length,'This project is unavailable for new enquiries.',404);
    const contacts=new Set(offers.map(offer=>offer.responsible_id));
    return {id,kind,title:project.name,project_id:id,responsible_id:project.responsible_id||(contacts.size===1?offers[0].responsible_id:null)};
  }

  async function addMessage(row,source,body,id=randomUUID()) {
    const content=screen(body);
    if(!content.original)return false;
    const {original,...visible}=content;
    await db.insert('enquiry_messages',{id,enquiry_id:row.id,source,...visible,at:now()});
    if(content.held||original!==content.body)await db.insert('enquiry_restricted_messages',{
      enquiry_id:row.id,message_id:id,original
    });
    return !content.held;
  }

  async function changeStage(row,acting,stage,reason,extra={}){
    const previous=stageOf(row);
    const at=now();
    const history=row.stage_history||[];
    const entry={from:previous,to:stage,reason,at,actor:acting?.name||'Customer'};
    await db.put('enquiries',{id:row.id},{stage,...extra,
      stage_history:previous===stage?history:[...history,entry],
      ...(stage==='Qualified'?{qualified_at:row.qualified_at||at}:{}),updated_at:at});
    if(previous!==stage)await audit(db,acting,row.id,'enquiry.stage.changed',JSON.stringify({from:previous,to:stage,reason}));
  }

  async function routeTo(staffId){
    return staffId&&await db.get('staff_users',{id:staffId,active:1}) ? staffId : null;
  }

  async function recordRequest(data,party,initialTarget,key) {
    const filter={target_id:initialTarget.id,target_kind:initialTarget.kind,email:party.email};
    const row=await db.get('enquiries',filter);
    const requests=row?.requests||[];
    if(requests.some(r=>r.id===key))return row;
    requireValue(requests.length<100,'This enquiry has reached its request limit.',409);
    const request={id:key,kind:data.intent,at:now(),permissionVersion:2};
    const first=!row;
    const next={...row,...filter,id:row?.id||randomUUID(),title:row?.title||initialTarget.title,
      project_id:first?initialTarget.project_id:row.project_id,source:row?.source||'Direct enquiry',
      assigned_id:first?await routeTo(initialTarget.responsible_id):row.assigned_id||null,
      stage:row?stageOf(row):'New',verified:true,phone:data.phone||row?.phone||'',name:party.name,
      requests:[...requests,request],updated_at:request.at,created_at:row?.created_at||request.at};
    if(data.share===true)next.client_sharing={allowed:true,at:request.at,version:1,source:'enquiry'};
    const account=await db.get('external_accounts',{email:party.email,kind:'customer'});
    const interest=account&&initialTarget.kind==='Listing'&&await db.get('saved_interests',{account_id:account.id,listing_id:initialTarget.id});
    if(interest){
      next.interest_id=interest.id;
      next.interest_locality=interest.locality;
      await db.put('saved_interests',{id:interest.id},{enquiry_id:next.id,grant:null});
    }
    await db.put('enquiries',{id:next.id},next);
    if(stageOf(next)==='Closed'){
      await changeStage(next,party,'New','Customer submitted a new request',{contact_grant:null,qualification:''});
    }
    await addMessage(next,'Customer',data.message);
    await audit(db,party,next.id,'enquiry.requested',request.kind);
    return next;
  }

  async function guest(req) {
    const code=/(?:^|;\s*)forma_guest=([a-f0-9]{64})(?=;|$)/.exec(req.headers.cookie||'')?.[1];
    if(!code)return null;
    return db.get('guest_enquiry_sessions',{token_hash:digest(code),expires:{$gt:new Date()}});
  }

  async function authorized(req,id,staff) {
    const row=await db.get('enquiries',{id});
    requireValue(row,'Enquiry not found.',404);
    if(staff)requireValue(staff.role==='administrator'||row.assigned_id===staff.id,'Enquiry not found.',404);
    else{
      const account=await currentCustomer(db,req);
      const session=await guest(req);
      requireValue(account?(account.email===row.email&&row.verified):session?.enquiry_id===row.id,'Enquiry not found.',404);
    }
    return row;
  }

  async function thread(row,staff,before) {
    const administrator=staff?.role==='administrator';
    const grant=row.contact_grant;
    const activeGrant=staff&&grant?.staff_id===staff.id&&grant.expires_at>Date.now()&&row.assigned_id===staff.id;
    const cursor=before?.split('|');
    if (cursor) requireValue(cursor.length===2&&Number.isFinite(Date.parse(cursor[0]))&&idPattern.test(cursor[1]),'Invalid message cursor.');
    const earlier=cursor?{$or:[{at:{$lt:cursor[0]}},{at:cursor[0],id:{$lt:cursor[1]}}]}:{};
    const messages=await db.raw.collection('enquiry_messages').find({
      enquiry_id:row.id,...earlier
    }).sort({at:-1,id:-1}).limit(51).toArray();
    const visit=row.visit||null;
    const current=staff&&row.target_kind==='Listing'&&await db.get('listings',{id:row.target_id});
    let location;
    if(!staff&&visit?.status==='Confirmed'&&visit.disclosed_at&&row.target_kind==='Listing'){
      const listing=await db.get('listings',{id:row.target_id,publication:'Published'});
      if(listing)location=row.disclosed_location;
    }
    const recent = messages.slice(0,50).reverse();
    const heldBodies = new Map();
    if (administrator) for (const message of recent.filter(item=>item.held)) {
      const restricted=await db.get('enquiry_restricted_messages',{enquiry_id:row.id,message_id:message.id});
      heldBodies.set(message.id,restricted?.original||'');
    }
    return {id:row.id,title:row.title,projectId:row.project_id,targetKind:row.target_kind,
      requests:row.requests,visit,location,verified:row.verified,updatedAt:row.updated_at,
      clientSharing:!!row.client_sharing?.allowed,
      ...(staff?{stage:stageOf(row),history:row.stage_history||[],qualification:row.qualification,
        source:row.source||'Direct enquiry',interestLocality:row.interest_locality,
        availability:row.target_kind==='Listing'?(current?.publication==='Published'?current.availability:'Off market'):undefined,lastAttempt:row.call_attempts?.at(-1)}:{}),
      ...(staff?{assignedId:row.assigned_id,followUp:row.follow_up,notes:row.notes,contactGrant:administrator||activeGrant?grant:undefined}:{}),
      ...(administrator?{name:row.name,email:row.email,phone:row.phone}:Object.fromEntries((activeGrant?grant.fields:[]).map(field=>[field,row[field]]))),
      messages:recent.map(m=>({
        id:m.id,source:m.source,at:m.at,held:m.held,
        ...(m.held ? administrator ? {body:heldBodies.get(m.id)}:{} : {body:m.body})
      })),
      previous:messages.length>50?messages[49].at+'|'+messages[49].id:undefined
    };
  }

  async function submit(req,res) {
    rate(req,'enquiry-create');
    const input=await readBody(req),{targetKind,targetId,intent,key}=input;
    requireValue(['Listing','Project'].includes(targetKind)&&typeof targetId==='string'&&idPattern.test(targetId)&&types.includes(intent),'Choose a property and request type.');
    requireValue(typeof key==='string'&&idPattern.test(key),'Invalid request reference.');
    const account=await currentCustomer(db,req);
    const email=account?.email||text(input.email,120).toLowerCase();
    if (!account) requireValue(!await db.get('external_accounts',{email,kind:'owner'}),'Use a customer email address for enquiries.',403);
    const name=account?.name||text(input.name,80);
    const phone=text(input.phone,30);
    requireValue(emailPattern.test(email)&&name.length>=2,'Enter your name and a valid email address.');
    requireValue((!phone&&intent!=='Callback')||(/^[+()0-9 -]{7,30}$/.test(phone)&&phone.replace(/\D/g,'').length>=7),'Enter a valid contact number.');
    const data={intent,phone,message:text(input.message,2000),share:input.share===true};
    if(account){
      const row=await transaction(db,async()=>{
        requireValue(await currentCustomer(db,req),'Sign in to continue.',401);
        return recordRequest(data,account,await target(targetKind,targetId),key);
      });
      return send(res,201,{id:row.id});
    }
    requireValue(mail,'Guest verification email is unavailable in this installation.',503);
    const code=token(),token_hash=digest(code);
    const pending=await transaction(db,async()=>{
      const destination=await target(targetKind,targetId);
      const filter={target_kind:targetKind,target_id:targetId,email};
      const existing=await db.get('guest_enquiry_requests',filter);
      if(existing&&existing.expires>Date.now()&&Date.now()-existing.created_at<60_000)return false;
      await db.put('guest_enquiry_requests',filter,{...filter,target:destination,name,data,key,token_hash,created_at:Date.now(),expires:new Date(Date.now()+hour/2)});
      return true;
    });
    if(pending){
      const link=new URL('/account/enquiry',origin||`http://${req.headers.host}`);
      link.hash='code='+code;
      try{await mail({to:email,subject:`Verify your ${brand.name} enquiry`,link:link.href});}
      catch{
        await db.remove('guest_enquiry_requests',{token_hash});
        throw new HttpError(503,'The verification email could not be sent. Please retry.');
      }
    }
    return send(res,202,{verify:true});
  }

  async function verify(req,res){
    rate(req,'enquiry-verify');
    const {code}=await readBody(req);
    requireValue(typeof code==='string'&&tokenPattern.test(code),'This link is invalid or has expired.');
    const session=token();
    const id=await transaction(db,async()=>{
      const filter={token_hash:digest(code),expires:{$gt:new Date()}};
      const pending=await db.get('guest_enquiry_requests',filter);
      requireValue(pending,'This link is invalid or has expired.');
      const destination=await target(pending.target_kind,pending.target_id);
      requireValue(!await db.get('external_accounts',{email:pending.email,kind:'owner'}),'Use a customer email address for enquiries.',403);
      const row=await recordRequest(pending.data,pending,destination,pending.key);
      await db.remove('guest_enquiry_requests',filter);
      await db.insert('guest_enquiry_sessions',{token_hash:digest(session),enquiry_id:row.id,expires:new Date(Date.now()+7*24*hour)});
      return row.id;
    });
    res.setHeader('Set-Cookie',`forma_guest=${session}; HttpOnly; SameSite=Strict; Path=/api/customer/enquiries; Max-Age=604800${secure?'; Secure':''}`);
    return send(res,200,{id});
  }

  const savedInterests=savedInterestRoute({db,actor,readBody,send,screen,stageOf,changeStage});
  return async (req,res,path) => {
    if(await savedInterests(req,res,path))return true;
    const admin=path.startsWith('/api/team-enquiries');
    const base=admin?'/api/team-enquiries':'/api/customer/enquiries';
    if(path!==base&&!path.startsWith(base+'/'))return false;
    const method=req.method;
    const staff=admin?await actor(req):null;
    if(admin)requireValue(staff,'Team sign-in required.',401);
    if(path===base&&method==='POST'&&!admin){await submit(req,res);return true;}
    if(path===base+'/verify'&&method==='POST'&&!admin){await verify(req,res);return true;}
    if(path===base+'/export'&&method==='POST'&&admin){
      requireValue(staff.role==='administrator','Administrator access required.',403);
      const {ids,fields,versions}=await readBody(req);
      const allowed=['id','title','target_id','project_id','created_at','updated_at','stage','source','qualification','name','email','phone'];
      requireValue(Array.isArray(ids)&&ids.length>0&&ids.length<=200&&ids.every(id=>typeof id==='string'&&idPattern.test(id)),'Select up to 200 enquiries.');
      requireValue(Array.isArray(fields)&&fields.length>0&&fields.every(field=>allowed.includes(field)),'Select export columns.');
      const csv=await transaction(db,async()=>{
        const acting=await actor(req);
        requireValue(acting?.role==='administrator','Administrator access required.',403);
        const uniqueIds=[...new Set(ids)],columns=[...new Set(fields)];
        const rows=await db.find('enquiries',{id:{$in:uniqueIds}});
        requireValue(rows.length===uniqueIds.length&&rows.every(row=>stageOf(row)==='Qualified'&&row.client_sharing?.allowed),'A selected lead is no longer eligible. Refresh your selection.',409);
        if(versions)requireValue(rows.every(row=>versions[row.id]===row.updated_at),'A selected lead changed. Select the latest version before exporting.',409);
        await audit(db,acting,'enquiries','enquiry.exported',JSON.stringify({ids:uniqueIds,fields:columns}));
        return [columns,...rows.map(row=>columns.map(key=>row[key]))].map(row=>row.map(csvCell).join(',')).join('\r\n');
      });
      send(res,200,{csv});return true;
    }
    if(path===base&&method==='GET'){
      const administrator=staff?.role==='administrator';
      const account=!staff&&await currentCustomer(db,req);
      const session=!staff&&!account&&await guest(req);
      const filter=staff?(administrator?{}:{assigned_id:staff.id}):account?{email:account.email,verified:true}:session?{id:session.enquiry_id}:{id:null};
      const rows=await db.find('enquiries',filter,{updated_at:-1});
      const saved=administrator ? await db.find('customer_bookmarks',{saved:true}) : [];
      const incoming=administrator ? await db.count('guest_enquiry_requests',{expires:{$gt:new Date()}}) : undefined;
      const distinct=new Set(),perProject={};
      if(administrator){
        const listings=await db.find('listings',{});
        const index=new Map(listings.map(l=>[l.id,l]));
        for (const bookmark of saved){
          const project=index.get(bookmark.listing_id)?.project_id;
          distinct.add((project||'standalone')+':'+bookmark.account_id);
        }
        for(const key of distinct){
          const project=key.split(':')[0];
          perProject[project]=(perProject[project]||0)+1;
        }
      }
      send(res,200,{enquiries:rows.map(row=>({id:row.id,title:row.title,projectId:row.project_id,assignedId:staff?row.assigned_id:undefined,
        request:row.requests.at(-1)?.kind||'Saver call',updatedAt:row.updated_at,createdAt:row.created_at,
        ...(staff?{stage:stageOf(row),source:row.source||'Direct enquiry',qualifiedAt:row.qualified_at,visitConfirmedAt:row.visit_confirmed_at,
          firstReplyAt:row.first_reply_at,followUp:row.follow_up,upcomingVisit:row.visit?.status==='Confirmed'?row.visit.at:null,
          exportEligible:administrator&&stageOf(row)==='Qualified'&&!!row.client_sharing?.allowed}:{})})),metrics:administrator?{incoming,saves:saved.length,perProject}:undefined});
      return true;
    }
    const match=/^\/([A-Za-z0-9-]{1,80})(?:\/([a-z-]+))?$/.exec(path.slice(base.length));
    if(!match)throw new HttpError(404,'Enquiry route not found.');
    const [,id,action]=match;
    if(method==='GET'&&!action){
      const row=await authorized(req,id,staff);
      const before=new URL(req.url,`http://${req.headers.host}`).searchParams.get('before');
      send(res,200,{enquiry:await thread(row,staff,before)});return true;
    }
    requireValue(method==='POST'&&action,'Enquiry route not found.',404);
    const data=await readBody(req);
    await transaction(db,async()=>{
      const acting=admin?await actor(req):null;
      if(admin)requireValue(acting,'Team sign-in required.',401);
      const row=await authorized(req,id,acting),administrator=acting?.role==='administrator';
      if(action==='message'){
        requireValue(stageOf(row)!=='Closed','This lead is closed. Submit a new request or reopen it to continue.',409);
        rate(req,'enquiry-message');
        requireValue(row.verified&&text(data.body,2000),'Enter a message.');
        const {key}=data;
        requireValue(typeof key==='string'&&idPattern.test(key),'Invalid message reference.');
        if(!await db.get('enquiry_messages',{enquiry_id:id,id:key})){
          const delivered=await addMessage(row,acting?'Team':'Customer',data.body,key);
          if(acting&&delivered){
            await queueUpdate(db,'messages',{enquiry_id:id});
            if(stageOf(row)==='New')await changeStage(row,acting,'In progress','First team reply',{first_reply_at:row.first_reply_at||now()});
            else if(!row.first_reply_at)await db.put('enquiries',{id},{first_reply_at:now()});
          }
        }
      }else if(action==='sharing'&&!acting){
        requireValue(!admin&&typeof data.allowed==='boolean',`Choose whether ${brand.name} may share these details.`);
        if(!!row.client_sharing?.allowed===data.allowed)return;
        await db.put('enquiries',{id},{client_sharing:{allowed:data.allowed,at:now(),version:1,source:'verified thread'}});
        await audit(db,null,id,'enquiry.sharing.changed',data.allowed?'allowed':'withdrawn');
      }else if(action==='qualify'&&acting){
        requireValue(stageOf(row)!=='Closed','Reopen this lead first.',409);
        const summary=screen(data.summary);
        requireValue(summary.body&&!summary.held,'Enter a client-facing requirement without contact details.');
        await changeStage(row,acting,'Qualified','Qualified for client consideration',{qualification:summary.body});
      }else if(action==='call'&&acting){
        requireValue(stageOf(row)!=='Closed','Reopen this lead first.',409);
        requireValue(row.phone&&(administrator||(row.contact_grant?.staff_id===acting.id&&
          row.contact_grant.expires_at>Date.now()&&row.contact_grant.fields.includes('phone'))),'Phone access is required.',403);
        requireValue(['Connected','No answer'].includes(data.outcome),'Choose a call outcome.');
        const attempts=row.call_attempts||[];
        requireValue(attempts.length<250,'Call history limit reached.',409);
        requireValue(typeof data.key==='string'&&idPattern.test(data.key),'Invalid call reference.');
        if(attempts.some(a=>a.key===data.key))return;
        const call_attempts=[...attempts,{key:data.key,outcome:data.outcome,day:indiaDay(),at:now(),actor:acting.name}];
        await changeStage(row,acting,stageOf(row)==='New'&&data.outcome==='Connected'?'In progress':stageOf(row),
          'Connected call',{call_attempts});
        await audit(db,acting,id,'enquiry.call.recorded',data.outcome);
      }else if(action==='close'&&acting){
        requireValue(stageOf(row)!=='Closed'&&closeReasons.includes(data.reason),'Choose a closure reason.',409);
        if(data.reason==='No response')requireValue(new Set((row.call_attempts||[]).filter(a=>a.outcome==='No answer').map(a=>a.day)).size>=2,
          'Record unanswered calls on two separate days before closing for no response.',409);
        await changeStage(row,acting,'Closed',data.reason,{contact_grant:null});
      }else if(action==='reopen'&&administrator){
        requireValue(stageOf(row)==='Closed','This lead is already open.',409);
        await changeStage(row,acting,'New','Reopened by admin',{qualification:'',contact_grant:null});
      }else if(action==='assign'&&administrator){
        requireValue(!data.staffId||(typeof data.staffId==='string'&&idPattern.test(data.staffId)&&await db.get('staff_users',{id:data.staffId,active:1})),'Choose an active staff member.');
        if((row.assigned_id||null)!==(data.staffId||null)){
          await db.put('enquiries',{id},{assigned_id:data.staffId||null,contact_grant:null});
          await audit(db,acting,id,'enquiry.assigned',data.staffId||'Unassigned');
        }
      }else if(action==='contact'&&administrator){
        if(data.revoke)await db.put('enquiries',{id},{contact_grant:null});
        else{
          const expires_at=new Date(data.expiresAt).getTime();
          requireValue(row.assigned_id&&row.assigned_id===data.staffId&&await db.get('staff_users',{id:row.assigned_id,active:1,role:{$ne:'administrator'}}),'Grant access to the currently assigned staff member.');
          requireValue(Array.isArray(data.fields)&&data.fields.length>0&&data.fields.every(field=>grantFields.includes(field))&&expires_at>Date.now(),'Choose contact fields and an expiry in the future.');
          await db.put('enquiries',{id},{contact_grant:{staff_id:row.assigned_id,expires_at,fields:[...new Set(data.fields)]}});
        }
        await audit(db,acting,id,data.revoke?'enquiry.contact.revoked':'enquiry.contact.granted',data.revoke?'':JSON.stringify({staffId:data.staffId,fields:data.fields,expiresAt:data.expiresAt}));
      }else if(action==='moderate'&&administrator){
        requireValue(typeof data.messageId==='string'&&idPattern.test(data.messageId),'Select a message.');
        const message=await db.get('enquiry_messages',{id:data.messageId,enquiry_id:id,held:true});
        requireValue(message,'Message is not awaiting review.',409);
        const content=screen(data.body);
        requireValue(content.body&&!content.held,'Enter a version without contact information.');
        await db.put('enquiry_messages',{id:message.id,enquiry_id:id},{body:content.body,held:false});
        await audit(db,acting,id,'enquiry.message.reviewed',message.id);
        if(message.source==='Team'){
          await queueUpdate(db,'messages',{enquiry_id:id});
          if(stageOf(row)==='New')await changeStage(row,acting,'In progress','First released team reply',{first_reply_at:row.first_reply_at||now()});
        }
      }else if(action==='follow-up'&&acting){
        const date=text(data.date,10);
        requireValue(!date||/^\d{4}-\d{2}-\d{2}$/.test(date),'Choose a follow-up date.');
        const screened=screen(data.notes);
        requireValue(!screened.held,'Remove contact details from internal notes.');
        await db.put('enquiries',{id},{follow_up:date,notes:screened.body});
      }else if(action==='visit'){
        const previous=row.visit;
        const status=data.status;
        const schedule=typeof data.at==='string'?new Date(data.at):null;
        const date=schedule&&Number.isFinite(schedule.getTime())?schedule.toISOString():null;
        requireValue(acting||status==='Cancelled','Team confirmation is required.',403);
        if(status==='Confirmed')await target(row.target_kind,row.target_id);
        requireValue(status==='Confirmed' ? date&&schedule.getTime()>Date.now() : previous?.status==='Confirmed'&&['Cancelled','Completed','No-show'].includes(status),'Choose a valid visit action.');
        if(['Completed','No-show'].includes(status))requireValue(Date.parse(previous.at)<=Date.now(),'Record the outcome after the visit time.');
        const visit={status,at:status==='Confirmed'?date:previous.at};
        if(previous?.status===visit.status&&previous?.at===visit.at)return;
        await db.put('enquiries',{id},{visit,disclosed_location:null,...(status==='Confirmed'?{visit_confirmed_at:row.visit_confirmed_at||now()}:{})});
        await audit(db,acting,id,'enquiry.visit.changed',JSON.stringify(visit));
        await queueUpdate(db,'visits',{enquiry_id:id});
      }else if(action==='disclose'&&acting){
        requireValue(row.visit?.status==='Confirmed'&&row.target_kind==='Listing','Confirm a listing visit before disclosing its location.',409);
        const listing=await db.get('listings',{id:row.target_id,publication:'Published'});
        const place=listing?.availability==='Available'&&await db.get('locations',{property_id:listing.property_id});
        requireValue(place&&(place.internal_address||(Number.isFinite(place.exact_lat)&&Number.isFinite(place.exact_lng))),'The team has not entered exact viewing details.',409);
        if(row.visit.disclosed_at)return;
        await db.put('enquiries',{id},{visit:{...row.visit,disclosed_at:now()},disclosed_location:{address:place.internal_address,latitude:place.exact_lat,longitude:place.exact_lng}});
        await queueUpdate(db,'visits',{enquiry_id:id});
        await audit(db,acting,id,'enquiry.visit.location_disclosed');
      }else throw new HttpError(403,'This action is unavailable.');
      await db.put('enquiries',{id},{updated_at:now()});
    });
    send(res,200,{ok:true});return true;
  };
}
