// Set-based synthetic dataset generator for the V3.1 benchmark harness. Runs ONLY against a throwaway database
// (name prefix relay_bench_, enforced by run.ts). Deterministic shapes: every per-row choice comes from
// bench_rand(seed || row), so the same profile yields the same distribution of states, times and destinations.
//
// Per post (measured workspace): 70% published (last 720 days), 3% failed, 1% unknown/blocked (last 10 days),
// 8% scheduled (next 60 days), 4% pending approval on approval brands (else scheduled), 2% cancelled, 12% drafts.
// 1–3 destinations per post, all on the post's brand. One attempt row per finished delivery. Approvals: pending for
// pending posts; approved (decided) for published posts on approval brands.
import { randomUUID } from 'node:crypto';
import type { PoolClient } from '@social-lite/db';

export const BENCH_ISSUER = 'https://idp.bench.relay.test/realms/relay';
const PROVIDERS = ['instagram', 'facebook', 'x', 'tiktok', 'youtube', 'linkedin', 'threads', 'pinterest', 'bluesky', 'telegram'];

export interface GeneratedWorkspace {
  workspaceId: string; ownerId: string; ownerSub: string; editorId: string; approverId: string;
  brandIds: string[]; restrictedBrandIds: string[];
}

export async function installHelpers(c: PoolClient): Promise<void> {
  await c.query(`CREATE OR REPLACE FUNCTION bench_rand(seed text) RETURNS float8 LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
    $$ SELECT ('x' || substr(md5(seed), 1, 13))::bit(52)::bigint::float8 / 4503599627370496.0 $$`);
}

