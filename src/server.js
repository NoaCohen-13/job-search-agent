import express from 'express';
import multer from 'multer';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { marked } from 'marked';
import { Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle } from 'docx';
import { sendMessage, searchPositions, resetSession, listSessions, resumeSession, deleteSession, addMessage, initSession } from './agent.js';
import puppeteer from 'puppeteer-core';
import { getAuthUrl, handleCallback, isConnected, checkGmailHealth, getEmailSummaries, getInterviewEmailForCompany, detectEmailStatus, detectEmailStatusWithAI, scanForNewApplications, scanForRejections, classifyEmail } from './gmail.js';
import { startScheduler, triggerDiscover, triggerDigest } from './scheduler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.cwd();
const PORT = 3000;

const DATA_FILE = resolve(ROOT, 'data.json');
const EMPTY_DATA = {
  stats: { totalApplied: 0, responseRate: 0, activeInterviews: 0, streak: 0 },
  applications: [],
  companies: [],
  savedJobs: [],
  activity: [],
  weeklyActivity: { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0, Sun: 0 },
};

function ensureDirs() {
  const dirs = [
    'workspace/memory',
    'workspace/resume',
    'workspace/applications',
    'workspace/companies',
    'workspace/courses',
    'workspace/notes/weekly_reviews',
    'workspace/discover',
  ];
  for (const dir of dirs) {
    const full = resolve(ROOT, dir);
    if (!existsSync(full)) mkdirSync(full, { recursive: true });
  }

  // Create a resume placeholder if none exists so agent commands don't silently fail
  const resumePath = resolve(ROOT, 'workspace', 'resume', 'base_resume.md');
  if (!existsSync(resumePath)) {
    writeFileSync(resumePath, [
      '# Your Name',
      '',
      'your.email@example.com | Your City | linkedin.com/in/yourprofile',
      '',
      '---',
      '',
      '> **Replace this file with your actual resume** (plain text or Markdown).',
      '> The agent reads this file for tailoring and scoring — never edit it directly.',
      '',
      '## Summary',
      '',
      'Replace with your professional summary.',
      '',
      '## Experience',
      '',
      '**Company Name** — Role Title (Month Year – Month Year)',
      '- Achievement or responsibility',
      '',
      '## Education',
      '',
      '**University Name** — Degree, Field (Year)',
      '',
      '## Skills',
      '',
      'Skill 1, Skill 2, Skill 3',
    ].join('\n'));
  }
}

function readData() {
  if (existsSync(DATA_FILE)) {
    try {
      const data = JSON.parse(readFileSync(DATA_FILE, 'utf-8'));
      if (!data.savedJobs) data.savedJobs = [];
      return data;
    } catch {
      return { ...EMPTY_DATA };
    }
  }
  return { ...EMPTY_DATA };
}

