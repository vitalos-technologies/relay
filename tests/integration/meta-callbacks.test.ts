import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deletionStatus, handleMetaDataDeletion, handleMetaDeauthorize, parseSignedRequest } from '@social-lite/services/meta-callbacks';
import { resetConfigCache } from '@social-lite/services';
import { closeTestPool, tenant, testPool } from './helpers.js';

const SECRET = 'meta-test-app-secret';
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const signed = (payload: object, secret = SECRET) => { const p = b64(JSON.stringify(payload)); return `${b64(createHmac('sha256', secret).update(p).digest())}.${p}`; };

afterAll(closeTestPool);
beforeAll(() => { testPool(); process.env.META_APP_SECRET = SECRET; resetConfigCache(); });

async function liveMetaConnection(metaUserId: string) {
  const t = await tenant();
  const cred = await testPool().query<{ id: string }>(`INSERT INTO credentials(workspace_id, encrypted_blob, key_version) VALUES ($1,'{}','test') RETURNING id`, [t.workspaceId]);
  const c = await testPool().query<{ id: string }>(
    `INSERT INTO connections(workspace_id, brand_id, provider, provider_account_id, display_name, status, is_mock, credential_id, metadata)
     VALUES ($1,$2,'facebook','1234567890','Page','ready',false,$3,$4) RETURNING id`, [t.workspaceId, t.brandId, cred.rows[0]!.id, JSON.stringify({ meta_user_id: metaUserId })]);
  return { ...t, connectionId: c.rows[0]!.id, credentialId: cred.rows[0]!.id };
}

describe('Meta platform callbacks', () => {
  it('rejects forged or malformed signed_request', () => {
    expect(() => parseSignedRequest(signed({ algorithm: 'HMAC-SHA256', user_id: '1' }, 'wrong'), SECRET)).toThrow(/signature/);
    expect(() => parseSignedRequest('garbage', SECRET)).toThrow();
    expect(() => parseSignedRequest(signed({ algorithm: 'HMAC-SHA256' }), SECRET)).toThrow(/user_id/);
  });

  it('deauthorize deletes tokens, flags reconnect and blocks only that user’s connections', async () => {
    const a = await liveMetaConnection('111');
    const b = await liveMetaConnection('222');
    const r = await handleMetaDeauthorize(new URLSearchParams({ signed_request: signed({ algorithm: 'HMAC-SHA256', user_id: '111' }) }));
    expect(r.affected).toBe(1);
    const ca = await testPool().query(`SELECT status, credential_id FROM connections WHERE id=$1`, [a.connectionId]);
    expect(ca.rows[0]).toMatchObject({ status: 'reconnect_required', credential_id: null });
    expect((await testPool().query(`SELECT 1 FROM credentials WHERE id=$1`, [a.credentialId])).rowCount).toBe(0);
    const cb = await testPool().query(`SELECT status FROM connections WHERE id=$1`, [b.connectionId]);
    expect(cb.rows[0].status).toBe('ready');
  });

  it('data deletion responds with url + confirmation code and removes the stored user id', async () => {
    const a = await liveMetaConnection('333');
    const r = await handleMetaDataDeletion(new URLSearchParams({ signed_request: signed({ algorithm: 'HMAC-SHA256', user_id: '333' }) }));
    expect(r.url).toMatch(new RegExp(`/data-deletion/${r.confirmation_code}$`));
    expect((await deletionStatus(r.confirmation_code)).status).toBe('completed');
    const c = await testPool().query(`SELECT metadata FROM connections WHERE id=$1`, [a.connectionId]);
    expect(c.rows[0].metadata.meta_user_id).toBeUndefined();
    const stored = await testPool().query(`SELECT provider_user_id FROM data_deletion_requests WHERE confirmation_code=$1`, [r.confirmation_code]);
    expect(stored.rows[0].provider_user_id).toBe('redacted');
  });
});
