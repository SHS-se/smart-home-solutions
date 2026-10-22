-- Trigger callers cannot read the private archive config. Validate under the
-- function owner's rights, retaining revoked direct execution and fixed paths.
ALTER FUNCTION private.validate_generation_forecast_run() SECURITY DEFINER;
ALTER FUNCTION private.validate_price_generation_mix_reference() SECURITY DEFINER;