const app = express();
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());
app.use(express.static(resolve(__dirname, '../public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.post('/api/upload-resume', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  const { originalname, buffer, mimetype } = req.file;
  const resumePath = resolve(ROOT, 'workspace', 'resume', 'base_resume.md');
  try {
    let text = '';
    if (mimetype === 'application/pdf') {
      // Save as-is and note it's a PDF (agent can read path)
      const pdfPath = resolve(ROOT, 'workspace', 'resume', originalname);
      writeFileSync(pdfPath, buffer);
      return res.json({ ok: true, message: `PDF saved to workspace/resume/${originalname}. Ask the agent to read and convert it.`, path: pdfPath });
    }
    text = buffer.toString('utf-8');
    writeFileSync(resumePath, text);
    res.json({ ok: true, message: `Resume saved as base_resume.md (${text.split('\n').length} lines)`, preview: text.slice(0, 300) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function computeStreak(activity) {
  const days = new Set(activity.filter(a => a.type === 'application').map(a => a.timestamp.slice(0, 10)));
  const today = new Date();
  let streak = 0;
  for (let i = 0; ; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    if (days.has(key)) {
      streak++;
    } else if (i === 0) {
      // today has no activity yet — start counting from yesterday
      continue;
    } else {
      break;
    }
  }
  return streak;
}

app.get('/api/data', async (req, res) => {
  const data = readData();
  data.stats.streak = computeStreak(data.activity);
  // Always compute live — never let stale stored values mislead the UI
  data.stats.activeInterviews = data.applications.filter(a => a.status === 'interview').length;
  for (const app of data.applications) {
    const scorePath = resolve(ROOT, 'workspace', 'applications', app.id, 'ats_score.json');
    if (existsSync(scorePath)) {
      try { app.atsScore = JSON.parse(readFileSync(scorePath, 'utf-8')); } catch {}
    }
  }
  // Validate the token on each request so the UI reflects the real state
  if (isConnected()) {
    const healthy = await checkGmailHealth();
    data.gmailConnected = healthy;
  } else {
    data.gmailConnected = false;
  }

  res.json(data);
});

// Slow endpoint — fetches Gmail email summaries per company and returns enriched apps.
// Called lazily by the frontend after the dashboard has already rendered.
app.get('/api/data/emails', async (req, res) => {
  if (!isConnected()) return res.json({ apps: [] });
  const data = readData();
  const active = data.applications.filter(a => ['applied','screening','interview','offer'].includes(a.status));
  const rejected = data.applications.filter(a => a.status === 'rejected');
  const forEmail = [...active, ...rejected];
  if (!forEmail.length) return res.json({ apps: [] });

  const emails = await getEmailSummaries(forEmail.map(a => a.company));
  const interviewEmails = await Promise.all(active.map(a => getInterviewEmailForCompany(a.company)));
  let dataChanged = false;

  for (let i = 0; i < forEmail.length; i++) {
    const app = forEmail[i];
    const email = emails[app.company];
    if (email) {
      app.lastEmail = email;
      app.lastEmail.detectedStatus = await detectEmailStatusWithAI(email);
    }
    const interviewEmail = active.includes(app) ? interviewEmails[active.indexOf(app)] : null;
    if (interviewEmail) {
      const iStatus = await detectEmailStatusWithAI(interviewEmail);
      if (iStatus === 'interview') app.interviewEmail = interviewEmail;
    }
    // No status auto-updates here — status changes are handled by scan-rejections only.
    // This endpoint is read-only to prevent partial data writes corrupting data.json.
  }
  res.json({ apps: forEmail });
});

app.post('/api/chat', async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const write = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  try {
    for await (const event of sendMessage(message)) {
      write(event);
      if (event.type === 'done') break;
    }
  } catch (err) {
    console.error('Agent error:', err);
    write({ type: 'error', content: err.message });
  }

  res.end();
});

// Direct status update — no agent needed for simple state changes
app.patch('/api/application', (req, res) => {
  const { id, status, nextAction, dueDate, salary } = req.body;
  const data = readData();
  const application = data.applications.find(a => a.id === id);
  if (!application) return res.status(404).json({ error: 'not found' });

  if (status) application.status = status;
  if (nextAction !== undefined) application.nextAction = nextAction;
  if (dueDate !== undefined) application.dueDate = dueDate;
  if (salary !== undefined) application.salary = salary;

  // Recompute stats
  data.stats.activeInterviews = data.applications.filter(a => a.status === 'interview').length;
  const replied = data.applications.filter(a => ['screening', 'interview', 'offer', 'rejected'].includes(a.status)).length;
  data.stats.responseRate = data.stats.totalApplied > 0 ? Math.round(replied / data.stats.totalApplied * 100) : 0;

  // Log activity
  data.activity.push({ text: `${application.company} status updated to ${status}`, type: 'follow-up', timestamp: new Date().toISOString() });
  if (data.activity.length > 20) data.activity.shift();

  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  res.json({ ok: true });
});

app.post('/api/reset', (req, res) => {
  resetSession();
  res.json({ ok: true });
});

app.get('/api/sessions', (req, res) => {
  res.json(listSessions());
});

app.post('/api/sessions/:id/resume', (req, res) => {
  const meta = resumeSession(req.params.id);
  if (!meta) return res.status(404).json({ error: 'not found' });
  res.json(meta);
});

app.delete('/api/sessions/:id', (req, res) => {
  deleteSession(req.params.id);
  res.json({ ok: true });
});

app.post('/api/session/message', (req, res) => {
  const { role, text } = req.body;
  if (!role || !text) return res.status(400).json({ error: 'role and text required' });
  initSession();
  addMessage(role, text);
  res.json({ ok: true });
});

app.delete('/api/application', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });
  const data = readData();
  const before = data.applications.length;
  data.applications = data.applications.filter(a => a.id !== id);
  if (data.applications.length === before) return res.status(404).json({ error: 'not found' });
  // totalApplied is a lifetime counter — never decremented on delete
  data.stats.activeInterviews = data.applications.filter(a => a.status === 'interview').length;
  const replied = data.applications.filter(a => ['screening','interview','offer','rejected'].includes(a.status)).length;
  data.stats.responseRate = data.stats.totalApplied > 0 ? Math.round(replied / data.stats.totalApplied * 100) : 0;
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  res.json({ ok: true });
});

app.delete('/api/activity', (req, res) => {
  const { timestamp } = req.query;
  if (!timestamp) return res.status(400).json({ error: 'timestamp required' });
  const data = readData();
  const before = data.activity.length;
  data.activity = data.activity.filter(a => a.timestamp !== timestamp);
  if (data.activity.length === before) return res.status(404).json({ error: 'not found' });
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  res.json({ ok: true });
});

app.delete('/api/company', (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });
  const data = readData();
  data.companies = data.companies.filter(c => c.name.toLowerCase() !== name.toLowerCase());
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  res.json({ ok: true });
});

