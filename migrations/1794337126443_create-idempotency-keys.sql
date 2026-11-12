-- Up Migration

-- One row per Idempotency-Key. It remembers WHAT was asked (a fingerprint of the request
-- body) and WHAT was answered (status and body), so a retry can be answered identically
-- without doing the work again.
CREATE TABLE idempotency_keys (
    key         text        PRIMARY KEY,
    fingerprint text        NOT NULL,
    status_code integer     NOT NULL,
    response    jsonb       NOT NULL,
    created_at  timestamptz NOT NULL
);

-- Down Migration
DROP TABLE idempotency_keys;