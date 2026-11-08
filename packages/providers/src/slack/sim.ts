// Simulated Slack Web API (mock_ installations only). Messages are stored, never sent anywhere.
import { sjson, type SimHandler } from '../biz/sim.js';

const ok = (b: Record<string, unknown> = {}) => sjson(200, { ok: true, ...b });
const fail = (error: string) => sjson(200, { ok: false, error });

export const slackSim: SimHandler = async (req, env) => {
  if (!(await env.get('channel', 'mock_C1'))) {
    await env.put('channel', 'mock_C1', { id: 'mock_C1', name: 'social-approvals', is_private: false, is_member: true });
    await env.put('channel', 'mock_C2', { id: 'mock_C2', name: 'care-escalations', is_private: true, is_member: true });
    await env.put('channel', 'mock_C3', { id: 'mock_C3', name: 'general', is_private: false, is_member: false });
  }
  if (req.url.hostname === 'hooks.slack.com') { await env.put('response', env.newId('mock_resp_'), { url: req.url.pathname, body: JSON.parse(req.body || '{}') }); return sjson(200, { ok: true }); }
  const method = req.url.pathname.replace(/^\/api\//, '');
  const body = req.body && req.headers['content-type']?.includes('json') ? JSON.parse(req.body) as Record<string, unknown> : {};
  switch (method) {
    case 'oauth.v2.access': return ok({ access_token: `mock_xoxb_${env.newId('')}`, scope: 'chat:write,channels:read,groups:read', team: { id: 'mock_T1', name: 'Simulated Slack' }, bot_user_id: 'mock_B1' });
    case 'auth.test': return ok({ team_id: 'mock_T1', team: 'Simulated Slack', user_id: 'mock_B1' });
    case 'auth.revoke': return ok({ revoked: true });
    case 'conversations.list': return ok({ channels: (await env.list('channel')).map((c) => c.data) });
    case 'chat.postMessage': {
      const ch = await env.get('channel', String(body.channel));
      if (!ch) return fail('channel_not_found');
      if (!ch.is_member) return fail('not_in_channel');
      const ts = `${Math.floor(env.now().getTime() / 1000)}.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
      await env.put('message', `${String(body.channel)}:${ts}`, { channel: body.channel, ts, text: body.text, blocks: body.blocks ?? null });
      return ok({ ts, channel: body.channel });
    }
    case 'chat.update': {
      const k = `${String(body.channel)}:${String(body.ts)}`;
      const m = await env.get('message', k);
      if (!m) return fail('message_not_found');
      await env.put('message', k, { ...m, text: body.text, blocks: body.blocks ?? null, edited: true });
      return ok({ ts: body.ts });
    }
    default: return fail('unknown_method');
  }
};