function slugify(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

app.get('/api/company', (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });

  const data = readData();

  // Check if name is a savedJob id
  const savedJob = (data.savedJobs || []).find(j => j.id === name);
  if (savedJob) {
    const dir = resolve(ROOT, 'workspace', 'companies', savedJob.id);
    let atsScore = null;
    const scorePath = resolve(dir, 'ats_score.json');
    if (existsSync(scorePath)) {
      try { atsScore = JSON.parse(readFileSync(scorePath, 'utf-8')); } catch {}
    }
    const hasJd = existsSync(resolve(dir, 'job_description.md'));
    const hasTailored = existsSync(resolve(dir, 'tailored_resume.md'));
    const notesPath = resolve(dir, 'notes.md');
    const userNotes = existsSync(notesPath) ? readFileSync(notesPath, 'utf-8') : '';
    const company = data.companies.find(c => c.name.toLowerCase() === savedJob.company.toLowerCase()) || null;
    return res.json({ savedJob, company, application: null, research: null, interviewNotes: null, userNotes, atsScore, hasJd, hasTailored });
  }

  const company = data.companies.find(c => c.name.toLowerCase() === name.toLowerCase()) || null;
  const application = data.applications.find(a => a.company.toLowerCase() === name.toLowerCase()) || null;

  let research = null, interviewNotes = null, userNotes = '';

  if (application) {
    const dir = resolve(ROOT, 'workspace', 'applications', application.id);
    const rp = resolve(dir, 'research.md');
    const ip = resolve(dir, 'interview_notes.md');
    const np = resolve(dir, 'notes.md');
    if (existsSync(rp)) research = readFileSync(rp, 'utf-8');
    if (existsSync(ip)) interviewNotes = readFileSync(ip, 'utf-8');
    if (existsSync(np)) userNotes = readFileSync(np, 'utf-8');
  } else {
    const slug = slugify(name);
    const rp = resolve(ROOT, 'workspace', 'companies', `${slug}.md`);
    const np = resolve(ROOT, 'workspace', 'companies', `${slug}-notes.md`);
    if (existsSync(rp)) research = readFileSync(rp, 'utf-8');
    if (existsSync(np)) userNotes = readFileSync(np, 'utf-8');
  }

  let atsScore = null;
  let hasJd = false;
  let hasTailored = false;
  if (application) {
    const dir = resolve(ROOT, 'workspace', 'applications', application.id);
    const scorePath = resolve(dir, 'ats_score.json');
    if (existsSync(scorePath)) {
      try { atsScore = JSON.parse(readFileSync(scorePath, 'utf-8')); } catch {}
    }
    hasJd = existsSync(resolve(dir, 'job_description.md'));
    hasTailored = existsSync(resolve(dir, 'tailored_resume.md'));
  } else {
    const slug = slugify(name);
    let dir = resolve(ROOT, 'workspace', 'companies', slug);
    let savedJobFallback = null;

    // If no JD in the company folder, fall back to the most recent savedJob for this company
    if (!existsSync(resolve(dir, 'job_description.md'))) {
      const companySavedJobs = (data.savedJobs || [])
        .filter(j => j.company.toLowerCase() === name.toLowerCase())
        .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
      if (companySavedJobs.length > 0) {
        savedJobFallback = companySavedJobs[0];
        dir = resolve(ROOT, 'workspace', 'companies', savedJobFallback.id);
      }
    }

    const scorePath = resolve(dir, 'ats_score.json');
    if (existsSync(scorePath)) {
      try { atsScore = JSON.parse(readFileSync(scorePath, 'utf-8')); } catch {}
    }
    hasJd = existsSync(resolve(dir, 'job_description.md'));
    hasTailored = existsSync(resolve(dir, 'tailored_resume.md'));
    if (savedJobFallback) {
      return res.json({ savedJob: savedJobFallback, company, application: null, research, interviewNotes, userNotes, atsScore, hasJd, hasTailored });
    }
  }
  res.json({ company, application, research, interviewNotes, userNotes, atsScore, hasJd, hasTailored });
});

