-- Preserve011 checksums and retirement/fact authority. Select the candidate
-- namespaces once: repeating the computed-order eligibility scan per namespace
-- magnifies maintenance cost while the consumer lock is held. LIMIT bounds
-- selected namespaces; the physical eligibility scan is not bounded by batch.
BEGIN;
SET LOCAL search_path = ag_kernel, pg_catalog;
CREATE OR REPLACE FUNCTION retire_closed_request_details(who text, batch integer) RETURNS integer
  LANGUAGE plpgsql SET search_path=ag_kernel,pg_catalog AS $$
DECLARE e executions%ROWTYPE; doomed text[]; removed integer; total_removed integer=0;
  refunds jsonb='{}'::jsonb;
BEGIN
  IF batch<1 OR batch>1000 THEN RAISE EXCEPTION 'invalid retirement batch' USING ERRCODE='23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(who,908417));
  PERFORM 1 FROM consumers WHERE consumer=who FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing retirement consumer' USING ERRCODE='23514'; END IF;
  FOR e IN
    SELECT x.* FROM executions x JOIN cleanup j ON j.consumer=x.consumer AND j.execution_ref=x.ref
      WHERE x.consumer=who AND x.state<>'open' AND x.closed_at IS NOT NULL
        AND x.request_details_drained_at IS NULL AND x.request_readback_retention_ms IS NOT NULL
        AND j.state='done' AND j.done_at IS NOT NULL
        AND greatest(x.closed_at,j.done_at)+x.request_readback_retention_ms*interval '1 millisecond'<=clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.consumer=x.consumer AND r.execution_ref=x.ref
          AND (r.transport_occupied OR r.effect NOT IN ('not_dispatched','completed','rejected_before_dispatch')
            OR (r.effect<>'not_dispatched' AND (NOT r.namespace_bound OR r.closure_acked_at IS NULL))))
      ORDER BY (x.request_details_retired_at IS NULL),greatest(x.closed_at,j.done_at),x.ref LIMIT batch
  LOOP
    EXIT WHEN total_removed>=batch;
    PERFORM 1 FROM accounts WHERE consumer=who AND ref=e.account_ref FOR UPDATE;
    IF e.request_details_retired_at IS NULL THEN
      UPDATE executions SET request_details_retired_at=clock_timestamp() WHERE consumer=who AND ref=e.ref;
    END IF;
    SELECT array_agg(r.id) INTO doomed FROM (SELECT id FROM requests WHERE consumer=who AND execution_ref=e.ref
      ORDER BY id LIMIT batch-total_removed) r;
    IF doomed IS NOT NULL THEN
      DELETE FROM usage_observations WHERE consumer=who AND execution_ref=e.ref AND request_ref=ANY(doomed);
      DELETE FROM requests WHERE consumer=who AND execution_ref=e.ref AND id=ANY(doomed);
      GET DIAGNOSTICS removed=ROW_COUNT;
      total_removed=total_removed+removed;
      refunds=jsonb_set(refunds,ARRAY[e.account_ref::text],
        to_jsonb(coalesce((refunds->>e.account_ref::text)::integer,0)+removed),true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM requests WHERE consumer=who AND execution_ref=e.ref) THEN
      UPDATE executions SET request_details_drained_at=clock_timestamp() WHERE consumer=who AND ref=e.ref;
    END IF;
  END LOOP;
  IF total_removed>0 THEN
    -- Every account referenced below was locked above, before this shared row.
    UPDATE fact_budget SET used=used-total_removed WHERE singleton;
    UPDATE consumers SET fact_used=fact_used-total_removed WHERE consumer=who;
    UPDATE accounts a SET fact_used=a.fact_used-refund.units::integer
      FROM jsonb_each_text(refunds) AS refund(account_ref,units)
      WHERE a.consumer=who AND a.ref=refund.account_ref::uuid;
  END IF;
  RETURN total_removed;
END;
$$;
COMMIT;
