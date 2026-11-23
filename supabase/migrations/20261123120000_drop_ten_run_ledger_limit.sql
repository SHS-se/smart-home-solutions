-- The shared room response publishes up to 24 assessed runs. The original
-- ten-run ledger check is named after its column; 20261123100000 dropped the
-- wrong name, so every shared completion was rejected and retried. The
-- 24-run check added there remains the ledger's only size limit.
ALTER TABLE private.energy_room_run_ledgers DROP CONSTRAINT IF EXISTS energy_room_run_ledgers_evidence_check;