app.get('/api/company/positions', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const raw = await searchPositions(name);
    const lines = raw.split('\n').filter(l => l.startsWith('POSITION:'));
    if (lines.length === 0) return res.json({ positions: [] });
    const positions = lines.map(l => {
      const parts = l.replace('POSITION:', '').split('|').map(s => s.trim());
      return { title: parts[0] || '', url: parts[1] || '', fit: parts[2] || '' };
    }).filter(p => p.title);
    res.json({ positions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/company/contacts', (req, res) => {
  const { name, contacts } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const data = readData();
  let company = data.companies.find(c => c.name.toLowerCase() === name.toLowerCase());
  if (!company) {
    company = { name, status: 'researched', contacts: [] };
    data.companies.push(company);
  }
  company.contacts = contacts || [];
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  res.json({ ok: true });
});

app.get('/api/profile', (req, res) => {
  // config.json is the primary source of truth (used by the agent system prompt)
  const configPath = resolve(ROOT, 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (config.targetRole || config.location) {
        return res.json({ targetRole: config.targetRole || '', location: config.location || '' });
      }
    } catch {}
  }
  // Fall back to workspace/profile.json
  const profilePath = resolve(ROOT, 'workspace', 'profile.json');
  if (existsSync(profilePath)) {
    try { return res.json(JSON.parse(readFileSync(profilePath, 'utf-8'))); } catch {}
  }
  return res.status(404).json({ error: 'no profile' });
});

app.post('/api/profile', (req, res) => {
  const { targetRole, location } = req.body;
  if (!targetRole || !location) return res.status(400).json({ error: 'targetRole and location required' });

  // Write to workspace/profile.json (used by Discover /find defaults)
  const profilePath = resolve(ROOT, 'workspace', 'profile.json');
  writeFileSync(profilePath, JSON.stringify({ targetRole, location }, null, 2));

  // Merge into config.json so the agent system prompt stays in sync
  const configPath = resolve(ROOT, 'config.json');
  let config = {};
  if (existsSync(configPath)) {
    try { config = JSON.parse(readFileSync(configPath, 'utf-8')); } catch {}
  }
  config.targetRole = targetRole;
  config.location = location;
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  res.json({ ok: true });
});

app.get('/api/discover', (req, res) => {
  const discoverPath = resolve(ROOT, 'workspace', 'discover', 'latest.json');
  if (!existsSync(discoverPath)) return res.json(null);
  try {
    res.json(JSON.parse(readFileSync(discoverPath, 'utf-8')));
  } catch {
    res.json(null);
  }
});

