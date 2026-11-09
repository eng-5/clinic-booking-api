-- Up Migration

-- The database, not application code, guarantees that a slot has at most ONE confirmed
-- booking. "Check, then insert" in code leaves a gap in which two simultaneous requests can
-- both pass the check; a unique index has no gap.
--
-- It is PARTIAL (only rows with status = 'confirmed'), so cancelled bookings don't count:
-- cancelling a booking frees the slot with no extra bookkeeping.
CREATE UNIQUE INDEX one_confirmed_per_slot
    ON bookings (slot_id)
    WHERE status = 'confirmed';

-- Down Migration
DROP INDEX one_confirmed_per_slot;