import {randomBytes, randomUUID, scryptSync} from 'node:crypto';
import {audit, now, requireValue, text, transaction} from './database.mjs';

export async function createStaff(db, data, role) {
  const email = text(data.email, 120).toLowerCase();
  const name = text(data.name, 80);
  const password = String(data.password || '');
  requireValue(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && name.length >= 2, 'Enter a name and valid email.');
  requireValue(password.length >= 12 && password.length <= 200, 'Use a password between 12 and 200 characters.');
  requireValue(['administrator', 'editor', 'reviewer'].includes(role), 'Invalid staff role.');
  requireValue(!await db.get('staff_users', {email}), 'This staff email is already registered.', 409);
  const salt = randomBytes(16).toString('hex');
  const password_hash = scryptSync(password, salt, 64).toString('hex');
  const id = randomUUID();
  await db.insert('staff_users', {id, email, name, password_hash, salt, role, created_at: now(), active: 1});
  return db.get('staff_users', {id});
}

export function createFirstAdministrator(db, data) {
  return transaction(db, async () => {
    requireValue(await db.count('staff_users') === 0, 'Workspace initialization is already complete.', 409);
    const user = await createStaff(db, data, 'administrator');
    await audit(db, user, user.id, 'workspace.initialized');
    return user;
  });
}
