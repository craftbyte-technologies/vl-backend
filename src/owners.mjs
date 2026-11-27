import {randomUUID} from 'node:crypto';
import {audit, now, requireValue, text, transaction, types} from './database.mjs';
import {currentCustomer} from './customers.mjs';
import {saveListing} from './inventory.mjs';

const idPattern = /^[A-Za-z0-9-]{1,80}$/;
const ownerStatuses = ['Pending','Approved','Changes requested','Rejected','Suspended'];
const editable = ['administrator','editor','reviewer'];

function proposal(input) {
  const title = text(input.title,100), neighbourhood = text(input.neighbourhood,100);
  const description = text(input.description,4000);
  const area = Number(input.area), price = Number(input.price);
  const type = input.type, transaction = input.transaction;
  requireValue(title.length >= 5 && neighbourhood && description.length >= 30, 'Enter a title, neighbourhood and description of at least 30 characters.');
  requireValue(types.includes(type) && ['Buy','Rent'].includes(transaction),'Choose a property type and offer.');
  requireValue(Number.isFinite(area) && area > 0 && area <= 1e9 && Number.isFinite(price) && price > 0 && price <= 1e12,'Enter a valid area and asking price.');
  return {title, neighbourhood, description, area, price, type, transaction};
}

async function submissionView(db, submission, owner) {
  const listing = submission.listing_id ? await db.get('listings',{id:submission.listing_id}) : null;
  const {id,status,revisions,feedback} = submission;
  const base = {id,status,revisions,feedback,listingStatus:listing?.publication || null};
  return owner ? base : {...base,ownerId:submission.owner_id,listingId:submission.listing_id};
}

async function takeDown(db, listing, reason, actor) {
  await db.put('listings',{id:listing.id},{owner_hold:reason,publication:'Archived',revision:listing.revision+1});
  await audit(db,actor,listing.id,'owner.listing.hidden',reason);
}

