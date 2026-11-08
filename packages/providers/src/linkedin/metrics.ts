// LinkedIn post metrics (verified 2026-11-07):
//  Organization: GET /rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity={org}
//                &shares=List({share}) | &ugcPosts=List({ugcPost})  (rw_organization_admin, ADMINISTRATOR role) — L11.
//                "Shares that are not returned … can be assumed to have counts of 0" (documented ⇒ reported as 0).
//  Member:       GET /rest/memberCreatorPostAnalytics?q=entity&entity=(share:{urn})&queryType=…&aggregation=TOTAL
//                (r_member_postAnalytics), one call per metric — L12.
import { TransportError } from '@social-lite/core';
import type { MetricPoint, MetricsFetcher, MetricsOutcome } from '../metrics.js';
import { ProviderHttpError, oauthAccessToken } from '../shared/http.js';
import { metricsFromClass } from '../shared/classify.js';
import { grantedScopes } from '../shared/oauth.js';
import { classifyLinkedIn, encUrn, liRest } from './api.js';

export const LI_ORG_METRICS = ['impressionCount', 'uniqueImpressionsCount', 'clickCount', 'likeCount', 'commentCount', 'shareCount'] as const;
export const LI_MEMBER_METRICS = ['IMPRESSION', 'MEMBERS_REACHED', 'REACTION', 'COMMENT', 'RESHARE'] as const;

export const linkedinMetricsFetcher: MetricsFetcher = {
  provider: 'linkedin',
  billableRead: false,
  metricNames: [...LI_ORG_METRICS, ...LI_MEMBER_METRICS],
  async fetch(ctx, target): Promise<MetricsOutcome> {
    const urn = target.providerIds.find((x) => /^urn:li:(share|ugcPost):/.test(x));
    if (!urn) return { kind: 'not_found', message: 'No LinkedIn post URN was recorded for this delivery.' };
    let token: string;
    try { token = oauthAccessToken(target.credentials, 'LinkedIn'); } catch { return { kind: 'reconnect', message: 'Reconnect the LinkedIn account.' }; }
    const org = target.connection.providerAccountId.startsWith('urn:li:organization:');
    const scopes = grantedScopes(target.credentials);
    const need = org ? 'rw_organization_admin' : 'r_member_postAnalytics';
    if (scopes.length && !scopes.includes(need)) return { kind: 'permission_missing', message: `LinkedIn post analytics need ${need} (Community Management API). Not granted for this connection.` };
    const isShare = urn.startsWith('urn:li:share:');
    try {
      if (org) {
        const r = await liRest<{ elements?: Array<{ share?: string; ugcPost?: string; totalShareStatistics?: Record<string, unknown> }> }>(ctx, {
          method: 'GET', path: '/rest/organizationalEntityShareStatistics', bearer: token, op: 'linkedin.org.share_stats', timeoutMs: 15_000,
          rawQuery: `q=organizationalEntity&organizationalEntity=${encUrn(target.connection.providerAccountId)}&${isShare ? 'shares' : 'ugcPosts'}=List(${encUrn(urn)})`,
        });
        const el = (r.data.elements ?? []).find((e) => e.share === urn || e.ugcPost === urn);
        const stats = el?.totalShareStatistics ?? {};
        const points: MetricPoint[] = LI_ORG_METRICS.map((name) => ({ name, dimension: null, value: typeof stats[name] === 'number' ? (stats[name] as number) : 0, period: 'lifetime', windowEnd: null }));
        return { kind: 'ok', points, unavailable: [] };
      }
      const points: MetricPoint[] = [];
      const unavailable: Array<{ name: string; reason: string }> = [];
      for (const q of LI_MEMBER_METRICS) {
        const r = await liRest<{ elements?: Array<{ count?: number }> }>(ctx, {
          method: 'GET', path: '/rest/memberCreatorPostAnalytics', bearer: token, op: 'linkedin.member.post_analytics', timeoutMs: 15_000,
          rawQuery: `q=entity&entity=(${isShare ? 'share' : 'ugc'}:${encUrn(urn)})&queryType=${q}&aggregation=TOTAL`,
        });
        const c = r.data.elements?.[0]?.count;
        if (typeof c === 'number') points.push({ name: q, dimension: null, value: c, period: 'lifetime', windowEnd: null });
        else unavailable.push({ name: q, reason: 'Not reported by LinkedIn' });
      }
      return { kind: 'ok', points, unavailable };
    } catch (err) {
      if (err instanceof ProviderHttpError) return metricsFromClass(classifyLinkedIn(err, ctx.now().getTime()), 'LinkedIn');
      if (err instanceof TransportError) return { kind: 'error', code: `transport_${err.kind}`, message: 'LinkedIn could not be reached.' };
      throw err;
    }
  },
};