app.post('/api/discover/save', (req, res) => {
  const { company, role, description, url, source, idx } = req.body;
  if (!company) return res.status(400).json({ error: 'company required' });

  const id = role
    ? `${slugify(company)}-${slugify(role)}`
    : slugify(company);
  const dir = resolve(ROOT, 'workspace', 'companies', id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const jdContent = [
    `# ${company} — ${role || 'Open Role'}`,
    `**Source:** ${source || 'Job board'}`,
    url ? `**URL:** ${url}` : '',
    '',
    description || '',
  ].filter(l => l !== null).join('\n');
  writeFileSync(resolve(dir, 'job_description.md'), jdContent);

  // Add to savedJobs (not companies)
  const data = readData();
  if (!data.savedJobs) data.savedJobs = [];
  const existingJob = data.savedJobs.find(j => j.id === id);
  if (!existingJob) {
    data.savedJobs.push({ id, company, role: role || '', source: source || '', url: url || '', savedAt: new Date().toISOString() });
    data.activity.push({ text: `Saved ${company}${role ? ' — ' + role : ''} from Discover`, type: 'research', timestamp: new Date().toISOString() });
    if (data.activity.length > 20) data.activity.shift();
    writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  }

  // Remove from discover results
  if (idx !== undefined) {
    const discoverPath = resolve(ROOT, 'workspace', 'discover', 'latest.json');
    if (existsSync(discoverPath)) {
      try {
        const discover = JSON.parse(readFileSync(discoverPath, 'utf-8'));
        discover.results = (discover.results || []).filter((_, i) => i !== parseInt(idx));
        writeFileSync(discoverPath, JSON.stringify(discover, null, 2));
      } catch {}
    }
  }

  res.json({ ok: true, id });
});

app.delete('/api/saved-job', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });
  const data = readData();
  if (!data.savedJobs) data.savedJobs = [];
  data.savedJobs = data.savedJobs.filter(j => j.id !== id);
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  res.json({ ok: true });
});

app.delete('/api/discover/result', (req, res) => {
  const idx = parseInt(req.query.idx);
  const discoverPath = resolve(ROOT, 'workspace', 'discover', 'latest.json');
  if (!existsSync(discoverPath)) return res.status(404).json({ error: 'not found' });
  try {
    const data = JSON.parse(readFileSync(discoverPath, 'utf-8'));
    data.results = (data.results || []).filter((_, i) => i !== idx);
    writeFileSync(discoverPath, JSON.stringify(data, null, 2));
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'failed' });
  }
});


app.post('/api/company/notes', (req, res) => {
  const { name, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const data = readData();

  // Check if name is a savedJob id
  const savedJob = (data.savedJobs || []).find(j => j.id === name);
  if (savedJob) {
    const dir = resolve(ROOT, 'workspace', 'companies', savedJob.id);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'notes.md'), notes || '');
    return res.json({ ok: true });
  }

  const application = data.applications.find(a => a.company.toLowerCase() === name.toLowerCase());

  let notesPath;
  if (application) {
    const dir = resolve(ROOT, 'workspace', 'applications', application.id);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    notesPath = resolve(dir, 'notes.md');
  } else {
    const dir = resolve(ROOT, 'workspace', 'companies');
    notesPath = resolve(dir, `${slugify(name)}-notes.md`);
  }

  writeFileSync(notesPath, notes || '');
  res.json({ ok: true });
});

// ── Resume export helpers ──────────────────────────────────────────────────

function parseInlineRuns(text, baseOpts = {}) {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/);
  return parts.filter(Boolean).map(part => {
    if (part.startsWith('**') && part.endsWith('**'))
      return new TextRun({ text: part.slice(2, -2), ...baseOpts, bold: true });
    if (part.startsWith('*') && part.endsWith('*'))
      return new TextRun({ text: part.slice(1, -1), ...baseOpts, italics: true });
    return new TextRun({ text: part, ...baseOpts });
  });
}

