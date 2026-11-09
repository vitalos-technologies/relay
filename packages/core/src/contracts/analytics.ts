// Analytics (V3 stream AN) typed contracts for the UI. Served by /api/analytics/** (apps/web/app/api/analytics) and
// produced by packages/services/src/analytics/query.ts + reports.ts. Semantics: docs/V3_ANALYTICS_DICTIONARY.md.
//
// Rules the UI must keep (V3 spec §8/§9):
//  - `null` values are MISSING, never zero: never draw/connect them as 0 (TrendPoint.status says why).
//  - Values carry their measure definition; never relabel or add values of different measures.
//  - Lifetime counters of posts are labelled with `basis_label` ("Lifetime performance of posts published in this period").
//  - Comparison.state 'new' / 'insufficient' replaces any percentage when the baseline is zero/missing.
//  - Every series has health (status + coverage + freshness/through-date); show it, do not hide it.
import type { Provider } from '../types.js';

// ------------------------------------------------------------------ filters (URL-serialisable; ids/dates only)
export const ANALYTICS_VIEWS = ['overview', 'content', 'channels', 'video', 'audience', 'workflow'] as const;
export type AnalyticsView = (typeof ANALYTICS_VIEWS)[number];

/** live = network-reported data of real connections; simulated = mock_ destinations (dev); demo = synthetic fixtures (demo workspaces only). */
export const ANALYTICS_DATASETS = ['live', 'simulated', 'demo'] as const;
export type AnalyticsDataset = (typeof ANALYTICS_DATASETS)[number];

export const POST_FORMATS = ['text', 'image', 'album', 'video', 'reel'] as const;
export type PostFormat = (typeof POST_FORMATS)[number];

export interface AnalyticsFilters {
  brand_ids: string[];
  connection_ids: string[];
  providers: Provider[];
  campaign_ids: string[];
  team_ids: string[];
  formats: PostFormat[];
  /** Inclusive local dates (YYYY-MM-DD) in `timezone`. */
  from: string;
  to: string;
  /** IANA timezone used for day boundaries (DST-aware). */
  timezone: string;
  compare: 'previous_period' | 'none';
  dataset: AnalyticsDataset;
}

/**
 * Query-string keys (all optional): brand, account, network, campaign, team, format (comma-separated ids/values),
 * from, to (YYYY-MM-DD), tz, compare (previous_period|none), dataset (live|simulated|demo).
 * View-specific: measure, basis (overview); sort, dir, page, page_size (content).
 */
export const FILTER_QUERY_KEYS = ['brand', 'account', 'network', 'campaign', 'team', 'format', 'from', 'to', 'tz', 'compare', 'dataset'] as const;

// ------------------------------------------------------------------ health
/** Per-series state. 'zero' = observed 0. 'not_fetched' = never attempted / not requested by the adapter. */
export const SERIES_STATUSES = ['ok', 'zero', 'unsupported', 'permission_missing', 'not_fetched', 'stale', 'provider_delayed', 'partial_coverage', 'fetch_failed'] as const;
export type SeriesStatus = (typeof SERIES_STATUSES)[number];

export interface StatusReason {
  status: Exclude<SeriesStatus, 'ok'>;
  /** Number of resources (posts/accounts) in this state. */
  count: number;
  provider: Provider | null;
  message: string;
}

export interface Coverage {
  unit: 'posts' | 'accounts';
  /** Resources in the query scope (e.g. posts published in the period on the selected accounts). */
  selected: number;
  /** Selected resources on networks that support the measure. */
  eligible: number;
  /** Eligible resources with at least one observation. */
  with_data: number;
  /** Selected resources on networks that do not provide the measure. */
  unsupported: number;
  /** with_data / eligible, null when nothing is eligible. */
  ratio: number | null;
}

export interface Freshness {
  /** Earliest/latest observation timestamps used (ISO). */
  observed_from: string | null;
  observed_to: string | null;
  /** All included data is complete through this instant (provider delays applied). ISO. */
  through: string | null;
  /** `through` as a local date in the filter timezone. */
  through_date: string | null;
  /** Last successful sync among the included accounts (ISO). */
  last_sync_at: string | null;
}

