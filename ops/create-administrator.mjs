import {openDatabase} from '../src/database.mjs';
import {createFirstAdministrator} from '../src/staff-accounts.mjs';

const [, , name, email] = process.argv;
if (!name || !email || process.stdin.isTTY) {
  console.error('Provide the administrator name and email as arguments, and the password on standard input.');
  process.exit(1);
}
let password = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  password += chunk;
  if (password.length > 210) throw new Error('Use a password between 12 and 200 characters.');
}
const db = await openDatabase();
try {
  const user = await createFirstAdministrator(db, {name, email, password: password.replace(/\r?\n$/, '')});
  console.log(`Created administrator ${user.name}. Sign in with the Team account type.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
