import express from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { sendMessage, resetSession, listSessions, resumeSession, deleteSession } from './agent.js';

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
app.use(express.json());
app.use(express.static(resolve(__dirname, '../public')));

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

app.get('/api/data', (req, res) => {
  const data = readData();
  data.stats.streak = computeStreak(data.activity);
  for (const app of data.applications) {
    const scorePath = resolve(ROOT, 'workspace', 'applications', app.id, 'ats_score.json');
    if (existsSync(scorePath)) {
      try { app.atsScore = JSON.parse(readFileSync(scorePath, 'utf-8')); } catch {}
    }
  }
  res.json(data);
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

app.delete('/api/application', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });
  const data = readData();
  const before = data.applications.length;
  data.applications = data.applications.filter(a => a.id !== id);
  if (data.applications.length === before) return res.status(404).json({ error: 'not found' });
  data.stats.totalApplied = data.applications.length;
  data.stats.activeInterviews = data.applications.filter(a => a.status === 'interview').length;
  const replied = data.applications.filter(a => ['screening','interview','offer','rejected'].includes(a.status)).length;
  data.stats.responseRate = data.stats.totalApplied > 0 ? Math.round(replied / data.stats.totalApplied * 100) : 0;
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
    const dir = resolve(ROOT, 'workspace', 'companies', slug);
    const scorePath = resolve(dir, 'ats_score.json');
    if (existsSync(scorePath)) {
      try { atsScore = JSON.parse(readFileSync(scorePath, 'utf-8')); } catch {}
    }
    hasJd = existsSync(resolve(dir, 'job_description.md'));
    hasTailored = existsSync(resolve(dir, 'tailored_resume.md'));
  }
  res.json({ company, application, research, interviewNotes, userNotes, atsScore, hasJd, hasTailored });
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
  const profilePath = resolve(ROOT, 'workspace', 'profile.json');
  if (!existsSync(profilePath)) return res.status(404).json({ error: 'no profile' });
  try {
    res.json(JSON.parse(readFileSync(profilePath, 'utf-8')));
  } catch {
    res.status(500).json({ error: 'parse error' });
  }
});

app.post('/api/profile', (req, res) => {
  const { targetRole, location } = req.body;
  if (!targetRole || !location) return res.status(400).json({ error: 'targetRole and location required' });
  const profilePath = resolve(ROOT, 'workspace', 'profile.json');
  writeFileSync(profilePath, JSON.stringify({ targetRole, location }, null, 2));
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

ensureDirs();

app.listen(PORT, () => {
  console.log(`\nJobAgent running → http://localhost:${PORT}\n`);
});
