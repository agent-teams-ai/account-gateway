-- Additive facts on the existing immutable management journal. No secret inputs.
BEGIN;
ALTER TABLE ag_management.candidate_journal ADD COLUMN connection_snapshot jsonb
  CHECK (connection_snapshot IS NULL OR (
    jsonb_typeof(connection_snapshot)='object' AND octet_length(connection_snapshot::text)<=131072
    AND connection_snapshot->'connection'->>'profileId'=profile));
ALTER TABLE ag_management.physical_mappings ADD COLUMN publication jsonb
  CHECK (publication IS NULL OR (jsonb_typeof(publication)='object' AND octet_length(publication::text)<=4096));

CREATE FUNCTION ag_management.validate_connection_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE accepted jsonb; saved jsonb;
BEGIN
  IF TG_TABLE_NAME='candidate_journal' THEN
    SELECT intent->'connection' INTO accepted FROM ag_kernel.operations
      WHERE consumer=NEW.consumer AND id=NEW.operation_id AND account_ref=NEW.account_ref;
    IF accepted IS DISTINCT FROM NEW.connection_snapshot THEN
      RAISE EXCEPTION 'connection selection mismatch' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT connection_snapshot INTO saved FROM ag_management.candidate_journal
      WHERE consumer=NEW.consumer AND generation=NEW.generation;
    IF (saved IS NULL) IS DISTINCT FROM (NEW.publication IS NULL)
      OR (saved IS NOT NULL AND (NEW.publication->'connection' IS DISTINCT FROM saved->'connection'
        OR NOT COALESCE(saved->'method'->'allowedCredentialPolicies' ? (NEW.publication->'credential'->>'credentialPolicy'), false))) THEN
      RAISE EXCEPTION 'connection publication mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER journal_connection_binding BEFORE INSERT ON ag_management.candidate_journal
  FOR EACH ROW EXECUTE FUNCTION ag_management.validate_connection_binding();
CREATE TRIGGER mapping_connection_binding BEFORE INSERT ON ag_management.physical_mappings
  FOR EACH ROW EXECUTE FUNCTION ag_management.validate_connection_binding();
REVOKE ALL ON FUNCTION ag_management.validate_connection_binding() FROM PUBLIC;
COMMIT;
