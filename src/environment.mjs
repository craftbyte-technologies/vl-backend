// Shared by the standalone Web Service and its operator commands, including off-host runs.
process.env.FORMA_DEPLOYMENT = 'render';
process.env.NODE_ENV ??= 'production';
process.env.STORAGE_DRIVER ??= 'mongodb';
process.env.CUSTOMER_MAIL_MODE ??= 'brevo-api';

if (!process.env.MONGODB_DATABASE?.trim()) {
  throw new Error('Set MONGODB_DATABASE to the dedicated application database.');
}

if (process.env.RENDER_EXTERNAL_HOSTNAME) {
  const hosts = [process.env.ALLOWED_HOSTS, process.env.RENDER_EXTERNAL_HOSTNAME].filter(Boolean);
  process.env.ALLOWED_HOSTS = hosts.join(',');
}
