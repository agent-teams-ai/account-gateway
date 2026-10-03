-- Apply once after unchanged 001/002 with old writers stopped. Legacy rows
-- retain their exact occupancy/token and NULL native binding; no backfill permit.
BEGIN;
SET LOCAL search_path = ag_kernel, pg_catalog;
ALTER TABLE requests ADD COLUMN native_origin_ref text;
ALTER TABLE requests ADD COLUMN engine_incarnation uuid;
ALTER TABLE requests ADD COLUMN request_nonce uuid;
ALTER TABLE requests ADD COLUMN descriptor_generation uuid;
ALTER TABLE requests DROP CONSTRAINT requests_effect_check;
ALTER TABLE requests ADD CONSTRAINT requests_effect_check CHECK (
  effect IN ('not_dispatched','dispatch_started','response_started','completed','effect_unknown','rejected_before_dispatch')
);
ALTER TABLE requests ADD CONSTRAINT requests_native_binding CHECK (
  (native_origin_ref IS NULL AND engine_incarnation IS NULL AND request_nonce IS NULL AND descriptor_generation IS NULL)
  OR (native_origin_ref IS NOT NULL AND engine_incarnation IS NOT NULL AND request_nonce IS NOT NULL
    AND descriptor_generation IS NOT NULL AND closure_token IS NOT NULL AND worker IS NOT NULL
    AND length(native_origin_ref) BETWEEN 1 AND 128 AND native_origin_ref ~ '^[a-zA-Z0-9_.:-]+$'
    AND effect <> 'not_dispatched')
);
ALTER TABLE requests ADD CONSTRAINT requests_rejection_proof CHECK (
  effect <> 'rejected_before_dispatch' OR native_origin_ref IS NOT NULL
);
CREATE FUNCTION immutable_native_dispatch_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.native_origin_ref,NEW.engine_incarnation,NEW.request_nonce,NEW.descriptor_generation)
        IS DISTINCT FROM ROW(OLD.native_origin_ref,OLD.engine_incarnation,OLD.request_nonce,OLD.descriptor_generation) THEN
      RAISE EXCEPTION 'immutable native dispatch binding' USING ERRCODE = '23514';
    END IF;
    IF (OLD.effect = 'rejected_before_dispatch' AND NEW.effect <> OLD.effect)
        OR (NEW.effect = 'rejected_before_dispatch' AND OLD.effect NOT IN ('dispatch_started','rejected_before_dispatch')) THEN
      RAISE EXCEPTION 'terminal native rejection' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.native_origin_ref IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM ag_kernel.executions e WHERE e.consumer=NEW.consumer AND e.ref=NEW.execution_ref AND e.generation=NEW.descriptor_generation
  ) THEN
    RAISE EXCEPTION 'native dispatch generation mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER requests_native_binding BEFORE INSERT OR UPDATE ON requests
  FOR EACH ROW EXECUTE FUNCTION immutable_native_dispatch_binding();
-- A spent reservation remains a replay tombstone after exact closure/restore.
CREATE UNIQUE INDEX requests_native_reservation ON requests
  (consumer,native_origin_ref,engine_incarnation,request_nonce) WHERE native_origin_ref IS NOT NULL;
COMMIT;
