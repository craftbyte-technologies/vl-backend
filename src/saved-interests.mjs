import {randomUUID} from 'node:crypto';
import {audit,now,requireValue,transaction} from './database.mjs';

const base='/api/team-interests';
const outcomes=['Interested','Not interested','No answer'];
const reference=/^[A-Za-z0-9-]{1,80}$/;

export function savedInterestRoute({db,actor,readBody,send,screen,stageOf,changeStage}){
  async function view(row,staff){
    const admin=staff.role==='administrator';
    const account=await db.get('external_accounts',{id:row.account_id,kind:'customer'});
    const eligible=!!(row.active&&!row.enquiry_id&&row.last_outcome!=='Not interested'&&
      account?.saved_call_permission?.allowed&&account.saved_call_phone);
    const grant=row.grant;
    const authorized=grant?.staff_id===staff.id&&grant.expires_at>Date.now();
    if(!admin&&!(eligible&&authorized))return null;
    const listing=await db.get('listings',{id:row.listing_id});
    return {id:row.id,title:row.title,locality:row.locality,savedAt:row.saved_at,
      availability:listing?.publication==='Published'?listing.availability:'Off market',
      eligible,lastOutcome:row.last_outcome,leadId:row.enquiry_id,grant:admin||authorized?grant:null,
      phone:eligible&&(admin||authorized)?account.saved_call_phone:undefined};
  }

  async function delegate(row,staff,data){
    requireValue(staff.role==='administrator','Administrator access required.',403);
    if(data.revoke){
      await db.put('saved_interests',{id:row.id},{grant:null});
      await audit(db,staff,row.id,'interest.contact.revoked');
      return {};
    }
    const expires_at=typeof data.expiresAt==='string'?Date.parse(data.expiresAt):NaN;
    const recipient=typeof data.staffId==='string'&&await db.get('staff_users',{id:data.staffId,active:1});
    requireValue(recipient&&recipient.role!=='administrator'&&expires_at>Date.now(),'Choose a staff member and an expiry in the future.');
    await db.put('saved_interests',{id:row.id},{grant:{staff_id:recipient.id,expires_at}});
    await audit(db,staff,row.id,'interest.contact.granted',JSON.stringify({staffId:recipient.id,expires_at}));
    return {};
  }

  async function convert(row,staff,summary,qualify){
    const account=await db.get('external_accounts',{id:row.account_id,kind:'customer'});
    const filter={target_kind:'Listing',target_id:row.listing_id,email:account.email};
    const existing=await db.get('enquiries',filter);
    const at=now();
    const lead=existing||{...filter,id:randomUUID(),title:row.title,project_id:row.project_id,verified:true,source:'Saver call',
      stage:'New',assigned_id:staff.role==='administrator'?null:staff.id,requests:[],created_at:at,updated_at:at,
      name:account.name,phone:account.saved_call_phone};
    await db.put('enquiries',{id:lead.id},{...lead,interest_id:row.id,interest_locality:row.locality});
    if(stageOf(lead)!=='Qualified'){
      await changeStage(lead,staff,'In progress','Customer confirmed interest',{notes:existing?.notes||summary,contact_grant:null});
      if(qualify){
        const progressing=await db.get('enquiries',{id:lead.id});
        await changeStage(progressing,staff,'Qualified','Qualified for client consideration',{qualification:summary});
      }
    }
    await audit(db,staff,lead.id,'enquiry.interest.linked',row.id);
    return lead.id;
  }

  return async(req,res,path)=>{
    if(path!==base&&!path.startsWith(base+'/'))return false;
    const staff=await actor(req);
    requireValue(staff,'Team sign-in required.',401);
    if(path===base&&req.method==='GET'){
      const filter=staff.role==='administrator'?{active:true}:{active:true,'grant.staff_id':staff.id,'grant.expires_at':{$gt:Date.now()}};
      const interests=[];
      for(const row of await db.find('saved_interests',filter,{saved_at:-1})){
        const projected=await view(row,staff);
        if(projected)interests.push(projected);
      }
      send(res,200,{interests});
      return true;
    }
    const [,id,action]=/^\/([A-Za-z0-9-]{1,80})\/(grant|outcome)$/.exec(path.slice(base.length))||[];
    requireValue(req.method==='POST'&&id,'Saved interest route not found.',404);
    const data=await readBody(req);
    const result=await transaction(db,async()=>{
      const acting=await actor(req);
      requireValue(acting,'Team sign-in required.',401);
      const row=await db.get('saved_interests',{id});
      requireValue(row,'Saved interest not found.',404);
      const attempts=row.attempts||[];
      if(action==='outcome'&&attempts.some(attempt=>attempt.key===data.key&&attempt.actorId===acting.id))return {leadId:row.enquiry_id};
      const projected=await view(row,acting);
      requireValue(projected,'Saved interest not found.',404);
      if(action==='grant'){
        requireValue(data.revoke||projected.eligible,'This save is unavailable for outreach.',409);
        return delegate(row,acting,data);
      }
      requireValue(projected.eligible,'This save is unavailable for outreach.',409);
      requireValue(outcomes.includes(data.outcome),'Choose a call outcome.');
      requireValue(typeof data.key==='string'&&reference.test(data.key),'Invalid call reference.');
      requireValue(attempts.length<250,'Call history limit reached.',409);
      const summary=screen(data.summary);
      const interested=data.outcome==='Interested';
      if(interested)requireValue(summary.body&&!summary.held,'Record the requirement without contact details.');
      const leadId=interested?await convert(row,acting,summary.body,data.qualify===true):undefined;
      await db.put('saved_interests',{id},{last_outcome:data.outcome,attempts:[...attempts,
        {at:now(),key:data.key,outcome:data.outcome,actorId:acting.id}],...(leadId?{enquiry_id:leadId}:{}),grant:null});
      await audit(db,acting,id,'interest.call.recorded',data.outcome);
      return {leadId};
    });
    send(res,200,result);
    return true;
  };
}
