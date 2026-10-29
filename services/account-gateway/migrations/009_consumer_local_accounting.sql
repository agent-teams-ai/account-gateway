-- Apply with all SQL005-era writers stopped. Existing rows/counters survive.
-- Every supported writer targets one consumer per transaction. Existing facts
-- lock advisory consumer identity -> consumer row -> account row -> budget.
-- A new consumer has no existing row: its advisory identity lock protects the
-- absence check before the budget charge and insertion of its own new row.
BEGIN;
SET LOCAL search_path = ag_kernel, pg_catalog;

CREATE OR REPLACE FUNCTION charge_facts(who text, account uuid, units integer) RETURNS boolean LANGUAGE plpgsql SET search_path=ag_kernel,pg_catalog AS $$
DECLARE s fact_budget%ROWTYPE; c consumers%ROWTYPE; a accounts%ROWTYPE;
BEGIN
  IF units<=0 THEN RAISE EXCEPTION 'invalid fact charge' USING ERRCODE='23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(who,908417));
  SELECT * INTO c FROM consumers WHERE consumer=who FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing fact consumer' USING ERRCODE='23514'; END IF;
  IF account IS NOT NULL THEN
    SELECT * INTO a FROM accounts WHERE consumer=who AND ref=account FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'missing fact parent' USING ERRCODE='23514'; END IF;
  END IF;
  -- Denials from local bounds need no service-wide lock at all.
  IF c.fact_used+units>c.fact_limit OR
      (account IS NOT NULL AND a.fact_used+units>c.account_fact_limit) THEN RETURN false; END IF;
  SELECT * INTO s FROM fact_budget WHERE singleton FOR UPDATE;
  IF s.used+units>s.capacity THEN RETURN false; END IF;
  UPDATE fact_budget SET used=used+units WHERE singleton;
  UPDATE consumers SET fact_used=fact_used+units WHERE consumer=who;
  IF account IS NOT NULL THEN
    UPDATE accounts SET fact_used=fact_used+units WHERE consumer=who AND ref=account;
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION bound_new_fact() RETURNS trigger LANGUAGE plpgsql SET search_path=ag_kernel,pg_catalog AS $$
DECLARE units integer; account uuid; slots integer; n bigint; reserved boolean=false;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.consumer,908417));
  IF TG_TABLE_NAME='consumers' THEN
    -- Recheck after the identity lock: concurrent ON CONFLICT bootstrap must
    -- never charge a losing BEFORE INSERT trigger or wait on an old consumer
    -- while holding the shared budget.
    PERFORM 1 FROM consumers WHERE consumer=NEW.consumer FOR UPDATE;
    IF FOUND THEN RETURN NEW; END IF;
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

-- One round trip establishes mutation scope. An ordinary mutation/replay does
-- not touch fact_budget. Limits only tighten; prepaid worker slots only grow.
CREATE FUNCTION open_consumer(who text, service_limit bigint, consumer_limit bigint,
    account_limit bigint, requested_worker_slots integer, requested_issuer_slots integer)
  RETURNS uuid LANGUAGE plpgsql SET search_path=ag_kernel,pg_catalog AS $$
DECLARE c consumers%ROWTYPE; additional integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(who,908417));
  SELECT * INTO c FROM consumers WHERE consumer=who FOR UPDATE;
  -- The missing-consumer branch is protected by the same identity lock as the
  -- insert trigger. No other writer can create this row between these steps.
  UPDATE fact_budget SET capacity=service_limit WHERE singleton AND capacity>service_limit;
  IF c.consumer IS NULL THEN
    INSERT INTO consumers(consumer,fact_limit,account_fact_limit,worker_slots,issuer_slots)
      VALUES (who,consumer_limit,account_limit,requested_worker_slots,requested_issuer_slots)
      RETURNING * INTO c;
  ELSE
    UPDATE consumers SET fact_limit=least(fact_limit,consumer_limit),
      account_fact_limit=least(account_fact_limit,account_limit)
      WHERE consumer=who AND (fact_limit>consumer_limit OR account_fact_limit>account_limit);
    additional=requested_worker_slots-c.worker_slots;
    IF additional>0 THEN
      IF NOT charge_facts(who,NULL,additional) THEN
        RAISE EXCEPTION 'fact capacity' USING ERRCODE='54000';
      END IF;
      UPDATE consumers SET worker_slots=requested_worker_slots WHERE consumer=who;
    END IF;
  END IF;
  INSERT INTO issuer_epochs(consumer,issuer) VALUES (who,c.issuer) ON CONFLICT DO NOTHING;
  RETURN c.issuer;
END;
$$;
REVOKE ALL ON FUNCTION open_consumer(text,bigint,bigint,bigint,integer,integer) FROM PUBLIC;
COMMIT;
