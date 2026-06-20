import nodemailer from 'nodemailer';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const ROOT = process.cwd();

function getConfig() {
  const cfg = resolve(ROOT, 'config.json');
  if (!existsSync(cfg)) return {};
  try { return JSON.parse(readFileSync(cfg, 'utf-8')); } catch { return {}; }
}

function getTransport() {
  const config = getConfig();
  if (!config.smtpHost) {
    // Default: Gmail SMTP using the user's own email (app password required)
    return nodemailer.createTransport({
      service: 'gmail',
      auth: { user: config.email, pass: config.gmailAppPassword },
    });
  }
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort || 587,
    secure: config.smtpSecure || false,
    auth: { user: config.smtpUser, pass: config.smtpPass },
  });
}

export async function sendDigest(subject, htmlBody) {
  const config = getConfig();
  if (!config.email) throw new Error('No email in config.json');
  if (!config.gmailAppPassword && !config.smtpHost) throw new Error('No email credentials in config.json (add gmailAppPassword or smtpHost/smtpUser/smtpPass)');

  const transport = getTransport();
  await transport.sendMail({
    from: `"JobAgent" <${config.email}>`,
    to: config.email,
    subject,
    html: htmlBody,
  });
}

export function buildWeeklyDigestHtml(data, newJobs) {
  const apps = data.applications || [];
  const now = new Date();

  const stale = apps
    .filter(a => a.status === 'applied')
    .filter(a => {
      const days = (now - new Date(a.dateApplied)) / 86400000;
      return days > 10;
    });

  const active = apps.filter(a => ['applied','screening','interview'].includes(a.status));
  const interviews = apps.filter(a => a.status === 'interview');

  const staleRows = stale.map(a => `
    <tr>
      <td style="padding:6px 12px">${a.company}</td>
      <td style="padding:6px 12px">${a.role}</td>
      <td style="padding:6px 12px;color:#ef4444">${Math.floor((now - new Date(a.dateApplied)) / 86400000)}d ago</td>
    </tr>`).join('');

  const interviewRows = interviews.map(a => `
    <tr>
      <td style="padding:6px 12px">${a.company}</td>
      <td style="padding:6px 12px">${a.role}</td>
      <td style="padding:6px 12px">${a.nextAction || '—'}</td>
    </tr>`).join('');

  const newJobRows = (newJobs || []).map(j => `
    <tr>
      <td style="padding:6px 12px">${j.company}</td>
      <td style="padding:6px 12px">${j.role}</td>
      <td style="padding:6px 12px">${j.location}</td>
      <td style="padding:6px 12px"><a href="${j.url}" style="color:#2563eb">${j.source}</a></td>
    </tr>`).join('');

  return `<!DOCTYPE html><html><body style="font-family:sans-serif;color:#1e293b;max-width:600px;margin:0 auto;padding:24px">
  <h2 style="color:#2563eb">📋 Weekly Job Search Digest</h2>
  <p style="color:#64748b">${now.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' })}</p>

  <h3>Pipeline snapshot</h3>
  <p>${data.stats?.totalApplied || 0} applied · ${interviews.length} interviewing · ${active.length} active</p>

  ${interviews.length ? `
  <h3>🟢 Active interviews</h3>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <tr style="background:#f1f5f9"><th style="padding:6px 12px;text-align:left">Company</th><th style="padding:6px 12px;text-align:left">Role</th><th style="padding:6px 12px;text-align:left">Next action</th></tr>
    ${interviewRows}
  </table>` : ''}

  ${stale.length ? `
  <h3>⚠️ Follow up needed (10+ days, no update)</h3>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <tr style="background:#f1f5f9"><th style="padding:6px 12px;text-align:left">Company</th><th style="padding:6px 12px;text-align:left">Role</th><th style="padding:6px 12px;text-align:left">Applied</th></tr>
    ${staleRows}
  </table>` : '<p>✅ No stale applications.</p>'}

  ${newJobs?.length ? `
  <h3>🆕 New jobs found this week</h3>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <tr style="background:#f1f5f9"><th style="padding:6px 12px;text-align:left">Company</th><th style="padding:6px 12px;text-align:left">Role</th><th style="padding:6px 12px;text-align:left">Location</th><th style="padding:6px 12px;text-align:left">Source</th></tr>
    ${newJobRows}
  </table>` : ''}

  <hr style="margin:24px 0;border:none;border-top:1px solid #e2e8f0">
  <p style="color:#94a3b8;font-size:12px">Sent by JobAgent · <a href="http://localhost:3000" style="color:#2563eb">Open dashboard</a></p>
</body></html>`;
}
