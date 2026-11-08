// Simulated Mailchimp Marketing API (mock_ installations only). Has no send endpoint at all; audiences never change.
import { sjson, type SimHandler } from '../biz/sim.js';

const err = (status: number, title: string, detail: string) => sjson(status, { type: 'https://mailchimp.com/developer/marketing/docs/errors/', title, status, detail });

export const mailchimpSim: SimHandler = async (req, env) => {
  if (!(await env.get('list', 'mock_list_1'))) {
    await env.put('list', 'mock_list_1', { id: 'mock_list_1', name: 'Newsletter (simulated)', stats: { member_count: 1240 } });
    await env.put('list', 'mock_list_2', { id: 'mock_list_2', name: 'VIP customers (simulated)', stats: { member_count: 86 } });
  }
  const host = req.url.hostname; const p = req.url.pathname;
  if (host === 'login.mailchimp.com') {
    if (p === '/oauth2/token') return sjson(200, { access_token: `mock_mc_${env.newId('')}`, expires_in: 0, scope: null });
    if (p === '/oauth2/metadata') return sjson(200, { dc: 'us1', accountname: 'Simulated Mailchimp', login: { login_id: env.accountId }, api_endpoint: 'https://us1.api.mailchimp.com' });
  }
  const path = p.replace(/^\/3\.0/, '');
  const body = req.body ? JSON.parse(req.body) as Record<string, unknown> : {};
  if (/\/actions\/|\/members/.test(path) && req.method !== 'GET') return err(400, 'Not supported', 'The simulation has no send or subscribe endpoints.');
  if (path === '/ping') return sjson(200, { health_status: "Everything's Chimpy!" });
  if (path === '/lists') return sjson(200, { lists: (await env.list('list')).map((l) => l.data), total_items: 2 });
  if (path === '/campaigns' && req.method === 'POST') {
    const listId = (body.recipients as { list_id?: string } | undefined)?.list_id;
    if (!listId || !(await env.get('list', listId))) return err(400, 'Invalid Resource', 'The resource submitted could not be validated.');
    const id = env.newId('mock_cmp_');
    const web_id = Math.floor(Math.random() * 1e6);
    const c = { id, web_id, type: 'regular', status: 'save', settings: body.settings, recipients: { list_id: listId }, create_time: env.now().toISOString(), emails_sent: 0 };
    await env.put('campaign', id, c);
    return sjson(200, c);
  }
  if (path === '/campaigns') return sjson(200, { campaigns: (await env.list('campaign')).map((x) => x.data).reverse() });
  const content = /^\/campaigns\/([^/]+)\/content$/.exec(path);
  if (content) { const c = await env.get('campaign', content[1]!); if (!c) return err(404, 'Resource Not Found', 'The requested resource could not be found.'); await env.put('campaign', content[1]!, { ...c, html_set: true }); return sjson(200, { html: '' }); }
  const one = /^\/campaigns\/([^/]+)$/.exec(path);
  if (one) { const c = await env.get('campaign', one[1]!); return c ? sjson(200, c) : err(404, 'Resource Not Found', 'The requested resource could not be found.'); }
  const rep = /^\/reports\/([^/]+)$/.exec(path);
  if (rep) {
    const c = await env.get('campaign', rep[1]!);
    if (!c) return err(404, 'Resource Not Found', 'The requested resource could not be found.');
    // A draft has no report data: zeros, exactly as the API reports for unsent campaigns.
    return sjson(200, { id: rep[1], emails_sent: c.emails_sent ?? 0, opens: { unique_opens: 0 }, clicks: { unique_subscriber_clicks: 0 }, unsubscribed: 0 });
  }
  return err(404, 'Resource Not Found', `simulated Mailchimp: no route ${req.method} ${path}`);
};
