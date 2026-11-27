import { migrateDiscovery, migrateCustomerAccounts, migrateLocationPrivacy, migrateLeadHistory } from './migrations.mjs';
import { MongoClient, Long } from 'mongodb';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
export const types=['Apartment','Villa','Plot','Office'];
export const now=()=>new Date().toISOString();
export const today=()=>now().slice(0,10);
export class HttpError extends Error {
  constructor(status, message, issues) {
    super(message);
    this.status = status;
    this.issues = issues;
  }
}
export function requireValue(value,message,status=400){if(!value)throw new HttpError(status,message);}
export const text=(value,max=500)=>typeof value==='string'?value.trim().slice(0,max):'';
function publicLocation(source) {
  let {public_lat,public_lng,exact_lat,exact_lng}=source;
  if (typeof exact_lat==='number'&&typeof exact_lng==='number'&&
      Math.hypot(exact_lat-public_lat,exact_lng-public_lng)<0.002) {
    public_lat=null;
    public_lng=null;
  }
  const point=typeof public_lat==='number'&&typeof public_lng==='number'
    ? {type:'Point',coordinates:[public_lng,public_lat]} : null;
  return {public_mode:'approximate',public_lat:public_lat??null,public_lng:public_lng??null,public_point:point};
}
const context=new AsyncLocalStorage();
const names=['staff_users','sessions','projects','configurations','properties','locations','listings','prices','amenities','property_amenities','media','listing_media','audit_events','schema_migrations','workspace','external_accounts','customer_sessions','customer_links','customer_bookmarks','saved_interests','customer_searches','owner_submissions','enquiries','enquiry_messages','enquiry_restricted_messages','guest_enquiry_requests','guest_enquiry_sessions','update_events','customer_updates','staff_recovery'];
export async function openDatabase(directory,options={}) {
  const uri=options.uri||process.env.MONGODB_URI||(process.env.MONGODB_URI_FILE?readFileSync(process.env.MONGODB_URI_FILE,'utf8').trim():null);
  requireValue(uri,'MONGODB_URI or MONGODB_URI_FILE is required.',503);
  const client=new MongoClient(uri,{serverSelectionTimeoutMS:5000,maxPoolSize:10,promoteLongs:true});
  try {await client.connect();const raw=client.db(options.database||process.env.MONGODB_DATABASE||'forma');const hello=await raw.admin().command({hello:1});requireValue(hello.setName,'MongoDB must run as a replica set.',503);
  const opts=()=>context.getStore()?.session?{session:context.getStore().session}:{};
  const normalize=d=>{if(!d)return d;const {_id,...rest}=d;return rest;};
  const store={client,raw,
    async get(name,filter){return normalize(await raw.collection(name).findOne(filter,opts()));},
    async find(name,filter={},sort={}){return (await raw.collection(name).find(filter,opts()).sort(sort).toArray()).map(normalize);},
    async count(name,filter={}){return raw.collection(name).countDocuments(filter,opts());},
    async insert(name,doc){const value={...doc};if(name==='locations')Object.assign(value,publicLocation(value));if(name==='properties')value.search_beds=Number(JSON.parse(value.details_json||'{}').beds)||0;for(const key of ['amount_minor','starting_minor'])if(value[key]!=null){requireValue(Number.isSafeInteger(Number(value[key])),'Currency exceeds supported integer range.');value[key]=Long.fromNumber(Number(value[key]));}await raw.collection(name).insertOne({_id:value.id||value.token_hash||randomUUID(),...value},opts());return doc;},
    async put(name,filter,doc){const value={...doc};if(name==='locations')Object.assign(value,publicLocation({...await this.get(name,filter),...value}));for(const key of ['amount_minor','starting_minor'])if(value[key]!=null)value[key]=Long.fromNumber(value[key]);return raw.collection(name).updateOne(filter,{$set:value},{...opts(),upsert:true});},
    async remove(name,filter){return raw.collection(name).deleteMany(filter,opts());},
    async close(){await client.close();},async ping(){await raw.command({ping:1});},
    async guard(){await raw.collection('workspace').updateOne({_id:'integrity'},{$inc:{revision:1}},opts());}
  };
  // Exclusive initialization; a crashed migration releases its lease after one minute.
  await raw.collection('workspace').updateOne({_id:'integrity'},{$setOnInsert:{revision:0}},{upsert:true});
  const owner=randomUUID();let locked=false;
  for(let i=0;i<60;i++){try{const r=await raw.collection('workspace').findOneAndUpdate({_id:'migration', $or:[{expires:{$lt:new Date()}},{owner}]},{$set:{owner,expires:new Date(Date.now()+60000)}},{upsert:true,returnDocument:'after'});locked=r?.owner===owner;}catch(e){if(e.code!==11000)throw e;}if(locked)break;await new Promise(r=>setTimeout(r,250));}
  requireValue(locked,'Another process is applying migrations. Retry startup.',503);
  try {
    for(const name of names)if(!(await raw.listCollections({name}).hasNext()))await raw.createCollection(name,{validator:{$jsonSchema:{bsonType:'object'}}});
    for(const [name,key] of [['staff_users','email'],['amenities','name'],['media','stored_name'],['sessions','token_hash']])await raw.collection(name).createIndex({[key]:1},{unique:true});
    for(const name of ['staff_users','projects','configurations','properties','listings','prices','amenities','media','audit_events'])await raw.collection(name).createIndex({id:1},{unique:true});
    await raw.collection('locations').createIndex({property_id:1},{unique:true});
    await raw.collection('listing_media').createIndex({listing_id:1,position:1},{unique:true});
    await raw.collection('property_amenities').createIndex({property_id:1,amenity_id:1},{unique:true});
    await raw.collection('prices').createIndex({listing_id:1,sequence:1},{unique:true});
    await raw.collection('listings').createIndex({publication:1});
    await raw.collection('sessions').createIndex({expires:1},{expireAfterSeconds:0});
    for(const name of ['prices','projects','configurations'])await raw.command({collMod:name,validator:{$jsonSchema:{bsonType:'object',properties:{[name==='prices'?'amount_minor':'starting_minor']:{bsonType:['long','null']}}}}});
    if(!await store.count('amenities')){const catalog={Apartment:['Covered parking','Lift','Power backup','Balcony','Gym','Pool','Step-free access'],Villa:['Covered parking','Garden','Power backup','Balcony','Pool','Step-free access'],Plot:['Road access','Water connection','Electricity connection','Gated community'],Office:['Covered parking','Lift','Power backup','Step-free access','Meeting room']};for(const name of new Set(Object.values(catalog).flat()))await store.insert('amenities',{id:randomUUID(),name,types_json:JSON.stringify(types.filter(t=>catalog[t].includes(name))),active:1});}
    await raw.collection('schema_migrations').updateOne({_id:'001_mongo_inventory'},{$setOnInsert:{applied_at:now()}},{upsert:true});
    await migrateDiscovery(store);
    await migrateCustomerAccounts(store);
    await migrateLocationPrivacy(store);
    await raw.collection('owner_submissions').createIndex({id:1},{unique:true});
    await raw.collection('owner_submissions').createIndex({owner_id:1,updated_at:-1});
    await raw.collection('listings').createIndex({owner_id:1});
    await raw.collection('saved_interests').createIndex({id:1},{unique:true});
    await raw.collection('saved_interests').createIndex({account_id:1,listing_id:1},{unique:true});
    await raw.collection('saved_interests').createIndex({'grant.staff_id':1,active:1});
    await raw.collection('enquiries').createIndex({id:1},{unique:true});
    await raw.collection('enquiries').createIndex({target_kind:1,target_id:1,email:1},{unique:true});
    await raw.collection('enquiries').createIndex({assigned_id:1,updated_at:-1});
    await raw.collection('enquiry_messages').createIndex({enquiry_id:1,at:-1});
    await raw.collection('enquiry_restricted_messages').createIndex({enquiry_id:1,message_id:1},{unique:true});
    await migrateLeadHistory(store);
    await raw.collection('guest_enquiry_requests').createIndex({target_kind:1,target_id:1,email:1},{unique:true});
    await raw.collection('staff_recovery').createIndex({staff_id:1},{unique:true});
    await raw.collection('update_events').createIndex({id:1},{unique:true});
    await raw.collection('update_events').createIndex({processed_at:1,created_at:1});
    await raw.collection('customer_updates').createIndex({account_id:1,event_key:1},{unique:true});
    await raw.collection('customer_updates').createIndex({account_id:1,at:-1});
    for (const name of ['guest_enquiry_requests','guest_enquiry_sessions','staff_recovery']) {
      await raw.collection(name).createIndex({token_hash:1},{unique:true});
      await raw.collection(name).createIndex({expires:1},{expireAfterSeconds:0});
    }
  }finally{await raw.collection('workspace').deleteOne({_id:'migration',owner});}
  return store;
  }catch(e){await client.close();throw e;}
}
export async function transaction(db,fn){if(context.getStore()?.session)return fn();return db.client.withSession(session=>session.withTransaction(()=>context.run({session},async()=>{await db.guard();return fn();}),{readConcern:{level:'snapshot'},writeConcern:{w:'majority'},maxCommitTimeMS:10000}));}
export async function audit(db,actor,entity,action,detail=''){await db.insert('audit_events',{id:randomUUID(),actor_id:actor?.id||null,entity_id:entity,action,detail,created_at:now()});}
