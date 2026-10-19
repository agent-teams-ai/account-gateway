BEGIN;
SET LOCAL search_path = ag_kernel, pg_catalog;

-- Additive authoritative reversible state. It is separate from destructive
-- disabled and existing rows/history remain unchanged.
ALTER TABLE accounts DROP CONSTRAINT accounts_state_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_state_check
  CHECK (state IN ('staging','active','suspended','disabled','quarantined'));
ALTER TABLE accounts ADD CONSTRAINT accounts_suspended_has_generation
  CHECK (state <> 'suspended' OR active_generation IS NOT NULL);

-- Preserve original transition result across later lifecycle changes/replays.
ALTER TABLE operations ADD COLUMN lifecycle_result jsonb;
ALTER TABLE operations ADD CONSTRAINT lifecycle_result_scope CHECK (lifecycle_result IS NULL OR
  (intent->>'kind' IN ('suspend','resume') AND lifecycle_result->>'accountRef'=account_ref::text));

COMMIT;
