-- The existing raw JSON reader verifies the current job, lease, fence, ready
-- cursor, unsealed state and execution revision on every request.
CREATE FUNCTION public.read_energy_owned_snapshot_for_hash(
 p_home_id uuid,p_job_id uuid,p_fence bigint,p_cursor bigint,p_node integer)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,private SET statement_timeout='8s' AS $$
DECLARE snapshot json; network json; node_count integer:=0;
BEGIN
 snapshot:=public.read_energy_owned_snapshot_for_hash(p_home_id,p_job_id,p_fence,p_cursor);
 IF snapshot IS NULL THEN RETURN NULL; END IF;
 IF p_node IS NOT NULL THEN
   IF p_node<0 THEN RETURN NULL; END IF;
   RETURN snapshot#>ARRAY['room_network','nodes',p_node::text];
 END IF;
 network:=snapshot->'room_network';
 IF json_typeof(network->'nodes')='array' THEN
   node_count:=json_array_length(network->'nodes');
   snapshot:=private.planning_replace_member(snapshot,'room_network',private.planning_replace_member(network,'nodes','[]'::json));
 END IF;
 RETURN json_build_object('snapshot',snapshot,'node_count',node_count);
END; $$;
REVOKE ALL ON FUNCTION public.read_energy_owned_snapshot_for_hash(uuid,uuid,bigint,bigint,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_energy_owned_snapshot_for_hash(uuid,uuid,bigint,bigint,integer) TO service_role;
