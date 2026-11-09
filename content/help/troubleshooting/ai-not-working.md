---
title: The assistant or AI features don't work
summary: Fix "AI is not set up", plan, budget, permission and blocked-run problems with the assistant and AI workflows.
section: troubleshooting
audience: user
status: available
related: [use-the-ai-workspace, ai-limits-privacy-and-usage, plans-and-features]
product_version: "2026-11"
reviewed: 2026-11-09
order: 60
keywords: [ai error, assistant not working, ai not set up, budget used up]
---

| You see | Cause | Fix |
|---|---|---|
| **AI is not set up** | No AI provider key for your Relay installation. Data steps still run; AI-written parts are skipped. | An Owner adds the key in **Setup**. |
| **Multi-step tasks are on the Professional plan** | Standard includes AI drafting only. | Upgrade, or use **Ask** and composer help. |
| **AI budget used up** / **Budget used up** | The month's AI tokens are spent. | Wait for the next period or ask an admin to raise the workspace budget within the plan. |
| **Stopped** / Access revoked | Your access changed during the task. | Check your role; start again. |
| **Needs your input** | The task asked a question. | Answer it in the task. |
| **Partly done** | Some items failed; the card lists them. | Fix and run again (saved items aren't duplicated). |
| *Choose a task type — free questions need AI to be set up* | Free-text questions need a provider. | Pick a task type. |
| No **Assistant** in the sidebar | You don't have `ai.use` or `automation.manage`. | Ask an admin. |
| Paid actions paused | Billing restriction. | See [When paid actions are paused](/help/billing-and-plans/when-paid-actions-are-paused). |
