import brand from './brand.json' with { type: 'json' };
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { audit, HttpError, requireValue, text, transaction, now } from './database.mjs';
import {customerUpdates} from './updates.mjs';
import { criteria, searchListings } from './search.mjs';
import {accountCookie, accountTokenHash, newAccountToken, revokeAccountSession} from './account-session.mjs';

const derive = promisify(scrypt);
const digest = token => createHash('sha256').update(token).digest('hex');
const randomToken = () => randomBytes(32).toString('hex');
const sessionAge = 30 * 24 * 60 * 60;
const linkAge = 30 * 60_000;
const preferences = {price: true, availability: true, matches: false, messages:true, visits:true};
const shape = ({id, name, email}) => ({id, name, email});
const recordId = /^[a-zA-Z0-9-]{1,80}$/;

function emailAddress(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  requireValue(email.length <= 120 && /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,63}$/.test(email), 'Enter a valid email address.');
  return email;
}

async function passwordRecord(value) {
  requireValue(typeof value === 'string' && value.length >= 12 && value.length <= 200, 'Use a password between 12 and 200 characters.');
  const salt = randomBytes(16).toString('hex');
  return {salt, password_hash: (await derive(value, salt, 64)).toString('hex')};
}

function savedQuery(value) {
  requireValue(typeof value === 'string' && value.length <= 2400, 'Invalid saved search.');
  const input = new URLSearchParams(value);
  const c = criteria(input);
  const query = new URLSearchParams({v: '1', transaction: c.transaction, type: c.type || 'All'});
  for (const key of ['q', 'maxPrice', 'beds', 'bounds', 'project']) {
    if (c[key] !== null && c[key] !== undefined && c[key] !== '') query.set(key, String(c[key]));
  }
  for (const id of c.amenities.sort()) query.append('amenity', id);
  return query.toString();
}

export async function currentCustomer(db, req, kind = 'customer') {
  const token_hash = accountTokenHash(req);
  if (!token_hash) return null;
  const session = await db.get('customer_sessions', {token_hash, unified: true, expires: {$gt: new Date()}});
  return session ? db.get('external_accounts', {id: session.account_id, kind}) : null;
}

