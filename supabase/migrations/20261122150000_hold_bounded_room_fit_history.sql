-- Bounded run captures use envelope version 2. Their immutable discovery
-- inputs must remain available until the ordinary fenced fit completes or
-- resets; otherwise rolling retention changes a still-running fingerprint.
CREATE OR REPLACE FUNCTION private.room_fit_retention_holds(p_home_id uuid)
RETURNS TABLE(customer_id uuid,room_key text,discovery_at tstzrange,fit_at tstzrange,reference jsonb)
LANGUAGE sql STABLE SET search_path=public,private AS $$
 SELECT j.customer_id,j.owner_key,r.discovery_at,r.fit_at,p.metadata#>'{capture,reference}'
 FROM private.energy_learning_jobs j JOIN private.energy_room_fit_progress p ON p.job_id=j.id AND p.generation=j.generation
 CROSS JOIN LATERAL private.room_fit_retention_ranges(p.metadata->'capture') r
 WHERE j.home_id=p_home_id AND j.owner_kind='room' AND j.pending
   AND p.metadata->'version'='2'::jsonb AND p.metadata#>'{capture,version}'='1'::jsonb
   AND p.metadata#>>'{capture,homeId}'=j.home_id::text AND p.metadata#>>'{capture,customerId}'=j.customer_id::text
   AND p.metadata#>>'{capture,roomKey}'=j.owner_key;
$$;
