BEGIN;
SET LOCAL search_path = ag_kernel, pg_catalog;
-- A transactional counter serializes commit order; sequences alone are not a feed.
CREATE TABLE usage_feed_counter (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), value bigint NOT NULL DEFAULT 0);
INSERT INTO usage_feed_counter VALUES(true,0);
CREATE TABLE usage_observations (
  position bigint PRIMARY KEY, consumer text NOT NULL REFERENCES consumers,
  execution_ref uuid NOT NULL, request_ref text NOT NULL, revision integer NOT NULL CHECK(revision BETWEEN 0 AND 2),
  fact jsonb NOT NULL, UNIQUE(consumer,execution_ref,request_ref,revision),
  FOREIGN KEY(consumer,execution_ref,request_ref) REFERENCES requests(consumer,execution_ref,id)
);
CREATE INDEX usage_observations_consumer_page ON usage_observations(consumer,position);
COMMIT;
