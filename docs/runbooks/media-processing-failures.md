# Media processing failures

Audience: operators. Repo only. Reviewed 2026-11-09 (product 2026-11). Background:
`content/help/developers/background-jobs-and-media.md`.

**Affected resources:** `assets`, `asset_derivatives`, the storage bucket, the worker `video` class and
`media-transcode` queue, `ffmpeg`/`ffprobe` in the worker image.

## Symptoms

- Upload fails immediately ("type not allowed", "unexpected data", "could not be read").
- An image or video stays **Processing** (asset status `quarantined`) for minutes.
- A video becomes **Rejected** with a reason.
- Posts with media fail at dispatch with a media error from the network.

## Diagnostics

1. **READ-ONLY** Asset state and reason:
   ```sql
   SELECT id, status, declared_mime, mime, bytes, width, height, rejection_reason, created_at, validated_at
     FROM assets WHERE id='<asset id>';
   SELECT status, count(*) FROM assets WHERE created_at > now() - interval '1 day' GROUP BY status;
   ```
2. Interpret `rejection_reason`: wrong or mismatched type (only JPEG and PNG images; the declared type must match the
   bytes), data after the image end (polyglot), decode failure or too many pixels, video codec/duration/size outside
   what can be transcoded within the time limit.
3. **READ-ONLY** Videos stuck in `quarantined`: is the worker running and the `video` class busy (`:3001/ready` →
   `workload`)? The class runs one video at a time per worker and **defers while publishing is under pressure**
   (up to 60 s at a time). Check the worker log for `asset.uploaded` handling errors and ffmpeg timeouts.
4. **READ-ONLY** Storage reachable? `/api/diagnostics` → `storage`. Storage outages make video jobs throw so pg-boss
   retries them.
5. **READ-ONLY** ffmpeg present in the worker? Missing binaries fail every video. Paths: `FFMPEG_PATH`, `FFPROBE_PATH`
   (default `/usr/bin/...`; the worker image installs them).

## Corrective actions

| Cause | Action |
|---|---|
| File genuinely invalid or unsupported | Tell the person what is accepted and ask them to export again (JPEG/PNG, common video codecs). Relay never weakens validation for one file. |
| Video backlog | Add workers or raise `WORKLOAD_VIDEO_CONCURRENCY`; publishing pressure clears on its own. |
| Storage outage | Restore storage; queued jobs retry automatically. Dead-lettered `asset.uploaded` events can be requeued from `/admin/operations`. |
| ffmpeg missing or broken | Fix the worker image; requeue the affected `asset.uploaded` events. |
| Network rejects media at dispatch | Check the network's current media rules (the post preview shows the validation). Replace the media and retry the failed delivery. |

Never serve or attach an `original` object directly, and never move an asset from `rejected` to `ready` by SQL: the
derivatives (stripped of metadata) would not exist.

## Verification

- The asset shows `ready` with derivatives; the post preview renders it.
- `SELECT count(*) FROM assets WHERE status='quarantined' AND created_at < now() - interval '15 minutes';` → 0.

## Escalation

Systematic rejections of files that should be valid (for example after an image library or ffmpeg upgrade): stop
the rollout, keep failing samples (never customer files outside the deployment), escalate to the media owner.