export interface SeriesHealth {
  status: SeriesStatus;
  reasons: StatusReason[];
  coverage: Coverage;
  freshness: Freshness;
}

// ------------------------------------------------------------------ measures
export const MEASURE_KEYS = [
  'posts_published', 'engagements', 'engagement_rate_views', 'engagement_rate_impressions',
  'views', 'impressions', 'reach', 'likes', 'comments', 'shares', 'quotes', 'saves', 'clicks', 'link_clicks',
  'watch_time', 'avg_view_duration', 'followers',
] as const;
export type MeasureKey = (typeof MEASURE_KEYS)[number];

/** How a measure may be combined across networks. */
export type MeasureCombination =
  | 'sum_labelled'      // additive counts; a cross-network total is shown WITH its native components listed
  | 'per_network'       // never combined across networks (e.g. unique reach); broken out per network
  | 'ratio_of_sums'     // Σ numerator / Σ denominator over resources having both
  | 'latest'            // snapshot gauge (followers): latest value, never summed over dates
  | 'app_fact';         // app-owned count (posts published, workflow facts)

export type MeasureBasis = 'lifetime_by_publish_date' | 'observed_change' | 'snapshot_latest' | 'app_fact';

export interface MeasureComponent {
  provider: Provider;
  metric_id: string;
  native_metric: string;
  name: string;
  /** Role inside a ratio. */
  role?: 'numerator' | 'denominator';
}

export interface MeasureDefinition {
  key: MeasureKey;
  label: string;
  unit: 'count' | 'percent' | 'minutes' | 'seconds';
  combination: MeasureCombination;
  /** Plain-language definition, e.g. "Engagements ÷ views, summed over posts that report both". */
  definition: string;
  /** Native metrics included for the providers in scope. */
  components: MeasureComponent[];
  caveats: string[];
}

export interface MeasureOption { key: MeasureKey; label: string; available: boolean; reason: string | null }

export interface Period {
  from: string;            // YYYY-MM-DD (local)
  to: string;              // YYYY-MM-DD (local, inclusive)
  timezone: string;
  start_utc: string;       // ISO, local midnight of `from`
  end_utc: string;         // ISO, local midnight after `to` (exclusive)
  days: number;
}

export type ComparisonState = 'up' | 'down' | 'flat' | 'new' | 'insufficient';

export interface Comparison {
  current: number | null;
  previous: number | null;
  change_abs: number | null;
  /** Fractional change (0.12 = +12%). null when state is new/insufficient. */
  change_pct: number | null;
  state: ComparisonState;
  previous_period: Period | null;
}

// ------------------------------------------------------------------ shared response envelope
export interface ScopeSummary {
  brands: Array<{ id: string; name: string }>;
  accounts: Array<{ connection_id: string; brand_id: string; provider: Provider; display_name: string; status: string; is_mock: boolean }>;
}

export interface ResponseMeta {
  filters: AnalyticsFilters;
  /** Canonical, shareable query string for the filters (no names or private data). */
  query_string: string;
  period: Period;
  previous_period: Period | null;
  dataset: AnalyticsDataset;
  /** true for demo fixtures (never network-reported). */
  synthetic: boolean;
  generated_at: string;
  scope: ScopeSummary;
}

// ------------------------------------------------------------------ overview
export interface Kpi {
  measure: MeasureKey;
  label: string;
  value: number | null;
  unit: MeasureDefinition['unit'];
  basis: MeasureBasis;
  /** e.g. "Lifetime performance of posts published in this period". */
  basis_label: string;
  comparison: Comparison;
  health: SeriesHealth;
  definition: MeasureDefinition;
  /** Per-network breakdown (always present for sum_labelled / per_network measures). */
  by_network: Array<{ provider: Provider; value: number | null; health: SeriesHealth }>;
}

export type TrendPointStatus = 'ok' | 'zero' | 'no_posts' | 'missing' | 'partial';

export interface TrendPoint {
  date: string;                    // local date
  value: number | null;            // null ⇒ do not draw / connect
  status: TrendPointStatus;
  with_data: number;
  eligible: number;
  /** Ratio measures: the numerator/denominator behind `value`. */
  numerator?: number | null;
  denominator?: number | null;
}

