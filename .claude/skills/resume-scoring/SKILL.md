---
name: resume-scoring
description: Scores the user's resume fit against a job description (0–100) with keyword gap analysis. Works before or after applying. Invoked by /score [company]. Returns a score, verdict, gaps with severity, and a delta if re-scoring.
---

# Resume Scoring Skill

Score resume fit against a JD and surface the most important gaps. Works both before applying (to decide whether to tailor first) and after (to track improvement).

## Step 1 — Locate the working folder

Check in this exact order:

1. Read `data.json` → check `savedJobs` array for an entry where `id === argument`. If found: working folder = `workspace/companies/[savedJob.id]/`. Use the savedJob id as-is — do not slugify.
2. Check `data.json` → `applications` for a matching company. If found: working folder = `workspace/applications/[app.id]/`.
3. Otherwise: working folder = `workspace/companies/[slugify(argument)]/`.

## Step 2 — Find the job description

- Look for `job_description.md` in the working folder.
- If missing, ask the user to paste the JD. Save it to `[working-folder]/job_description.md` before continuing.

## Step 3 — Find the resume

- Check `[working-folder]/tailored_resume.md` — use it if it exists (`resumeUsed: "tailored"`).
- Otherwise use `workspace/resume/base_resume.md` (`resumeUsed: "base"`).

## Step 4 — Score

- Extract the top skills, tools, and keywords the JD emphasizes (by frequency and prominence in requirements/responsibilities).
- Cross-reference with the resume: identify which keywords are present, weak, or absent.
- Compute a match score (0–100 integer).
- Identify 3–5 missing or underemphasized keywords with JD frequency and severity:
  - `"mid"` = present in resume but weak / not prominent
  - `"lo"` = absent from resume entirely
- Write one short, actionable recommendation.

## Step 5 — Check for previous score

- Read `[working-folder]/ats_score.json` if it exists.
- Note the previous score so you can show the delta in the reply.

## Step 6 — Save

```json
{
  "score": 84,
  "verdict": "Strong match",
  "recommendation": "Add 'A/B testing' and 'SQL' to your resume summary.",
  "gaps": [
    { "keyword": "A/B testing", "count": 3, "severity": "mid" },
    { "keyword": "SQL", "count": 2, "severity": "mid" },
    { "keyword": "LTV modeling", "count": 0, "severity": "lo" }
  ],
  "resumeUsed": "tailored",
  "scoredAt": "<ISO timestamp>"
}
```

Save to `[working-folder]/ats_score.json`.

## Step 7 — Reply

- Report the score, verdict, and top gaps.
- If re-scoring, show the delta (e.g. "up from 61 → 84").
- End with one of:
  - **Score < 55** — *"Fit is weak — want me to tailor your resume now to close these gaps? I can do it right away."*
  - **Score 55–74** — *"Decent fit but there's room to improve. Want me to tailor the resume before you apply?"*
  - **Score ≥ 75** — *"Strong match. Ready to apply? Tell me the role title and I'll log it."*
