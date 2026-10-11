import type { OptimisationSnapshot, ServiceInput } from '../../../supabase/functions/_shared/planner/energy-optimisation.ts';
import { parseDeviceModels, parseHeaterResponse, publishHeater, WATER_KWH_PER_M3_K, type PublishedHeater, type ThermalStoreModel } from '../../../supabase/functions/_shared/planner/device-models.ts';
import { poolHeaters } from '../../../supabase/functions/_shared/planner/pool-devices.ts';

export type HomeModelCapture = Pick<OptimisationSnapshot, 'captured_at' | 'timezone' | 'capabilities' | 'battery' | 'ev_battery' | 'pool' | 'device_physics' | 'pool_model' | 'grid' | 'value_settings' | 'device_models'> & { services: Pick<ServiceInput, 'device' | 'control'>[] };
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
function fail(message: string): never { throw new Error(message); }

/** Browser boundary for captured physical facts. No forecast fitting or planner admission.
 * The empirical pool conversion is pinned to live preparation by parity tests. */
export function homePhysics(snapshot: HomeModelCapture) {
  if (!snapshot?.capabilities || !Array.isArray(snapshot.device_models) || !Array.isArray(snapshot.services) || !snapshot.grid
    || typeof snapshot.timezone !== 'string' || !snapshot.timezone || !['battery', 'pool', 'ev'].every(k => typeof snapshot.capabilities[k] === 'boolean')
    || !finite(Date.parse(snapshot.captured_at))) fail('Current home physical model is unavailable');
  new Intl.DateTimeFormat('en-GB', { timeZone: snapshot.timezone }).format();
  const supplied = snapshot.device_physics ? parseDeviceModels(snapshot.device_physics) : {};
  const battery = snapshot.capabilities.battery ? supplied.battery ?? snapshot.battery : null;
  if (snapshot.capabilities.battery && !battery) fail('Battery physical model is unavailable');
  const ev = snapshot.capabilities.ev ? snapshot.ev_battery : null;
  const evService = snapshot.services.find(s => s.device === 'ev' && s.control.type === 'discrete_current');
  const charger = ev ? supplied.car?.charger ?? (evService?.control.type === 'discrete_current' ? evService.control : null) : null;
  const car = ev ? supplied.car?.battery ?? (finite(ev.kwh_per_km) ? {
    capacity_kwh: ev.capacity_kwh, kwh_per_km: ev.kwh_per_km, charge_efficiency: ev.charge_efficiency,
  } : null) : null;
  if (snapshot.capabilities.ev && (!ev || !car || !charger)) fail('EV battery and charger physical models are unavailable');
  parseDeviceModels({ ...(battery ? { battery } : {}), ...(car && charger ? { car: { battery: car, charger } } : {}) });

  const poolMembers = snapshot.capabilities.pool ? snapshot.device_models.filter(m => m.planning_service === 'pool') : [];
  const evMembers = car ? snapshot.device_models.filter(m => m.category === 'ev_charging') : [];
  if (snapshot.capabilities.pool && !poolMembers.length) fail('Pool device meters are unavailable');
  if (car && !evMembers.length) fail('EV device meters are unavailable');
  let poolStore: ThermalStoreModel | null = null, heater: PublishedHeater | null = null;
  if (snapshot.capabilities.pool) {
    if (supplied.pool) {
      poolStore = supplied.pool.store; heater = publishHeater(supplied.pool.heater);
    } else {
      const measured = snapshot.pool_model;
      if (!snapshot.pool || !measured?.heater_response) fail('Pool physical response model is unavailable');
      const heaterKeys = new Set(poolHeaters(poolMembers).map(m => m.key));
      const memberCompressor = sum(poolMembers.filter(m => heaterKeys.has(m.key)).map(m => m.active_power_w ?? 0));
      const measuredCompressor = measured.heater_response.kind === 'bergvarme' ? measured.heater_response.evidence?.steady_compressor_w : undefined;
      const compressor = finite(measuredCompressor) ? measuredCompressor : memberCompressor;
      const auxiliary = sum(poolMembers.filter(m => !heaterKeys.has(m.key)).map(m => m.active_power_w ?? 0));
      const capacity = snapshot.pool.volume_m3 * WATER_KWH_PER_M3_K;
      const lossPoints = (measured.response ?? []).flatMap(bin => finite(bin.idle_c_per_h)
        ? [{ at_c: bin.at_c, c_per_h: bin.idle_c_per_h }] : []).sort((a, b) => a.at_c - b.at_c);
      const gains = (measured.response ?? []).filter(bin => finite(bin.heat_c_per_kwh) && bin.heat_c_per_kwh > 0 && finite(bin.heated_kwh) && bin.heated_kwh > 0);
      const weight = sum(gains.map(bin => bin.heated_kwh!));
      const gain = weight > 0 ? sum(gains.map(bin => bin.heat_c_per_kwh! * bin.heated_kwh!)) / weight : null;
      const heat = gain === null ? (finite(measured.rated_cop) ? measured.rated_cop * compressor : null) : gain * capacity * compressor;
      if (!(compressor > 0) || heat === null || !(heat > 0)) fail('Pool model requires measured compressor input and heat delivery');
      const loss: ThermalStoreModel['loss'] = lossPoints.length ? { kind: 'measured', points: lossPoints }
        : finite(measured.loss_kw_per_k) ? { kind: 'linear', kw_per_c: measured.loss_kw_per_k, surroundings_c: null }
        : fail('Pool model requires fitted standing loss');
      poolStore = { capacity_kwh_per_c: capacity, loss };
      heater = { compressor_w: compressor, auxiliary_w: auxiliary, heat_w: heat, response: parseHeaterResponse(measured.heater_response) };
      // Validate the derived physical facts with the same public model boundary.
      parseDeviceModels({ pool: { store: poolStore, heater: { setting_unit: 'on', selected_setting: 1, control: 'switch',
        auxiliary_w: auxiliary, response: heater.response, operating_points: [{ setting: 1, electric_w: compressor, compressor_w: compressor, heat_w: heat }] } } });
    }
  }
  const wear = battery ? snapshot.value_settings?.battery_degradation_sek_per_kwh : 0;
  if (!finite(wear) || wear < 0) fail('Battery wear setting is unavailable');
  if (![snapshot.grid.import_limit_w, snapshot.grid.export_limit_w].every(v => finite(v) && v >= 0)) fail('Home grid limits are unavailable');
  return { battery, car, charger, poolStore, heater, wear,
    memberKeys: [...poolMembers, ...evMembers].map(m => m.key),
    carName: ev?.name ?? 'EV' };
}
