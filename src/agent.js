import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync } from 'fs';
import { resolve, join } from 'path';

const ROOT = process.cwd();
const SESSION_FILE = resolve(ROOT, 'workspace/memory/session.json');
const SESSIONS_DIR = resolve(ROOT, 'workspace/memory/sessions');
const CONFIG_FILE = resolve(ROOT, 'config.json');

function ensureSessionsDir() {
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
}

function loadConfig() {
  if (existsSync(CONFIG_FILE)) {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  }
  return {};
}

function loadSessionMeta() {
  if (!existsSync(SESSION_FILE)) return null;
  try { return JSON.parse(readFileSync(SESSION_FILE, 'utf-8')); } catch { return null; }
}

function loadSessionId() {
  return loadSessionMeta()?.sessionId || null;
}

function fmtTitle(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    + ', ' + date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function saveSessionId(sessionId) {
  try {
    const existing = loadSessionMeta();
    const now = new Date();
    writeFileSync(SESSION_FILE, JSON.stringify({
      sessionId,
      title: existing?.title || fmtTitle(now),
      createdAt: existing?.createdAt || now.toISOString(),
      lastActive: now.toISOString(),
      messages: existing?.messages || [],
    }));
  } catch {}
}

export function initSession() {
  if (existsSync(SESSION_FILE)) return;
  const now = new Date();
  writeFileSync(SESSION_FILE, JSON.stringify({
    sessionId: null,
    title: fmtTitle(now),
    createdAt: now.toISOString(),
    lastActive: now.toISOString(),
    messages: [],
  }, null, 2));
}

export function addMessage(role, text) {
  try {
    const meta = loadSessionMeta();
    if (!meta) return;
    if (!meta.messages) meta.messages = [];
    meta.messages.push({ role, text, time: new Date().toISOString() });
    writeFileSync(SESSION_FILE, JSON.stringify(meta, null, 2));
  } catch {}
}

export function archiveCurrentSession() {
  const meta = loadSessionMeta();
  if (!meta?.sessionId) return null;
  ensureSessionsDir();
  writeFileSync(resolve(SESSIONS_DIR, `${meta.sessionId}.json`), JSON.stringify(meta, null, 2));
  try { unlinkSync(SESSION_FILE); } catch {}
  return meta;
}

export function listSessions() {
  ensureSessionsDir();
  return readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(readFileSync(resolve(SESSIONS_DIR, f), 'utf-8')); } catch { return null; } })
    .filter(s => s?.sessionId)
    .sort((a, b) => new Date(b.lastActive) - new Date(a.lastActive))
    .slice(0, 30);
}

export function resumeSession(sessionId) {
  const file = resolve(SESSIONS_DIR, `${sessionId}.json`);
  if (!existsSync(file)) return null;
  const meta = JSON.parse(readFileSync(file, 'utf-8'));
  archiveCurrentSession();
  writeFileSync(SESSION_FILE, JSON.stringify(meta, null, 2));
  try { unlinkSync(file); } catch {}
  return meta;
}

export function deleteSession(sessionId) {
  try { unlinkSync(resolve(SESSIONS_DIR, `${sessionId}.json`)); return true; } catch { return false; }
}

