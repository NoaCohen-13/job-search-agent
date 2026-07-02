import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';

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
  _tokenValid = true; // reset after fresh OAuth grant
  return tokens;
}

export function loadToken() {
  if (!existsSync(TOKEN_FILE)) return null;
  try { return JSON.parse(readFileSync(TOKEN_FILE, 'utf-8')); } catch { return null; }
}

let _tokenValid = true; // flipped to false on invalid_grant

export function isConnected() {
  return !!loadToken() && !!getCredentials() && _tokenValid;
}

export function markTokenInvalid() {
  _tokenValid = false;
  try { unlinkSync(TOKEN_FILE); } catch {}
}

async function getAuthedClient() {
  const token = loadToken();
  if (!token) return null;
  const client = getOAuth2Client('http://localhost:3000/api/auth/gmail/callback');
  if (!client) return null;
  client.setCredentials(token);
  client.on('tokens', (t) => {
    const existing = loadToken() || {};
    writeFileSync(TOKEN_FILE, JSON.stringify({ ...existing, ...t }, null, 2));
  });
  return client;
}

// Wraps a Gmail API call and catches invalid_grant to mark the token dead
async function gmailCall(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err?.message?.includes('invalid_grant') || err?.response?.data?.error === 'invalid_grant') {
      markTokenInvalid();
    }
    throw err;
  }
}

// Returns { subject, snippet, date, from } for the most recent email matching the company name
export async function getLastEmailForCompany(companyName) {
  try {
    const auth = await getAuthedClient();
    if (!auth) return null;
    const gmail = google.gmail({ version: 'v1', auth });

    // Exclude LinkedIn JOB ALERTS only (jobalerts-noreply) — they list many companies
    // and cause false matches. Allow jobs-noreply (application status updates like rejections).
    const q = `"${companyName}" in:anywhere -from:jobalerts-noreply@linkedin.com -category:promotions -category:social -subject:"weekly job search digest"`;
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

export const APPLIED_SIGNALS = [
  'thank you for applying', 'thanks for applying', 'we received your application',
  'your application has been received', 'application received', 'application submitted',
  'successfully applied', 'we got it', 'your resume has been received',
  'thank you for your interest in joining', 'thank you for submitting',
];

const REJECTION_SIGNALS = [
  'regret to inform', 'regret that', 'not moving forward', 'will not be moving',
  'not selected', 'not been selected', 'not successful', 'have decided not',
  'not a fit', 'not the right fit', 'not a good fit', 'decided to move forward with other',
  'filled the position', 'position has been filled', 'no longer considering',
  'unfortunately', 'at this time we', 'we will not', 'not proceed',
  // Phrases found in real rejection emails
  "won't be continuing", 'not continuing', 'not continuing the recruitment',
  'decided to move forward with other candidates', 'move forward with other candidates',
  'after thoughtful consideration', 'after careful consideration',
  'after reviewing your', 'will not be moving forward',
  'not be moving forward', 'decided not to move',
  'not a match', 'not the right match',
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
  if (APPLIED_SIGNALS.some(s => text.includes(s))) return 'applied';
  return null;
}

// Classify an email using the email-classifier sub-agent.
// Returns { category, company, confidence } or null on failure.
async function classifyEmailWithAgent(subject, from, body) {
  try {
    const prompt = `Classify this email from a job application process. Return only the JSON object.

Subject: ${subject}
From: ${from || ''}
Body: ${(body || '').slice(0, 2000)}`;

    const schema = {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['rejection', 'interview_invite', 'confirmation', 'irrelevant'] },
        company: { type: ['string', 'null'] },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      },
      required: ['category', 'company', 'confidence'],
    };

    let result = null;
    for await (const msg of query({
      prompt,
      options: {
        cwd: ROOT,
        agent: 'email-classifier',
        maxTurns: 3,
        allowedTools: [],
        jsonSchema: schema,
      },
    })) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text') {
            const match = block.text.match(/\{[\s\S]*\}/);
            if (match) try { result = JSON.parse(match[0]); } catch {}
          }
        }
      }
      if (msg.type === 'result' && msg.result) {
        const match = msg.result.match(/\{[\s\S]*\}/);
        if (match) try { result = JSON.parse(match[0]); } catch {}
      }
    }
    if (!result) return null;

    // Normalise — the agent may use different field names; map back to the schema
    const raw = result;
    const typeStr = (raw.category || raw.type || raw.emailType || '').toLowerCase();
    const statusStr = (raw.status || raw.status_update || '').toLowerCase();
    let category = raw.category;
    if (!['rejection','interview_invite','confirmation','irrelevant'].includes(category)) {
      if (typeStr.includes('reject') || statusStr === 'rejected') category = 'rejection';
      else if (typeStr.includes('interview') || statusStr.includes('interview')) category = 'interview_invite';
      else if (typeStr.includes('application_received') || typeStr.includes('confirmation') || statusStr === 'applied') category = 'confirmation';
      else category = 'irrelevant';
    }

    return {
      category,
      company: raw.company || null,
      confidence: raw.confidence || 'medium',
    };
  } catch { return null; }
}

// Thin wrapper — maps sub-agent categories to the legacy status strings
// used throughout the codebase ('rejected' | 'interview' | 'applied' | null).
async function classifyEmailWithAI(subject, body, from = '') {
  const result = await classifyEmailWithAgent(subject, from, body);
  if (!result) return null;
  const MAP = { rejection: 'rejected', interview_invite: 'interview', confirmation: 'applied' };
  return MAP[result.category] || null;
}

