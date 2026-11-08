// Simulated Google Business Profile API (mock_ installations only): accounts, locations, local posts, metrics.
// Reviews are simulated by stream B's inbox adapter.
import { sjson, type SimEnv, type SimHandler } from '../biz/sim.js';

const gerr = (status: number, message: string, s: string) => sjson(status, { error: { code: status, message, status: s } });

async function seed(env: SimEnv) {
  if (await env.get('account', 'accounts/mock_acc_1')) return;
  await env.put('account', 'accounts/mock_acc_1', { name: 'accounts/mock_acc_1', accountName: 'Simulated business', type: 'LOCATION_GROUP' });
  for (const [id, title, addr] of [['mock_loc_1', 'Harbour Café — High St', '1 High St, Exampleton'], ['mock_loc_2', 'Harbour Café — Station', '2 Station Rd, Exampleton'], ['mock_loc_3', 'Harbour Café — Market', '3 Market Sq, Exampleton']]) {
    await env.put('location', `locations/${id}`, { name: `locations/${id}`, title, storefrontAddress: { addressLines: [addr!.split(',')[0]], locality: 'Exampleton' } });
  }
}

export const gbpSim: SimHandler = async (req, env) => {
  await seed(env);
  const host = req.url.hostname; const p = req.url.pathname;
  if (host === 'oauth2.googleapis.com') return sjson(200, { access_token: `mock_at_${env.newId('')}`, refresh_token: 'mock_rt', expires_in: 3600, scope: 'https://www.googleapis.com/auth/business.manage openid email' });
  if (host === 'openidconnect.googleapis.com') return sjson(200, { sub: 'mock_google_sub_1', email: 'owner@example.com' });
  if (host === 'mybusinessaccountmanagement.googleapis.com') return sjson(200, { accounts: (await env.list('account')).map((a) => a.data) });
  if (host === 'mybusinessbusinessinformation.googleapis.com') return sjson(200, { locations: (await env.list('location')).map((l) => l.data) });
  if (host === 'businessprofileperformance.googleapis.com') {
    return sjson(200, { multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: req.url.searchParams.getAll('dailyMetric').concat(req.url.searchParams.getAll('dailyMetrics')).map((m, i) => ({ dailyMetric: m, timeSeries: { datedValues: [{ value: String(40 + i * 7) }, { value: String(35 + i * 5) }] } })) }] });
  }
  if (host === 'mybusiness.googleapis.com') {
    const m = /^\/v4\/(accounts\/[\w-]+\/locations\/([\w-]+))\/localPosts$/.exec(p);
    if (m) {
      if (!(await env.get('location', `locations/${m[2]}`))) return gerr(404, 'Requested entity was not found.', 'NOT_FOUND');
      if (req.method === 'POST') {
        const b = JSON.parse(req.body) as { summary?: string; topicType?: string; languageCode?: string };
        if (!b.summary || b.summary.length > 1500) return gerr(400, 'Request contains an invalid argument.', 'INVALID_ARGUMENT');
        const name = `${m[1]}/localPosts/${env.newId('mock_lp_')}`;
        const post = { name, summary: b.summary, topicType: b.topicType ?? 'STANDARD', languageCode: b.languageCode, state: 'LIVE', createTime: env.now().toISOString(), searchUrl: `https://local.google.com/place?id=${m[2]}&use=posts` };
        await env.put('localPost', name, post);
        return sjson(200, post);
      }
      return sjson(200, { localPosts: (await env.list('localPost')).map((x) => x.data).filter((x) => String(x.name).startsWith(m[1]!)).reverse() });
    }
    const g = /^\/v4\/(accounts\/[\w-]+\/locations\/[\w-]+\/localPosts\/[\w-]+)$/.exec(p);
    if (g) { const x = await env.get('localPost', g[1]!); return x ? sjson(200, x) : gerr(404, 'Requested entity was not found.', 'NOT_FOUND'); }
  }
  return gerr(404, `simulated Google: no route ${req.method} ${host}${p}`, 'NOT_FOUND');
};
