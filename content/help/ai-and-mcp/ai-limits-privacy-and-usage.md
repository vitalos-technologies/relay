---
title: AI limits, privacy and usage
summary: How AI usage is budgeted and counted, what is stored and for how long, and what AI can and can't see.
section: ai-and-mcp
audience: user
status: available
related: [use-the-ai-workspace, usage-and-limits, plans-and-features]
product_version: "2026-11"
reviewed: 2026-11-09
order: 50
keywords: [ai budget, tokens, privacy, data retention, ai usage, limits]
---

## Budgets

- AI use is measured in **tokens**. Your plan includes a monthly allowance (bounded during the trial), and admins can set
  a lower workspace cap in **Settings → Operations → Usage and limits**.
- When the budget is used up, new AI requests are refused and running tasks stop, keeping what they already saved. There
  are no overage charges.
- Each person can make up to 20 assistant requests per 10 minutes.

## What AI sees

- Only data **you** can access, re-checked when the task runs. If your access is removed mid-task, it stops before
  reading anything more.
- Never internal discussions, tasks, notifications, or other people's assistant history.
- Customer messages, documents and attachments are handled as untrusted data.

## What is stored

| Item | Kept |
|---|---|
| Generated text, model output, attachments, your request text | 30 days |
| Steps, progress lines, IDs, counts, usage and audit entries | Kept |
| Your assistant conversations | Private to you |

Prompts aren't written to logs. Admins see usage, cost estimates (shown as unknown until the installation sets model prices) and failures (**Admin console → AI and automation**), never
prompts or content.
