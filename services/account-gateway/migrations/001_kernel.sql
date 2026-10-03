-- Dedicated PostgreSQL 17 database; no RR tables or credential/payload storage.
BEGIN;
CREATE SCHEMA ag_kernel;
SET LOCAL search_path = ag_kernel, pg_catalog;
CREATE TABLE consumers (
  consumer text PRIMARY KEY CHECK (length(consumer) BETWEEN 1 AND 128),
  issuer uuid NOT NULL DEFAULT gen_random_uuid()
);
CREATE TABLE issuer_epochs (
  consumer text NOT NULL REFERENCES consumers, issuer uuid NOT NULL, PRIMARY KEY (consumer, issuer)
);
CREATE TABLE workers (
  consumer text NOT NULL REFERENCES consumers, worker uuid NOT NULL,
  lease_until timestamptz NOT NULL, PRIMARY KEY (consumer, worker)
);
CREATE TABLE accounts (
  consumer text NOT NULL REFERENCES consumers, ref uuid NOT NULL,
  owner_ref text NOT NULL CHECK (length(owner_ref) BETWEEN 1 AND 128),
  profile text NOT NULL CHECK (length(profile) BETWEEN 1 AND 64),
  display_name text NOT NULL CHECK (length(display_name) <= 160),
  state text NOT NULL CHECK (state IN ('staging','active','disabled','quarantined')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  epoch integer NOT NULL DEFAULT 1 CHECK (epoch > 0), active_generation uuid,
  PRIMARY KEY (consumer, ref), CHECK (state <> 'active' OR active_generation IS NOT NULL)
);
CREATE FUNCTION immutable_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_ref IS DISTINCT FROM OLD.owner_ref THEN
    RAISE EXCEPTION 'immutable owner' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER accounts_owner BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION immutable_owner();
CREATE TABLE operations (
  consumer text NOT NULL REFERENCES consumers, id text NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  -- Fixed positive nonsecret shape assembled by the adapter, never an ingress body.
  intent jsonb NOT NULL, state text NOT NULL CHECK (state IN ('pending','applied','rejected','unknown')),
  account_ref uuid, execution_ref uuid, code text, revision integer, epoch integer,
  deadline timestamptz, PRIMARY KEY (consumer, id),
  FOREIGN KEY (consumer, account_ref) REFERENCES accounts(consumer, ref)
);
CREATE TABLE candidates (
  consumer text NOT NULL, generation uuid NOT NULL, account_ref uuid NOT NULL,
  operation_id text NOT NULL, profile text NOT NULL,
  expected_revision integer NOT NULL, expected_epoch integer NOT NULL, old_generation uuid,
  state text NOT NULL CHECK (state IN ('staged','creating','ready','quarantined','retired')),
  native_identity uuid, worker uuid,
  PRIMARY KEY (consumer, generation), UNIQUE (consumer, operation_id),
  UNIQUE (consumer, generation, account_ref), UNIQUE (consumer, native_identity),
  FOREIGN KEY (consumer, account_ref) REFERENCES accounts(consumer, ref),
  FOREIGN KEY (consumer, operation_id) REFERENCES operations(consumer, id),
  FOREIGN KEY (consumer, worker) REFERENCES workers(consumer, worker),
  CHECK (state <> 'ready' OR native_identity IS NOT NULL)
);
ALTER TABLE accounts ADD FOREIGN KEY (consumer, active_generation, ref)
  REFERENCES candidates(consumer, generation, account_ref) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE policy_fences (
  consumer text NOT NULL REFERENCES consumers, subject text NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991), fence uuid NOT NULL DEFAULT gen_random_uuid(),
  PRIMARY KEY (consumer, subject)
);
CREATE TABLE executions (
  consumer text NOT NULL REFERENCES consumers, ref uuid NOT NULL,
  invocation text NOT NULL, attempt_ref text NOT NULL CHECK (length(attempt_ref) BETWEEN 1 AND 128),
  intent jsonb NOT NULL, account_ref uuid NOT NULL, account_epoch integer NOT NULL CHECK (account_epoch > 0),
  profile text NOT NULL CHECK (length(profile) BETWEEN 1 AND 64),
  generation uuid NOT NULL, policy_subject text NOT NULL, policy_revision bigint NOT NULL CHECK (policy_revision BETWEEN 0 AND 9007199254740991),
  binding_revision bigint NOT NULL CHECK (binding_revision BETWEEN 0 AND 9007199254740991),
  issuer uuid NOT NULL, policy_fence uuid NOT NULL, deadline timestamptz NOT NULL,
  max_requests integer NOT NULL CHECK (max_requests BETWEEN 1 AND 10000),
  max_concurrent integer NOT NULL CHECK (max_concurrent BETWEEN 1 AND 128 AND max_concurrent <= max_requests),
  max_request_bytes integer NOT NULL CHECK (max_request_bytes BETWEEN 1 AND 16777216),
  max_output_bytes integer NOT NULL CHECK (max_output_bytes BETWEEN 1 AND 67108864),
  max_tokens integer NOT NULL CHECK (max_tokens BETWEEN 1 AND 10000000),
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0 AND request_count <= max_requests),
  state text NOT NULL CHECK (state IN ('open','closed','fenced')),
  PRIMARY KEY (consumer, ref), UNIQUE (consumer, invocation, attempt_ref),
  FOREIGN KEY (consumer, account_ref) REFERENCES accounts(consumer, ref),
  FOREIGN KEY (consumer, generation, account_ref) REFERENCES candidates(consumer, generation, account_ref),
  FOREIGN KEY (consumer, policy_subject) REFERENCES policy_fences(consumer, subject)
);
ALTER TABLE operations ADD FOREIGN KEY (consumer, execution_ref) REFERENCES executions(consumer, ref);
CREATE TABLE requests (
  consumer text NOT NULL, execution_ref uuid NOT NULL, id text NOT NULL,
  effect text NOT NULL CHECK (effect IN ('not_dispatched','dispatch_started','response_started','completed','effect_unknown')),
  code text, worker uuid, PRIMARY KEY (consumer, execution_ref, id),
  FOREIGN KEY (consumer, execution_ref) REFERENCES executions(consumer, ref),
  FOREIGN KEY (consumer, worker) REFERENCES workers(consumer, worker),
  CHECK (effect = 'not_dispatched' OR worker IS NOT NULL)
);
CREATE TABLE cleanup (
  consumer text NOT NULL REFERENCES consumers, ref uuid NOT NULL DEFAULT gen_random_uuid(),
  generation uuid, execution_ref uuid,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','done')),
  worker uuid, token uuid, lease_until timestamptz,
  PRIMARY KEY (consumer, ref), UNIQUE (consumer, generation), UNIQUE (consumer, execution_ref),
  FOREIGN KEY (consumer, generation) REFERENCES candidates(consumer, generation),
  FOREIGN KEY (consumer, execution_ref) REFERENCES executions(consumer, ref),
  FOREIGN KEY (consumer, worker) REFERENCES workers(consumer, worker),
  CHECK ((generation IS NULL) <> (execution_ref IS NULL)),
  CHECK (state <> 'claimed' OR (worker IS NOT NULL AND token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX accounts_owner_page ON accounts(consumer, owner_ref, ref);
CREATE INDEX requests_inflight ON requests(consumer, worker) WHERE effect IN ('dispatch_started','response_started');
CREATE INDEX cleanup_pending ON cleanup(consumer, state, lease_until);
CREATE INDEX executions_deadline ON executions(consumer, deadline) WHERE state = 'open';
COMMIT;
