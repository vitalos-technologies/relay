---
title: Time zones and daylight saving time
summary: How Relay stores scheduled times, which zone it uses by default, and what happens when clocks change.
section: calendar-and-scheduling
audience: user
status: available
related: [schedule-a-post, posting-slots-and-queue, workspace-and-brand-settings]
product_version: "2026-11"
reviewed: 2026-11-09
order: 30
keywords: [timezone, time zone, dst, daylight saving, clocks change, utc, summer time]
---

## The rules

- Every schedule stores the **local time you typed and its time zone** (for example *09:00 Europe/London*), plus the
  exact moment it means.
- Relay **never assumes your browser's time zone**. The default is the brand's time zone, then the workspace's
  (Europe/London unless changed).
- Changing the workspace or brand time zone affects **new** schedules and how times are shown. *Scheduled posts keep
  their times.*
- The schedule dialog shows the exact moment in the chosen zone, in UTC, and in your own zone when it's different.

## When clocks go forward (a time that doesn't exist)

On the night clocks jump forward, local times in the gap (for example 01:30 in London on the last Sunday of March) don't
exist. Relay refuses them: *That time doesn't exist*. Pick a time before or after the gap.

## When clocks go back (a time that happens twice)

On the night clocks go back, an hour repeats (for example 01:30 in London on the last Sunday of October). Relay asks:
*01:30 occurs twice (clocks go back). Which one?* Choose **First** (summer time, for example UTC+01:00) or **Second**
(winter time, UTC+00:00).

## Posting slots

Recurring posting slots use each slot's own zone. A slot time skipped by a clock change is shown as **Skipped · clock
change**; a repeated hour uses the **first** occurrence (*First of two*).

## Example (synthetic)

A post for *Northwind Coffee* scheduled for **09:00 Europe/London on 30 March 2026** goes out at 08:00 UTC (summer time).
The same 09:00 on 30 October 2026 goes out at 09:00 UTC. Someone in New York sees both in their own time as well.

## Task deadlines

Task deadlines also keep their own zone (*Local time (America/New_York)*) and are shown in it.
