import { assert, assertEquals } from '@std/assert';
import palette from '../src/lib/energy-shift/chart-palette.json' with { type: 'json' };
import { CHART_COLOURS, DEVICE_COLOURS } from '../src/lib/energy-shift/chart-palette.ts';
import { paletteCss, paletteMigration } from '../scripts/generate-chart-palette.ts';

Deno.test('website CSS and persisted device assignment are generated from one palette', async () => {
  assertEquals(await Deno.readTextFile('src/components/portal/energy/charts/palette.css'), paletteCss());
  assertEquals(await Deno.readTextFile('supabase/migrations/20261023193000_expand_shared_chart_palette.sql'), paletteMigration());
  assertEquals(CHART_COLOURS.solar, '#eb6834');
  assertEquals(CHART_COLOURS.grid, '#2a78d6');
  assertEquals(CHART_COLOURS.battery, '#1baf7a');
  assertEquals(CHART_COLOURS.pool, '#e87ba4');
  assertEquals(CHART_COLOURS.ev, '#4a3aa7');
  assertEquals(DEVICE_COLOURS.slice(0, 4), ['#e34948', '#eda100', '#008300', '#a855b5']);
  assertEquals(new Set(DEVICE_COLOURS).size, DEVICE_COLOURS.length);
  const colours = palette.colours as Record<string, string>;
  const reserved = new Set(Object.values(palette.tokens).map(name => colours[name]));
  assert(DEVICE_COLOURS.every(colour => !reserved.has(colour)), 'devices must not reuse a flow or aggregate colour');
});
