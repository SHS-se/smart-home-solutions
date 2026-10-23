import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import palette from '../src/lib/energy-shift/chart-palette.json' with { type: 'json' };

const colours = palette.colours as Record<string, string>;
const header = 'Generated from src/lib/energy-shift/chart-palette.json by scripts/generate-chart-palette.ts.';
export function paletteCss(): string {
  return `/* ${header} */\n@layer base {\n  :root {\n${Object.entries(palette.tokens).map(([token, name]) => `    --plan-${token}: ${colours[name]};`).join('\n')}\n  }\n}\n`;
}
export function paletteMigration(): string {
  return `-- ${header}
-- This requested palette correction recolours existing devices exactly once.
BEGIN;
LOCK TABLE public.energy_optimisation_devices IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION public.energy_chart_colour_coordinates(p_colour text)
RETURNS double precision[] LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog AS $$
  WITH rgb AS (SELECT
    ('x' || substr(p_colour, 2, 2))::bit(8)::integer / 255.0 AS r,
    ('x' || substr(p_colour, 4, 2))::bit(8)::integer / 255.0 AS g,
    ('x' || substr(p_colour, 6, 2))::bit(8)::integer / 255.0 AS b),
  linear AS (SELECT
    CASE WHEN r <= 0.04045 THEN r / 12.92 ELSE power((r + 0.055) / 1.055, 2.4) END AS r,
    CASE WHEN g <= 0.04045 THEN g / 12.92 ELSE power((g + 0.055) / 1.055, 2.4) END AS g,
    CASE WHEN b <= 0.04045 THEN b / 12.92 ELSE power((b + 0.055) / 1.055, 2.4) END AS b FROM rgb),
  lms AS (SELECT
    power(0.4122214708*r + 0.5363325363*g + 0.0514459929*b, 1.0/3) AS l,
    power(0.2119034982*r + 0.6806995451*g + 0.1073969566*b, 1.0/3) AS m,
    power(0.0883024619*r + 0.2817188376*g + 0.6299787005*b, 1.0/3) AS s FROM linear)
  SELECT ARRAY[0.2104542553*l + 0.7936177850*m - 0.0040720468*s,
    1.9779984951*l - 2.4285922050*m + 0.4505937099*s,
    0.0259040371*l + 0.7827717662*m - 0.8086757660*s]::double precision[] FROM lms;
$$;

DROP FUNCTION public.next_energy_device_colour(uuid);
CREATE FUNCTION public.next_energy_device_colour(p_home_id uuid, p_category text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  palette constant jsonb := '${JSON.stringify(palette)}'::jsonb;
  used text[];
  reserved text[];
  used_coordinates double precision[][];
  coordinates double precision[];
  point double precision[];
  candidate text;
  best text;
  best_distance double precision := -1;
  nearest double precision;
  chroma double precision;
  considered integer := 0;
  rgb integer;
  name text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('energy_device_colour:' || p_home_id::text, 0));
  SELECT coalesce(array_agg(colour) FILTER (WHERE colour IS NOT NULL), ARRAY[]::text[])
    INTO used FROM public.energy_optimisation_devices WHERE home_id = p_home_id;
  SELECT array_agg(DISTINCT palette->'colours'->>token.value) INTO reserved
    FROM jsonb_each_text(palette->'tokens') token;
  -- Preserve the original pool/EV/boiler hues for the first device of that
  -- role. Further devices use unused colours from the same expanded set.
  candidate := palette->'colours'->>(palette->'preferredDeviceRoles'->>p_category);
  IF candidate IS NOT NULL AND NOT (candidate = ANY(used)) THEN RETURN candidate; END IF;
  FOR name IN SELECT jsonb_array_elements_text(palette->'deviceOrder') LOOP
    candidate := palette->'colours'->>name;
    IF NOT (candidate = ANY(used)) THEN RETURN candidate; END IF;
  END LOOP;
  -- Continue the same gamut for large catalogues. Choose the furthest of
  -- 512 unused candidates in OKLab, rather than accepting an arbitrary RGB.
  SELECT array_agg(public.energy_chart_colour_coordinates(value)) INTO used_coordinates
    FROM (SELECT DISTINCT unnest(used || reserved) AS value) points;
  FOR i IN 0..16777215 LOOP
    rgb := ((i::bigint * 104729 + 1640531) % 16777216)::integer;
    candidate := '#' || lpad(to_hex(rgb), 6, '0');
    IF candidate = ANY(used || reserved) THEN CONTINUE; END IF;
    coordinates := public.energy_chart_colour_coordinates(candidate);
    chroma := sqrt(coordinates[2]^2 + coordinates[3]^2);
    IF coordinates[1] < (palette->'extension'->>'minLightness')::double precision
      OR coordinates[1] > (palette->'extension'->>'maxLightness')::double precision
      OR chroma < (palette->'extension'->>'minChroma')::double precision
      OR chroma > (palette->'extension'->>'maxChroma')::double precision THEN CONTINUE; END IF;
    nearest := 1e9;
    FOREACH point SLICE 1 IN ARRAY used_coordinates LOOP
      nearest := least(nearest, (coordinates[1]-point[1])^2 + (coordinates[2]-point[2])^2 + (coordinates[3]-point[3])^2);
    END LOOP;
    IF nearest > best_distance THEN best := candidate; best_distance := nearest; END IF;
    considered := considered + 1;
    EXIT WHEN considered = 512;
  END LOOP;
  IF best IS NULL THEN RAISE EXCEPTION 'Device colour space exhausted for home %', p_home_id; END IF;
  RETURN best;
END;
$$;
REVOKE ALL ON FUNCTION public.next_energy_device_colour(uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.assign_energy_device_colour() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE existing_colour text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.colour IS DISTINCT FROM OLD.colour OR NEW.home_id IS DISTINCT FROM OLD.home_id THEN
      RAISE EXCEPTION 'Device colour and home are immutable';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('energy_device_colour:' || NEW.home_id::text, 0));
  SELECT colour INTO existing_colour FROM public.energy_optimisation_devices
    WHERE home_id = NEW.home_id AND device_key = NEW.device_key;
  IF FOUND THEN NEW.colour := existing_colour;
  ELSE
    IF NEW.colour IS NOT NULL THEN RAISE EXCEPTION 'Device colours are assigned by the catalogue'; END IF;
    NEW.colour := public.next_energy_device_colour(NEW.home_id, NEW.category);
  END IF;
  RETURN NEW;
END;
$$;

-- The exclusive transaction makes the one-time replacement atomic. Active
-- devices get the original hues first; retired devices still retain unique
-- assignments. Normal inventory updates cannot recolour either afterwards.
ALTER TABLE public.energy_optimisation_devices DISABLE TRIGGER energy_device_colour;
ALTER TABLE public.energy_optimisation_devices ALTER COLUMN colour DROP NOT NULL;
ALTER TABLE public.energy_optimisation_devices DROP CONSTRAINT energy_device_colour_unique;
UPDATE public.energy_optimisation_devices SET colour = NULL;
DO $$ DECLARE device record; BEGIN
  FOR device IN SELECT id, home_id, category FROM public.energy_optimisation_devices
    ORDER BY home_id, (retired_at IS NOT NULL), first_seen_at, device_key, id LOOP
    UPDATE public.energy_optimisation_devices
      SET colour = public.next_energy_device_colour(device.home_id, device.category) WHERE id = device.id;
  END LOOP;
END $$;
ALTER TABLE public.energy_optimisation_devices ALTER COLUMN colour SET NOT NULL;
ALTER TABLE public.energy_optimisation_devices ADD CONSTRAINT energy_device_colour_unique UNIQUE (home_id, colour);
ALTER TABLE public.energy_optimisation_devices ENABLE TRIGGER energy_device_colour;
COMMIT;
`;
}

if (import.meta.main) {
  const migration = Deno.args[0];
  if (!migration?.startsWith('supabase/migrations/')) throw new Error('Pass a new migration path explicitly.');
  const sql = paletteMigration();
  try {
    const old = readFileSync(migration, 'utf8');
    if (old !== sql) throw new Error('Do not rewrite an existing migration; use a new timestamp.');
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
    writeFileSync(migration, sql);
  }
  writeFileSync(fileURLToPath(new URL('../src/components/portal/energy/charts/palette.css', import.meta.url)), paletteCss());
}