function markdownToDocx(markdown) {
  const base = { font: 'Calibri', size: 20 };
  const children = [];

  for (const line of markdown.split('\n')) {
    const t = line.trim();

    if (t.startsWith('# ')) {
      children.push(new Paragraph({
        children: [new TextRun({ text: t.slice(2), bold: true, size: 40, font: 'Calibri' })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 80 },
      }));
    } else if (t.startsWith('## ')) {
      children.push(new Paragraph({
        children: [new TextRun({ text: t.slice(3), bold: true, size: 22, font: 'Calibri', allCaps: true })],
        spacing: { before: 240, after: 80 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '888888' } },
      }));
    } else if (t.startsWith('### ')) {
      children.push(new Paragraph({
        children: parseInlineRuns(t.slice(4), { ...base, bold: true }),
        spacing: { before: 120, after: 40 },
      }));
    } else if (t.startsWith('- ') || t.startsWith('* ')) {
      children.push(new Paragraph({
        children: [new TextRun({ text: '•  ', ...base }), ...parseInlineRuns(t.slice(2), base)],
        indent: { left: 360 },
        spacing: { after: 40 },
      }));
    } else if (t.startsWith('> ')) {
      children.push(new Paragraph({
        children: parseInlineRuns(t.slice(2), { ...base, italics: true, color: '888888' }),
        spacing: { after: 60 },
      }));
    } else if (t === '---') {
      children.push(new Paragraph({ spacing: { before: 120, after: 120 } }));
    } else if (t === '') {
      children.push(new Paragraph({ spacing: { after: 60 } }));
    } else {
      children.push(new Paragraph({
        children: parseInlineRuns(t, base),
        spacing: { after: 60 },
      }));
    }
  }

  return new Document({ sections: [{ children }] });
}

function resumePrintHtml(markdown) {
  const body = marked.parse(markdown);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Resume</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Georgia, 'Times New Roman', serif; font-size: 11pt; color: #111;
         max-width: 780px; margin: 0 auto; padding: 36px 48px; line-height: 1.5; }
  h1 { font-size: 22pt; text-align: center; margin-bottom: 4px; }
  h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: 0.08em;
       border-bottom: 1px solid #888; padding-bottom: 3px; margin-top: 18px; margin-bottom: 6px; }
  h3 { font-size: 11pt; margin-top: 10px; margin-bottom: 2px; }
  p  { margin-bottom: 4px; }
  ul { padding-left: 18px; margin-bottom: 4px; }
  li { margin-bottom: 2px; }
  hr { border: none; border-top: 1px solid #ccc; margin: 12px 0; }
  blockquote { color: #666; font-style: italic; padding-left: 12px; }
  @media print {
    body { padding: 0; }
    @page { margin: 0.6in 0.7in; size: A4; }
  }
</style>
</head>
<body>
${body}
<script>window.addEventListener('load', () => window.print());<\/script>
</body>
</html>`;
}

function findResumeFile(data, key) {
  // savedJob id?
  const savedJob = (data.savedJobs || []).find(j => j.id === key);
  if (savedJob) {
    const dir = resolve(ROOT, 'workspace', 'companies', savedJob.id);
    const tailored = resolve(dir, 'tailored_resume.md');
    return {
      path: existsSync(tailored) ? tailored : resolve(ROOT, 'workspace', 'resume', 'base_resume.md'),
      isTailored: existsSync(tailored),
      label: `${savedJob.company}_${savedJob.role}`.replace(/[^\w-]/g, '_').replace(/_+/g, '_'),
    };
  }
  // application?
  const app = data.applications.find(a => a.id === key || a.company.toLowerCase() === key.toLowerCase());
  if (app) {
    const dir = resolve(ROOT, 'workspace', 'applications', app.id);
    const tailored = resolve(dir, 'tailored_resume.md');
    return {
      path: existsSync(tailored) ? tailored : resolve(ROOT, 'workspace', 'resume', 'base_resume.md'),
      isTailored: existsSync(tailored),
      label: `${app.company}_${app.role}`.replace(/[^\w-]/g, '_'),
    };
  }
  // companies folder?
  const dir = resolve(ROOT, 'workspace', 'companies', slugify(key));
  const tailored = resolve(dir, 'tailored_resume.md');
  return {
    path: existsSync(tailored) ? tailored : resolve(ROOT, 'workspace', 'resume', 'base_resume.md'),
    isTailored: existsSync(tailored),
    label: key.replace(/[^\w-]/g, '_'),
  };
}

app.get('/api/resume/export', async (req, res) => {
  const { company, format } = req.query;
  if (!company || !format) return res.status(400).json({ error: 'company and format required' });

  const data = readData();
  const { path: resumePath, isTailored, label } = findResumeFile(data, company);

  if (!existsSync(resumePath)) {
    return res.status(404).json({ error: 'No resume file found. Add workspace/resume/base_resume.md to get started.' });
  }

  const markdown = readFileSync(resumePath, 'utf-8');

  if (format === 'pdf') {
    try {
      const browser = await puppeteer.launch({
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      const page = await browser.newPage();
      await page.setContent(resumePrintHtml(markdown), { waitUntil: 'networkidle0' });
      const pdf = Buffer.from(await page.pdf({ format: 'A4', margin: { top: '0.6in', right: '0.7in', bottom: '0.6in', left: '0.7in' } }));
      await browser.close();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${label}_Resume.pdf"`);
      return res.end(pdf);
    } catch (err) {
      return res.status(500).json({ error: `PDF generation failed: ${err.message}` });
    }
  }

  if (format === 'docx') {
    try {
      const doc = markdownToDocx(markdown);
      const buffer = await Packer.toBuffer(doc);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${label}_Resume.docx"`);
      return res.send(buffer);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.status(400).json({ error: 'format must be pdf or docx' });
});

