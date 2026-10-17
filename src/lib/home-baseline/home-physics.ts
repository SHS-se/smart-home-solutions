import type { OptimisationSnapshot, ServiceInput } from '../../../supabase/functions/_shared/planner/planning-contracts.ts';
import { parseDeviceModels } from '../../../supabase/functions/_shared/planner/device-models.ts';
import { poolPhysics } from '../../../supabase/functions/_shared/planner/pool-physics.ts';
import type { PoolSeed } from './pool-carry.ts';

export type HomeModelCapture = Pick<OptimisationSnapshot, 'captured_at' | 'timezone' | 'capabilities' | 'battery' | 'ev_battery' | 'pool' | 'device_physics' | 'pool_model' | 'grid' | 'value_settings' | 'device_models' | 'comfort' | 'policy'> & { roi_solar_profile: string | null; roi_pool_seed: PoolSeed | null; services: Pick<ServiceInput, 'device' | 'control'>[]; criteria?: import('../../../supabase/functions/_shared/planner-wasm/rule-policy.ts').CriteriaOverrides };
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
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
  const pool = snapshot.capabilities.pool ? poolPhysics(snapshot) : null;
  const poolStore = pool?.store ?? null, heater = pool?.heater ?? null;
  const wear = battery ? snapshot.value_settings?.battery_degradation_sek_per_kwh : 0;
  if (!finite(wear) || wear < 0) fail('Battery wear setting is unavailable');
  if (![snapshot.grid.import_limit_w, snapshot.grid.export_limit_w].every(v => finite(v) && v >= 0)) fail('Home grid limits are unavailable');
  return { battery, car, charger, poolStore, heater, wear,
    memberKeys: [...poolMembers, ...evMembers].map(m => m.key),
    carName: ev?.name ?? 'EV' };
}
