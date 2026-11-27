const serialMap=async(values,fn)=>{const result=[];for(const value of values)result.push(await fn(value));return result;};
import {randomUUID} from 'node:crypto';
import {audit,requireValue,text,today,now,transaction,types,HttpError} from './database.mjs';
import {distributionAllowed} from './pdf-scans.mjs';
import {queueUpdate} from './updates.mjs';
import {catalogue, propertyAmenities, sharedAmenities, validateAmenities, validateProjectAccess} from './amenities.mjs';
export async function projects(db){return serialMap(await db.find('projects',{}, {name:1}),async p=>({id:p.id,name:p.name,location:p.location,description:p.description,startingPrice:p.starting_minor===null?null:p.starting_minor/100,currency:p.currency,amenities:p.amenities||[],revision:p.revision||0,configurations:(await db.find('configurations',{project_id:p.id})).map(c=>({id:c.id,label:c.label,area:c.area_label,from:c.starting_minor===null?null:c.starting_minor/100}))}));}
export async function listing(db,id,staff=false,member=false){
 const l=await db.get('listings',{id});if(!l||(!staff&&l.publication!=='Published'))throw new HttpError(404,'Listing not found.');
 const p=await db.get('properties',{id:l.property_id}),loc=await db.get('locations',{property_id:p.id});
 const price=await db.get('prices',{id:l.current_price_id});
 const files=[];for(const assignment of await db.find('listing_media',{listing_id:id},{position:1})){const m=await db.get('media',{id:assignment.media_id});if(m&&(staff||(distributionAllowed(m)&&(assignment.visibility==='public'||(member&&assignment.visibility==='member')))))files.push({...m,...assignment,id:m.id});}
 const media=files.map(m=>({id:m.id,url:`/api/${!staff&&m.visibility==='member'?'customer/':''}files/${m.id}`,name:staff?m.original_name:undefined,kind:m.kind,mime:m.mime,caption:m.caption,visibility:m.visibility,classification:m.classification,...(staff?{scan:m.kind==='document'?m.scan_status||'Checking':undefined,review:m.review_status}:{} )}));
 const images=media.filter(m=>m.kind==='image'&&(m.visibility==='public'||(member&&m.visibility==='member'))).map(m=>m.url);
 const assigned=await propertyAmenities(db,p.id,await catalogue(db));
 const project=l.project_id ? await db.get('projects',{id:l.project_id}) : null;
 const inherited=sharedAmenities(project,l.project_amenity_access);
 const history=(await db.find('prices',{listing_id:id},{sequence:1})).map(h=>({id:h.id,date:h.effective_date,price:h.amount_minor/100,kind:h.kind==='initial'?'Initial asking price':h.kind==='correction'?'Price correction':'Asking price change',reason:h.reason||undefined,supersedesId:h.supersedes_id||undefined}));
  const publicPosition={latitude:loc.public_lat,longitude:loc.public_lng};
  const result={id,title:l.title,type:p.type,transaction:l.transaction_type,currency:l.currency,priceBasis:l.price_basis,price:price?price.amount_minor/100:0,area:p.area??0,areaBasis:p.area_basis,description:p.description,...JSON.parse(p.details_json),neighbourhood:loc.neighbourhood,address:loc.neighbourhood,point:{x:loc.schematic_x,y:loc.schematic_y},location:{mode:'approximate',...publicPosition},images,media,mediaCaptions:Object.fromEntries(media.map(m=>[m.url,m.caption])),amenities:staff ? assigned : assigned.filter(a=>a.state!=='Unknown'),sharedAmenities:inherited,publication:l.publication,availability:l.availability,reviewed:l.reviewed,history,projectId:l.project_id||undefined,youtubeId:l.youtube_id||undefined,revision:l.revision};
  if(staff||member) result.memberDetails=p.member_details||'';
  else result.hasMemberDetails=Boolean(p.member_details)||Boolean(await db.get('listing_media',{listing_id:id,visibility:'member'}));
  if(staff&&l.owner_submission_id) {
    const submission=await db.get('owner_submissions',{id:l.owner_submission_id});
    if(submission) result.ownerProposal={...submission.revisions.at(-1),version:submission.revisions.length};
  }
  if(staff)Object.assign(result,{propertyId:p.id,ownerHold:l.owner_hold||undefined,projectAmenityAccess:l.project_amenity_access||{},responsibleId:l.responsible_id,configurationId:l.configuration_id,privateLocation:{address:loc.internal_address,latitude:loc.exact_lat,longitude:loc.exact_lng},audit:(await db.find('audit_events',{entity_id:id},{created_at:-1})).slice(0,30).map(({action,detail,created_at})=>({action,detail,created_at}))});
  return result;
}

