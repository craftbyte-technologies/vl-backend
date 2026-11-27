import {createHash, randomBytes} from 'node:crypto';

const name = 'forma_account';
const guestPath = '/api/customer/enquiries';
const hash = token => createHash('sha256').update(token).digest('hex');

export function accountTokenHash(req) {
  const token = /(?:^|;\s*)forma_account=([a-f0-9]{64})(?=;|$)/.exec(req.headers.cookie || '')?.[1];
  return token && hash(token);
}

export async function revokeAccountSession(db, req) {
  const token_hash = accountTokenHash(req);
  if (!token_hash) return;
  await db.remove('sessions', {token_hash});
  await db.remove('customer_sessions', {token_hash});
}

export function newAccountToken() {
  const token = randomBytes(32).toString('hex');
  return {token, token_hash: hash(token)};
}

export function accountCookie(res, secure, token = '', age = 0) {
  const cookie = (key, value, path, maxAge) =>
    `${key}=${value}; HttpOnly; SameSite=Strict; Path=${path}; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', [
    cookie(name, token, '/api', age),
    cookie('forma_guest', '', guestPath, 0),
    cookie('forma_session', '', '/api', 0),
    cookie('forma_customer', '', '/api/customer', 0),
    cookie('forma_owner', '', '/api/owner', 0),
  ]);
}