export function customerRoutes({db, mail, origin, secure, rate, readBody, send, localMail}, kind = 'customer') {
  const base = '/api/' + kind;
  const owner = kind === 'owner';
  const dashboard = owner ? '/owner' : '/account';
  const linkPurpose = purpose => owner ? 'owner-' + purpose : purpose;

  async function signedIn(req) {
    const account = await currentCustomer(db, req, kind);
    requireValue(account, 'Sign in to your customer account to continue.', 401);
    return account;
  }

  async function startSession(account, req) {
    await revokeAccountSession(db, req);
    const {token, token_hash} = newAccountToken();
    await db.insert('customer_sessions', {token_hash, unified: true, account_id: account.id, expires: new Date(Date.now() + sessionAge * 1000)});
    return token;
  }

  async function state(account) {
    if (owner) return {user:shape(account), status:account.owner_status, feedback:account.owner_feedback||''};
    const account_id = account.id;
    const [bookmarks, searches] = await Promise.all([
      db.find('customer_bookmarks', {account_id}),
      db.find('customer_searches', {account_id}, {created_at: -1, id: 1}),
    ]);
    return {
      user: shape(account),
      saved: bookmarks.filter(b => b.saved).map(b => b.listing_id),
      followed: bookmarks.filter(b => b.followed).map(b => b.listing_id),
      searches: searches.map(({id, label, query}) => ({id, label, query})),
      preferences: {...preferences, ...account.preferences},
    };
  }

  async function issueLink(req, email, purpose) {
    requireValue(mail, 'Email is temporarily unavailable. Try again later.', 503);
    const filter = {email, purpose:linkPurpose(purpose)};
    const token = randomToken(), token_hash = digest(token);
    const issued = await transaction(db, async () => {
      const account = await db.get('external_accounts', {email});
      if (purpose === 'verify' ? !!account : account?.kind !== kind) return false;
      const previous = await db.get('customer_links', filter);
      const time = Date.now();
      if (previous && time - previous.created_at < 60_000) return false;
      await db.put('customer_links', filter, {...filter, token_hash, created_at: time, expires: new Date(time + linkAge)});
      return true;
    });
    if (!issued) return;
    const link = new URL(`${dashboard}/${purpose}`, origin || `http://${req.headers.host}`);
    link.hash = 'code=' + token;
    try {
      await mail({to: email, subject: purpose === 'verify' ? (owner ? `Finish creating your ${brand.name} owner account` : `Finish creating your ${brand.name} account`) : `Reset your ${brand.name} password`, link: link.href});
    } catch {
      await db.remove('customer_links', {...filter, token_hash});
      console.error('Account email could not be delivered.');
    }
  }

  return async (req, res, path) => {
    const method = req.method;
    const action = path.slice(base.length);
    if (action === '/session' && method === 'GET') {
      const account = await currentCustomer(db, req, kind);
      return send(res, 200, account ? await state(account) : {user: null});
    }
    if (action === '/logout' && method === 'POST') {
      if (await currentCustomer(db, req, kind)) {
        await revokeAccountSession(db, req);
        accountCookie(res, secure);
      }
      return send(res, 200, {ok: true});
    }
    if (method === 'POST' && ['/register', '/recover'].includes(action)) {
      rate(req, 'customer-mail');
      const data = await readBody(req);
      await issueLink(req, emailAddress(data?.email), path.endsWith('/register') ? 'verify' : 'reset');
      return send(res, 202, localMail ? {ok: true, localInbox: true} : {ok: true});
    }
    if (method === 'POST' && ['/verify', '/reset'].includes(action)) {
      rate(req, 'customer-link');
      const data = await readBody(req);
      requireValue(typeof data?.code === 'string' && /^[a-f0-9]{64}$/.test(data.code), 'This link is invalid or has expired.');
      const purpose = path.endsWith('/verify') ? 'verify' : 'reset';
      const filter = {token_hash: digest(data.code), purpose:linkPurpose(purpose), expires: {$gt: new Date()}};
      requireValue(await db.get('customer_links', filter), 'This link is invalid or has expired.');
      const name = text(data.name, 80);
      if (purpose === 'verify') requireValue(name.length >= 2, 'Enter your name.');
      const credentials = await passwordRecord(data.password);
      const phone = owner && purpose === 'verify' ? text(data.phone,30) : '';
      if (owner && purpose === 'verify') {
        requireValue(/^[+()0-9 -]{7,30}$/.test(phone)&&phone.replace(/\D/g,'').length>=7,'Enter a valid contact number.');
        requireValue(data.authorized === 'on', 'Confirm you are authorized to submit properties.');
      }
      const result = await transaction(db, async () => {
        const link = await db.get('customer_links', {...filter, expires: {$gt: new Date()}});
        requireValue(link, 'This link is invalid or has expired.');
        const existing = await db.get('external_accounts', {email: link.email});
        let account;
        if (purpose === 'verify') {
          requireValue(!existing, 'This link is no longer available.');
          account = {id: randomUUID(), email: link.email, name, kind, verified_at: now(), ...(owner ? {owner_status:'Pending',owner_phone:phone,declaration_at:now()} : {}), ...credentials};
          await db.insert('external_accounts', account);
        } else {
          requireValue(existing?.kind === kind, 'This link is no longer available.');
          await db.put('external_accounts', {id: existing.id}, credentials);
          await db.remove('customer_sessions', {account_id: existing.id});
          account = existing;
        }
        await db.remove('customer_links', {email: link.email, purpose:linkPurpose(purpose)});
        return {account, token: await startSession(account, req)};
      });
      accountCookie(res, secure, result.token, sessionAge);
      return send(res, 200, await state(result.account));
    }
    if (action === '/login' && method === 'POST') {
      rate(req, 'customer-login');
      const data = await readBody(req);
      const email = emailAddress(data?.email);
      const account = await db.get('external_accounts', {email, kind});
      const password = typeof data?.password === 'string' && data.password.length <= 200 ? data.password : '';
      const actual = await derive(password, account?.salt || 'forma-customer-dummy', 64);
      requireValue(timingSafeEqual(actual, Buffer.from(account?.password_hash || '00'.repeat(64), 'hex')) && account, 'Email or password is incorrect.', 401);
      const token = await transaction(db, async () => {
        requireValue(await db.get('external_accounts', {id: account.id, kind, password_hash: account.password_hash}), 'Email or password is incorrect.', 401);
        return startSession(account, req);
      });
      accountCookie(res, secure, token, sessionAge);
      return send(res, 200, await state(account));
    }
    if (path === '/api/customer/collection' && method === 'GET') {
      const account = await signedIn(req);
      const bookmarks = await db.find('customer_bookmarks', {account_id: account.id});
      const listingIds = bookmarks.map(b => b.listing_id);
      const found = listingIds.length ? await searchListings(db, new URLSearchParams({limit: '48'}), listingIds) : {listings: []};
      return send(res, 200, {listings: found.listings});
    }
    if (path === '/api/customer/call-preference' && ['GET','PUT'].includes(method)) {
      const account = await signedIn(req);
      if (method === 'GET') return send(res,200,{phone:account.saved_call_phone||'',allowed:!!account.saved_call_permission?.allowed});
      const data=await readBody(req);
      const phone=text(data.phone,30);
      requireValue(typeof data.allowed==='boolean',`Choose whether ${brand.name} may call you.`);
      requireValue((!data.allowed&&!phone)||(/^[+()0-9 -]{7,30}$/.test(phone)&&phone.replace(/\D/g,'').length>=7),'Enter a valid phone number.');
      await transaction(db,async()=>{
        const current=await signedIn(req);
        if(current.saved_call_phone===phone&&current.saved_call_permission?.allowed===data.allowed)return;
        await db.put('external_accounts',{id:current.id},{saved_call_phone:phone,saved_call_permission:{allowed:data.allowed,version:1,at:now(),source:'collection'}});
        if(data.allowed){
          for(const bookmark of await db.find('customer_bookmarks',{account_id:current.id,saved:true})){
            const filter={account_id:current.id,listing_id:bookmark.listing_id};
            if(await db.get('saved_interests',filter))continue;
            const listing=await db.get('listings',{id:bookmark.listing_id});
            if(!listing)continue;
            const loc=await db.get('locations',{property_id:listing.property_id});
            const lead=await db.get('enquiries',{target_kind:'Listing',target_id:listing.id,email:current.email});
            await db.insert('saved_interests',{id:randomUUID(),...filter,active:true,title:listing.title,
              locality:loc?.neighbourhood||'',project_id:listing.project_id||null,saved_at:null,grant:null,
              ...(lead?{enquiry_id:lead.id}:{})});
          }
        }
        for(const interest of await db.find('saved_interests',{account_id:current.id,grant:{$ne:null}})){
          await db.put('saved_interests',{id:interest.id},{grant:null});
        }
        await audit(db,current,current.id,'customer.saved_calls.preference',data.allowed?'allowed':'withdrawn');
      });
      return send(res,200,{phone,allowed:data.allowed});
    }
    if (path === '/api/customer/bookmark' && method === 'PUT') {
      const data = await readBody(req);
      requireValue(typeof data?.id === 'string' && recordId.test(data.id) && ['saved', 'followed'].includes(data.kind) && typeof data.active === 'boolean', 'Invalid collection action.');
      const updated = await transaction(db, async () => {
        const account = await signedIn(req);
        const filter = {account_id: account.id, listing_id: data.id};
        const previous = await db.get('customer_bookmarks', filter);
        const listing=data.active&&await db.get('listings',{id:data.id,publication:'Published'});
        if (data.active) {
          requireValue(listing, 'This property is unavailable.', 404);
          if (!previous) requireValue(await db.count('customer_bookmarks', {account_id: account.id}) < 48, 'Your collection is full. Remove a property first.');
        }
        const next = {saved: !!previous?.saved, followed: !!previous?.followed, [data.kind]: data.active};
        if (next.saved || next.followed) await db.put('customer_bookmarks', filter, {...filter, ...next});
        else if (previous) await db.remove('customer_bookmarks', filter);
        if(data.kind==='saved'){
          const interest=await db.get('saved_interests',filter);
          if(data.active&&!interest){
            const location=await db.get('locations',{property_id:listing.property_id});
            const lead=await db.get('enquiries',{target_kind:'Listing',target_id:listing.id,email:account.email});
            await db.insert('saved_interests',{id:randomUUID(),...filter,active:true,title:listing.title,
              locality:location?.neighbourhood||'',project_id:listing.project_id||null,saved_at:now(),grant:null,
              ...(lead?{enquiry_id:lead.id}:{})});
          }else if(interest&&interest.active!==data.active){
            await db.put('saved_interests',{id:interest.id},{active:data.active,grant:null});
          }
        }
        return next;
      });
      return send(res, 200, updated);
    }
    if (path === '/api/customer/searches' && method === 'POST') {
      const data = await readBody(req);
      const query = savedQuery(data?.query), label = text(data?.label, 240);
      requireValue(label, 'Enter a label for your saved search.');
      const search = await transaction(db, async () => {
        const account = await signedIn(req);
        const account_id = account.id;
        const previous = await db.get('customer_searches', {account_id, query});
        if (previous) return previous;
        requireValue(await db.count('customer_searches', {account_id}) < 20, 'Remove a saved search before adding another.');
        return db.insert('customer_searches', {account_id, id: randomUUID(), label, query, created_at: now()});
      });
      return send(res, 200, {search: {id: search.id, label: search.label, query: search.query}});
    }
    if (path.startsWith('/api/customer/searches/') && method === 'DELETE') {
      const id = path.split('/').at(-1);
      requireValue(recordId.test(id), 'Invalid saved search.');
      await transaction(db, async () => {
        const account = await signedIn(req);
        await db.remove('customer_searches', {account_id: account.id, id});
      });
      return send(res, 200, {ok: true});
    }
    if (path === '/api/customer/updates' && method === 'GET') {
      return send(res,200,{updates:await customerUpdates(db,await signedIn(req))});
    }
    if (path === '/api/customer/updates' && method === 'PUT') {
      const data=await readBody(req);
      requireValue(typeof data.id==='string'&&recordId.test(data.id),'Invalid update reference.');
      await transaction(db,async()=>{
        const account=await signedIn(req);
        const filter={account_id:account.id,id:data.id};
        requireValue(await db.get('customer_updates',filter),'Update not found.',404);
        await db.put('customer_updates',filter,{read:true});
      });
      return send(res,200,{ok:true});
    }
    if (path === '/api/customer/preferences' && method === 'PUT') {
      const data = await readBody(req);
      requireValue(Object.hasOwn(preferences, data?.key) && typeof data?.enabled === 'boolean', 'Invalid update preference.');
      await transaction(db, async () => {
        const account = await signedIn(req);
        await db.put('external_accounts', {id: account.id}, {preferences: {...preferences, ...account.preferences, [data.key]: data.enabled}});
      });
      return send(res, 200, {ok: true});
    }
    throw new HttpError(404, 'Customer route not found.');
  };
}
