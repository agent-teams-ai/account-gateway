-- Apply after009 with old writers stopped. Retirement is opt-in on each NEW
-- execution. Legacy rows retain their complete readback/replay authority.
BEGIN;
SET LOCAL search_path = ag_kernel, pg_catalog;
ALTER TABLE executions ADD COLUMN request_readback_retention_ms bigint
  CHECK (request_readback_retention_ms BETWEEN 1 AND 31536000000);
ALTER TABLE executions ADD COLUMN closed_at timestamptz;
ALTER TABLE executions ADD COLUMN request_details_retired_at timestamptz;
ALTER TABLE cleanup ADD COLUMN done_at timestamptz;
ALTER TABLE requests ADD COLUMN namespace_bound boolean NOT NULL DEFAULT false;
ALTER TABLE requests ADD COLUMN closure_acked_at timestamptz;
UPDATE executions SET closed_at=clock_timestamp() WHERE state<>'open';
UPDATE cleanup SET done_at=clock_timestamp() WHERE state='done';

CREATE FUNCTION request_bound_nonce(who text, origin text, incarnation uuid, execution uuid, request text)
  RETURNS uuid LANGUAGE sql IMMUTABLE STRICT SET search_path=ag_kernel,pg_catalog AS $$
  WITH hashed AS (
    SELECT sha256(convert_to('account-gateway/native-reservation/v2','UTF8') || '\x00'::bytea
      || convert_to(who,'UTF8') || '\x00'::bytea || convert_to(origin,'UTF8') || '\x00'::bytea
      || convert_to(incarnation::text,'UTF8') || '\x00'::bytea
      || convert_to(execution::text,'UTF8') || '\x00'::bytea || convert_to(request,'UTF8')) AS h
  ) SELECT encode(set_byte(set_byte(substring(h FROM 1 FOR 16),6,(get_byte(h,6)&15)|128),
      8,(get_byte(h,8)&63)|128),'hex')::uuid FROM hashed;
$$;

CREATE FUNCTION retain_execution_namespace() RETURNS trigger LANGUAGE plpgsql SET search_path=ag_kernel,pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.request_details_retired_at IS NOT NULL THEN
      RAISE EXCEPTION 'new execution namespace retired' USING ERRCODE='23514';
    END IF;
    NEW.closed_at=CASE WHEN NEW.state<>'open' THEN clock_timestamp() ELSE NULL END;
  ELSE
    IF NEW.request_readback_retention_ms IS DISTINCT FROM OLD.request_readback_retention_ms
        OR (OLD.state<>'open' AND NEW.state='open')
        OR (OLD.request_details_retired_at IS NOT NULL
          AND NEW.request_details_retired_at IS DISTINCT FROM OLD.request_details_retired_at) THEN
      RAISE EXCEPTION 'immutable execution namespace' USING ERRCODE='23514';
    END IF;
    IF OLD.closed_at IS NULL AND NEW.state<>'open' THEN NEW.closed_at=clock_timestamp();
    ELSIF NEW.closed_at IS DISTINCT FROM OLD.closed_at THEN
      RAISE EXCEPTION 'immutable execution closure' USING ERRCODE='23514';
    END IF;
    IF NEW.request_details_retired_at IS NOT NULL AND NEW.state='open' THEN
      RAISE EXCEPTION 'open execution namespace retired' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER executions_namespace BEFORE INSERT OR UPDATE ON executions
  FOR EACH ROW EXECUTE FUNCTION retain_execution_namespace();

CREATE FUNCTION retain_cleanup_completion() RETURNS trigger LANGUAGE plpgsql SET search_path=ag_kernel,pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.done_at=CASE WHEN NEW.state='done' THEN clock_timestamp() ELSE NULL END;
  ELSIF OLD.state<>'done' AND NEW.state='done' THEN NEW.done_at=clock_timestamp();
  ELSIF NEW.done_at IS DISTINCT FROM OLD.done_at OR (OLD.state='done' AND NEW.state<>'done') THEN
    RAISE EXCEPTION 'immutable cleanup completion' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cleanup_completion BEFORE INSERT OR UPDATE ON cleanup
  FOR EACH ROW EXECUTE FUNCTION retain_cleanup_completion();

