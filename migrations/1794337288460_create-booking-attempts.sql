-- Up Migration

-- One row per booking attempt, used for the "5 attempts per email per minute" limit.
-- It lives in Postgres (not in memory) so the limit survives restarts and is shared by
-- every instance.
CREATE TABLE booking_attempts (
    id           bigserial   PRIMARY KEY,
    email        text        NOT NULL,
    attempted_at timestamptz NOT NULL
);
 
CREATE INDEX booking_attempts_email_time ON booking_attempts (email, attempted_at);
-- Down Migration
DROP TABLE booking_attempts;