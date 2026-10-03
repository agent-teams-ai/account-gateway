-- Apply once after unchanged 001, with all old writers stopped. No inferred
-- closure: even legacy completed effects may own an open local transport.
BEGIN;
SET LOCAL search_path = ag_kernel, pg_catalog;
ALTER TABLE requests ADD COLUMN transport_occupied boolean NOT NULL DEFAULT true;
ALTER TABLE requests ADD COLUMN closure_token uuid;
UPDATE requests SET transport_occupied=false WHERE effect='not_dispatched';
-- An accepted insert omitting the new field must retain conservative occupancy.
-- Denied requests explicitly insert false; omission must never free capacity.
ALTER TABLE requests ALTER COLUMN transport_occupied SET DEFAULT true;
ALTER TABLE requests ADD CONSTRAINT requests_transport_proof CHECK (
  (effect <> 'not_dispatched' OR (NOT transport_occupied AND closure_token IS NULL))
  AND (closure_token IS NULL OR worker IS NOT NULL)
);
-- Legacy accepted rows deliberately have no token. Exact reset after independently
-- proved transport closure requires separate authority; this migration grants none.
-- Keep the entire proof binding permanent, including legacy NULL tokens. A
-- future adapter must not move a proof onto a newer request, rotate its owner
-- or reopen an independently acknowledged closed transport.
CREATE FUNCTION immutable_request_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.consumer,NEW.execution_ref,NEW.id,NEW.worker,NEW.closure_token)
      IS DISTINCT FROM ROW(OLD.consumer,OLD.execution_ref,OLD.id,OLD.worker,OLD.closure_token)
      OR (NOT OLD.transport_occupied AND NEW.transport_occupied) THEN
    RAISE EXCEPTION 'immutable request closure binding' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER requests_binding BEFORE UPDATE ON requests
  FOR EACH ROW EXECUTE FUNCTION immutable_request_binding();
CREATE INDEX requests_occupied ON requests(consumer,execution_ref,id) WHERE transport_occupied;
CREATE INDEX executions_account_all ON executions(consumer,account_ref,ref);
COMMIT;