export async function generateWorkspace(c: PoolClient, o: { name: string; brands: number; connections: number; posts: number; seed: string }): Promise<GeneratedWorkspace> {
  const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows as T[];
  const ws = (await q<{ id: string }>(`INSERT INTO workspaces(name, is_demo) VALUES ($1, true) RETURNING id`, [o.name]))[0]!.id;
  const ownerSub = randomUUID();
  const user = async (role: string, label: string, sub = randomUUID(), restricted = false) => {
    const id = (await q<{ id: string }>(`INSERT INTO users(oidc_issuer, oidc_subject, email, email_verified, name) VALUES ($1,$2,$3,true,$4) RETURNING id`,
      [BENCH_ISSUER, sub, `${label}-${sub.slice(0, 8)}@bench.relay.test`, label]))[0]!.id;
    await q(`INSERT INTO memberships(workspace_id, user_id, role, brand_restricted) VALUES ($1,$2,$3,$4)`, [ws, id, role, restricted]);
    return id;
  };
  const ownerId = await user('owner', 'owner', ownerSub);
  const approverId = await user('approver', 'approver');
  const editorId = await user('editor', 'editor', randomUUID(), true);
  await q(`INSERT INTO scoped_role_grants(workspace_id, principal_type, user_id, role, scope_type, source) VALUES ($1,'user',$2,'owner','workspace','bench'), ($1,'user',$3,'approver','workspace','bench')`,
    [ws, ownerId, approverId]);

  await q(`INSERT INTO brands(workspace_id, name, timezone, approval_required, is_demo)
           SELECT $1, 'Bench brand ' || lpad(g::text, 4, '0'), CASE WHEN g % 3 = 0 THEN 'America/New_York' ELSE 'Europe/London' END, g % 4 = 1, true
             FROM generate_series(1, $2) g`, [ws, o.brands]);
  const brands = await q<{ id: string }>(`SELECT id FROM brands WHERE workspace_id=$1 ORDER BY name`, [ws]);
  const brandIds = brands.map((b) => b.id);
  // Brand-restricted editor: grants on the first half of the brands (exercises the brandIds-array scoping path).
  const restrictedBrandIds = brandIds.slice(0, Math.max(1, Math.floor(brandIds.length / 2)));
  for (const b of restrictedBrandIds) {
    await q(`INSERT INTO membership_brand_grants(workspace_id, user_id, brand_id) VALUES ($1,$2,$3)`, [ws, editorId, b]);
    await q(`INSERT INTO scoped_role_grants(workspace_id, principal_type, user_id, role, scope_type, brand_id, source) VALUES ($1,'user',$2,'editor','brand',$3,'bench')`, [ws, editorId, b]);
  }

  await q(`CREATE TEMP TABLE bb ON COMMIT DROP AS SELECT id, (row_number() OVER (ORDER BY name) - 1)::int AS idx, approval_required FROM brands WHERE workspace_id=$1`, [ws]);
  await q(`INSERT INTO connections(workspace_id, brand_id, provider, provider_account_id, display_name, status, is_mock, metadata)
           SELECT $1::uuid, bb.id, ($3::text[])[1 + (j % 10)]::provider_kind, 'mock_bench_' || $4 || '_' || j, 'Bench destination ' || lpad(j::text, 5, '0'), 'ready', true, '{"bench":true}'
             FROM generate_series(0, $2 - 1) j JOIN bb ON bb.idx = j % (SELECT count(*) FROM bb)`, [ws, o.connections, PROVIDERS, ws.slice(0, 8)]);
  await q(`CREATE TEMP TABLE cc ON COMMIT DROP AS
           SELECT c.id, c.provider, bb.idx AS brand_idx, (row_number() OVER (PARTITION BY c.brand_id ORDER BY c.display_name) - 1)::int AS k,
                  count(*) OVER (PARTITION BY c.brand_id)::int AS n
             FROM connections c JOIN bb ON bb.id = c.brand_id WHERE c.workspace_id=$1`, [ws]);
  await q(`CREATE INDEX ON cc(brand_idx, k)`);

  // Posts plan.
  await q(`CREATE TEMP TABLE gp ON COMMIT DROP AS
     SELECT i, gen_random_uuid() AS post_id, gen_random_uuid() AS rev_id, gen_random_uuid() AS sch_id, bb.id AS brand_id, bb.idx AS brand_idx, bb.approval_required,
            CASE WHEN r < 0.70 THEN 'published' WHEN r < 0.73 THEN 'failed' WHEN r < 0.74 THEN (CASE WHEN i % 2 = 0 THEN 'unknown' ELSE 'blocked' END)
                 WHEN r < 0.82 THEN 'scheduled' WHEN r < 0.86 THEN (CASE WHEN bb.approval_required THEN 'pending' ELSE 'scheduled' END)
                 WHEN r < 0.88 THEN 'cancelled' ELSE 'draft' END AS kind, r2, r3
       FROM (SELECT i, bench_rand($1::text || ':k:' || i) r, bench_rand($1::text || ':t:' || i) r2, bench_rand($1::text || ':d:' || i) r3 FROM generate_series(0, $2::int - 1) i) g
       JOIN bb ON bb.idx = g.i % (SELECT count(*) FROM bb)`, [o.seed, o.posts]);
  await q(`ALTER TABLE gp ADD COLUMN due_at timestamptz`);
  await q(`UPDATE gp SET due_at = date_trunc('minute', CASE kind
             WHEN 'published' THEN now() - r2 * interval '720 days' - interval '1 hour'
             WHEN 'failed' THEN now() - r2 * interval '720 days' - interval '1 hour'
             WHEN 'unknown' THEN now() - r2 * interval '10 days' - interval '1 hour'
             WHEN 'blocked' THEN now() - r2 * interval '10 days' - interval '1 hour'
             WHEN 'cancelled' THEN now() + (r2 - 0.5) * interval '60 days'
             WHEN 'draft' THEN now() - r2 * interval '120 days'
             ELSE now() + interval '1 hour' + r2 * interval '60 days' END)`);
  await q(`CREATE TEMP TABLE gd ON COMMIT DROP AS
     SELECT gp.i, t, cc.id AS connection_id, cc.provider, gen_random_uuid() AS variant_id
       FROM gp CROSS JOIN LATERAL generate_series(0, 2) t
       JOIN cc ON cc.brand_idx = gp.brand_idx AND cc.k = (gp.i + t) % cc.n
      WHERE t < least(1 + floor(gp.r3 * 3)::int, cc.n)`);
  await q(`CREATE INDEX ON gd(i)`);
  await q(`ANALYZE gp; ANALYZE gd`);

  await q(`INSERT INTO posts(id, workspace_id, brand_id, created_by, title, tags, draft, version, current_revision_id, schedule_generation, created_at, updated_at, updated_by)
     SELECT gp.post_id, $1, gp.brand_id, $2, 'Bench post ' || gp.i,
            CASE WHEN gp.i % 7 = 0 THEN ARRAY['promo'] WHEN gp.i % 11 = 0 THEN ARRAY['evergreen','howto'] ELSE '{}'::text[] END,
            jsonb_build_object('baseText', CASE WHEN gp.i % 13 = 0 THEN 'Spring launch: ' ELSE '' END || 'Synthetic benchmark copy #' || gp.i || ' with a realistic length of text so excerpts and search have something to chew on.',
              'baseLink', NULL, 'baseAssetIds', '[]'::jsonb,
              'variants', coalesce((SELECT jsonb_agg(jsonb_build_object('connectionId', gd.connection_id, 'inheritText', true, 'inheritMedia', true) ORDER BY gd.t) FROM gd WHERE gd.i = gp.i), '[]'::jsonb)),
            1, CASE WHEN gp.kind <> 'draft' THEN gp.rev_id END, CASE WHEN gp.kind <> 'draft' THEN 1 ELSE 0 END,
            least(gp.due_at, now()) - interval '1 day', least(gp.due_at, now()) - interval '1 day' + interval '1 hour', $2
       FROM gp`, [ws, ownerId]);
  await q(`INSERT INTO post_revisions(id, workspace_id, post_id, revision_number, base_text, content_hash, created_by, created_at)
     SELECT gp.rev_id, $1, gp.post_id, 1, 'Synthetic benchmark copy #' || gp.i, md5('bench' || gp.i), $2, least(gp.due_at, now()) - interval '1 day'
       FROM gp WHERE gp.kind <> 'draft'`, [ws, ownerId]);
  await q(`INSERT INTO variants(id, workspace_id, revision_id, connection_id, rendered_text, format)
     SELECT gd.variant_id, $1, gp.rev_id, gd.connection_id, 'Synthetic benchmark copy #' || gp.i, 'text' FROM gd JOIN gp ON gp.i = gd.i WHERE gp.kind <> 'draft'`, [ws]);
  await q(`INSERT INTO schedules(id, workspace_id, brand_id, post_id, revision_id, generation, due_at, input_timezone, input_local_time, publish_before, status, fingerprint, created_by, created_at)
     SELECT gp.sch_id, $1, gp.brand_id, gp.post_id, gp.rev_id, 1, gp.due_at, 'Europe/London', to_char(gp.due_at AT TIME ZONE 'Europe/London', 'YYYY-MM-DD"T"HH24:MI:SS'),
            gp.due_at + interval '1 hour',
            CASE gp.kind WHEN 'scheduled' THEN 'active' WHEN 'pending' THEN 'pending_approval' WHEN 'cancelled' THEN 'cancelled' ELSE 'completed' END,
            'bench:' || gp.i, $2, least(gp.due_at, now()) - interval '1 day'
       FROM gp WHERE gp.kind <> 'draft'`, [ws, ownerId]);
  await q(`INSERT INTO deliveries(workspace_id, brand_id, post_id, schedule_id, generation, revision_id, variant_id, connection_id, provider, is_mock, state, due_at, publish_before,
            next_attempt_at, attempt_count, provider_ids, published_at, last_error_code, blocked_reason, needs_reconcile, unknown_since, created_at, updated_at)
     SELECT $1, gp.brand_id, gp.post_id, gp.sch_id, 1, gp.rev_id, gd.variant_id, gd.connection_id, gd.provider, true,
            CASE gp.kind WHEN 'published' THEN 'published' WHEN 'failed' THEN 'failed' WHEN 'unknown' THEN 'unknown' WHEN 'blocked' THEN 'blocked'
                         WHEN 'cancelled' THEN 'cancelled' ELSE 'scheduled' END::delivery_state,
            gp.due_at, gp.due_at + interval '1 hour', gp.due_at, CASE WHEN gp.kind IN ('scheduled','cancelled') THEN 0 ELSE 1 END,
            CASE WHEN gp.kind = 'published' THEN ARRAY['mock_' || substr(gd.variant_id::text, 1, 12)] ELSE '{}'::text[] END,
            CASE WHEN gp.kind = 'published' THEN gp.due_at + interval '3 seconds' END,
            CASE gp.kind WHEN 'failed' THEN 'provider_rejected' WHEN 'blocked' THEN 'reconnect_required' END,
            CASE WHEN gp.kind = 'blocked' THEN 'reconnect' END, gp.kind = 'unknown', CASE WHEN gp.kind = 'unknown' THEN gp.due_at END,
            least(gp.due_at, now()) - interval '1 day', CASE WHEN gp.kind IN ('scheduled','cancelled') THEN least(gp.due_at, now()) - interval '1 day' ELSE gp.due_at + interval '3 seconds' END
       FROM gd JOIN gp ON gp.i = gd.i WHERE gp.kind NOT IN ('draft','pending')`, [ws]);
  await q(`INSERT INTO delivery_attempts(workspace_id, delivery_id, attempt_number, fence, worker_id, kind, phase, started_at, ended_at, outcome)
     SELECT workspace_id, id, 1, 1, 'bench', 'automatic', 'sending', due_at + interval '1 second', due_at + interval '3 seconds',
            CASE state WHEN 'published' THEN 'confirmed' WHEN 'failed' THEN 'permanent' WHEN 'unknown' THEN 'unknown' ELSE 'blocked' END
       FROM deliveries WHERE workspace_id=$1 AND state IN ('published','failed','unknown','blocked')`, [ws]);
  await q(`INSERT INTO approvals(workspace_id, brand_id, post_id, revision_id, schedule_id, schedule_generation, fingerprint, requested_by, requested_at, reviewer_id, decision, decided_at, author_ids)
     SELECT $1, gp.brand_id, gp.post_id, gp.rev_id, gp.sch_id, 1, 'bench:' || gp.i, $2,
            CASE WHEN gp.kind = 'pending' THEN now() - gp.r3 * interval '5 days' ELSE gp.due_at - interval '2 hours' END,
            CASE WHEN gp.kind = 'pending' THEN NULL ELSE $3::uuid END, CASE WHEN gp.kind = 'pending' THEN 'pending' ELSE 'approved' END,
            CASE WHEN gp.kind = 'pending' THEN NULL ELSE gp.due_at - interval '1 hour' END, ARRAY[$2::uuid]
       FROM gp WHERE gp.approval_required AND gp.kind IN ('pending','published')`, [ws, ownerId, approverId]);
  return { workspaceId: ws, ownerId, ownerSub, editorId, approverId, brandIds, restrictedBrandIds };
}
