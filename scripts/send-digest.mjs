/**
 * Standalone weekly digest sender — no server required.
 * Run directly: node scripts/send-digest.mjs
 * Or via LaunchAgent for automatic Monday 8am delivery.
 */
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

import { buildWeeklyDigestHtml, sendDigest } from '../src/mailer.js';

const config = (() => {
  const f = resolve(ROOT, 'config.json');
  if (!existsSync(f)) { console.error('[digest] config.json not found'); process.exit(1); }
  return JSON.parse(readFileSync(f, 'utf-8'));
})();

if (!config.email || (!config.gmailAppPassword && !config.smtpHost)) {
  console.error('[digest] No email credentials — add gmailAppPassword to config.json');
  process.exit(1);
}

const data = existsSync(resolve(ROOT, 'data.json'))
  ? JSON.parse(readFileSync(resolve(ROOT, 'data.json'), 'utf-8'))
  : {};

// Use the most recent discover results if available
const discoverFile = resolve(ROOT, 'workspace/discover/latest.json');
const recentJobs = existsSync(discoverFile)
  ? JSON.parse(readFileSync(discoverFile, 'utf-8')).results || []
  : [];

const html = buildWeeklyDigestHtml(data, recentJobs);
await sendDigest('📋 Your weekly job search digest', html);
console.log('[digest] Sent to', config.email);
