---
name: company-research
description: Researches a company using web search and saves structured notes. Covers product, recent news, culture, funding, and PM team structure. Saves to the correct folder depending on application stage. Invoked by /research [company].
---

# Company Research Skill

Research a company and produce structured notes that help the user position themselves effectively.

## Step 1 — Determine save location

- If the user has an active application: save to `workspace/applications/[company-id]/research.md`.
- Otherwise (prospecting or saved job): save to `workspace/companies/[company-slug].md`.

Check `data.json` → `applications` for an existing entry to determine which applies.

## Step 2 — Run web searches

Run focused searches to gather fresh information. Cover:

1. **What they do** — core product, business model, customer segment, market position
2. **Recent news** — funding rounds, product launches, leadership changes, press coverage (last 6–12 months)
3. **Product & PM culture** — how they build product, team structure, any public writing from their PMs
4. **Culture & values** — Glassdoor signals, LinkedIn posts, what they emphasize in job postings

Keep searches focused — 3–4 targeted queries is enough.

## Step 3 — Write structured notes

Save findings in this format:

```markdown
# [Company Name] — Research Notes
_Last updated: [date]_

## What they do
[2–3 sentences: product, customer, business model]

## Recent news
- [bullet: date + headline + why it matters]
- ...

## Product & PM signals
[How they build, what they value in PMs, any public writing or talks]

## Culture signals
[Glassdoor themes, LinkedIn tone, what they emphasize in hiring]

## How to position
[1–3 specific points on how the user should frame their experience for this company]
```

## Step 4 — Surface highlights

After saving, highlight the 2–3 most relevant findings in the chat — things that directly affect how the user should position themselves or what to expect in interviews.
