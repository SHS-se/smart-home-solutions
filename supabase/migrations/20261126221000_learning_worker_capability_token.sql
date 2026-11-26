-- Deployment verifies the worker using the same credential as ordinary DB wakes.
CREATE FUNCTION public.get_energy_learning_worker_token() RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE worker_token text;
BEGIN
 SELECT c.token INTO STRICT worker_token FROM private.energy_learning_credentials c
 WHERE c.singleton AND c.function_url IS NOT NULL;
 RETURN worker_token;
END; $$;
REVOKE ALL ON FUNCTION public.get_energy_learning_worker_token() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_energy_learning_worker_token() TO service_role;
