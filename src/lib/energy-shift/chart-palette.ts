import palette from './chart-palette.json' with { type: 'json' };

/** One coordinated categorical set, expanded from the original energy chart. */
export const CHART_COLOURS = palette.colours;
export const DEVICE_COLOURS = palette.deviceOrder.map(name => CHART_COLOURS[name as keyof typeof CHART_COLOURS]);
export const DEVICE_ROLE_COLOURS = Object.fromEntries(Object.entries(palette.preferredDeviceRoles)
  .map(([category, name]) => [category, CHART_COLOURS[name as keyof typeof CHART_COLOURS]]));
