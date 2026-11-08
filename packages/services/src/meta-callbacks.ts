// Meta platform callbacks (required before onboarding external customers):
//  - Deauthorize callback: the user removed the app ⇒ delete stored tokens, mark affected connections
//    "Reconnect required" and block their queued work.
//  - Data Deletion Request callback: same, plus remove the stored Meta user id; respond with a status URL
//    and confirmation code as Meta requires.
// Both are authenticated by verifying `signed_request` (HMAC-SHA256 with the app secret).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '@social-lite/core';
import { getPool, many, maybeOne, withTx } from '@social-lite/db';
import { config } from './config.js';
import { getSetting } from './settings.js';
import { audit } from './audit.js';
import { writeOutbox } from './outbox.js';
import { blockDeliveriesForConnection } from './engine/hooks.js';

const b64urlDecode = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export function parseSignedRequest(signed: string, appSecret: string): { user_id: string; issued_at?: number } {
  const [sig, payload] = signed.split('.', 2);
  if (!sig || !payload) throw new AppError('forbidden', 'Malformed signed_request');
  const expected = createHmac('sha256', appSecret).update(payload).digest();
  const got = b64urlDecode(sig);
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new AppError('forbidden', 'Invalid signed_request signature');
  let data: { algorithm?: string; user_id?: unknown; issued_at?: number };
  try { data = JSON.parse(b64urlDecode(payload).toString('utf8')); } catch { throw new AppError('forbidden', 'Malformed signed_request payload'); }
  if (String(data.algorithm).toUpperCase() !== 'HMAC-SHA256') throw new AppError('forbidden', 'Unsupported signed_request algorithm');
  if (typeof data.user_id !== 'string' || !/^\d{1,32}$/.test(data.user_id)) throw new AppError('forbidden', 'signed_request has no user_id');
  return { user_id: data.user_id, issued_at: data.issued_at };
}

async function appSecret(): Promise<string> {
  const s = await getSetting('META_APP_SECRET');
  if (!s) throw new AppError('provider_not_configured', 'Meta is not configured');
  return s;
}

/** Revoke local access for every live Meta connection granted by this app-scoped user. */
async function revokeForMetaUser(metaUserId: string, kind: 'deauthorize' | 'data_deletion'): Promise<{ code: string; affected: number }> {
  const code = randomBytes(12).toString('hex');
  const affected = await withTx(async (tx) => {
    const conns = await many<{ id: string; workspace_id: string; brand_id: string; credential_id: string | null; provider: string }>(tx,
      `SELECT id, workspace_id, brand_id, credential_id, provider FROM connections
        WHERE provider IN ('facebook','instagram') AND NOT is_mock AND metadata->>'meta_user_id' = $1 FOR UPDATE`, [metaUserId]);
    for (const c of conns) {
      const msg = kind === 'deauthorize' ? 'The app was removed in Facebook settings. Reconnect to publish.' : 'A data deletion request removed this account’s stored access. Reconnect to publish.';
      await tx.query(
        `UPDATE connections SET status = CASE WHEN disconnected_at IS NULL THEN 'reconnect_required'::connection_status ELSE status END,
                credential_id=NULL, health_detail=jsonb_build_object('message', $2::text), health_checked_at=now(), updated_at=now(),
                metadata = CASE WHEN $3 THEN metadata - 'meta_user_id' ELSE metadata END
          WHERE id=$1`, [c.id, msg, kind === 'data_deletion']);
      if (c.credential_id) await tx.query(`DELETE FROM credentials WHERE id=$1 AND workspace_id=$2`, [c.credential_id, c.workspace_id]);
      await blockDeliveriesForConnection(tx, c.id, msg);
      await writeOutbox(tx, { workspaceId: c.workspace_id, aggregateType: 'connection', aggregateId: c.id, eventType: 'connection.health_changed', payload: { status: 'reconnect_required', reason: kind } });
      await audit(tx, { workspaceId: c.workspace_id, brandId: c.brand_id, actorService: 'meta', action: `connection.meta_${kind}`, resourceType: 'connection', resourceId: c.id, diff: { confirmation_code: code } });
    }
    await tx.query(
      `INSERT INTO data_deletion_requests(provider, provider_user_id, confirmation_code, kind, status, affected_connections, completed_at)
       VALUES ('meta',$1,$2,$3,'completed',$4, now())`, [kind === 'data_deletion' ? 'redacted' : metaUserId, code, kind, conns.length]);
    return conns.length;
  }, getPool());
  return { code, affected };
}

export async function handleMetaDeauthorize(form: URLSearchParams) {
  const sr = parseSignedRequest(form.get('signed_request') ?? '', await appSecret());
  const r = await revokeForMetaUser(sr.user_id, 'deauthorize');
  return { ok: true, affected: r.affected };
}

export async function handleMetaDataDeletion(form: URLSearchParams) {
  const sr = parseSignedRequest(form.get('signed_request') ?? '', await appSecret());
  const r = await revokeForMetaUser(sr.user_id, 'data_deletion');
  return { url: `${config().APP_BASE_URL}/data-deletion/${r.code}`, confirmation_code: r.code };
}

export async function deletionStatus(code: string) {
  if (!/^[0-9a-f]{24}$/.test(code)) throw new AppError('not_found', 'Unknown confirmation code');
  const r = await maybeOne<{ status: string; kind: string; received_at: Date; completed_at: Date | null }>(getPool(),
    `SELECT status, kind, received_at, completed_at FROM data_deletion_requests WHERE confirmation_code=$1`, [code]);
  if (!r) throw new AppError('not_found', 'Unknown confirmation code');
  return { status: r.status, kind: r.kind, received_at: r.received_at.toISOString(), completed_at: r.completed_at?.toISOString() ?? null };
}
