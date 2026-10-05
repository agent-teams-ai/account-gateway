-- Apply after 001-004 with all old writers stopped. No rows/evidence deleted.
-- Populated overfull databases remain readable/closable; new facts deny.
BEGIN;
SET LOCAL search_path = ag_kernel, pg_catalog;
CREATE TABLE fact_budget (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  used bigint NOT NULL CHECK (used >= 0),
  capacity bigint NOT NULL DEFAULT 1000000 CHECK (capacity > 0)
);
ALTER TABLE consumers ADD COLUMN fact_used bigint NOT NULL DEFAULT 0;
ALTER TABLE consumers ADD COLUMN fact_limit bigint NOT NULL DEFAULT 100000;
ALTER TABLE consumers ADD COLUMN account_fact_limit bigint NOT NULL DEFAULT 10000;
ALTER TABLE consumers ADD COLUMN worker_slots integer NOT NULL DEFAULT 16;
ALTER TABLE consumers ADD COLUMN issuer_slots integer NOT NULL DEFAULT 32;
ALTER TABLE accounts ADD COLUMN fact_used bigint NOT NULL DEFAULT 2;
ALTER TABLE accounts ADD COLUMN disable_reserved_used boolean NOT NULL DEFAULT false;
ALTER TABLE executions ADD COLUMN close_reserved_used boolean NOT NULL DEFAULT false;
ALTER TABLE policy_fences ADD COLUMN fence_reserved_used boolean NOT NULL DEFAULT false;
-- SHA256 of canonical PostgreSQL JSONB text includes the whole trusted intent,
-- not just its caller-provided digest. Keep it permanently across compaction.
ALTER TABLE operations ADD COLUMN intent_hash bytea;
ALTER TABLE executions ADD COLUMN intent_hash bytea;
UPDATE operations SET intent_hash=sha256(convert_to(intent::text,'UTF8'));
UPDATE executions SET intent_hash=sha256(convert_to(intent::text,'UTF8'));
ALTER TABLE operations ALTER COLUMN intent_hash SET NOT NULL;
ALTER TABLE executions ALTER COLUMN intent_hash SET NOT NULL;
ALTER TABLE operations ALTER COLUMN intent DROP NOT NULL;
ALTER TABLE executions ALTER COLUMN intent DROP NOT NULL;
ALTER TABLE operations ADD CONSTRAINT operation_intent_hash CHECK (octet_length(intent_hash)=32);
ALTER TABLE executions ADD CONSTRAINT execution_intent_hash CHECK (octet_length(intent_hash)=32);
CREATE FUNCTION retain_intent_hash() RETURNS trigger LANGUAGE plpgsql SET search_path=ag_kernel,pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.intent IS NULL THEN RAISE EXCEPTION 'intent required' USING ERRCODE='23514'; END IF;
    NEW.intent_hash=sha256(convert_to(NEW.intent::text,'UTF8'));
  ELSIF NEW.intent_hash IS DISTINCT FROM OLD.intent_hash OR
      (NEW.intent IS DISTINCT FROM OLD.intent AND NEW.intent IS NOT NULL) THEN
    RAISE EXCEPTION 'immutable intent' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER operations_intent_hash BEFORE INSERT OR UPDATE ON operations
  FOR EACH ROW EXECUTE FUNCTION retain_intent_hash();
CREATE TRIGGER executions_intent_hash BEFORE INSERT OR UPDATE ON executions
  FOR EACH ROW EXECUTE FUNCTION retain_intent_hash();

-- Count actual accepted rows plus fixed headroom. A candidate prepays its own
-- row, generation cleanup, transient intent, journal and physical mapping (5).
-- An execution prepays its row, execution cleanup and one close operation (3).
-- An account/subject prepays its row and one disable/fence operation (2).
-- Unique parent FKs bound those child rows. Existing operations are also counted,
-- so migration grants fresh headroom without erasing any accepted authority.
UPDATE consumers c SET
  worker_slots=greatest(16,(SELECT count(*) FROM workers w WHERE w.consumer=c.consumer)),
  issuer_slots=greatest(32,(SELECT count(*) FROM issuer_epochs i WHERE i.consumer=c.consumer));
