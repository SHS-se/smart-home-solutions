-- Inventory power is a rolling descriptive estimate, not measured thermal
-- evidence. Native energy limits travel with their observations and are
-- journaled there. As in the prior source fingerprint, power and display names
-- must not invalidate every archived interval on ordinary inventory uploads.
-- A fit pins its descriptive power/name with its chronological capture; the
-- next changed tail supplies fresh descriptors without restarting current work.
DO $$
DECLARE operation text; transition_tables text;
 projection text:='SELECT s.home_id,''''::text AS room_key,tstzrange(NULL::timestamptz,NULL::timestamptz,''[)'') AS span,
   s.id,s.device_key,s.statistic_id,s.category,s.first_seen_at,s.mapping_summary->>''room_key'' AS mapped_room,
   s.control_type_override,s.mapping_status,s.mapped_control_type
   FROM %I s WHERE s.retired_at IS NULL AND s.planning_role_override=''controllable''
     AND s.control_type_override IN (''setpoint'',''switch_schedule'')';
BEGIN
 FOREACH operation IN ARRAY ARRAY['INSERT','UPDATE','DELETE'] LOOP
   transition_tables:=CASE operation WHEN 'INSERT' THEN 'NEW TABLE AS new_source'
     WHEN 'DELETE' THEN 'OLD TABLE AS old_source' ELSE 'OLD TABLE AS old_source NEW TABLE AS new_source' END;
   EXECUTE format('DROP TRIGGER room_evidence_%s ON public.energy_optimisation_devices',lower(operation));
   EXECUTE format('CREATE TRIGGER room_evidence_%s AFTER %s ON public.energy_optimisation_devices
     REFERENCING %s FOR EACH STATEMENT EXECUTE FUNCTION private.journal_room_evidence(%L)',
     lower(operation),operation,transition_tables,projection);
 END LOOP;
END; $$;
