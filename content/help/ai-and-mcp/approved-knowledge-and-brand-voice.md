---
title: Set brand voice and approved knowledge for AI
summary: Tell Relay how the brand sounds and which documents AI may rely on, so drafts and answers stay on-brand and grounded.
section: ai-and-mcp
audience: user
roles: [owner, admin, brand_manager]
status: available
related: [use-the-ai-workspace, ai-help-while-writing-and-replying, brand-rules, automation-rules-and-policies]
product_version: "2026-11"
reviewed: 2026-11-09
order: 30
keywords: [brand voice, tone, knowledge base, approved documents, hashtags, footer]
---

## Brand voice

**Required:** `brands.manage` on the brand to edit (others see **View only**).

1. **Settings → AI and automation → Brand voice** ([/settings/automation/voice](/settings/automation/voice)), choose the brand.
2. Fill in **Tone** (*Warm, plain-spoken*), **Preferred terms**, **Avoid terms** (*Composer warns on these*), **Call to
   action**, **Hashtags** and **Footer** (lists are comma-separated).
3. **Save**.

The composer's **Hashtags** and **Footer** buttons insert these defaults, and avoided terms are flagged as you type.
AI drafts and answers follow the voice.

## Approved knowledge

AI tasks that write facts (campaign from a brief, automatic replies) may only rely on **approved knowledge**.

1. Link the document in **Content library → Sources** (Google Docs, Notion, Drive) or keep it ready to attach.
2. In **Assistant → Knowledge sources**, a Brand manager, Admin or Owner approves it for the brand and sets a review date.
3. Items **Past its review date** are flagged; review them or remove approval.

*No approved knowledge yet. A brand manager can approve documents under Knowledge.* means AI tasks have nothing approved
to rely on yet.
