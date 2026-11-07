-- V3.1 PERF (stream PERF), second migration (020 is frozen): precomputed per-local-day analytics summary.
--
-- metric_rollup_days holds exactly what analytics aggregate() computes from metric_rollups for one time zone:
--   sum(value_sum), sum(resources), min/min/max of the freshness timestamps, GROUP BY connection, local date
--   ((bucket_start AT TIME ZONE tz)::date — the same expression the query uses, so DST days of 23/25 hours and
--   :30/:45 offsets bucket identically), metric_key, definition_version, dimension.
-- Dataset isolation: `source` (provider | simulated | synthetic) is part of the key; readers filter it exactly like the
-- rollups (live / simulated / demo never mix).
-- Maintenance is incremental and writer-agnostic: statement-level triggers on metric_rollups recompute only the
-- (time zone, connection, source, local day) cells whose buckets changed, for every zone tracked for the workspace.
-- Zones (workspace + brand time zones) start 'pending'; the analytics worker backfills them and marks them 'ready'.
-- Readers use the summary only for a READY zone and fall back to metric_rollups otherwise.
-- Rollback: DROP TRIGGER metric_rollups_days_{ins,del,upd} ON metric_rollups, workspaces_summary_zone ON workspaces, brands_summary_zone ON brands;
--   DROP FUNCTION metric_rollups_days_trigger(), metric_rollup_days_refresh(uuid[],uuid[],text[],timestamptz[],text), metric_summary_track_workspace_zone(),
--   metric_summary_track_brand_zone(); DROP TABLE metric_rollup_days, metric_summary_zones. Readers fall back to metric_rollups automatically.

CREATE TABLE metric_summary_zones (
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tz            text NOT NULL CHECK (length(tz) BETWEEN 1 AND 64),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready')),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  ready_at      timestamptz,
  PRIMARY KEY (workspace_id, tz)
);

CREATE TABLE metric_rollup_days (
  workspace_id       uuid NOT NULL,
  tz                 text NOT NULL,
  source             text NOT NULL CHECK (source IN ('provider','simulated','synthetic')),
  local_date         date NOT NULL,
  connection_id      uuid NOT NULL,
  metric_key         text NOT NULL,
  definition_version integer NOT NULL,
  dimension          text NOT NULL DEFAULT '',
  brand_id           uuid NOT NULL,
  provider           provider_kind NOT NULL,
  value_sum          numeric NOT NULL,
  resources          integer NOT NULL,
  min_through_at     timestamptz,
  min_observed_at    timestamptz,
  max_observed_at    timestamptz,
  PRIMARY KEY (workspace_id, tz, source, local_date, connection_id, metric_key, definition_version, dimension),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connections(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, tz) REFERENCES metric_summary_zones(workspace_id, tz) ON DELETE CASCADE
);
CREATE INDEX metric_rollup_days_conn_idx ON metric_rollup_days(workspace_id, connection_id, source);

-- Recompute the given (workspace, connection, source, bucket) set for every tracked zone of those workspaces (or one zone).
-- Locks one advisory key per (workspace, tz, connection, source) in a fixed order (no deadlocks between writers);
-- each statement below takes a fresh snapshot after the locks (READ COMMITTED), so concurrent writers serialize.
CREATE FUNCTION metric_rollup_days_refresh(p_ws uuid[], p_conn uuid[], p_source text[], p_bucket timestamptz[], p_tz text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('rollup-days:' || k.workspace_id || ':' || k.tz || ':' || k.connection_id || ':' || k.source, 0))
     FROM (SELECT DISTINCT b.ws AS workspace_id, z.tz, b.conn AS connection_id, b.src AS source
             FROM unnest(p_ws, p_conn, p_source, p_bucket) AS b(ws, conn, src, bucket)
             JOIN metric_summary_zones z ON z.workspace_id = b.ws AND (p_tz IS NULL OR z.tz = p_tz)
            ORDER BY 1, 2, 3, 4) k;
  -- Recompute every local day in [first, last] changed day per (zone, connection, source): one index range scan per group
  -- (a bulk rebuild touches every day anyway; a single ingest touches one day). Unchanged days in between are
  -- recomputed to the same values.
  WITH grp AS (
    SELECT b.ws, z.tz, b.conn, b.src, min((b.bucket AT TIME ZONE z.tz)::date) AS d0, max((b.bucket AT TIME ZONE z.tz)::date) AS d1
      FROM unnest(p_ws, p_conn, p_source, p_bucket) AS b(ws, conn, src, bucket)
      JOIN metric_summary_zones z ON z.workspace_id = b.ws AND (p_tz IS NULL OR z.tz = p_tz)
     GROUP BY 1, 2, 3, 4)
  DELETE FROM metric_rollup_days m USING grp g
   WHERE m.workspace_id = g.ws AND m.tz = g.tz AND m.source = g.src AND m.connection_id = g.conn AND m.local_date BETWEEN g.d0 AND g.d1;
  WITH grp AS (
    SELECT b.ws, z.tz, b.conn, b.src, min((b.bucket AT TIME ZONE z.tz)::date) AS d0, max((b.bucket AT TIME ZONE z.tz)::date) AS d1
      FROM unnest(p_ws, p_conn, p_source, p_bucket) AS b(ws, conn, src, bucket)
      JOIN metric_summary_zones z ON z.workspace_id = b.ws AND (p_tz IS NULL OR z.tz = p_tz)
     GROUP BY 1, 2, 3, 4)
  INSERT INTO metric_rollup_days(workspace_id, tz, source, local_date, connection_id, metric_key, definition_version, dimension, brand_id, provider,
                                 value_sum, resources, min_through_at, min_observed_at, max_observed_at)
  SELECT g.ws, g.tz, g.src, (r.bucket_start AT TIME ZONE g.tz)::date, r.connection_id, r.metric_key, r.definition_version, r.dimension,
         min(r.brand_id::text)::uuid, min(r.provider::text)::provider_kind,
         sum(r.value_sum), sum(r.resources), min(r.min_through_at), min(r.min_observed_at), max(r.max_observed_at)
    FROM grp g
    JOIN metric_rollups r ON r.workspace_id = g.ws AND r.connection_id = g.conn AND r.source = g.src
                         -- index range wide enough for any UTC offset (±14 h) and 25-hour days; the expression decides
                         AND r.bucket_start >= (g.d0 - 2)::timestamp AT TIME ZONE 'UTC' AND r.bucket_start < (g.d1 + 3)::timestamp AT TIME ZONE 'UTC'
   WHERE (r.bucket_start AT TIME ZONE g.tz)::date BETWEEN g.d0 AND g.d1
   GROUP BY g.ws, g.tz, g.src, 4, r.connection_id, r.metric_key, r.definition_version, r.dimension;
