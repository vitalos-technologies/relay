---
title: Import posts from a CSV file
summary: Turn rows of a spreadsheet into drafts, with a per-row check before anything is created; nothing is scheduled.
section: publishing
audience: user
roles: [owner, admin, brand_manager, editor]
status: available
related: [create-a-post, schedule-a-post, bulk-actions]
product_version: "2026-11"
reviewed: 2026-11-09
order: 41
keywords: [csv, import, spreadsheet, bulk create, excel]
---

## Prepare the file

A `.csv` file of at most **512 KB** and **200 rows**, with a header row. Columns (only `text` is required):

| Column | Meaning |
|---|---|
| `text` | The post text. |
| `destinations` | Networks to use, separated by `|`, `;` or `,` — for example `instagram|facebook`. Empty or `all` = every network connected to the brand. |
| `title` | Internal title. |
| `link` | A full `https://` link. |
| `image_asset_id` | The ID of an image already in this brand's library. |
| `scheduled_local_time` | A suggested time, `2026-12-01 09:00`; optional `timezone` column (default: the brand's). |
| `tags` | Tags separated by `|`. |

Example (synthetic):

```
text,destinations,title,tags,scheduled_local_time
"Winter blend is back ☕",instagram|facebook,Winter blend,launch|winter,2026-12-01 09:00
"Open late on Fridays",all,Late opening,stores,
```

## Import

1. Go to **Create** ([/compose](/compose)), choose the brand and select **Import CSV**.
2. **Choose a .csv file**. Relay checks every row with the same rules as the editor and shows, per row, the post and its
   **Check** result.
3. Fix problem rows in your file and choose it again if needed. Rows with issues are skipped.
4. Select the import button. **Result:** one draft per valid row, with tags. *Import creates drafts only. Nothing is
   scheduled or published.*

## Common row errors

| Message | Fix |
|---|---|
| The CSV needs a "text" column | Add a `text` header. |
| Unknown destination "…" | Use network names: instagram, facebook, telegram, x, tiktok, youtube, linkedin, threads, pinterest, bluesky. |
| … is not connected to this brand. | Connect the account or remove it from the row. |
| image_asset_id is not an image in this brand's library. | Upload the image to this brand and copy its ID. |
| The CSV changed since the preview. Preview it again. | Choose the file again. |

## Limitations

- The suggested time is recorded with the draft but **not scheduled**; schedule each draft yourself, or add them to
  the [queue](/help/calendar-and-scheduling/posting-slots-and-queue).
- One image per row; albums and video aren't supported in CSV.
- The error message for unknown destinations lists only four networks; all ten network names above are accepted.