CREATE FUNCTION retain_request_namespace() RETURNS trigger LANGUAGE plpgsql SET search_path=ag_kernel,pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF EXISTS (SELECT 1 FROM executions WHERE consumer=NEW.consumer AND ref=NEW.execution_ref
        AND request_details_retired_at IS NOT NULL) THEN
      RAISE EXCEPTION 'retired request namespace' USING ERRCODE='23514';
    END IF;
    NEW.namespace_bound=coalesce(NEW.request_nonce=request_bound_nonce(NEW.consumer,NEW.native_origin_ref,
      NEW.engine_incarnation,NEW.execution_ref,NEW.id),false);
    IF substring(NEW.request_nonce::text FROM 15 FOR 1)='8' AND NOT NEW.namespace_bound THEN
      RAISE EXCEPTION 'invalid bound reservation' USING ERRCODE='23514';
    END IF;
    NEW.closure_acked_at=NULL;
  ELSE
    IF NEW.namespace_bound IS DISTINCT FROM OLD.namespace_bound THEN
      RAISE EXCEPTION 'immutable request namespace' USING ERRCODE='23514';
    END IF;
    IF OLD.transport_occupied AND NOT NEW.transport_occupied THEN NEW.closure_acked_at=clock_timestamp();
    ELSIF NEW.closure_acked_at IS DISTINCT FROM OLD.closure_acked_at THEN
      RAISE EXCEPTION 'immutable request closure observation' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER requests_namespace BEFORE INSERT OR UPDATE ON requests
  FOR EACH ROW EXECUTE FUNCTION retain_request_namespace();

-- Closed execution rows and stable prepare intent hashes remain the irreversible
-- replay namespace. Only detailed positively settled request/usage rows expire.
-- The marker hides the complete namespace before bounded physical reclamation.
CREATE FUNCTION retire_closed_request_details(who text, batch integer) RETURNS integer
  LANGUAGE plpgsql SET search_path=ag_kernel,pg_catalog AS $$
DECLARE e executions%ROWTYPE; doomed text[]; removed integer;
BEGIN
  IF batch<1 OR batch>1000 THEN RAISE EXCEPTION 'invalid retirement batch' USING ERRCODE='23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(who,908417));
  PERFORM 1 FROM consumers WHERE consumer=who FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing retirement consumer' USING ERRCODE='23514'; END IF;
  SELECT x.* INTO e FROM executions x JOIN cleanup j ON j.consumer=x.consumer AND j.execution_ref=x.ref
    WHERE x.consumer=who AND x.state<>'open' AND x.closed_at IS NOT NULL
      AND x.request_readback_retention_ms IS NOT NULL AND j.state='done' AND j.done_at IS NOT NULL
      AND greatest(x.closed_at,j.done_at)+x.request_readback_retention_ms*interval '1 millisecond'<=clock_timestamp()
      AND (x.request_details_retired_at IS NULL OR EXISTS (SELECT 1 FROM requests r
        WHERE r.consumer=x.consumer AND r.execution_ref=x.ref))
      AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.consumer=x.consumer AND r.execution_ref=x.ref
        AND (r.transport_occupied OR r.effect NOT IN ('not_dispatched','completed','rejected_before_dispatch')
          OR (r.effect<>'not_dispatched' AND (NOT r.namespace_bound OR r.closure_acked_at IS NULL))))
    ORDER BY (x.request_details_retired_at IS NULL),greatest(x.closed_at,j.done_at),x.ref LIMIT 1;
  IF NOT FOUND THEN RETURN 0; END IF;
  PERFORM 1 FROM accounts WHERE consumer=who AND ref=e.account_ref FOR UPDATE;
  IF e.request_details_retired_at IS NULL THEN
    UPDATE executions SET request_details_retired_at=clock_timestamp() WHERE consumer=who AND ref=e.ref;
  END IF;
  SELECT array_agg(r.id) INTO doomed FROM (SELECT id FROM requests WHERE consumer=who AND execution_ref=e.ref
    ORDER BY id LIMIT batch) r;
  IF doomed IS NULL THEN RETURN 0; END IF;
  DELETE FROM usage_observations WHERE consumer=who AND execution_ref=e.ref AND request_ref=ANY(doomed);
  DELETE FROM requests WHERE consumer=who AND execution_ref=e.ref AND id=ANY(doomed);
  GET DIAGNOSTICS removed=ROW_COUNT;
  -- Every deleted request charged exactly one fact. There is no release for a
  -- retained execution, operation, issuer, uncertain effect or occupied proof.
  UPDATE fact_budget SET used=used-removed WHERE singleton;
  UPDATE consumers SET fact_used=fact_used-removed WHERE consumer=who;
  UPDATE accounts SET fact_used=fact_used-removed WHERE consumer=who AND ref=e.account_ref;
  RETURN removed;
END;
$$;
CREATE INDEX executions_request_retirement ON executions(consumer,closed_at,ref)
  WHERE request_readback_retention_ms IS NOT NULL AND state<>'open';
REVOKE ALL ON FUNCTION retire_closed_request_details(text,integer) FROM PUBLIC;
COMMIT;