// Public — used by the /api/classify-email test endpoint.
// Returns the full structured result from the sub-agent.
// Extract company from "... at CompanyName" in subject line
function companyFromSubject(subject) {
  const m = subject.match(/\bat\s+(.+?)(?:\s*[|\-–]|$)/i);
  return m?.[1]?.trim() || null;
}

export async function classifyEmail({ subject = '', from = '', body = '' }) {
  const keyword = detectEmailStatus({ subject, snippet: body.slice(0, 300) });
  if (keyword) {
    const MAP = { rejected: 'rejection', interview: 'interview_invite', applied: 'confirmation' };
    return {
      category: MAP[keyword] || 'irrelevant',
      company: companyFromSubject(subject),
      confidence: 'high',
      source: 'keyword',
    };
  }
  const result = await classifyEmailWithAgent(subject, from, body);
  return result ? { ...result, source: 'sub-agent' } : null;
}

// Extract plain text from a Gmail message payload (handles nested multipart)
function extractEmailText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data)
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  if (payload.mimeType === 'text/html' && payload.body?.data)
    return Buffer.from(payload.body.data, 'base64').toString('utf-8')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  if (payload.parts) {
    // Prefer text/plain, fall back to html
    const plain = payload.parts.find(p => p.mimeType === 'text/plain');
    if (plain) return extractEmailText(plain);
    return payload.parts.map(extractEmailText).join(' ');
  }
  return '';
}

// Generate name variants for Gmail search: "Super Play" → ["Super Play", "SuperPlay"]
function companyNameVariants(name) {
  const variants = new Set([name]);
  const noSpace = name.replace(/\s+/g, '');
  if (noSpace !== name) variants.add(noSpace);
  return [...variants];
}

export async function detectEmailStatusWithAI(email) {
  if (!email) return null;
  const fast = detectEmailStatus(email);
  if (fast) return fast;
  return classifyEmailWithAI(email.subject, email.snippet);
}

// Searches specifically for interview invitation emails from a company
export async function getInterviewEmailForCompany(companyName) {
  try {
    const auth = await getAuthedClient();
    if (!auth) return null;
    const gmail = google.gmail({ version: 'v1', auth });

    // Exclude job alert emails only. Allow jobs-noreply (application status updates).
    // Require real scheduling language — excludes LinkedIn Easy Apply confirmations.
    const q = `"${companyName}" (interview OR "schedule a call" OR "schedule time" OR "phone screen" OR "video call" OR "zoom link" OR "google meet" OR "teams meeting" OR "book a time" OR "pick a time" OR "calendly" OR "when are you available") in:anywhere -from:jobalerts-noreply@linkedin.com -category:promotions -category:social -subject:"weekly job search digest"`;
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
// Validates the Gmail token with a cheap API call.
// Returns true if valid, false if token is expired/revoked.
export async function checkGmailHealth() {
  try {
    const auth = await getAuthedClient();
    if (!auth) return false;
    const gmail = google.gmail({ version: 'v1', auth });
    // 5-second timeout — never let a Gmail network call block the dashboard
    await Promise.race([
      gmail.users.getProfile({ userId: 'me' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);
    _tokenValid = true;
    return true;
  } catch (err) {
    if (err?.message?.includes('invalid_grant') || err?.status === 401 || err?.code === 401) {
      markTokenInvalid();
    }
    return false;
  }
}

// Scans Gmail for rejection emails, one search per applied company.
//
// Approach: search by company name variants (handles "Super Play" vs "SuperPlay"),
// fetch the full email body, send to Claude for classification. Claude understands
// rejection in any language and phrasing without needing specific keywords.
// This avoids false positives from marketing/junk emails unrelated to job applications.
export async function scanForRejections(companyNames) {
  if (!companyNames?.length) return [];
  try {
    const auth = await getAuthedClient();
    if (!auth) return [];
    const gmail = google.gmail({ version: 'v1', auth });

    const results = await Promise.all(companyNames.map(async (company) => {
      try {
        // Build name-variant query: "Super Play" OR "SuperPlay"
        const variants = companyNameVariants(company);
        const nameQ = variants.map(v => `"${v}"`).join(' OR ');
        // Search for recent emails mentioning this company — scoped, no junk
        const q = `(${nameQ}) -from:me -from:jobalerts-noreply@linkedin.com newer_than:120d`;
        const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 5 });
        if (!list.data.messages?.length) return null;

        for (const { id } of list.data.messages) {
          const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
          const headers = msg.data.payload?.headers || [];
          const get = (n) => headers.find(h => h.name === n)?.value || '';
          const subject = get('Subject');
          const from = get('From');
          const date = get('Date');
          const snippet = msg.data.snippet || '';

          // Extract full body — Claude reads the whole email, not just the snippet
          const body = extractEmailText(msg.data.payload);

          // Fast keyword check first (free); fall back to Claude for anything ambiguous
          const quick = detectEmailStatus({ subject, snippet: body.slice(0, 300) || snippet });
          const status = quick || await classifyEmailWithAI(subject, body || snippet, from);

          if (status === 'rejected') {
            return { company, subject, from, snippet, date, messageId: id };
          }
        }
        return null;
      } catch (err) {
        if (err?.message?.includes('invalid_grant') || err?.status === 401) markTokenInvalid();
        return null;
      }
    }));

    return results.filter(Boolean);
  } catch { return []; }
}

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
