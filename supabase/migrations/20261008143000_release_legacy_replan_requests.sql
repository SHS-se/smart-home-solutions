-- A published auction plan awaiting HA cannot complete the new planner's
-- manual request. Release that request as failed; keep its displayed plan and
-- acknowledgement identity intact rather than fabricating completion.
UPDATE public.energy_optimisation_current
SET replan_error='Planner changed. Request a new replan.'
WHERE model_version LIKE 'marginal-value-planner-%'
  AND replan_request_id IS DISTINCT FROM replan_completed_request_id
  AND replan_request_id IS NOT NULL
  AND ha_ack_status='pending'
  AND replan_error IS NULL;
