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

    const q = `"${companyName}" in:anywhere -category:promotions -category:social`;
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
