---
name: interview-prep
description: Generates tailored interview questions and STAR-format answer structures for a specific role, based on the JD and the user's resume. Saves output to interview_notes.md. Invoked by /prep [company].
---

# Interview Prep Skill

Generate 10 role-specific interview questions with STAR-format answer structures grounded in the user's actual experience.

## Step 1 — Load context

- Read `workspace/applications/[company-name]/job_description.md` for the role details.
- Read `workspace/applications/[company-name]/research.md` for company context (product areas, culture, recent news).
- Read `workspace/resume/base_resume.md` for the user's experience — this is what STAR answers should draw from.
- If a tailored resume exists at `workspace/applications/[company-name]/tailored_resume.md`, use that instead.

If the application folder doesn't exist, check `workspace/companies/[slug]/job_description.md`.

## Step 2 — Generate questions

Produce exactly 10 questions split across two types:

**Behavioral (5 questions)** — "Tell me about a time when..."
- Draw from common PM behavioral themes: stakeholder conflict, prioritization under constraints, data-driven decisions, cross-functional leadership, product failure/learning.
- Tailor to signals in the JD and company research (e.g. if the role emphasizes growth, include a question on growth experiments).

**Product sense (5 questions)** — Case-style product questions
- At least one question specific to the company's actual product or market.
- Cover: product improvement, metrics definition, prioritization framework, new feature design, go-to-market thinking.

## Step 3 — Add STAR structures

For each behavioral question, provide a suggested STAR skeleton using the user's real experience from the resume:

- **Situation** — which role/project to draw from
- **Task** — what the user was responsible for
- **Action** — specific actions they took (pull from resume bullets)
- **Result** — outcome or metric if available

Do not fabricate metrics or outcomes not present in the resume. If a relevant story isn't obvious, note what type of example would work best.

For product sense questions, provide a suggested framework approach (e.g. "Start with clarifying questions → define success metric → segment users → prioritize features").

## Step 4 — Save

Save the full output to `workspace/applications/[company-name]/interview_notes.md`.

## Step 5 — Offer next step

After saving, offer:
> "Notes saved to interview_notes.md. Want to run a mock interview? I'll ask the questions one by one and give feedback on each answer."
