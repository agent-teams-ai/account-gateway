-- Heartbeat reclaim must inspect worker references in every durable state.
-- Nullable owners have no worker reference; journal owners are NOT NULL.
BEGIN;
SET LOCAL search_path = ag_kernel, pg_catalog;
CREATE INDEX IF NOT EXISTS candidates_worker ON ag_kernel.candidates(consumer, worker) WHERE worker IS NOT NULL;
CREATE INDEX IF NOT EXISTS requests_worker ON ag_kernel.requests(consumer, worker) WHERE worker IS NOT NULL;
CREATE INDEX IF NOT EXISTS cleanup_worker ON ag_kernel.cleanup(consumer, worker) WHERE worker IS NOT NULL;
CREATE INDEX IF NOT EXISTS candidate_journal_worker ON ag_management.candidate_journal(consumer, worker);
COMMIT;