UPDATE accounts a SET fact_used=2
  +5*(SELECT count(*) FROM candidates c WHERE c.consumer=a.consumer AND c.account_ref=a.ref)
  +3*(SELECT count(*) FROM executions e WHERE e.consumer=a.consumer AND e.account_ref=a.ref)
  +(SELECT count(*) FROM operations o WHERE o.consumer=a.consumer AND o.account_ref=a.ref)
  +(SELECT count(*) FROM requests r JOIN executions e ON e.consumer=r.consumer AND e.ref=r.execution_ref
    WHERE e.consumer=a.consumer AND e.account_ref=a.ref);
UPDATE consumers c SET fact_used=1+c.worker_slots+c.issuer_slots
  +(SELECT coalesce(sum(a.fact_used),0) FROM accounts a WHERE a.consumer=c.consumer)
  +2*(SELECT count(*) FROM policy_fences f WHERE f.consumer=c.consumer)
  +(SELECT count(*) FROM operations o WHERE o.consumer=c.consumer AND o.account_ref IS NULL);
-- Include the budget's own singleton row in the service bound as well.
INSERT INTO fact_budget(singleton,used) SELECT true,1+coalesce(sum(fact_used),0) FROM consumers;
ALTER TABLE consumers ADD CONSTRAINT consumer_fact_bounds CHECK (
  fact_used>=0 AND fact_limit>0 AND account_fact_limit>0 AND worker_slots>0 AND issuer_slots>0);
ALTER TABLE accounts ADD CONSTRAINT account_fact_bounds CHECK (fact_used>=0);

-- One singleton counter serializes cross-consumer final-slot admission. Kernel
-- takes it before the existing consumer lock, including reads, to keep lock order
-- explicit. Counters never decrease; payload compaction cannot admit more IDs.
CREATE FUNCTION charge_facts(who text, account uuid, units integer) RETURNS boolean LANGUAGE plpgsql SET search_path=ag_kernel,pg_catalog AS $$
DECLARE s fact_budget%ROWTYPE; c consumers%ROWTYPE; a accounts%ROWTYPE;
BEGIN
  SELECT * INTO s FROM fact_budget WHERE singleton FOR UPDATE;
  SELECT * INTO c FROM consumers WHERE consumer=who FOR UPDATE;
  IF account IS NOT NULL THEN
    SELECT * INTO a FROM accounts WHERE consumer=who AND ref=account FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'missing fact parent' USING ERRCODE='23514'; END IF;
  END IF;
  IF s.used+units>s.capacity OR c.fact_used+units>c.fact_limit OR
      (account IS NOT NULL AND a.fact_used+units>c.account_fact_limit) THEN RETURN false; END IF;
  UPDATE fact_budget SET used=used+units WHERE singleton;
  UPDATE consumers SET fact_used=fact_used+units WHERE consumer=who;
  IF account IS NOT NULL THEN
    UPDATE accounts SET fact_used=fact_used+units WHERE consumer=who AND ref=account;
  END IF;
  RETURN true;