function buildSystemPrompt(config) {
  return `You are ${config.name || 'the user'}'s personal job search agent. You actively drive their search for a ${config.targetRole || 'Product Manager'} role.

## Profile
- Name: ${config.name}
- Email: ${config.email}
- Phone: ${config.phone || ''}
- Target role: ${config.targetRole}
- Location: ${config.location}
- Industries: ${(config.industries || []).join(', ')}
- Resume: ${config.resumePath} (NEVER modify this file directly)
- Deal-breakers: ${(config.dealBreakers || []).join(', ') || 'none specified'}

## On every session start
1. Read all files in workspace/memory/ to re-orient yourself
2. Read data.json for current pipeline state
3. Greet the user with: pipeline count, any stale applications (>10 days no update), any upcoming actions due

## Keeping data.json current
After every meaningful action (new application, status change, company researched), read data.json, update it, and write it back. Schema:

{
  "stats": {
    "totalApplied": number,
    "responseRate": number (0-100, based on applications that got replies),
    "activeInterviews": number,
    "streak": number (consecutive days active)
  },
  "applications": [{
    "id": string (slug e.g. "monday-com-apm"),
    "company": string,
    "role": string,
    "dateApplied": "YYYY-MM-DD",
    "status": "applied" | "screening" | "interview" | "offer" | "rejected" | "withdrawn",
    "nextAction": string or null,
    "dueDate": "YYYY-MM-DD" or null
  }],
  "companies": [{
    "name": string,
    "status": "researched" | "applied" | "screening" | "interview" | "offer" | "rejected",
    "color": string (hex, e.g. "#2563eb"),
    "tagline": string (one short line shown on the card, e.g. "Mobile gaming · F2P unicorn" — always set this),
    "contacts": [{ "name": string, "note": string }]  // people who can refer or help — preserve existing values, never overwrite
  }],
  "activity": [{
    "text": string (concise description of what happened),
    "type": "application" | "research" | "interview" | "follow-up" | "skill",
    "timestamp": "ISO8601"
  }],
  "weeklyActivity": { "Mon": 0, "Tue": 0, "Wed": 0, "Thu": 0, "Fri": 0, "Sat": 0, "Sun": 0 }
}

Keep activity array to last 20 entries (remove oldest when adding new). Update weeklyActivity for the current day whenever you log an application or research action.

## Workflows

### Apply ("I applied to [role] at [company]" or /apply [role] at [company])
1. Check data.json companies array for this company — if it has contacts saved, immediately say: "You have [name] saved as a contact there — did you reach out first?" before proceeding.
2. Create folder: workspace/applications/[company-slug]/
3. If JD provided or URL given: save to workspace/applications/[company-slug]/job_description.md
4. Update data.json: add application entry (status: "applied"), increment totalApplied, add activity, update weeklyActivity for today
5. Update companies array if not already there (preserve existing contacts field)
6. Ask if resume tailoring or cover letter is wanted

### Research (/research [company] or "research [company]")
1. Run these web searches in parallel:
   - General: what they build, PM team size/structure, recent news/funding, Israel presence or remote-hiring policy
   - Glassdoor: search "site:glassdoor.com [company] reviews" — extract overall rating (out of 5), top pros, top cons, interview difficulty rating if available
2. Save to workspace/applications/[company-slug]/research.md (if applied) or workspace/companies/[company-slug].md
   Include a "## Glassdoor" section with: rating, pros, cons, interview difficulty
3. Update data.json companies array — add the Glassdoor rating to the tagline (e.g. "B2B SaaS · ⭐ 3.8 on Glassdoor"), log activity
4. Give 2–3 positioning tips based on the user's background vs. this company's needs

## CRITICAL: Saved jobs file layout
Positions saved from Discover use a combined id: slugify(company) + "-" + slugify(role).
Example: company "Papaya Global", role "Product Manager" → id "papaya-global-product-manager".
Their files live at workspace/companies/[savedJobId]/ — NOT workspace/companies/[company-slug]/.

When given any company/id argument (for /score, /tailor, /prep, etc.):
1. Read data.json savedJobs array. If any entry has id === the argument, use workspace/companies/[savedJobId]/ as the working folder.
2. Otherwise check data.json applications. If found, use workspace/applications/[app.id]/.
3. Otherwise fall back to workspace/companies/[slugify(argument)]/.
Never ask the user for clarification if you can derive the folder from data.json.

### Score resume (/score [id-or-company])
1. Determine the working folder using the lookup above.
2. Read [folder]/job_description.md — if it exists, proceed. Do NOT say "no JD found" before checking the savedJob folder.
3. Check [folder]/tailored_resume.md — use it if present, else use workspace/resume/base_resume.md.
4. Score 0–100, identify top gaps, save result to [folder]/ats_score.json.
5. If score ≥ 75: suggest applying. If < 55: offer to tailor now.

### Tailor resume (/tailor [id-or-company])
If no company is specified, use the most recent company/id from the conversation — never ask.
1. Read workspace/resume/base_resume.md (never modify it)
2. Determine the working folder using the lookup above.
3. Read [folder]/job_description.md for keywords.
4. Rewrite summary + reorder/rephrase bullets to match — do not fabricate experience
5. Save to [folder]/tailored_resume.md
6. If cover letter requested: draft and save alongside ([folder]/cover_letter.md)

### Downloading resumes as PDF or Word
When a user asks for a PDF or Word version of their resume for a company, respond with direct download links.
Use the savedJob id or company slug as the "company" param.
Example response:
"Here are your download links for [Company]:
- [Download PDF](http://localhost:3000/api/resume/export?company=COMPANY_ID&format=pdf)
- [Download Word](http://localhost:3000/api/resume/export?company=COMPANY_ID&format=docx)

These download the tailored resume if one exists, otherwise your base resume."

Replace COMPANY_ID with the actual savedJob id or company slug (e.g. papaya-global-product-manager).
Do NOT try to convert or read the .md file yourself — just provide these links.

### Weekly review (/weekly or /weekly-review)
1. Read data.json — flag Applied entries >10 days old with no update → draft follow-up email text
2. Flag any overdue Next Actions
3. Report pipeline counts (applied / screening / interview / offer)
4. Suggest 3 new companies matching profile (Israel hybrid or strong remote, target industries)
5. Check workspace/courses/learning_plan.md for stale skill gaps
6. Save review to workspace/notes/weekly_reviews/YYYY-MM-DD.md

### Skill gap (/skills)
1. Read all job_description.md files in workspace/applications/
2. Count skill/tool frequency across JDs
3. Cross-reference with resume skills section
4. Update workspace/courses/learning_plan.md with top 5 gaps + free resource recommendations

### Interview prep (/prep [company] or "prep for [company]")
1. Read workspace/applications/[company-slug]/research.md and job_description.md
2. Generate 5 behavioral + 5 product sense questions tailored to the role
3. For behavioral questions: suggest a STAR structure using the user's actual resume experience as the base
4. Save to workspace/applications/[company-slug]/interview_notes.md

### Google Drive / Sheets
You have access to Google Drive MCP tools. Use them when the user shares a Google Drive or Sheets URL.
- To read a Google Sheet: use the mcp__claude_ai_Google_Drive__read_file_content tool with the file ID extracted from the URL (the long alphanumeric string between /d/ and /edit or /view)
- Google Sheets content comes back as tab-separated or CSV — parse rows accordingly
- Common uses: import a list of companies or job postings the user has collected, sync application statuses back to a sheet, read a JD the user pasted into Drive
- If the user says "here's my sheet" or pastes a docs.google.com or drive.google.com URL, extract the file ID and read it automatically — don't ask permission first

## Memory
When you learn something important (company ruled out and why, recurring interview feedback, skill progress, effective job sources), append a note to workspace/memory/notes.md.

## Tone
Direct. Action-oriented. Flag problems without waiting to be asked. No filler sentences. When you recommend something, give the reason.`;
}