export interface TrendSeries {
  key: string;                     // 'all' | provider
  label: string;
  provider: Provider | null;
  points: TrendPoint[];
  total: number | null;
  health: SeriesHealth;
}

export interface Trend {
  measure: MeasureKey;
  basis: MeasureBasis;
  basis_label: string;
  definition: MeasureDefinition;
  available_measures: MeasureOption[];
  /** Combined series; null when the measure must not be combined across networks (see combined_reason). */
  combined: TrendSeries | null;
  combined_reason: string | null;
  by_network: TrendSeries[];
  /** Previous period aligned by day offset (point i ↔ current point i). */
  previous: { combined: TrendSeries | null; by_network: TrendSeries[] } | null;
}

export interface ChannelComparisonRow {
  connection_id: string;
  provider: Provider;
  display_name: string;
  value: number | null;
  /** Share of the group total (only inside a comparable group). */
  share: number | null;
  health: SeriesHealth;
}

export interface ChannelComparisonGroup {
  /** What makes the rows comparable, e.g. "Views (network-reported; definitions differ by network)". */
  label: string;
  measure: MeasureKey;
  rows: ChannelComparisonRow[];
}

export interface ChannelComparison {
  measure: MeasureKey;
  groups: ChannelComparisonGroup[];
  /** Accounts that cannot be compared on this measure, with the reason. */
  excluded: Array<{ connection_id: string; provider: Provider; display_name: string; reason: string }>;
}

export interface Insight {
  id: string;
  kind: 'calculated';              // facts computed from the filtered dataset; never AI interpretation
  text: string;
  measure: MeasureKey | null;
  /** Dataset citation: the filters/period/measure the fact was computed from. */
  basis: { query_string: string; period: Period; measure: MeasureKey | null };
}

export interface DataHealth {
  coverage: Coverage;
  freshness: Freshness;
  statuses: StatusReason[];
  accounts: Array<{
    connection_id: string; provider: Provider; display_name: string;
    sync_status: 'active' | 'stopped' | 'never_synced';
    stop_reason: string | null; last_sync_at: string | null; next_sync_at: string | null;
    note: string | null;
  }>;
  notes: string[];
}

export interface OverviewResponse {
  meta: ResponseMeta;
  kpis: Kpi[];                      // ≤ 4
  trend: Trend;
  channels: ChannelComparison;
  top_content: ContentRow[];
  insights: Insight[];
  data_health: DataHealth;
}

// ------------------------------------------------------------------ content
export interface MetricValue {
  metric_id: string;
  native_metric: string;
  name: string;
  family: string;
  unit: MeasureDefinition['unit'];
  dimension: string | null;
  value: number | null;
  status: SeriesStatus;
  status_message: string | null;
  basis: 'lifetime' | 'window' | 'daily' | 'snapshot';
  as_of_date: string | null;
  observed_at: string | null;
  through: string | null;
  /** Unique-people metric: never add across posts/networks without the label. */
  unique: boolean;
}

export interface Thumbnail { kind: 'asset' | 'synthetic' | 'none'; url: string | null; alt: string | null }

export interface ContentRow {
  delivery_id: string;
  post_id: string;
  brand_id: string;
  connection_id: string;
  provider: Provider;
  account: string;
  title: string | null;
  excerpt: string | null;
  format: PostFormat | null;
  campaign: { id: string; name: string } | null;
  published_at: string;
  published_local: string;          // YYYY-MM-DDTHH:mm in the filter timezone
  provider_url: string | null;
  thumbnail: Thumbnail;
  engagements: number | null;
  engagement_rate: { value: number | null; denominator: 'views' | 'impressions' | null };
  primary: { measure: MeasureKey; value: number | null; label: string } | null;
  metrics: MetricValue[];
  status: SeriesStatus;
  synthetic: boolean;
  simulated: boolean;
}