END;
$$;
CREATE FUNCTION bound_new_fact() RETURNS trigger LANGUAGE plpgsql SET search_path=ag_kernel,pg_catalog AS $$
DECLARE units integer; account uuid; slots integer; n bigint; reserved boolean=false;
BEGIN
  IF TG_TABLE_NAME='consumers' THEN
    IF EXISTS (SELECT 1 FROM consumers WHERE consumer=NEW.consumer) THEN RETURN NEW; END IF;
    units=1+NEW.worker_slots+NEW.issuer_slots;
    IF units>NEW.fact_limit THEN RAISE EXCEPTION 'fact capacity' USING ERRCODE='54000'; END IF;
    UPDATE fact_budget SET used=used+units WHERE singleton AND used+units<=capacity;
    IF NOT FOUND THEN RAISE EXCEPTION 'fact capacity' USING ERRCODE='54000'; END IF;
    NEW.fact_used=units;
    RETURN NEW;
  ELSIF TG_TABLE_NAME='workers' THEN
    IF EXISTS (SELECT 1 FROM workers WHERE consumer=NEW.consumer AND worker=NEW.worker) THEN RETURN NEW; END IF;
    SELECT worker_slots INTO slots FROM consumers WHERE consumer=NEW.consumer FOR UPDATE;
    SELECT count(*) INTO n FROM workers WHERE consumer=NEW.consumer;
    IF n>=slots THEN RAISE EXCEPTION 'fact capacity' USING ERRCODE='54000'; END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME='issuer_epochs' THEN
    IF EXISTS (SELECT 1 FROM issuer_epochs WHERE consumer=NEW.consumer AND issuer=NEW.issuer) THEN RETURN NEW; END IF;
    SELECT issuer_slots INTO slots FROM consumers WHERE consumer=NEW.consumer FOR UPDATE;
    SELECT count(*) INTO n FROM issuer_epochs WHERE consumer=NEW.consumer;
    IF n>=slots THEN RAISE EXCEPTION 'fact capacity' USING ERRCODE='54000'; END IF;
    RETURN NEW;
  ELSIF TG_TABLE_NAME='accounts' THEN
    units=2; NEW.fact_used=2;
    IF units>(SELECT account_fact_limit FROM consumers WHERE consumer=NEW.consumer) THEN
      RAISE EXCEPTION 'fact capacity' USING ERRCODE='54000';
    END IF;
  ELSIF TG_TABLE_NAME='policy_fences' THEN
    IF EXISTS (SELECT 1 FROM policy_fences WHERE consumer=NEW.consumer AND subject=NEW.subject) THEN RETURN NEW; END IF;
    units=2;
  ELSIF TG_TABLE_NAME='candidates' THEN
    units=5; account=NEW.account_ref;
  ELSIF TG_TABLE_NAME='executions' THEN
    units=3; account=NEW.account_ref;
  ELSIF TG_TABLE_NAME='requests' THEN
    units=1;
    SELECT account_ref INTO account FROM executions WHERE consumer=NEW.consumer AND ref=NEW.execution_ref;
  ELSIF TG_TABLE_NAME='operations' THEN
    units=1; account=NEW.account_ref;
    IF charge_facts(NEW.consumer,account,units) THEN RETURN NEW; END IF;
    -- Narrow single-use safety slots, never a general overflow pool. New IDs
    -- beyond them deny before a denial row; original stable-ID readback survives.
    IF NEW.intent->>'kind'='close' AND NEW.intent->>'execution'=NEW.execution_ref::text THEN
      UPDATE executions SET close_reserved_used=true WHERE consumer=NEW.consumer AND ref=NEW.execution_ref
        AND account_ref=NEW.account_ref AND NOT close_reserved_used RETURNING true INTO reserved;
    ELSIF NEW.intent->>'kind'='disable' AND NEW.intent->>'target'=NEW.account_ref::text THEN
      UPDATE accounts SET disable_reserved_used=true WHERE consumer=NEW.consumer AND ref=NEW.account_ref
        AND NOT disable_reserved_used RETURNING true INTO reserved;
    ELSIF NEW.intent->>'kind'='fence' THEN
      UPDATE policy_fences SET fence_reserved_used=true WHERE consumer=NEW.consumer AND subject=NEW.intent->>'subject'
        AND NOT fence_reserved_used RETURNING true INTO reserved;
    END IF;
    IF coalesce(reserved,false) THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'fact capacity' USING ERRCODE='54000';
  END IF;
  IF NOT charge_facts(NEW.consumer,account,units) THEN
    RAISE EXCEPTION 'fact capacity' USING ERRCODE='54000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER consumers_fact_budget BEFORE INSERT ON consumers FOR EACH ROW EXECUTE FUNCTION bound_new_fact();
CREATE TRIGGER accounts_fact_budget BEFORE INSERT ON accounts FOR EACH ROW EXECUTE FUNCTION bound_new_fact();
CREATE TRIGGER operations_fact_budget BEFORE INSERT ON operations FOR EACH ROW EXECUTE FUNCTION bound_new_fact();
CREATE TRIGGER candidates_fact_budget BEFORE INSERT ON candidates FOR EACH ROW EXECUTE FUNCTION bound_new_fact();
CREATE TRIGGER executions_fact_budget BEFORE INSERT ON executions FOR EACH ROW EXECUTE FUNCTION bound_new_fact();
CREATE TRIGGER requests_fact_budget BEFORE INSERT ON requests FOR EACH ROW EXECUTE FUNCTION bound_new_fact();
CREATE TRIGGER fences_fact_budget BEFORE INSERT ON policy_fences FOR EACH ROW EXECUTE FUNCTION bound_new_fact();
CREATE TRIGGER workers_fact_budget BEFORE INSERT ON workers FOR EACH ROW EXECUTE FUNCTION bound_new_fact();
CREATE TRIGGER issuers_fact_budget BEFORE INSERT ON issuer_epochs FOR EACH ROW EXECUTE FUNCTION bound_new_fact();
CREATE INDEX executions_compactable ON executions(consumer,deadline,ref) WHERE intent IS NOT NULL AND state<>'open';
COMMIT;
