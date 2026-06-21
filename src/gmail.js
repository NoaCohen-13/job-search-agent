import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const ROOT = process.cwd();
const TOKEN_FILE = resolve(ROOT, 'workspace/memory/gmail_token.json');
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

function getCredentials() {
  const cfg = resolve(ROOT, 'config.json');
  if (!existsSync(cfg)) return null;
  const config = JSON.parse(readFileSync(cfg, 'utf-8'));
  if (!config.gmailClientId || !config.gmailClientSecret) return null;
  return { clientId: config.gmailClientId, clientSecret: config.gmailClientSecret };
}

export function getOAuth2Client(redirectUri) {
  const creds = getCredentials();
  if (!creds) return null;
  return new google.auth.OAuth2(creds.clientId, creds.clientSecret, redirectUri);
}

export function getAuthUrl(redirectUri) {
  const client = getOAuth2Client(redirectUri);
  if (!client) return null;
  return client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
}

export async function handleCallback(code, redirectUri) {
  const client = getOAuth2Client(redirectUri);
  const { tokens } = await client.getToken(code);
  writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
  return tokens;
}

export function loadToken() {
  if (!existsSync(TOKEN_FILE)) return null;
  try { return JSON.parse(readFileSync(TOKEN_FILE, 'utf-8')); } catch { return null; }
}

export function isConnected() {
  return !!loadToken() && !!getCredentials();
}

async function getAuthedClient() {
  const token = loadToken();
  if (!token) return null;
  const client = getOAuth2Client('http://localhost:3000/api/auth/gmail/callback');
  if (!client) return null;
  client.setCredentials(token);
  // Refresh token if needed
  client.on('tokens', (t) => {
    const existing = loadToken() || {};
    writeFileSync(TOKEN_FILE, JSON.stringify({ ...existing, ...t }, null, 2));
  });
  return client;
}

// Returns { subject, snippet, date, from } for the most recent email matching the company name
export async function getLastEmailForCompany(companyName) {
  try {
    const auth = await getAuthedClient();
    if (!auth) return null;
    const gmail = google.gmail({ version: 'v1', auth });

    const q = `"${companyName}" in:anywhere -category:promotions -category:social -subject:"weekly job search digest"`;
    const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 1 });
    const messages = list.data.messages;
    if (!messages?.length) return null;

    const msg = await gmail.users.messages.get({ userId: 'me', id: messages[0].id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] });
    const headers = msg.data.payload?.headers || [];
    const get = (name) => headers.find(h => h.name === name)?.value || '';

    return {
      subject: get('Subject'),
      from: get('From'),
      date: get('Date'),
      snippet: msg.data.snippet || '',
      timestamp: msg.data.internalDate ? new Date(parseInt(msg.data.internalDate)).toISOString() : null,
      messageId: messages[0].id,
    };
  } catch { return null; }
}

const REJECTION_SIGNALS = [
  'regret to inform', 'regret that', 'not moving forward', 'will not be moving',
  'not selected', 'not been selected', 'not successful', 'have decided not',
  'not a fit', 'not the right fit', 'not a good fit', 'decided to move forward with other',
  'filled the position', 'position has been filled', 'no longer considering',
  'unfortunately', 'at this time we', 'we will not', 'not proceed',
];
const INTERVIEW_SIGNALS = [
  'interview', 'schedule a call', 'schedule time', 'availability', 'meet with',
  'next steps', 'next round', 'phone screen', 'video call', 'zoom', 'teams call',
];

export function detectEmailStatus(email) {
  if (!email) return null;
  const text = `${email.subject} ${email.snippet}`.toLowerCase();
  if (REJECTION_SIGNALS.some(s => text.includes(s))) return 'rejected';
  if (INTERVIEW_SIGNALS.some(s => text.includes(s))) return 'interview';
  return null;
}

// Searches specifically for interview invitation emails from a company
export async function getInterviewEmailForCompany(companyName) {
  try {
    const auth = await getAuthedClient();
    if (!auth) return null;
    const gmail = google.gmail({ version: 'v1', auth });

    const q = `"${companyName}" (interview OR "schedule a call" OR "schedule time" OR availability OR "next steps" OR "next round" OR "phone screen" OR "video call" OR "let's meet" OR "lets meet" OR "meet with you" OR "invitation") in:anywhere -category:promotions -category:social -subject:"weekly job search digest"`;
    const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 1 });
    const messages = list.data.messages;
    if (!messages?.length) return null;

    const msg = await gmail.users.messages.get({ userId: 'me', id: messages[0].id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] });
    const headers = msg.data.payload?.headers || [];
    const get = (name) => headers.find(h => h.name === name)?.value || '';

    return {
      subject: get('Subject'),
      from: get('From'),
      date: get('Date'),
      snippet: msg.data.snippet || '',
      timestamp: msg.data.internalDate ? new Date(parseInt(msg.data.internalDate)).toISOString() : null,
      messageId: messages[0].id,
    };
  } catch { return null; }
}

// Returns thread counts and last contact date for multiple companies at once
export async function getEmailSummaries(companyNames) {
  const results = {};
  await Promise.all(companyNames.map(async (name) => {
    results[name] = await getLastEmailForCompany(name);
  }));
  return results;
}

const GENERIC_SENDERS = new Set([
  'greenhouse', 'lever', 'workday', 'bamboohr', 'jobvite', 'gmail', 'yahoo',
  'linkedin', 'smartrecruiters', 'workable', 'taleo', 'icims', 'comeet',
  'drushim', 'glassdoor', 'indeed', 'jobscan', 'ashby', 'rippling', 'info',
  'notifications', 'mail', 'hiring', 'hr', 'jobs', 'careers', 'apply',
]);

