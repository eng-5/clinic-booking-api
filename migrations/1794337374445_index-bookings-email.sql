-- Up Migration

-- Lets "a person's bookings, oldest first" read straight from the index, however many
-- bookings the table holds. lower(email) matches how the query compares (case-insensitive);
-- seq gives the order and the cursor position.
CREATE INDEX bookings_email_seq ON bookings (lower(email), seq);
-- Down Migration
DROP INDEX bookings_email_seq;