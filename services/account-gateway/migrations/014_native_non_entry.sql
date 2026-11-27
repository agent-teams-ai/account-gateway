-- New reservations alone may negotiate finite non-entry evidence. Existing
-- rejection/occupancy rows are never upgraded, and no request allowance refunds.
BEGIN;
SET LOCAL search_path = ag_kernel, pg_catalog;
ALTER TABLE requests ADD COLUMN non_entry_negotiated boolean NOT NULL DEFAULT false;
ALTER TABLE requests ADD COLUMN non_entry_reason text;
ALTER TABLE requests ADD CONSTRAINT requests_non_entry_capability CHECK (
  NOT non_entry_negotiated OR (
    native_origin_ref IS NOT NULL AND engine_incarnation IS NOT NULL
    AND request_nonce IS NOT NULL AND descriptor_generation IS NOT NULL
    AND closure_token IS NOT NULL AND worker IS NOT NULL
  )
);
ALTER TABLE requests ADD CONSTRAINT requests_non_entry_reason CHECK (
  non_entry_reason IS NULL OR (
    non_entry_negotiated AND non_entry_reason='admission_storage_conflict'
    AND effect='rejected_before_dispatch'
  )
);
CREATE FUNCTION immutable_native_non_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.non_entry_reason IS NOT NULL THEN
      RAISE EXCEPTION 'non-entry requires original settlement' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.non_entry_negotiated IS DISTINCT FROM OLD.non_entry_negotiated THEN
      RAISE EXCEPTION 'immutable non-entry negotiation' USING ERRCODE = '23514';
    END IF;
    IF NEW.non_entry_reason IS DISTINCT FROM OLD.non_entry_reason AND NOT (
      OLD.effect='dispatch_started' AND NEW.effect='rejected_before_dispatch'
      AND OLD.non_entry_reason IS NULL AND OLD.non_entry_negotiated
      AND NEW.non_entry_reason IS NOT NULL
      AND NEW.non_entry_reason='admission_storage_conflict'
    ) THEN
      RAISE EXCEPTION 'immutable original non-entry reason' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER requests_non_entry BEFORE INSERT OR UPDATE ON requests
  FOR EACH ROW EXECUTE FUNCTION immutable_native_non_entry();
COMMIT;