const BAD_COMPANY_PREFIXES = ['we ', 're ', 'fw ', 'fwd ', 'hi ', 'hello ', 'dear ', 'your ', 'got '];
const BAD_COMPANY_NAMES = new Set(['we', 're', 'fw', 'fwd', 'hi', 'hello', 'dear', 'we got it',
  'we received', 'your application', 'thanks', 'thank you', 'application', 'received', 'got it',
  'thank', 'the', 'a', 'an', 'and']);

function isValidCompanyName(name) {
  if (!name || name.length < 2) return false;
  const lower = name.toLowerCase().trim();
  if (BAD_COMPANY_NAMES.has(lower)) return false;
  if (BAD_COMPANY_PREFIXES.some(p => lower.startsWith(p))) return false;
  return true;
}

function domainToCompany(fromAddr) {
  // Comeet/ATS subdomain: abra.rnd.comeet-notifications.com → "abra"
  const atsMatch = fromAddr.match(/@([a-z][a-z0-9-]+)\.(?:rnd\.|mail\.)?(?:comeet|lever|greenhouse|bamboohr|workday|jobvite|smartrecruiters|workable|taleo|icims|ashby|rippling)[-.]/i);
  if (atsMatch) {
    const sub = atsMatch[1].toLowerCase();
    if (!GENERIC_SENDERS.has(sub) && sub.length > 1) {
      return sub.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }
  }
  // Generic: no-reply@acme.com → "acme"
  const domMatch = fromAddr.match(/<[^>]*@(?:[a-z-]+\.)?([a-z][a-z0-9-]+)\.[a-z]{2,}>/i);
  if (domMatch) {
    const dom = domMatch[1].toLowerCase();
    if (!GENERIC_SENDERS.has(dom) && dom.length > 2) {
      return dom.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }
  }
  return null;
}

function extractCompanyAndRole(subject, from) {
  // Skip reply/forward emails entirely
  if (/^(re|fw|fwd)\s*:/i.test(subject)) return { company: null, role: null };

  const sub = subject || '';
  const fromAddr = from || '';
  let company = null;
  let role = null;

  // "applying/applied for {role} at {company}"
  let m = sub.match(/(?:applying|applied)\s+(?:for\s+)?(?:the\s+)?(?:position\s+(?:of\s+)?)?(.+?)\s+(?:position\s+)?at\s+([A-Za-z][^\s,!.]+(?:\s+[A-Za-z][^\s,!.]+){0,3})(?:\s*[!,.]|\s*$)/i);
  if (m) {
    role = m[1].trim().replace(/^(a|an|the)\s+/i, '');
    company = m[2].trim();
  }

  // "applying to {company}" or "applied to {company}"
  if (!company) {
    m = sub.match(/(?:applying|applied)\s+to\s+([A-Za-z][^\s,!.]+(?:\s+[A-Za-z][^\s,!.]+){0,3})(?:\s*[!,.]|\s*$)/i);
    if (m) company = m[1].trim();
  }

  // "for the {role} at {company}"
  if (!company) {
    m = sub.match(/\bfor\s+(?:the\s+)?([^@\n,]+?)\s+(?:role\s+)?at\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3})(?:\s*[!,.]|\s*$)/);
    if (m) { role = m[1].trim(); company = m[2].trim(); }
  }

  // "at {Company}" (capital letter company name)
  if (!company) {
    m = sub.match(/\bat\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3})(?:\s*[,!.]|\s+(?:for|position|role|team)\b|\s*$)/);
    if (m) company = m[1].trim();
  }

  // Domain extraction — most reliable for ATS-hosted confirmations (Comeet, Greenhouse EU, etc.)
  if (!company) company = domainToCompany(fromAddr);

  // Validate
  if (!isValidCompanyName(company)) company = null;

  return { company: company || null, role: role || null };
}

// Scans inbox for application confirmation emails — returns possible new applications
export async function scanForNewApplications() {
  try {
    const auth = await getAuthedClient();
    if (!auth) return [];
    const gmail = google.gmail({ version: 'v1', auth });

    const q = [
      'subject:"thank you for applying"',
      'subject:"thanks for applying"',
      'subject:"application received"',
      'subject:"we received your application"',
      'subject:"your application has been received"',
      'subject:"application submitted"',
      'subject:"successfully applied"',
    ].join(' OR ');

    const list = await gmail.users.messages.list({
      userId: 'me',
      q: `(${q}) newer_than:60d -subject:"weekly job search digest" -from:me`,
      maxResults: 20,
    });
    const messages = list.data.messages;
    if (!messages?.length) return [];

    const results = await Promise.all(messages.map(async ({ id }) => {
      try {
        const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] });
        const headers = msg.data.payload?.headers || [];
        const get = (name) => headers.find(h => h.name === name)?.value || '';
        const subject = get('Subject');
        const from = get('From');
        const { company, role } = extractCompanyAndRole(subject, from);
        if (!company) return null;
        return {
          messageId: id,
          subject,
          from,
          snippet: msg.data.snippet || '',
          timestamp: msg.data.internalDate ? new Date(parseInt(msg.data.internalDate)).toISOString() : null,
          company,
          role,
        };
      } catch { return null; }
    }));

    return results.filter(Boolean);
  } catch { return []; }
}
