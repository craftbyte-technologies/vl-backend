import { requireValue, types } from './database.mjs';
import {amenityMatch, catalogue} from './amenities.mjs';

// v1 is also the URL/saved-search contract. No client input becomes a Mongo operator.
export function criteria(params) {
  const allowed=['v','q','type','transaction','sort','maxPrice','beds','amenity','page','limit','bounds','project','exclude'];
  for(const key of params.keys())requireValue(allowed.includes(key),`Unsupported search field: ${key}`);
  for(const key of allowed.filter(k=>k!=='amenity'))requireValue(params.getAll(key).length<=1,`Repeated search field: ${key}`);
  const c=Object.fromEntries(params);c.v=c.v||'1';c.transaction=c.transaction||'All';c.sort=c.sort||'recommended';
  requireValue(c.v==='1'&&['Buy','Rent','All'].includes(c.transaction)&&['recommended','low','high','recent'].includes(c.sort),'Invalid search version, transaction or sort.');
  requireValue(!c.type||c.type==='All'||types.includes(c.type),'Invalid property type.');
  c.q=(c.q||'').trim();requireValue(c.q.length<=100,'Search is too long.');
  for(const [key,min,max,defaultValue] of [['page',1,1000,1],['limit',1,48,12],['maxPrice',0,1e12,null],['beds',1,30,null]]){
    c[key]=c[key]===undefined?defaultValue:Number(c[key]);requireValue(c[key]===null||Number.isFinite(c[key])&&c[key]>=min&&c[key]<=max&&(key==='maxPrice'||Number.isInteger(c[key])),`Invalid ${key}.`);
  }
  c.amenities=[...new Set(params.getAll('amenity'))];requireValue(c.amenities.length<=30&&c.amenities.every(a=>/^[a-zA-Z0-9-]{1,80}$/.test(a)),'Use valid amenity IDs.');
  if(c.exclude)requireValue(/^[a-zA-Z0-9-]{1,80}$/.test(c.exclude),'Invalid excluded listing.');
  if(c.project)requireValue(/^[a-zA-Z0-9-]{1,80}$/.test(c.project),'Invalid project.');
  if(c.bounds){c.bounds=c.bounds.split(',').map(Number);const [w,s,e,n]=c.bounds;requireValue(c.bounds.length===4&&c.bounds.every(Number.isFinite)&&w>=-180&&e<=180&&s>=-90&&n<=90&&w<e&&e-w<=180&&s<n,'Invalid map bounds.');}
  return c;
}

export async function searchListings(db,params,listingIds){
  const c=criteria(params),match={publication:'Published'};
  if(c.transaction!=='All')match.transaction_type=c.transaction;
  if(c.project)match.project_id=c.project;if(c.exclude)match.id={$ne:c.exclude};
  if(listingIds)match.id={$in:listingIds};
  const join=(from,localField,foreignField,as)=>({$lookup:{from,localField,foreignField,as}});
  const pipeline=[{$match:match},join('properties','property_id','id','property'),{$unwind:'$property'},join('locations','property_id','property_id','location'),{$unwind:'$location'},join('prices','current_price_id','id','priceRecord'),{$unwind:'$priceRecord'},
    {$set:{publicLat:'$location.public_lat',publicLng:'$location.public_lng'}}];
  if(c.bounds){const [w,s,e,n]=c.bounds;pipeline.splice(0,7,{$match:{public_point:{$geoWithin:{$geometry:{type:'Polygon',coordinates:[[[w,s],[e,s],[e,n],[w,n],[w,s]]]}}}}},join('listings','property_id','property_id','offer'),{$unwind:'$offer'},{$replaceRoot:{newRoot:{$mergeObjects:['$offer',{location:'$$ROOT'}]}}},{$match:match},join('properties','property_id','id','property'),{$unwind:'$property'},join('prices','current_price_id','id','priceRecord'),{$unwind:'$priceRecord'});}
  const filters={};if(c.type&&c.type!=='All')filters['property.type']=c.type;
  if(c.maxPrice!==null)filters['priceRecord.amount_minor']={$lte:c.maxPrice*100};
  if(c.q){const safe=c.q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');filters.$or=[{title:{$regex:safe,$options:'i'}},{'location.neighbourhood':{$regex:safe,$options:'i'}}];}
  if(c.bounds){const [w,s,e,n]=c.bounds;filters.publicLat={$type:'number',$gte:s,$lte:n};filters.publicLng={$type:'number',$gte:w,$lte:e};}
  pipeline.push({$match:filters});
  if(c.beds!==null)pipeline.push({$match:{'property.search_beds':{$gte:c.beds}}});
  if(c.amenities.length){
    const catalog=await catalogue(db);
    pipeline.push(join('property_amenities','property_id','property_id','facilities'),
      join('projects','project_id','id','development'),
      {$match:{$and:c.amenities.map(id=>amenityMatch(catalog,id))}});
  }
  const sort=c.sort==='low'?{'priceRecord.amount_minor':1,id:1}:c.sort==='high'?{'priceRecord.amount_minor':-1,id:1}:c.sort==='recent'?{reviewed:-1,id:1}:{created_at:-1,id:1};
  pipeline.push({$facet:{total:[{$count:'count'}],items:[{$sort:sort},{$skip:(c.page-1)*c.limit},{$limit:c.limit},{$lookup:{from:'listing_media',let:{id:'$id'},pipeline:[{$match:{$expr:{$and:[{$eq:['$listing_id','$$id']},{$eq:['$visibility','public']}]}}},{$sort:{position:1}},{$lookup:{from:'media',localField:'media_id',foreignField:'id',as:'file'}},{$match:{'file.kind':'image','file.review_status':{$nin:['Restricted','Pending']}}},{$limit:1}],as:'cover'}},{$project:{_id:0,id:1,title:1,type:'$property.type',transaction:'$transaction_type',neighbourhood:'$location.neighbourhood',price:{$divide:['$priceRecord.amount_minor',100]},area:'$property.area',areaBasis:'$property.area_basis',details:'$property.details_json',publication:1,availability:1,reviewed:1,projectId:'$project_id',currency:1,priceBasis:'$price_basis',location:{mode:{$literal:'approximate'},latitude:'$publicLat',longitude:'$publicLng'},cover:'$cover.media_id'}}]}});
  const [result]=await db.raw.collection(c.bounds?'locations':'listings').aggregate(pipeline,{maxTimeMS:5000}).toArray();
  return {version:1,page:c.page,limit:c.limit,total:result.total[0]?.count||0,listings:result.items.map(({details,cover,...p})=>({...p,...JSON.parse(details),images:cover.map(id=>`/api/files/${id}`),amenities:[],history:[],point:{x:50,y:50},description:'',address:''}))};
}
