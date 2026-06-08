# JobAgent

A personal AI job search agent with a web dashboard, built on the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). Chat naturally with your agent to track applications, research companies, tailor your resume, and run mock interviews — all from a single local UI.

**Uses your Claude subscription — no separate API key needed.**

![JobAgent dashboard](https://github.com/user-attachments/assets/placeholder)
> *Replace this line with a real screenshot once you've set it up*

---

## What it does

- **Conversational agent** — talk naturally ("I applied to APM at Monday.com") or use slash commands
- **Live dashboard** — pipeline view, weekly activity chart, company cards, recent actions
- **Company detail panel** — research notes, mock interview, personal notes, saved contacts per company
- **Mock interviews** — interactive Q&A tailored to the role and your resume, with per-answer feedback
- **Contact tracking** — save referral contacts per company, shown on applications and company cards
- **Chat history** — archive and resume past conversations
- **Google Drive integration** — read sheets, sync application data
- **Persistent memory** — agent re-orients itself on every session start
- **All data stays local** — resume, applications, and notes never leave your machine

---

## Quick start

**Requirements:** [Claude Code](https://claude.ai/code) installed and authenticated.

```bash
# 1. Clone
git clone https://github.com/YOUR_USERNAME/job-agent
cd job-agent

# 2. Install
npm install

# 3. Configure your profile
cp config.example.json config.json
# Edit config.json — add your name, email, target role, location, industries

# 4. Add your resume
mkdir -p workspace/resume
# Save your resume as workspace/resume/base_resume.md (markdown or plain text)

# 5. Run
npm start
# Open http://localhost:3000
```

---

## Slash commands

| Command | What it does |
|---------|-------------|
| `/apply [role] at [company]` | Log an application, scaffold the workspace folder |
| `/research [company]` | Web research → structured notes saved to workspace |
| `/tailor [company]` | Rewrites your resume for a specific JD |
| `/prep [company]` | Generates tailored interview questions + STAR structures |
| `/weekly` | Pipeline review, stale app flags, 3 new targets to consider |
| `/skills` | Scans all JDs for recurring skill gaps, updates learning plan |

Or just talk: *"I applied to APM at Monday.com"*, *"Research Fiverr for me"*, *"What should I follow up on?"*

---

## Workspace structure

All your personal data lives in `workspace/` (gitignored):

```
workspace/
├── resume/
│   └── base_resume.md        ← master resume — agent never modifies this
├── applications/
│   └── [company]/
│       ├── job_description.md
│       ├── tailored_resume.md
│       ├── cover_letter.md
│       ├── research.md
│       └── interview_notes.md
├── companies/                 ← research for companies you haven't applied to yet
├── courses/
│   └── learning_plan.md       ← auto-updated skill gap tracker
├── notes/
│   └── weekly_reviews/
└── memory/                    ← agent's persistent memory across sessions
```

---

## Stack

- [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) — agentic runtime (wraps Claude Code)
- [Express](https://expressjs.com/) + SSE — server + streaming
- Vanilla JS + [Chart.js](https://www.chartjs.org/) — frontend, no build step

---

## License

MIT
