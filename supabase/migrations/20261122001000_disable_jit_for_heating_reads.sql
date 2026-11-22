-- Compilation of the large seasonal-reader plans can outlast their ordinary
-- RPC timeout. Interpret these bounded reads without changing their SQL,
-- results, statement timeout or memory allowance. Function-local settings also
-- cover nested readers and restore the caller's compilation policy on return.
-- Future CREATE OR REPLACE definitions must retain jit=off and work_mem=32MB.
ALTER FUNCTION public.get_energy_room_heating_fit_windows(uuid,uuid,text,timestamptz,timestamptz)
 SET jit='off';
ALTER FUNCTION public.get_energy_room_thermal_interval_capture(uuid,uuid,text,timestamptz,timestamptz)
 SET jit='off';
