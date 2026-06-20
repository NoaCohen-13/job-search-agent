import cron from 'node-cron';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { sendDigest, buildWeeklyDigestHtml } from './mailer.js';

const ROOT = process.cwd();
const DATA_FILE = resolve(ROOT, 'data.json');
const DISCOVER_FILE = resolve(ROOT, 'workspace/discover/latest.json');

function readData() {
  if (!existsSync(DATA_FILE)) return {};
  try { return JSON.parse(readFileSync(DATA_FILE, 'utf-8')); } catch { return {}; }
}

function readConfig() {
  const cfg = resolve(ROOT, 'config.json');
  if (!existsSync(cfg)) return {};
  try { return JSON.parse(readFileSync(cfg, 'utf-8')); } catch { return {}; }
}

// Triggers the agent to run /find and returns new results
async function runDailyDiscover(sendMessageFn) {
  const config = readConfig();
  const role = config.targetRole || 'Product Manager';
  const location = config.location || 'Israel';

  // Capture results by reading latest.json before and after
  const before = existsSync(DISCOVER_FILE)
    ? JSON.parse(readFileSync(DISCOVER_FILE, 'utf-8')).results || []
    : [];

  const beforeIds = new Set(before.map(r => `${r.company}-${r.role}`));

  console.log(`[scheduler] Running daily /find for "${role}" in "${location}"...`);
  for await (const event of sendMessageFn(`/find ${role} ${location}`)) {
    // drain the stream silently
  }

  const after = existsSync(DISCOVER_FILE)
    ? JSON.parse(readFileSync(DISCOVER_FILE, 'utf-8')).results || []
    : [];

  const newJobs = after.filter(r => !beforeIds.has(`${r.company}-${r.role}`));
  console.log(`[scheduler] Daily discover done. ${newJobs.length} new listings.`);
  return { all: after, newJobs };
}

export function startScheduler(sendMessageFn) {
  // Daily job discovery — 9:00 AM every day
  cron.schedule('0 9 * * *', async () => {
    console.log('[scheduler] Daily discover starting...');
    try {
      await runDailyDiscover(sendMessageFn);
    } catch (err) {
      console.error('[scheduler] Daily discover error:', err.message);
    }
  });

  // Weekly digest — Monday 8:00 AM
  cron.schedule('0 8 * * 1', async () => {
    console.log('[scheduler] Sending weekly digest...');
    try {
      const data = readData();
      const config = readConfig();
      if (!config.email || (!config.gmailAppPassword && !config.smtpHost)) {
        console.log('[scheduler] No email credentials — skipping digest. Add gmailAppPassword to config.json.');
        return;
      }

      // Run discover to get fresh results for the digest
      const { all: newJobs } = await runDailyDiscover(sendMessageFn);

      const html = buildWeeklyDigestHtml(data, newJobs);
      await sendDigest('📋 Your weekly job search digest', html);
      console.log('[scheduler] Weekly digest sent to', config.email);
    } catch (err) {
      console.error('[scheduler] Weekly digest error:', err.message);
    }
  });

  console.log('[scheduler] Running: daily discover at 9am, weekly digest on Mondays at 8am');
}

// Manual trigger for testing
export async function triggerDiscover(sendMessageFn) {
  return runDailyDiscover(sendMessageFn);
}

export async function triggerDigest(sendMessageFn) {
  const data = readData();
  const { newJobs } = await runDailyDiscover(sendMessageFn);
  const html = buildWeeklyDigestHtml(data, newJobs);
  await sendDigest('📋 Your weekly job search digest', html);
}
