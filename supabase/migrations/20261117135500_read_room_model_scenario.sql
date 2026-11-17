-- Read the two directions of a doorway distinctly. The selected room is the
-- source in this scenario, so its neighbours supply the receiving-room fits.
CREATE FUNCTION public.get_energy_room_model_scenario(p_home_id uuid, p_room_key text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  result jsonb;
BEGIN
  IF NOT EXISTS (SELECT FROM public.homes
    WHERE id = p_home_id AND public.can_access_energy_billing_customer(customer_id)) THEN
    RAISE EXCEPTION 'Home not found or access denied' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'room', (SELECT to_jsonb(model) - 'doorway_exchange' - 'passive_heat'
      FROM public.energy_optimisation_zone_models model
      WHERE model.home_id = p_home_id AND model.room_key = p_room_key),
    'connections', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'key', edge.other_key, 'name', profile.rooms->edge.other_key->>'name',
        'model', CASE WHEN learned.peer IS NOT NULL
          THEN to_jsonb(receiver) - 'doorway_exchange' - 'passive_heat' END,
        'doorway', CASE WHEN learned.peer IS NOT NULL THEN jsonb_build_object(
          'weight', learned.peer->'weight', 'usual', learned.peer->'usual') END
      ) ORDER BY profile.rooms->edge.other_key->>'name', edge.other_key)
      FROM public.energy_room_profiles profile
      CROSS JOIN LATERAL jsonb_array_elements(profile.connections) AS connection(pair)
      CROSS JOIN LATERAL (VALUES
        (connection.pair->'rooms'->>0, connection.pair->'rooms'->>1),
        (connection.pair->'rooms'->>1, connection.pair->'rooms'->>0)
      ) AS edge(room_key, other_key)
      LEFT JOIN public.energy_optimisation_zone_models receiver
        ON receiver.home_id = profile.home_id AND receiver.room_key = edge.other_key AND receiver.trained
      LEFT JOIN LATERAL (
        SELECT peer FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(receiver.doorway_exchange->'peers') = 'array'
            THEN receiver.doorway_exchange->'peers' ELSE '[]'::jsonb END
        ) AS fit(peer)
        WHERE receiver.doorway_exchange->>'source' = profile.rooms->edge.other_key->>'source_key'
          AND peer->>'key' = p_room_key
          AND peer->>'source' = profile.rooms->p_room_key->>'source_key'
      ) learned ON true
      WHERE profile.home_id = p_home_id AND edge.room_key = p_room_key
    ), '[]'::jsonb)
  ) INTO result;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.get_energy_room_model_scenario(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_energy_room_model_scenario(uuid, text) TO authenticated;
