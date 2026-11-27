import brand from './brand.json' with { type: 'json' };
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import nodemailer from 'nodemailer';
import { localDataDirectory } from './local-paths.mjs';

export function customerMailer(env = process.env) {
  const mode = env.CUSTOMER_MAIL_MODE;
  if (!mode) return null;
  if (mode === 'capture') {
    if (env.NODE_ENV === 'production') throw new Error('Local mail capture is disabled in production.');
    const directory = resolve(env.CUSTOMER_INBOX_DIR || resolve(localDataDirectory(env), 'customer-inbox'));
    return async message => {
      await mkdir(directory, {recursive: true, mode: 0o700});
      await writeFile(resolve(directory, `${Date.now()}-${randomUUID()}.json`), JSON.stringify(message), {flag: 'wx', mode: 0o600});
    };
  }
  if (mode !== 'brevo' && mode !== 'brevo-api') throw new Error('Choose capture, brevo or brevo-api for CUSTOMER_MAIL_MODE.');
  const from = env.CUSTOMER_MAIL_FROM?.trim();
  if (!/^no-?reply@[a-z0-9.-]+\.[a-z]{2,63}$/i.test(from || '')) {
    throw new Error('Set CUSTOMER_MAIL_FROM to a verified noreply or no-reply sender.');
  }
  const origin = URL.parse(env.APP_ORIGIN || '');
  const localOrigin = env.NODE_ENV !== 'production' && origin?.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (!origin || origin.origin !== env.APP_ORIGIN || (origin.protocol !== 'https:' && !localOrigin)) {
    throw new Error('Set APP_ORIGIN to the HTTPS origin or a local loopback HTTP origin for development.');
  }
  const messageText = link => `Open the link to continue: ${link}\n\nThis link expires in 30 minutes and can only be used once. If you did not request it, you can ignore this email.`;
  if (mode === 'brevo-api') {
    const key = env.BREVO_API_KEY?.trim();
    if (!key) throw new Error('Set BREVO_API_KEY for Brevo HTTPS delivery.');
    return async ({to, subject, link}) => {
      const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: {'Content-Type': 'application/json', 'api-key': key},
        body: JSON.stringify({sender: {email: from, name: brand.name}, to: [{email: to}], subject, textContent: messageText(link)}),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`Brevo delivery failed with status ${response.status}.`);
    };
  }
  const user = env.BREVO_SMTP_USER?.trim();
  if (!user) throw new Error('Set BREVO_SMTP_USER to the login shown in Brevo SMTP settings.');
  let pass = env.BREVO_SMTP_KEY?.trim();
  if (env.BREVO_SMTP_KEY_FILE) {
    try { pass = readFileSync(env.BREVO_SMTP_KEY_FILE, 'utf8').trim(); }
    catch { throw new Error('The Brevo SMTP key file could not be read.'); }
  }
  if (!pass) throw new Error('Set BREVO_SMTP_KEY_FILE or BREVO_SMTP_KEY.');
  const smtp = nodemailer.createTransport({
    host: 'smtp-relay.brevo.com', port: 587, requireTLS: true, auth: {user, pass},
    connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 12000,
    disableFileAccess: true, disableUrlAccess: true,
  });
  return async ({to, subject, link}) => {
    await smtp.sendMail({from: {address: from, name: brand.name}, to: {address: to, name: ''}, subject, text: messageText(link)});
  };
}
