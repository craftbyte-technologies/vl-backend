import {randomUUID} from 'node:crypto';

// Ordered, restartable migrations run under the startup migration lease.
export async function migrateDiscovery(db){
  const id='002_discovery';if(!await db.raw.collection('schema_migrations').findOne({_id:id})){
  const cursor=db.raw.collection('properties').find({},{projection:{_id:1,details_json:1}});
  for await(const p of cursor){let details={};try{details=JSON.parse(p.details_json);}catch{}
    await db.raw.collection('properties').updateOne({_id:p._id},{$set:{search_beds:Number(details.beds)||0}});
    await db.raw.collection('workspace').updateOne({_id:'migration'},{$set:{expires:new Date(Date.now()+60000)}});
  }
  await db.raw.collection('listings').createIndex({publication:1,transaction_type:1,created_at:-1,id:1});
  await db.raw.collection('listings').createIndex({project_id:1,publication:1});
  await db.raw.collection('listing_media').createIndex({media_id:1,visibility:1});
  await db.raw.collection('schema_migrations').insertOne({_id:id,applied_at:new Date().toISOString()});}
  if(!await db.raw.collection('schema_migrations').findOne({_id:'003_public_spatial'})){
    for await(const loc of db.raw.collection('locations').find({})){const lat=loc.public_mode==='exact'?loc.exact_lat:loc.public_lat,lng=loc.public_mode==='exact'?loc.exact_lng:loc.public_lng;await db.raw.collection('locations').updateOne({_id:loc._id},{$set:{public_point:typeof lat==='number'&&typeof lng==='number'?{type:'Point',coordinates:[lng,lat]}:null}});await db.raw.collection('workspace').updateOne({_id:'migration'},{$set:{expires:new Date(Date.now()+60000)}});}
    await db.raw.collection('locations').createIndex({public_point:'2dsphere'});await db.raw.collection('listings').createIndex({property_id:1,publication:1});
    await db.raw.collection('schema_migrations').insertOne({_id:'003_public_spatial',applied_at:new Date().toISOString()});
  }
}

export async function migrateCustomerAccounts(db) {
  const id = '004_customer_accounts';
  if (await db.raw.collection('schema_migrations').findOne({_id: id})) return;
  const indexes = {
    external_accounts: [[{email: 1}, {unique: true}], [{id: 1}, {unique: true}]],
    customer_sessions: [[{token_hash: 1}, {unique: true}], [{account_id: 1}], [{expires: 1}, {expireAfterSeconds: 0}]],
    customer_links: [[{purpose: 1, email: 1}, {unique: true}], [{token_hash: 1}, {unique: true}], [{expires: 1}, {expireAfterSeconds: 0}]],
    customer_bookmarks: [[{account_id: 1, listing_id: 1}, {unique: true}]],
    customer_searches: [[{account_id: 1, query: 1}, {unique: true}], [{account_id: 1, id: 1}, {unique: true}]],
  };
  for (const [name, definitions] of Object.entries(indexes)) {
    for (const [keys, options] of definitions) await db.raw.collection(name).createIndex(keys, options);
  }
  await db.raw.collection('schema_migrations').insertOne({_id: id, applied_at: new Date().toISOString()});
}

export async function migrateLocationPrivacy(db) {
  const id = '005_private_exact_locations';
  const migrations = db.raw.collection('schema_migrations');
  if (await migrations.findOne({_id:id})) return;
  for await (const location of db.raw.collection('locations').find({public_mode:'exact'})) {
    await db.put('locations',{property_id:location.property_id},{public_mode:'approximate'});
    await db.raw.collection('workspace').updateOne({_id:'migration'},{$set:{expires:new Date(Date.now()+60_000)}});
  }
  await migrations.insertOne({_id:id,applied_at:new Date().toISOString()});
}

export async function migrateLeadHistory(db) {
  const id='006_lead_history';
  const migrations=db.raw.collection('schema_migrations');
  if(await migrations.findOne({_id:id}))return;
  for await(const row of db.raw.collection('enquiries').find({stage:{$exists:false}})){
    const reply=await db.raw.collection('enquiry_messages')
      .findOne({enquiry_id:row.id,source:'Team',held:false},{sort:{at:1}});
    const confirmed=row.visit?.status==='Confirmed'?row.visit.at:null;
    await db.put('enquiries',{id:row.id},{
      stage:reply?'In progress':'New',source:'Direct enquiry',
      ...(reply?{first_reply_at:reply.at}:{}),
      ...(confirmed?{visit_confirmed_at:confirmed}:{}),
    });
    await db.raw.collection('workspace').updateOne({_id:'migration'},{$set:{expires:new Date(Date.now()+60_000)}});
  }
  for await(const bookmark of db.raw.collection('customer_bookmarks').find({saved:true})){
    const filter={account_id:bookmark.account_id,listing_id:bookmark.listing_id};
    const listing=await db.get('listings',{id:bookmark.listing_id});
    const account=await db.get('external_accounts',{id:bookmark.account_id,kind:'customer'});
    if(listing&&account){
      const location=await db.get('locations',{property_id:listing.property_id});
      const lead=await db.get('enquiries',{target_kind:'Listing',target_id:listing.id,email:account.email});
      await db.raw.collection('saved_interests').updateOne(filter,{$setOnInsert:{id:randomUUID(),...filter,
        title:listing.title,locality:location?.neighbourhood||'',project_id:listing.project_id||null,
        active:true,saved_at:null,grant:null,...(lead?{enquiry_id:lead.id}:{})}},{upsert:true});
    }
    await db.raw.collection('workspace').updateOne({_id:'migration'},{$set:{expires:new Date(Date.now()+60_000)}});
  }
  await migrations.insertOne({_id:id,applied_at:new Date().toISOString()});
}