export async function listings(db,staff=false){return serialMap(await db.find('listings',staff?{}:{publication:'Published'},{created_at:-1,id:1}),l=>listing(db,l.id,staff));}
export function youtubeId(value){
  if(!value)return null;
  try{const u=new URL(value);requireValue(u.protocol==='https:'&&!u.username&&!u.password,'Use an HTTPS YouTube URL.');const host=u.hostname.toLowerCase();const id=host==='youtu.be'?u.pathname.slice(1):['www.youtube.com','youtube.com','m.youtube.com'].includes(host)?(u.pathname==='/watch'?u.searchParams.get('v'):u.pathname.startsWith('/embed/')?u.pathname.split('/')[2]:null):null;requireValue(/^[A-Za-z0-9_-]{11}$/.test(id||''),'Enter a valid YouTube watch, embed, or short link.');return id;}catch(e){if(e instanceof HttpError)throw e;throw new HttpError(400,'Enter a valid HTTPS YouTube URL.');}
}

export async function saveListing(db,actor,id,input){return transaction(db,async()=>{
 requireValue(['administrator','editor','reviewer'].includes(actor.role),'Staff editing permission required.',403);
 const existing=id?await db.get('listings',{id}):null;
 if(id)requireValue(existing,'Listing not found.',404);
 if(existing)requireValue(input.revision===existing.revision,'This listing changed in another session. Reload before saving.',409);
  const publication=input.publication||'Draft';
  requireValue(['Draft','Ready for review','Published','Archived'].includes(publication),'Invalid publication state.');
  if(publication==='Published'&&existing?.owner_id){
    requireValue(!existing.owner_hold&&await db.get('external_accounts',{id:existing.owner_id,kind:'owner',owner_status:'Approved'}),'Review the owner hold before publishing this listing.',409);
  }
  if(['Published','Archived'].includes(publication))requireValue(['administrator','reviewer'].includes(actor.role),'Publishing permission required.',403);
  requireValue(types.includes(input.type),'Choose a supported property type.');
  requireValue(['Buy','Rent'].includes(input.transaction),'Choose sale or rent.');
  const availability=input.availability||'Available';
  requireValue(['Available','Reserved','Withdrawn',input.transaction==='Buy'?'Sold':'Rented'].includes(availability),'Availability does not match this transaction.');
  const price=Number(input.price||0),area=Number(input.area||0);
  const priceLabel = input.transaction === 'Rent' ? 'monthly rent' : 'asking price';
  const issues = [];
  const check = (valid, field, message) => {
    if (!valid) issues.push({field, message});
  };
  const requireValidFields = () => {
    if (issues.length) throw new HttpError(400, issues[0].message, issues);
  };
  check(Number.isFinite(price) && price >= 0 && price <= 1e12, 'price', `Enter a valid ${priceLabel} in rupees, up to ₹10,00,00,00,00,000.`);
  check(Number.isFinite(area) && area >= 0 && area <= 1e9, 'area', 'Enter a valid area in square feet, up to 1,000,000,000.');
  requireValidFields();
  const minor=Math.round(price*100),basis=input.transaction==='Buy'?'total':'monthly';
  if(existing&&existing.current_price_id)requireValue(existing.transaction_type===input.transaction&&existing.currency===(input.currency||'INR')&&existing.price_basis===basis,'Create a separate offer to change transaction, currency or pricing basis.');
  requireValue((input.currency||'INR')==='INR','This local increment supports INR offers.');
  if(input.effectiveDate)requireValue(input.effectiveDate===today(),'Backdated or future price changes are not supported.');
  const title=text(input.title,100),description=text(input.description,4000),neighbourhood=text(input.neighbourhood,100);
  const details={};
  if(['Apartment','Villa'].includes(input.type)){for(const key of ['beds','baths']){const n=Number(input[key]||0);requireValue(Number.isInteger(n)&&n>=0&&n<=30,`Invalid ${key}.`);if(n)details[key]=n;}}
  if(input.type!=='Plot'&&input.floor)details.floor=text(input.floor,60);
  if(input.type==='Plot')details.dimensions=text(input.dimensions,80);
  if(input.type==='Office'&&input.frontage){requireValue(Number.isFinite(Number(input.frontage))&&Number(input.frontage)>0,'Invalid frontage.');details.frontage=Number(input.frontage);}
  const areaOptions={Apartment:['Super built-up area','Built-up area','Carpet area'],Villa:['Built-up area','Carpet area'],Plot:['Plot area'],Office:['Carpet area','Built-up area']};
  check(areaOptions[input.type].includes(input.areaBasis), 'areaBasis', 'Choose an area basis for this property type.');
  requireValidFields();
  const media=Array.isArray(input.media)?input.media:[];
  requireValue(media.length<=30&&new Set(media.map(m=>m.id)).size===media.length,'Use up to 30 distinct media files.');
  const verifiedMedia=await serialMap(media,async m=>{const stored=await db.get('media',{id:m.id});requireValue(stored,'An attached file is missing.');requireValue(['public','member','internal'].includes(m.visibility)&&!(m.visibility==='member'&&stored.kind==='document'),'Choose file access. Member files can be photos or floor plans.');requireValue(['actual','rendering','illustrative'].includes(m.classification||'actual'),'Choose photograph classification.');return {...m,kind:stored.kind,distributionAllowed:distributionAllowed(stored)};});
  const loc=input.privateLocation||{},mode=input.location?.mode||'approximate';
  requireValue(mode==='approximate','Choose an approximate public location. Save the exact pin under Staff only.');
  const coordinate=(value,min,max)=>{if(value===null||value===undefined||value==='')return null;const n=Number(value);requireValue(Number.isFinite(n)&&n>=min&&n<=max,'Invalid coordinates.');return n;};
  const exactLat=coordinate(loc.latitude,-90,90),exactLng=coordinate(loc.longitude,-180,180),publicLat=coordinate(input.location?.latitude,-90,90),publicLng=coordinate(input.location?.longitude,-180,180);
  requireValue((exactLat===null)===(exactLng===null)&&(publicLat===null)===(publicLng===null),'Provide both latitude and longitude.');
  if(mode==='approximate'&&exactLat!==null&&publicLat!==null)requireValue(Math.hypot(exactLat-publicLat,exactLng-publicLng)>=.002,'Choose a separate approximate public location, away from the private pin.');
  if(['Published','Ready for review'].includes(publication)){
    check(title.length >= 5, 'title', 'Use at least 5 characters for the listing title.');
    check(neighbourhood, 'neighbourhood', 'Enter the neighbourhood.');
    check(minor > 0, 'price', `Enter a ${priceLabel} of at least ₹0.01.`);
    check(description.length >= 30, 'description', 'Use at least 30 characters for the description.');
    check(area > 0, 'area', 'Enter an area greater than 0 sq ft.');
    if (['Apartment','Villa'].includes(input.type)) {
      check(details.beds, 'beds', 'Enter the number of bedrooms.');
      check(details.baths, 'baths', 'Enter the number of bathrooms.');
    }
    if (input.type === 'Plot') check(details.dimensions, 'dimensions', 'Enter the plot dimensions.');
    if (input.type === 'Office') check(details.frontage, 'frontage', 'Enter the office frontage in feet.');
    check(verifiedMedia.some(m => m.kind === 'image' && m.visibility === 'public' && m.distributionAllowed), 'media', 'Review at least one public property photo before publishing.');
    requireValidFields();
  }
  const catalog=await catalogue(db);
  const existingAmenities=existing ? await propertyAmenities(db,existing.property_id,catalog) : [];
  const assigned=validateAmenities(input.amenities??[],catalog,{type:input.type,existing:existingAmenities});
  const project=input.projectId ? await db.get('projects',{id:input.projectId}) : null;
  if(input.projectId) requireValue(project,'Project not found.');
  const previousAccess=existing?.project_id===input.projectId ? existing?.project_amenity_access : null;
  const projectAmenityAccess=validateProjectAccess(input.projectAmenityAccess??previousAccess??{},project,previousAccess,input.type);
  if(input.configurationId)requireValue(await db.get('configurations',{id:input.configurationId,project_id:input.projectId||null}),'Configuration does not belong to this project.');
  const video=youtubeId(input.youtubeUrl || (input.youtubeId?`https://youtu.be/${input.youtubeId}`:''));
  const responsible=input.responsibleId||actor.id;
  requireValue(await db.get('staff_users',{id:responsible,active:1}),'Choose an active responsible staff member.');
  const listingId=id||randomUUID(),propertyId=existing?.property_id||randomUUID();

 await db.put('properties',{id:propertyId},{id:propertyId,type:input.type,search_beds:details.beds||0,area:area||null,area_basis:input.areaBasis,description,member_details:text(input.memberDetails,4000),details_json:JSON.stringify(details)});
 await db.put('locations',{property_id:propertyId},{property_id:propertyId,neighbourhood,internal_address:text(loc.address,500),exact_lat:exactLat,exact_lng:exactLng,public_mode:mode,public_lat:publicLat,public_lng:publicLng,schematic_x:Math.max(10,Math.min(90,Math.round(Number(input.point?.x)||50))),schematic_y:Math.max(10,Math.min(90,Math.round(Number(input.point?.y)||50)))});
 let priceId=existing?.current_price_id||null;const current=priceId?await db.get('prices',{id:priceId}):null;
 if(current)requireValue(minor>0,'An existing asking price cannot be cleared; preserve its history.');
 const correction=text(input.correctionReason,500);
 if(correction){requireValue(actor.role==='administrator'&&current,'Only an administrator can correct an existing price.',403);requireValue(correction.length>=10,'Explain the price correction in at least 10 characters.');}
 if(minor>0&&(!current||current.amount_minor!==minor||correction)){const nextId=randomUUID();await db.insert('prices',{id:nextId,listing_id:listingId,amount_minor:minor,effective_date:today(),kind:correction?'correction':current?'change':'initial',reason:correction||null,supersedes_id:correction?priceId:null,created_at:now(),sequence:(current?.sequence||0)+1});priceId=nextId;}
 await db.put('listings',{id:listingId},{id:listingId,property_id:propertyId,title,project_id:input.projectId||null,configuration_id:input.configurationId||null,project_amenity_access:projectAmenityAccess,transaction_type:input.transaction,currency:'INR',price_basis:basis,publication,availability,responsible_id:responsible,current_price_id:priceId,youtube_id:video,reviewed:today(),revision:existing?existing.revision+1:1,created_at:existing?.created_at||now()});
 await db.remove('property_amenities',{property_id:propertyId});for(const a of assigned)await db.insert('property_amenities',{property_id:propertyId,amenity_id:a.id,state:a.state,detail:a.detail,values:a.values||{}});
 await db.remove('listing_media',{listing_id:listingId});for(const [i,m] of verifiedMedia.entries())await db.insert('listing_media',{listing_id:listingId,media_id:m.id,position:i,caption:text(m.caption,300),visibility:m.visibility,classification:m.classification||'actual'});
 await audit(db,actor,listingId,existing?'listing.updated':'listing.created',`${publication}; ${availability}${correction?'; price correction':''}`);
 if(publication==='Published'){
   if(existing?.publication!=='Published'||(current?.amount_minor!==minor&&!correction)||existing.availability!==availability)
     await queueUpdate(db,'matches',{listing_id:listingId});
   if(existing?.publication==='Published'&&current&&current.amount_minor!==minor&&!correction)
     await queueUpdate(db,'price',{listing_id:listingId});
   if(existing?.publication==='Published'&&existing.availability!==availability)
     await queueUpdate(db,'availability',{listing_id:listingId});
 }
 return listing(db,listingId,true);
 });}
