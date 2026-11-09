---
title: Automate inbox work with rules and policies
summary: Set bounded policies, then When-If-Then rules that route, label, note, escalate or reply, with a dry run, history and an emergency stop.
section: ai-and-mcp
audience: admin
roles: [owner, admin]
status: needs-setup
related: [work-in-the-inbox, cases-and-service-levels, approved-knowledge-and-brand-voice, plans-and-features]
product_version: "2026-11"
reviewed: 2026-11-09
order: 40
keywords: [automation, rules, auto reply, routing, triage, workflow automation, emergency stop]
---

**Required:** `automation.manage` (Owner, Admin) with two-step verification where required. **Plan:** Professional.
Open **Assistant → Automation** ([/automation](/automation)). Others see *Owners and admins manage automation*.

AI-written automatic replies also need an AI provider set up; saved-reply and routing actions don't.

## 1. Create a policy (the limits)

A policy sets *what automation may do: brands, channels, actions, sources, limits, escalation and expiry*.

1. **Policies → New policy**. Name it (for example *Customer care*).
2. Choose brands and channels; allow actions (actions marked *Sends to customers* send replies).
3. Set **Automatic replies per day**, **Monthly token budget**, **Actions per hour**, **Escalate to a person** (team or
   person, keywords, negative sentiment) and an expiry (at most 12 months) and review date.
   *Refunds, complaints and sensitive messages always go to a person.*
4. **Save** (*Saved · policy paused until you activate it*), then **Activate**. Activating makes you the policy's
   **owner**: it acts with your current permissions on those brands, and stops if you lose access.

Editing an active policy pauses it until you activate it again. **Pause** and **Stop** cancel its queued automatic replies.

## 2. Create rules (When → If → Then)

*Rules run in order. Each runs under a policy and never exceeds it.*

1. **Rules → New rule** (needs a policy first).
2. **When**: a new customer message, a case nearing its deadline, or a case change.
3. **If** (all must match): category, sentiment, urgency, channel, language, priority, assignment, first message, text
   contains, label; for cases, the change or minutes to deadline.
4. **Then**: assign or route to a person/team, set priority, add labels, add an internal note, create a case, notify,
   escalate, reply with a saved reply, reply with AI from approved knowledge, or a business-app action.
5. Set the schedule (always, business hours, outside business hours) and limits (runs per hour, per-conversation cooldown).
6. **Test** runs a dry run over the 25 latest conversations or cases in scope: it shows matches and what would happen,
   and changes or sends nothing.
7. Turn the rule **Enabled**.

## Safety built in

- AI replies are sent only when the draft is fully grounded in approved knowledge and the conversation hasn't changed;
  otherwise the conversation is escalated to a person.
- Never automatic replies for refunds, complaints, sensitive topics, spam, uncertain classification or instruction-like text.
- Each rule runs once per event; automation never triggers itself.
- Automatic replies are marked as such on the message.

## History and emergency stop

- **History** lists every run: rule, trigger, subject, outcome and reason, and each action's result.
- **Emergency stop** (*Stop all automation?* → **Stop everything**) stops every rule and cancels queued automatic replies
  (*Stopped · N queued replies cancelled*). **Resume automation** turns it back on.
