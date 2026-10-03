-- Private credential custody, not an admission/dispatch ledger. Keys live outside DB/backup.
BEGIN;
CREATE SCHEMA ag_management;
REVOKE ALL ON SCHEMA ag_management FROM PUBLIC;
SET LOCAL search_path = ag_management, pg_catalog;
CREATE TABLE transient_intents (
  consumer text NOT NULL, operation_id text NOT NULL, account_ref uuid NOT NULL,
  owner_ref text NOT NULL, purpose text NOT NULL CHECK (purpose IN ('create','reconnect')),
  nonce bytea, ciphertext bytea, tag bytea,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
  PRIMARY KEY (consumer, operation_id),
  FOREIGN KEY (consumer, operation_id) REFERENCES ag_kernel.operations(consumer,id),
  FOREIGN KEY (consumer, account_ref) REFERENCES ag_kernel.accounts(consumer,ref),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '5 minutes'),
  CHECK ((nonce IS NULL AND ciphertext IS NULL AND tag IS NULL) OR
    (nonce IS NOT NULL AND tag IS NOT NULL AND ciphertext IS NOT NULL AND
      octet_length(nonce)=12 AND octet_length(tag)=16 AND octet_length(ciphertext) BETWEEN 1 AND 4096))
);
CREATE TABLE candidate_journal (
  consumer text NOT NULL, operation_id text NOT NULL, account_ref uuid NOT NULL,
  owner_ref text NOT NULL, purpose text NOT NULL CHECK (purpose IN ('create','reconnect')),
  generation uuid NOT NULL, worker uuid NOT NULL,
  profile text NOT NULL CHECK (length(profile) BETWEEN 1 AND 64),
  base_url text NOT NULL CHECK (length(base_url) BETWEEN 1 AND 2048),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 128),
  qualification_ref text NOT NULL CHECK (length(qualification_ref) BETWEEN 1 AND 128),
  PRIMARY KEY (consumer, generation), UNIQUE (consumer, operation_id),
  FOREIGN KEY (consumer,generation,account_ref) REFERENCES ag_kernel.candidates(consumer,generation,account_ref),
  FOREIGN KEY (consumer,operation_id) REFERENCES ag_kernel.operations(consumer,id),
  FOREIGN KEY (consumer,worker) REFERENCES ag_kernel.workers(consumer,worker)
);
CREATE TABLE physical_mappings (
  consumer text NOT NULL, generation uuid NOT NULL,
  native_physical_identity uuid NOT NULL UNIQUE,
  native_id bigint NOT NULL CHECK (native_id BETWEEN 1 AND 9007199254740991),
  -- TEXT is intentional: PostgreSQL timestamptz / JS Date would truncate precision.
  native_created_at text NOT NULL CHECK (length(native_created_at) BETWEEN 20 AND 64),
  PRIMARY KEY (consumer,generation), UNIQUE (native_id,native_created_at),
  FOREIGN KEY (consumer,generation) REFERENCES candidate_journal(consumer,generation),
  CHECK (native_physical_identity=generation)
);
-- Independent FKs cannot bind an operation to its account, owner and consumed candidate.
CREATE FUNCTION validate_private_parent_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent ag_kernel.candidates%ROWTYPE;
BEGIN
  SELECT c.* INTO parent FROM ag_kernel.operations o
    JOIN ag_kernel.accounts a ON a.consumer=o.consumer AND a.ref=o.account_ref
    JOIN ag_kernel.candidates c ON c.consumer=o.consumer AND c.operation_id=o.id
      AND c.account_ref=a.ref AND c.profile=a.profile
    WHERE o.consumer=NEW.consumer AND o.id=NEW.operation_id AND o.state='pending'
      AND a.ref=NEW.account_ref AND a.owner_ref=NEW.owner_ref AND o.intent->>'kind'=NEW.purpose
      AND ((NEW.purpose='create' AND o.intent->>'owner'=a.owner_ref AND o.intent->>'profile'=c.profile)
        OR (NEW.purpose='reconnect' AND o.intent->>'target'=a.ref::text));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid private parent scope' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='candidate_journal' THEN
    IF parent.state<>'creating' OR parent.generation IS DISTINCT FROM NEW.generation
      OR parent.worker IS DISTINCT FROM NEW.worker OR parent.profile IS DISTINCT FROM NEW.profile THEN
      RAISE EXCEPTION 'invalid private candidate scope' USING ERRCODE='23514';
    END IF;
  ELSIF parent.state<>'staged' THEN
    RAISE EXCEPTION 'invalid private intent scope' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER intent_parent_scope BEFORE INSERT ON transient_intents
  FOR EACH ROW EXECUTE FUNCTION validate_private_parent_scope();
CREATE TRIGGER journal_parent_scope BEFORE INSERT ON candidate_journal
  FOR EACH ROW EXECUTE FUNCTION validate_private_parent_scope();
CREATE FUNCTION immutable_private_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'immutable private binding' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER journal_immutable BEFORE UPDATE ON candidate_journal
  FOR EACH ROW EXECUTE FUNCTION immutable_private_binding();
CREATE TRIGGER mapping_immutable BEFORE UPDATE ON physical_mappings
  FOR EACH ROW EXECUTE FUNCTION immutable_private_binding();
CREATE FUNCTION immutable_intent_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.consumer,NEW.operation_id,NEW.account_ref,NEW.owner_ref,NEW.purpose,NEW.created_at,NEW.expires_at)
      IS DISTINCT FROM (OLD.consumer,OLD.operation_id,OLD.account_ref,OLD.owner_ref,OLD.purpose,OLD.created_at,OLD.expires_at)
      OR (OLD.ciphertext IS NULL AND NEW.ciphertext IS NOT NULL)
      OR (NEW.ciphertext IS NOT NULL AND (NEW.nonce,NEW.ciphertext,NEW.tag)
        IS DISTINCT FROM (OLD.nonce,OLD.ciphertext,OLD.tag)) THEN
    RAISE EXCEPTION 'immutable transient scope' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER intent_scope BEFORE UPDATE ON transient_intents
  FOR EACH ROW EXECUTE FUNCTION immutable_intent_scope();
CREATE INDEX intents_expiry ON transient_intents(consumer,expires_at) WHERE ciphertext IS NOT NULL;
REVOKE ALL ON ALL TABLES IN SCHEMA ag_management FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ag_management FROM PUBLIC;
COMMIT;
