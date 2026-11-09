---
title: Use the AI workspace
summary: Ask questions and run multi-step AI tasks - campaign from a brief, inbox assistance, performance analysis, weekly planning and content adaptation - with every external action left for your review.
section: ai-and-mcp
audience: user
roles: [owner, admin, brand_manager, editor, care_agent]
status: needs-setup
related: [ai-help-while-writing-and-replying, approved-knowledge-and-brand-voice, ai-limits-privacy-and-usage, automation-rules-and-policies]
product_version: "2026-11"
reviewed: 2026-11-09
order: 10
keywords: [ai, assistant, workflow, generate, campaign brief, weekly plan, summarise, chatbot]
---

> **Note:** AI-written parts need an AI provider to be set up for your Relay installation (an Owner adds the key in
> **Setup**). Until then the page says **AI is not set up**: *Data steps (reading, checks, plans, reports) still run;
> AI-written parts are skipped.* Relay never shows placeholder or invented text.

## Before you start

- **Required:** `ai.use` (Owner, Admin, Brand manager, Editor, Care agent) plus read access to what the task uses
  (inbox for conversations, analytics for reports).
- **Plan:** **Ask** is on every plan. Multi-step tasks need **Professional** (*Multi-step tasks are on the Professional plan*).
- Open **Assistant** in the sidebar ([/assistant](/assistant)).

![AI workspace for the brand Lumen Lane Bakery with the "AI is not set up" notice, a task box with brand and task-type pickers, and suggested tasks such as Draft replies to unanswered messages and Plan this week's posts](/help/img/ai-and-mcp/ai-workspace.png)

## Run a task

1. Choose the **Brand** and a **Task type** (or type freely; Relay suggests a type you can change):

| Task | What it does | What it creates |
|---|---|---|
| **Campaign from a brief** | *Outline a campaign from a document and save channel drafts.* Choose the brief (approved knowledge, a Content library document, or an attached file), the accounts and an optional **Campaign name**. | A campaign and one **draft** per channel. |
| **Inbox assistance** | *Summarise conversations and prepare replies for review.* Choose unanswered conversations. | Summaries and reply previews (not sent). |
| **Performance analysis** | *Explain stored analytics with dates, coverage and evidence.* Choose a **Period** (7, 28 or 90 days). | A report. |
| **Weekly planning** | *Check the calendar and prepare a schedule for review.* Choose a **Week**. | Proposed times and drafts for empty slots (not scheduled). |
| **Content adaptation** | *Turn approved material into versions for each account.* Uses the latest **approved** version of a post, never the working draft. | New drafts. |
| **Ask** | *Ask a question or get copy in your brand voice.* | An answer (nothing saved). |

2. Optional: **Attach a file** (text, Markdown, CSV, JSON, up to 256 KB) and choose **Knowledge sources**.
3. Select **Start**. Steps appear as they run (*Reading the selected brief.*, *Saved 2 drafts.*). You can leave and come back;
   **Stop** halts it at the next step and lists what was already saved.

## Statuses

**Preparing**, **Working**, **Needs your input** (answer the question Relay shows), **Ready for review**, **Completed**,
**Partly done**, **Failed**, **Stopped**.

## Review what it prepared

Nothing external happens without you. Result cards offer **Open draft**, **Edit**, **Compare versions**, **View report**,
**Create task**, and for external actions **Review schedule**, **Submit for approval** or **Review reply**:

1. Open the action. Relay shows the exact destinations, text, timing and whether approval is needed.
2. Confirm, or choose **Don't do this**.
3. If anything changed since it was prepared (*The post changed since this was prepared*, *New messages since this
   draft*), Relay shows the updated preview first.

On brands that require approval, the assistant can only **submit for approval**, never schedule directly. Your normal
permissions and two-step verification apply when you confirm.

## History

**History** lists your own conversations with the assistant; nobody else can see them. **Quick results from other pages**
lists single answers you asked for from the inbox, composer or analytics.
