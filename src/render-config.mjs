function httpsOrigin(value, name) {
  const url = URL.parse(value || '');
  if (url?.protocol !== 'https:' || url.origin !== value) {
    throw new Error(`Set ${name} to an HTTPS origin without a path or trailing slash.`);
  }
  return url;
}

export function renderConfig(env = process.env) {
  if (env.FORMA_DEPLOYMENT !== 'render') {
    if (env.RENDER && env.NODE_ENV === 'production') throw new Error('Set FORMA_DEPLOYMENT=render for the Render backend.');
    return null;
  }
  const frontend = httpsOrigin(env.APP_ORIGIN, 'APP_ORIGIN');
  const api = httpsOrigin(env.PUBLIC_API_ORIGIN, 'PUBLIC_API_ORIGIN');
  if (frontend.origin === api.origin) throw new Error('Configure separate Render frontend and API origins.');
  if (env.NODE_ENV !== 'production' || env.ALLOW_LOCAL_BOOTSTRAP === '1') {
    throw new Error('Render requires production mode and operator-only administrator setup.');
  }
  if (!['mongodb', 'r2'].includes(env.STORAGE_DRIVER) || env.CUSTOMER_MAIL_MODE !== 'brevo-api' || !env.CLAMD_HOST?.trim()) {
    throw new Error('Render requires MongoDB or R2 storage, Brevo HTTPS email, and a private ClamAV host.');
  }
  if (!env.MONGODB_DATABASE?.trim()) throw new Error('Set MONGODB_DATABASE for the hosted service.');
  return { frontend, api };
}

export async function renderShell(frontend) {
  const response = await fetch(new URL('/index.html', frontend), {
    redirect: 'error', signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (!response?.ok || !response.headers.get('content-type')?.startsWith('text/html')) {
    await response?.body?.cancel();
    return null;
  }
  const html = await response.text().catch(() => '');
  if (!html.includes('<div id="root"></div>')) return null;
  return html.replace(/\b(src|href)="\/(?!\/)/g, `$1="${frontend.origin}/`);
}