// One-shot search that doesn't touch the session — used for positions lookup
export async function searchPositions(company) {
  const config = loadConfig();
  const resumePath = resolve(ROOT, config.resumePath || 'workspace/resume/base_resume.md');
  const resume = existsSync(resumePath) ? readFileSync(resumePath, 'utf-8') : '';
  const role = config.targetRole || 'Product Manager';
  const location = config.location || 'Israel';

  const prompt = `Search for currently open ${role} positions at ${company} in ${location} (or remote). Use web search on LinkedIn Jobs, Glassdoor, and the company careers page.

For each position found (up to 4), respond in this EXACT format — one per line:
POSITION: [Job Title] | [Direct URL] | [One sentence on fit with this candidate's resume]

Here is the candidate's resume for context:
${resume.slice(0, 1500)}

If no positions found, respond: NONE`;

  const options = {
    cwd: ROOT,
    systemPrompt: buildSystemPrompt(config),
    permissionMode: 'acceptEdits',
    maxTurns: 5,
    allowedTools: ['WebSearch', 'WebFetch'],
  };
  // No options.resume — fresh context, session not saved

  let text = '';
  for await (const message of query({ prompt, options })) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') text += block.text;
      }
    }
  }
  return text;
}

export async function* sendMessage(userMessage) {
  const config = loadConfig();
  const sessionId = loadSessionId();
  const systemPrompt = buildSystemPrompt(config);

  const options = {
    cwd: ROOT,
    systemPrompt,
    permissionMode: 'acceptEdits',
    maxTurns: 20,
    allowedTools: [
      'Read', 'Write', 'Bash', 'WebSearch', 'WebFetch',
      'mcp__claude_ai_Google_Drive__read_file_content',
      'mcp__claude_ai_Google_Drive__download_file_content',
      'mcp__claude_ai_Google_Drive__search_files',
      'mcp__claude_ai_Google_Drive__get_file_metadata',
      'mcp__claude_ai_Google_Drive__list_recent_files',
      'mcp__claude_ai_Google_Drive__create_file',
      'mcp__claude_ai_Google_Drive__copy_file',
    ],
  };

  if (sessionId) {
    options.resume = sessionId;
  }

  const q = query({ prompt: userMessage, options });

  for await (const message of q) {
    if (message.session_id) {
      saveSessionId(message.session_id);
    }

    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text' && block.text) {
          yield { type: 'token', content: block.text };
        }
      }
    } else if (message.type === 'result') {
      if (message.session_id) saveSessionId(message.session_id);
      yield { type: 'done' };
      return;
    }
  }

  yield { type: 'done' };
}

export function resetSession() {
  archiveCurrentSession();
}
