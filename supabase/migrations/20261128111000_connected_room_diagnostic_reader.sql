-- Read accepted connected coefficients, including passive fits, without the large inference population.
-- No fit, revision, learning cadence or stored observation is changed.
CREATE OR REPLACE FUNCTION public.get_energy_room_response_evidence(p_home_id uuid,p_room_key text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,private AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM public.homes h WHERE h.id=p_home_id AND public.can_access_energy_billing_customer(h.customer_id)) THEN
   RAISE EXCEPTION 'Home not found or access denied' USING ERRCODE='42501';
 END IF;
 RETURN jsonb_build_object(
   'room',(SELECT jsonb_build_object('trained',m.trained,'rejection_reason',m.rejection_reason,
     'last_attempted_at',m.last_attempted_at,'last_fit_attempt',m.last_fit_attempt,
     'policy',m.heating_bands->>'calibration_policy','shared_attempt',m.heating_bands->'shared_attempt')
     FROM public.energy_optimisation_zone_models m WHERE m.home_id=p_home_id AND m.room_key=p_room_key),
   'response',(SELECT CASE WHEN m.heating_bands#>>'{reference,scope,kind}'='shared' THEN jsonb_build_object(
     'revision',m.heating_bands->>'reference_revision','model',m.heating_bands#>'{reference,model}',
     'binding',m.heating_bands->>'binding',
     'connected_exchange',(m.heating_bands#>'{reference,connected_exchange}')-'process_belief',
     'training_from',m.heating_bands#>'{reference,training_from}','training_to',m.heating_bands#>'{reference,training_to}',
     'warnings',m.heating_bands#>'{reference,warnings}',
     'measured_runs',m.heating_bands#>'{reference,learning_evidence,measured_runs}',
     'descriptive_fit',m.heating_bands#>'{reference,learning_evidence,descriptive_fit}',
     'transition_calibration',m.heating_bands#>'{reference,learning_evidence,transition_calibration}',
     'run_calibration',m.heating_bands#>'{reference,learning_evidence,run_calibration}') END
     FROM public.energy_optimisation_zone_models m WHERE m.home_id=p_home_id AND m.room_key=p_room_key),
   'ledgers',(SELECT coalesce(jsonb_agg(jsonb_build_object('scope_key',l.scope_key,'model_revision',l.model_revision,
     'created_at',l.created_at,'evidence',CASE WHEN l.evidence->>'policy' IN ('shared_interval_transitions_v1','measured_room_runs_v1') THEN
       l.evidence||jsonb_build_object('runs',public.get_energy_room_run_assessments(p_home_id,p_room_key,coalesce(l.evidence->>'assessment_revision',l.evidence->>'assessed_against'),0,
         CASE WHEN l.evidence->>'policy'='measured_room_runs_v1' THEN 100 ELSE 50 END))
       ELSE l.evidence END) ORDER BY l.scope_key),'[]'::jsonb)
     FROM private.energy_room_run_ledgers l WHERE l.home_id=p_home_id AND l.room_key=p_room_key));
END; $$;
