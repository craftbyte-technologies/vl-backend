import brand from './brand.json' with { type: 'json' };
import { listing, projects } from './inventory.mjs';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function publicPage(db,path,origin,template,mediaOrigin=origin){
  let title='Find your place',description=`Discover published properties with ${brand.name}.`,image='',body='',status=200,publicPage=path==='/'||path==='/projects';
  if(path.startsWith('/property/')){
    try{const p=await listing(db,decodeURIComponent(path.slice(10)));publicPage=true;title=p.title;description=p.description.slice(0,250);image=p.images[0]||'';body=`<h1>${escape(title)}</h1><p>${escape(p.neighbourhood)} · ${escape(p.type)} · ${escape(p.availability)}</p><p>${escape(description)}</p>`;}
    catch(e){if(e.status!==404)throw e;status=404;title='Property unavailable';}
  }else if(path.startsWith('/projects/')){
    const id=decodeURIComponent(path.slice(10)),p=(await projects(db)).find(p=>p.id===id);
    if(p&&await db.get('listings',{project_id:id,publication:'Published'})){publicPage=true;title=p.name;description=p.description.slice(0,250);body=`<h1>${escape(title)}</h1><p>${escape(description)}</p>`;}else{status=404;title='Project unavailable';}
  }else if(path==='/sign-in'){title='Sign in';description=`Sign in to your ${brand.name} account.`;}
  else if(!publicPage&&!/^\/(admin|account|owner)(\/|$)/.test(path)){status=404;title='Page not found';}
  const pageTitle = escape(`${title} · ${brand.name}`);
  const canonical=origin+path,meta=`<link rel="canonical" href="${escape(canonical)}"><meta property="og:type" content="website"><meta property="og:site_name" content="${escape(brand.name)}"><meta property="og:title" content="${pageTitle}"><meta property="og:description" content="${escape(description)}"><meta property="og:url" content="${escape(canonical)}">${image?`<meta property="og:image" content="${escape(mediaOrigin+image)}">`:''}`;
  const html=template.replace(/<title>.*?<\/title>/,`<title>${pageTitle}</title>`).replace(/<meta name="description"[^>]*>/,`<meta name="description" content="${escape(description)}" />`).replace(/<meta name="robots"[^>]*>/,`<meta name="robots" content="${publicPage?'index,follow':'noindex,nofollow'}" />`).replace('</head>',meta+'</head>').replace('<div id="root"></div>',`<div id="root">${publicPage?`<noscript>${body}</noscript>`:''}</div>`);
  return {html,status};
}