// ── End resume export ──────────────────────────────────────────────────────

// ── Gmail OAuth ────────────────────────────────────────────────────────────
const GMAIL_REDIRECT = `http://localhost:${PORT}/api/auth/gmail/callback`;

app.get('/api/auth/gmail', (req, res) => {
  const url = getAuthUrl(GMAIL_REDIRECT);
  if (!url) return res.status(400).json({ error: 'Add gmailClientId and gmailClientSecret to config.json first.' });
  res.redirect(url);
});

app.get('/api/auth/gmail/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');
  try {
    await handleCallback(code, GMAIL_REDIRECT);
    res.redirect('/?gmail=connected');
  } catch (err) {
    res.status(500).send(`Error: ${err.message}`);
  }
});

app.get('/api/gmail/status', (req, res) => {
  res.json({ connected: isConnected() });
});

// Scan inbox for application confirmation emails from companies not yet in tracker
app.get('/api/gmail/new-applications', async (req, res) => {
  if (!isConnected()) return res.json({ results: [] });
  try {
    const data = readData();
    // Normalize: strip all non-alphanumeric so "Moon Active" == "moonactive"
    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const tracked = new Set([
      ...data.applications.map(a => norm(a.company)),
      ...(data.companies || []).map(c => norm(c.name)),
      ...(data.savedJobs || []).map(j => norm(j.company)),
    ]);
    const raw = await scanForNewApplications();
    const seen = new Set();
    const untracked = raw.filter(r => {
      const key = norm(r.company);
      if (tracked.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // For each untracked application, check if there's already a more recent status email
    const results = await Promise.all(untracked.map(async (r) => {
      const latest = await getLastEmailForCompany(r.company);
      const detectedStatus = await detectEmailStatusWithAI(latest);
      return { ...r, detectedStatus: detectedStatus || null, latestEmail: latest || null };
    }));
    res.json({ results });
  } catch {
    res.json({ results: [] });
  }
});

// Confirm and add a Gmail-detected application to the tracker
app.post('/api/gmail/add-application', (req, res) => {
  const { company, role, dateApplied, status } = req.body;
  if (!company) return res.status(400).json({ error: 'company required' });
  const data = readData();
  const id = slugify(company) + '-' + Date.now();
  const resolvedStatus = ['rejected', 'interview', 'screening', 'offer', 'applied'].includes(status) ? status : 'applied';
  const newApp = {
    id,
    company,
    role: role || '',
    status: resolvedStatus,
    dateApplied: dateApplied ? dateApplied.slice(0, 10) : new Date().toISOString().slice(0, 10),
    nextAction: '',
    source: 'gmail',
  };
  data.applications.push(newApp);
  data.stats.totalApplied = (data.stats.totalApplied || 0) + 1;
  data.stats.responseRate = data.stats.totalApplied > 0
    ? Math.round(data.applications.filter(a => ['screening','interview','offer','rejected'].includes(a.status)).length / data.stats.totalApplied * 100)
    : 0;
  data.activity.push({
    text: `Applied to ${role ? role + ' at ' : ''}${company}`,
    type: 'application',
    timestamp: dateApplied || new Date().toISOString(),
  });
  if (data.activity.length > 20) data.activity.shift();
  const dir = resolve(ROOT, 'workspace', 'applications', id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  res.json({ ok: true, id });
});

// Scan Gmail for rejection emails and auto-update application statuses.
// Covers applied, screening, AND interview — a rejection supersedes any stage.
app.get('/api/gmail/scan-rejections', async (req, res) => {
  if (!isConnected()) return res.json({ updated: [] });
  const data = readData();
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');

  const activeApps = data.applications.filter(a =>
    ['applied', 'screening', 'interview'].includes(a.status)
  );
  if (!activeApps.length) return res.json({ updated: [] });

  const companyNames = activeApps.map(a => a.company);
  const rejections = await scanForRejections(companyNames);

  const updated = [];
  for (const r of rejections) {
    // Fuzzy match: "Moon Active" === "moonactive" etc.
    const app = activeApps.find(a => norm(a.company) === norm(r.company));
    if (!app || app.status === 'rejected') continue;

    const prevStatus = app.status;
    app.status = 'rejected';
    app.nextAction = '';
    data.activity.unshift({
      text: `Rejected by ${r.company}`,
      type: 'rejection',
      subtext: r.subject,
      messageId: r.messageId,
      company: r.company,
      // Use the email's sent date, not the scan time
      timestamp: r.date ? new Date(r.date).toISOString() : new Date().toISOString(),
    });
    updated.push({ company: r.company, subject: r.subject, prevStatus });
  }

  if (updated.length) {
    data.activity = data.activity.slice(0, 20);
    // Recompute stats — never touch totalApplied (it's a historical counter)
    data.stats.activeInterviews = data.applications.filter(a => a.status === 'interview').length;
    const total = data.stats.totalApplied || data.applications.length;
    data.stats.responseRate = total > 0
      ? Math.round(data.applications.filter(a => ['screening','interview','offer','rejected'].includes(a.status)).length / total * 100)
      : 0;
    writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  }

  res.json({ updated });
});

// Debug: show raw Gmail rejection scan results without writing anything
app.get('/api/gmail/scan-rejections/debug', async (req, res) => {
  if (!isConnected()) return res.json({ error: 'Gmail not connected' });
  const data = readData();
  const activeApps = data.applications.filter(a =>
    ['applied', 'screening', 'interview'].includes(a.status)
  );
  const companyNames = activeApps.map(a => a.company);
  const rejections = await scanForRejections(companyNames);
  res.json({ searched: companyNames, found: rejections });
});

// Test endpoint — paste any email and see how the classifier responds
app.post('/api/classify-email', async (req, res) => {
  const { subject, from, body } = req.body;
  if (!subject && !body) return res.status(400).json({ error: 'provide at least subject or body' });
  const result = await classifyEmail({ subject, from, body });
  res.json(result || { error: 'classifier returned null' });
});

app.get('/api/gmail/threads', async (req, res) => {
  const { companies } = req.query;
  if (!companies) return res.status(400).json({ error: 'companies required' });
  const names = companies.split(',').map(s => s.trim()).filter(Boolean);
  const summaries = await getEmailSummaries(names);
  res.json(summaries);
});

// ── Scheduler triggers (manual) ────────────────────────────────────────────
app.post('/api/scheduler/discover', async (req, res) => {
  res.json({ ok: true, message: 'Discover running in background' });
  triggerDiscover(sendMessage).catch(err => console.error('[discover]', err.message));
});

app.post('/api/scheduler/digest', async (req, res) => {
  res.json({ ok: true, message: 'Digest sending in background' });
  triggerDigest(sendMessage).catch(err => console.error('[digest]', err.message));
});

// ── Start ───────────────────────────────────────────────────────────────────
ensureDirs();
startScheduler(sendMessage);

app.listen(PORT, () => {
  console.log(`\nJobAgent running → http://localhost:${PORT}\n`);
});