END $$;

CREATE FUNCTION metric_rollups_days_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ws uuid[]; conn uuid[]; src text[]; bucket timestamptz[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT array_agg(workspace_id), array_agg(connection_id), array_agg(source), array_agg(bucket_start) INTO ws, conn, src, bucket
      FROM (SELECT DISTINCT workspace_id, connection_id, source, bucket_start FROM old_rows o
             WHERE EXISTS (SELECT 1 FROM metric_summary_zones z WHERE z.workspace_id = o.workspace_id)) x;
  ELSIF TG_OP = 'INSERT' THEN
    SELECT array_agg(workspace_id), array_agg(connection_id), array_agg(source), array_agg(bucket_start) INTO ws, conn, src, bucket
      FROM (SELECT DISTINCT workspace_id, connection_id, source, bucket_start FROM new_rows n
             WHERE EXISTS (SELECT 1 FROM metric_summary_zones z WHERE z.workspace_id = n.workspace_id)) x;
  ELSE
    SELECT array_agg(workspace_id), array_agg(connection_id), array_agg(source), array_agg(bucket_start) INTO ws, conn, src, bucket
      FROM (SELECT workspace_id, connection_id, source, bucket_start FROM old_rows
            UNION SELECT workspace_id, connection_id, source, bucket_start FROM new_rows) x
     WHERE EXISTS (SELECT 1 FROM metric_summary_zones z WHERE z.workspace_id = x.workspace_id);
  END IF;
  IF ws IS NOT NULL THEN PERFORM metric_rollup_days_refresh(ws, conn, src, bucket); END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER metric_rollups_days_ins AFTER INSERT ON metric_rollups REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION metric_rollups_days_trigger();
CREATE TRIGGER metric_rollups_days_del AFTER DELETE ON metric_rollups REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION metric_rollups_days_trigger();
CREATE TRIGGER metric_rollups_days_upd AFTER UPDATE ON metric_rollups REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION metric_rollups_days_trigger();

-- Track the workspace and brand time zones (new ones start 'pending'; the worker backfills them).
CREATE FUNCTION metric_summary_track_workspace_zone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO metric_summary_zones(workspace_id, tz) VALUES (NEW.id, NEW.timezone) ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
CREATE FUNCTION metric_summary_track_brand_zone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO metric_summary_zones(workspace_id, tz) VALUES (NEW.workspace_id, NEW.timezone) ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER workspaces_summary_zone AFTER INSERT OR UPDATE OF timezone ON workspaces FOR EACH ROW EXECUTE FUNCTION metric_summary_track_workspace_zone();
CREATE TRIGGER brands_summary_zone AFTER INSERT OR UPDATE OF timezone ON brands FOR EACH ROW EXECUTE FUNCTION metric_summary_track_brand_zone();

INSERT INTO metric_summary_zones(workspace_id, tz)
SELECT id, timezone FROM workspaces UNION SELECT workspace_id, timezone FROM brands
ON CONFLICT DO NOTHING;

-- Analytics post scope (postStates, content table, per-post aggregation): published deliveries of the selected
-- connections in a period. The 020-era (workspace_id, published_at, connection_id) index scans every published delivery
-- of the workspace in the range and filters by connection (Large, 365 d: 191,822 rows read for 14,568 kept).
CREATE INDEX deliveries_conn_published_idx ON deliveries(connection_id, published_at) WHERE state = 'published';
