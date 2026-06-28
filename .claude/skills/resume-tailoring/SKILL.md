---
name: resume-tailoring
description: Tailors the user's resume to a specific job description. Reads the base resume, identifies the top keywords from the JD, rewrites the summary and bullets to match, and saves the result. Never modifies the base resume. Invoked by /tailor [company].
---

# Resume Tailoring Skill

Tailor the user's resume to a specific role without fabricating experience or modifying the master copy.

## Step 1 — Locate the working folder

Check in this exact order:

1. Read `data.json` → check `savedJobs` array for an entry where `id === argument`. If found: working folder = `workspace/companies/[savedJob.id]/`. Use the savedJob id as-is — do not slugify.
2. Check `data.json` → `applications` for a matching company. If found: working folder = `workspace/applications/[app.id]/`.
3. Otherwise: working folder = `workspace/companies/[slugify(argument)]/`.

## Step 2 — Find the job description

- Look for `job_description.md` in the working folder.
- If not found, ask the user to paste the JD and save it to `[working-folder]/job_description.md` before continuing.

## Step 3 — Read the base resume

- Read `workspace/resume/base_resume.md` as the source of truth.
- **Never modify this file.** All tailored output goes to a separate file.

## Step 4 — Extract top keywords from the JD

- Identify the 3–5 skills, tools, and keywords the JD emphasizes most (by frequency and prominence in requirements/responsibilities).
- Note which are present in the base resume, which are weak, and which are absent.

## Step 5 — Rewrite

- Rewrite the **summary** to lead with the most relevant skills and framing for this role.
- **Reorder and rephrase bullet points** to surface the most relevant experience first.
- Weave in the top JD keywords naturally — do not fabricate experience, invent metrics, or add responsibilities that aren't in the base resume.
- Keep the same overall structure and length.

## Step 6 — Save

- Save the tailored resume to `[working-folder]/tailored_resume.md`.
- If the user also requested a cover letter, draft one and save it to `[working-folder]/cover_letter.md`.

## Step 7 — Nudge

After saving, always end with:
> "Resume saved. Run `/score [company]` to see how much the tailoring improved your fit."
