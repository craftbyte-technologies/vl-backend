import {randomUUID} from 'node:crypto';
import {now, transaction} from './database.mjs';
import {searchListings} from './search.mjs';

export async function queueUpdate(db, kind, fields) {
  await db.insert('update_events',{id:randomUUID(),kind,...fields,created_at:now(),processed_at:null});
}

const aboutListing = new Set(['price','availability','matches']);
const followsListing = new Set(['price','availability']);
const copy = {
  price:'The asking price has changed.',
  availability:'The availability has changed.',
  matches:'A property matches your saved search.',
  messages:'The team sent a message.',
  visits:'Your visit details changed.'
};

async function recipients(db,event) {
  if(event.kind==='matches'){
    const matches=new Set();
    for(const search of await db.find('customer_searches',{})){
      if(matches.has(search.account_id))continue;
      const account=await db.get('external_accounts',{id:search.account_id,kind:'customer'});
      if(!account?.preferences?.matches)continue;
      const result=await searchListings(db,new URLSearchParams(search.query),[event.listing_id]);
      if(result.total)matches.add(account.id);
    }
    return [...matches];
  }
  if(followsListing.has(event.kind)){
    const matches=[];
    for(const bookmark of await db.find('customer_bookmarks',{listing_id:event.listing_id,$or:[{saved:true},{followed:true}]})){
      const account=await db.get('external_accounts',{id:bookmark.account_id,kind:'customer'});
      if(account&&account.preferences?.[event.kind]!==false)matches.push(account.id);
    }
    return matches;
  }
  const row=await db.get('enquiries',{id:event.enquiry_id});
  const account=row&&await db.get('external_accounts',{kind:'customer',email:row.email});
  return account&&account.preferences?.[event.kind]!==false?[account.id]:[];
}

export async function processUpdates(db) {
  const events=await db.raw.collection('update_events').find({processed_at:null}).sort({created_at:1}).limit(20).toArray();
  for(const event of events)await transaction(db,async()=>{
    if(!await db.get('update_events',{id:event.id,processed_at:null}))return;
    const listingVisible=!aboutListing.has(event.kind)||await db.get('listings',{id:event.listing_id,publication:'Published'});
    if(listingVisible){
      for(const accountId of await recipients(db,event)){
        const key=event.kind==='matches'?'match-'+event.listing_id:event.id;
        const filter={account_id:accountId,event_key:key};
        if(!await db.get('customer_updates',filter))await db.insert('customer_updates',{
          ...filter,id:randomUUID(),kind:event.kind,listing_id:event.listing_id,
          enquiry_id:event.enquiry_id,at:now(),read:false
        });
      }
    }
    await db.put('update_events',{id:event.id},{processed_at:now()});
  });
}

export function startUpdates(db) {
  let pending;
  const tick=()=>{
    if(!pending)pending=processUpdates(db).catch(()=>console.error('In-app updates could not be processed.')).finally(()=>{pending=undefined;});
  };
  const timer=setInterval(tick,5000);
  timer.unref();
  return async()=>{clearInterval(timer);await pending;};
}

export async function customerUpdates(db,account) {
  const rows=await db.raw.collection('customer_updates').find({account_id:account.id}).sort({at:-1}).limit(100).toArray();
  const result=[];
  for(const row of rows){
    const listing=row.listing_id&&await db.get('listings',{id:row.listing_id,publication:'Published'});
    if(row.listing_id&&!listing)continue;
    const enquiry=row.enquiry_id&&await db.get('enquiries',{id:row.enquiry_id,email:account.email});
    if(row.enquiry_id&&!enquiry)continue;
    result.push({id:row.id,title:listing?.title||enquiry?.title,text:copy[row.kind],at:row.at,read:row.read,
      href:listing?'/property/'+listing.id:'#/account/enquiry/'+enquiry.id});
  }
  return result;
}
