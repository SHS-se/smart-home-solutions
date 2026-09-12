import { NetworkTraffic } from '../../supabase/functions/_shared/network-traffic';

export const browserTraffic = new NetworkTraffic();
const sync = { responses: 0, initial_loads: 0, unchanged_payloads: 0,
  plan_downloads: 0, configuration_downloads: 0, thermal_downloads: 0,
  zone_model_downloads: 0, history_upserts: 0, history_removals: 0 };

interface DeltaSummary {
  plan: unknown;
  devices: { value: unknown };
  thermal: { value: unknown };
  zone_models: { value: unknown };
  actuals: { upserts: unknown[]; removed: unknown[] };
  prices: { upserts: unknown[]; removed: unknown[] };
  device_actuals: { upserts: unknown[]; removed: unknown[] };
}

export function recordPortalSync(delta: DeltaSummary, initial: boolean) {
  sync.responses++;
  if (initial) sync.initial_loads++;
  const plan = Number(delta.plan != null);
  const configuration = Number(delta.devices.value != null);
  const thermal = Number(delta.thermal.value != null);
  const zones = Number(delta.zone_models.value != null);
  const history = [delta.actuals, delta.prices, delta.device_actuals];
  const upserts = history.reduce((n, d) => n + d.upserts.length, 0);
  const removals = history.reduce((n, d) => n + d.removed.length, 0);
  sync.plan_downloads += plan;
  sync.configuration_downloads += configuration;
  sync.thermal_downloads += thermal;
  sync.zone_model_downloads += zones;
  sync.history_upserts += upserts;
  sync.history_removals += removals;
  if (!(plan + configuration + thermal + zones + upserts + removals)) sync.unchanged_payloads++;
}

export function browserTrafficReport() {
  return { source: 'browser_tab', ...browserTraffic.snapshot(), portal_sync: { ...sync } };
}

export function downloadTrafficReport() {
  const url = URL.createObjectURL(new Blob([JSON.stringify(browserTrafficReport(), null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'shs-network-traffic.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