export function ownerWorkflows({db, readBody, send}) {
  return async (req,res,path,staff,body=()=>readBody(req)) => {
    if (!staff && path!=='/api/owner/application' && !path.startsWith('/api/owner/submissions')) return false;
    if (staff && !path.startsWith('/api/admin/owners')) return false;
    const method = req.method;
    if (!staff) {
      const owner = await currentCustomer(db,req,'owner');
      requireValue(owner,'Sign in to your owner account.',401);
      if (path==='/api/owner/application'&&method==='POST') {
        const data=await body();
        const phone=text(data.phone,30);
        requireValue(/^[+()0-9 -]{7,30}$/.test(phone)&&phone.replace(/\D/g,'').length>=7,'Enter a valid contact number.');
        requireValue(data.authorized==='on','Confirm your authority to submit properties.');
        await transaction(db,async()=>{
          const account=await currentCustomer(db,req,'owner');
          requireValue(account?.owner_status==='Changes requested','This application cannot be resubmitted.',409);
          await db.put('external_accounts',{id:account.id},{owner_phone:phone,declaration_at:now(),owner_status:'Pending'});
          await audit(db,account,account.id,'owner.application.resubmitted');
        });
        send(res,200,{ok:true});
        return true;
      }
      const base = '/api/owner/submissions';
      if (path === base && method === 'GET') {
        const rows = await db.find('owner_submissions',{owner_id:owner.id},{updated_at:-1});
        send(res,200,{submissions:await Promise.all(rows.map(row=>submissionView(db,row,true)))});
        return true;
      }
      const match = /^\/api\/owner\/submissions\/([A-Za-z0-9-]{1,80})(?:\/(unavailable))?$/.exec(path);
      if (method !== 'POST' || (path !== base && !match)) return false;
      const data = await body();
      const result = await transaction(db,async()=>{
        const account = await currentCustomer(db,req,'owner');
        requireValue(account?.owner_status==='Approved','Your owner account needs approval.',403);
        const existing = match ? await db.get('owner_submissions',{id:match[1],owner_id:account.id}) : null;
        if (match) requireValue(existing,'Submission not found.',404);
        if (match?.[2]) {
          const listing = existing.listing_id && await db.get('listings',{id:existing.listing_id});
          requireValue(listing,'This submission has no listing.',409);
          if (!listing.owner_hold) await takeDown(db,listing,'Owner reported unavailable',account);
          return existing;
        }
        const fields = proposal(data);
        const revisions = existing?.revisions || [];
        requireValue(revisions.length < 100,'This submission has reached its revision limit.');
        if (existing) requireValue(data.version===revisions.length,'Reload the current submission before revising.',409);
        if (!existing) requireValue(await db.count('owner_submissions',{owner_id:account.id}) < 100,'This account has reached its submission limit.');
        const row = {id:existing?.id || randomUUID(),owner_id:account.id,
          revisions:[...revisions,{...fields,at:now()}],status:'Pending review',
          feedback:existing?.feedback||'',listing_id:existing?.listing_id||null,updated_at:now()};
        await db.put('owner_submissions',{id:row.id},row);
        await audit(db,account,row.id,'owner.submission.received',String(row.revisions.length));
        return row;
      });
      send(res,200,{submission:await submissionView(db,result,true)});
      return true;
    }

    requireValue(editable.includes(staff.role),'Team access required.',403);
    if (method === 'GET' && path === '/api/admin/owners') {
      const accounts = await db.find('external_accounts',{kind:'owner'},{verified_at:-1});
      const submissions = await db.find('owner_submissions',{}, {updated_at:-1});
      send(res,200,{
        owners:accounts.map(account=>({
          id:account.id,name:account.name,status:account.owner_status,feedback:account.owner_feedback||'',
          ...(staff.role==='administrator'?{email:account.email,phone:account.owner_phone,declaredAt:account.declaration_at}:{})
        })),
        submissions:await Promise.all(submissions.map(row=>submissionView(db,row,false)))
      });
      return true;
    }
    const approval = /^\/api\/admin\/owners\/([A-Za-z0-9-]{1,80})\/status$/.exec(path);
    const review = /^\/api\/admin\/owners\/submissions\/([A-Za-z0-9-]{1,80})$/.exec(path);
    if (method !== 'POST' || (!approval && !review)) return false;
    const data = await body();
    if (approval) {
      requireValue(staff.role==='administrator','Administrator access required.',403);
      requireValue(ownerStatuses.includes(data.status) && data.status!=='Pending','Choose an application decision.');
      const owner = await db.get('external_accounts',{id:approval[1],kind:'owner'});
      requireValue(owner,'Owner not found.',404);
      await db.put('external_accounts',{id:owner.id},{owner_status:data.status,owner_feedback:text(data.feedback,2000)});
      if (data.status!=='Approved') {
        const listings=await db.find('listings',{owner_id:owner.id});
        for (const listing of listings) if (listing.publication!=='Archived'||!listing.owner_hold) {
          await takeDown(db,listing,'Owner access withdrawn',staff);
        }
      }
      await audit(db,staff,owner.id,'owner.application.reviewed',data.status);
    } else {
      const row = await db.get('owner_submissions',{id:review[1]});
      requireValue(row,'Submission not found.',404);
      requireValue(data.version===row.revisions.length,'Reload the current submission before reviewing.',409);
      const owner = await db.get('external_accounts',{id:row.owner_id,kind:'owner',owner_status:'Approved'});
      requireValue(owner,'The owner requires approval.',409);
      const feedback = text(data.feedback,2000);
      const action = data.action;
      requireValue(['Request changes','Create draft','Review revision','Reopen draft'].includes(action),'Choose a review action.');
      if (action === 'Create draft') {
        requireValue(!row.listing_id,'A team listing already exists for this submission.',409);
        const {title,neighbourhood,description,type,transaction,area,price} = row.revisions.at(-1);
        const projectId = data.projectId && data.projectId!=='none' ? data.projectId : undefined;
        requireValue(!projectId || (typeof projectId==='string'&&idPattern.test(projectId)),'Choose a valid project.');
        const listing=await saveListing(db,staff,null,{title,neighbourhood,description,type,transaction,area,price,projectId,
          areaBasis:type==='Plot'?'Plot area':type==='Villa'?'Built-up area':type==='Office'?'Carpet area':'Super built-up area',
          publication:'Draft',amenities:[],media:[]});
        row.listing_id=listing.id;
        await db.put('listings',{id:listing.id},{owner_id:owner.id,owner_submission_id:row.id});
      } else if (action === 'Reopen draft') {
        requireValue(['administrator','reviewer'].includes(staff.role),'Publishing permission required.',403);
        const listing = row.listing_id && await db.get('listings',{id:row.listing_id});
        requireValue(listing?.owner_hold,'This listing is not on hold.',409);
        await db.put('listings',{id:listing.id},{owner_hold:null,publication:'Draft',revision:listing.revision+1});
      } else if (action === 'Review revision') {
        requireValue(row.listing_id,'Create a team draft first.',409);
        requireValue(feedback,'Record review feedback before accepting the revision.');
      }
      row.status=action==='Request changes'?'Changes requested':'Reviewed';
      row.feedback=feedback;
      row.updated_at=now();
      await db.put('owner_submissions',{id:row.id},row);
      await audit(db,staff,row.id,'owner.submission.reviewed',action);
    }
    send(res,200,{ok:true});
    return true;
  };
}