export const CONTENT_SORTS = ['published_at', 'engagements', 'engagement_rate', 'views', 'impressions', 'reach', 'likes', 'comments', 'shares', 'saves', 'clicks'] as const;
export type ContentSort = (typeof CONTENT_SORTS)[number];

export interface ContentTableResponse {
  meta: ResponseMeta;
  basis_label: string;
  sort: ContentSort;
  dir: 'asc' | 'desc';
  page: number;
  page_size: number;
  total: number;
  rows: ContentRow[];
  /** Rows without a value for the sort key are listed last (missing is not zero). */
  health: SeriesHealth;
}

export interface ContentDetailResponse {
  meta: Pick<ResponseMeta, 'dataset' | 'synthetic' | 'generated_at'> & { timezone: string };
  row: ContentRow;
  caption: string | null;
  media: Array<{ asset_id: string | null; kind: 'image' | 'video' | 'synthetic'; thumb_url: string | null; preview_url: string | null; alt: string | null }>;
  /** As-of series per metric: the lifetime total as observed on each date (not daily activity). */
  history: Array<{
    metric_id: string; name: string; dimension: string | null; basis_label: string;
    points: Array<{ as_of_date: string; value: number; observed_at: string; revision: number }>;
    /** Observed changes between consecutive snapshots (may include corrections; not event-time counts). */
    observed_changes: Array<{ date: string; value: number; period_start: string; period_end: string }>;
  }>;
  corrections: number;
  coverage: Array<{ metric_id: string; status: SeriesStatus; message: string | null; last_attempt_at: string | null; last_success_at: string | null }>;
}

// ------------------------------------------------------------------ channels
export interface ChannelRow {
  connection_id: string;
  brand_id: string;
  provider: Provider;
  display_name: string;
  connection_status: string;
  is_mock: boolean;
  posts_published: number;
  /** Native metric totals over posts published in the period (lifetime of those posts). */
  metrics: Array<MetricValue & { posts_with_data: number; label_note: string | null }>;
  /**
   * Fix H6: the table's measure columns (CHANNEL_TABLE_MEASURES), computed exactly like the comparison card
   * (engagements = the network's engagement families added up; views/impressions/reach = that family's total).
   */
  measures: Array<{ measure: ChannelTableMeasure; value: number | null; status: SeriesStatus; posts_with_data: number }>;
  followers: {
    latest: number | null;
    as_of_date: string | null;
    /** Latest − earliest snapshot inside the period (observed change; null when < 2 snapshots). */
    observed_change: number | null;
    snapshots: Array<{ as_of_date: string; value: number }>;
    status: SeriesStatus;
    message: string | null;
  };
  health: SeriesHealth;
}

/** Measure columns of the Analytics → Channels table, in order. */
export const CHANNEL_TABLE_MEASURES = ['engagements', 'views', 'impressions', 'reach'] as const satisfies readonly MeasureKey[];
export type ChannelTableMeasure = (typeof CHANNEL_TABLE_MEASURES)[number];

export interface ChannelsResponse {
  meta: ResponseMeta;
  basis_label: string;
  rows: ChannelRow[];
  comparison: ChannelComparison;
}

// ------------------------------------------------------------------ video
export interface VideoResponse {
  meta: ResponseMeta;
  basis_label: string;
  totals: Array<{ measure: MeasureKey; label: string; value: number | null; definition: MeasureDefinition; health: SeriesHealth }>;
  by_network: Array<{
    provider: Provider; videos: number;
    views: number | null; watch_time_minutes: number | null; avg_view_duration_seconds: number | null;
    retention: { status: SeriesStatus; message: string };
    health: SeriesHealth;
  }>;
  formats: Array<{ format: PostFormat; provider: Provider; posts: number; views: number | null; with_data: number }>;
  top_videos: ContentRow[];
}

// ------------------------------------------------------------------ audience
export interface AudienceResponse {
  meta: ResponseMeta;
  accounts: Array<{
    connection_id: string; provider: Provider; display_name: string;
    state: 'available' | 'below_threshold' | 'not_fetched' | 'unsupported' | 'permission_missing';
    message: string;
    threshold: number | null;
    breakdowns: Array<{
      metric_id: string; name: string; dimension_key: string; as_of_date: string; total: number;
      buckets: Array<{ key: string; value: number; share: number }>;
      /** Buckets under the provider/privacy threshold are folded here, never shown individually. */
      suppressed: number;
    }>;
  }>;
}

