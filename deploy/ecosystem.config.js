const path = require('node:path');

const root = process.env.BOORAN_ROOT || '/var/www/booran';
const webOrigin = 'https://booran-sales-floor.goodshowroom.com';
const webOrigins = [webOrigin, 'https://www.booran-sales-floor.goodshowroom.com'].join(',');
const backendOrigin = 'https://booran-sales-floor-backend.goodshowroom.com';
const shared = path.join(root, 'shared');

function app(name, cwd, script, env, killTimeout) {
  return {
    name,
    cwd: path.join(root, 'current', cwd),
    script,
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: name === 'booran-sales-floor-backend' ? '768M' : '512M',
    // Collect the backend heap before PM2's RSS limit interrupts long source pulls.
    ...(name === 'booran-sales-floor-backend' ? { node_args: ['--max-old-space-size=256'] } : {}),
    min_uptime: '10s',
    exp_backoff_restart_delay: 1000,
    kill_timeout: killTimeout,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    out_file: path.join(shared, 'logs', `${name}-out.log`),
    error_file: path.join(shared, 'logs', `${name}-error.log`),
    env: { NODE_ENV: 'production', ...env },
  };
}

module.exports = {
  apps: [
    app('booran-sales-floor-backend', 'backend', 'server.js', {
      PORT: 4103,
      BIND_HOST: '127.0.0.1',
      TRUST_LOOPBACK_PROXY: 'true',
      ALLOWED_ORIGINS: webOrigins,
      BACKEND_PUBLIC_URL: backendOrigin,
      MEDIA_STORAGE_BACKEND: 'mongodb',
      SMS_CAMPAIGN_DB_NAME: process.env.SMS_CAMPAIGN_DB_NAME ?? 'sms_campaign',
      AUTO_SYNC_CSV: 'false',
      WATCH_CSV: 'false',
    }, 35000),
    app('booran-sales-floor', 'web/.next/standalone', 'server.js', {
      PORT: 4101,
      HOSTNAME: '127.0.0.1',
      API_URL: 'http://127.0.0.1:4103/api',
      APP_PUBLIC_ORIGINS: webOrigins,
      TRUST_LOOPBACK_PROXY: 'true',
      NEXT_TELEMETRY_DISABLED: '1',
    }, 10000),
  ],
};
