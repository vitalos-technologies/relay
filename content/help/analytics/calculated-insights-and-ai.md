---
title: Calculated insights and AI explanations
summary: The difference between Relay's calculated observations, which are plain arithmetic on the numbers shown, and the Assistant's AI explanation, which may contain hypotheses.
section: analytics
audience: user
roles: [owner, admin, brand_manager, analyst]
status: available
related: [use-analytics, engagement-rate-and-comparisons, analytics-metric-dictionary]
product_version: "2026-11"
reviewed: 2026-11-09
order: 110
keywords: [insights, ai, assistant, explain analytics, calculated, observation, hypothesis]
---

## Calculated observations (not AI)

Under **Calculated from this data** on the Overview, Relay writes short sentences produced by fixed rules from the same
numbers you see. They are facts about your data, not interpretations:

| Observation | When it appears |
|---|---|
| "*N* posts were published from *date* to *date* (*time zone*)." | Always |
| "Engagements on posts published in this period are *X*% higher/lower than for posts published in the previous *N* days (*a* → *b*)." | When the comparison is up or down |
| "No engagements were recorded for the previous period, so no percentage change is shown." | When the comparison is *new* |
| "Top post by engagements: "…" on *network* (*n*)." | When a post has engagement data |
| "*a* of *b* eligible posts have engagement data; totals cover only those posts." | When coverage is below 100 % |

They never claim causes ("because of the hashtag…"). They are included in exports as *Observations (calculated from
this dataset)*.

## AI explanations (Assistant)

The **Assistant** button on Analytics can **explain analytics**: it receives the same Overview numbers for the brand
over the last 28 days, with their source, and writes a plain-language explanation. It is instructed to quote the
numbers it uses, describe only what was observed, and label any suggested reasons as hypotheses.

| | Calculated observations | AI explanation |
|---|---|---|
| Produced by | Fixed rules in Relay | An AI model, on request |
| Contains | Only arithmetic facts | Wording, emphasis, possible hypotheses |
| Can be wrong? | Only if the data is | Yes — it can misread or overstate; check against the numbers |
| Available | Always | Only when your workspace has AI set up and within its AI budget; otherwise the Assistant says so and nothing runs |
| Can act | No | It can propose a follow-up task, which you must confirm |

Treat AI text as a draft explanation, not as a measurement. Every number in it should be visible in the view.