// ------------------------------------------------------------------ workflow (app-owned facts; no per-person scores)
export interface DistributionStat { count: number; median: number | null; p90: number | null; unit: 'hours' | 'minutes' }

export interface WorkflowResponse {
  meta: ResponseMeta;
  note: string;
  review_turnaround: DistributionStat & { approved: number; rejected: number; pending: number; invalidated: number };
  workload: {
    created: number; submitted_for_review: number; scheduled: number; published: number;
    pending_reviews_now: number; overdue_now: number;
    by_team: Array<{ team_id: string | null; team: string; created: number; published: number; pending_reviews: number }>;
  };
  schedule_adherence: { published: number; on_time: number; on_time_ratio: number | null; tolerance_minutes: number; lateness: DistributionStat };
  delivery_reliability: {
    live: { published: number; failed: number; unknown: number; expired: number; ratio: number | null };
    simulated: { published: number; failed: number; unknown: number; expired: number; ratio: number | null };
    top_errors: Array<{ code: string; count: number }>;
  };
}

// ------------------------------------------------------------------ best time (observational heuristic)
export interface BestTimeResponse {
  meta: ResponseMeta;
  status: 'available' | 'insufficient_data';
  timezone: string;
  sample_size: number;
  required_sample: number;
  min_per_slot: number;
  measure: 'engagement_rate_views' | 'engagement_rate_impressions';
  /** Shown only when status = available. */
  slots: Array<{ weekday: number; hour: number; label: string; median_rate: number; posts: number }>;
  caveat: string;
}

// ------------------------------------------------------------------ dictionary
export interface MetricDefinitionDto {
  metric_id: string; version: number; provider: Provider; native_metric: string; name: string; description: string;
  unit: MeasureDefinition['unit']; scope: 'account' | 'post' | 'video'; family: string;
  aggregation: 'sum' | 'latest' | 'ratio_of_sums' | 'none'; time_basis: 'lifetime' | 'window' | 'daily' | 'snapshot';
  paid: 'organic' | 'mixed' | 'paid'; availability: string; fetched: boolean; required_scopes: string[];
  retention_days: number | null; provider_delay_hours: number; unique: boolean;
}

// ------------------------------------------------------------------ reports
export interface ReportDefinitionDto {
  id: string;
  name: string;
  view: AnalyticsView;
  filters: AnalyticsFilters;
  query_string: string;
  visibility: 'private' | 'workspace';
  owner_user_id: string | null;
  is_owner: boolean;
  created_at: string;
  updated_at: string;
}

export type ReportExportFormat = 'csv' | 'pdf' | 'html';
export type ReportExportDestination = 'download' | 'google_doc' | 'drive_file' | 'notion_page';
export type ReportExportStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired';

export interface ReportManifest {
  title: string;
  view: AnalyticsView;
  filters: AnalyticsFilters;
  query_string: string;
  period: Period;
  timezone: string;
  dataset: AnalyticsDataset;
  synthetic: boolean;
  scope: ScopeSummary;
  measures: MeasureDefinition[];
  observed_from: string | null;
  observed_to: string | null;
  through: string | null;
  coverage: Coverage;
  generated_at: string;
  requested_by: string;
}

export interface ReportExportDto {
  id: string;
  view: AnalyticsView;
  format: ReportExportFormat;
  destination: ReportExportDestination;
  status: ReportExportStatus;
  query_string: string;
  report_definition_id: string | null;
  filename: string | null;
  bytes: number | null;
  row_count: number | null;
  manifest: ReportManifest | null;
  /** PDF requested but no server-side renderer: HTML delivered instead (see error/notes). */
  delivered_format: ReportExportFormat | null;
  destination_result: { url: string | null; external_id: string | null; sharing_warning: string | null } | null;
  error: { code: string; message: string } | null;
  created_at: string;
  finished_at: string | null;
  expires_at: string | null;
  download_path: string | null;
}
