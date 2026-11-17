import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CartesianGrid, Legend, Line, LineChart, ReferenceArea, ReferenceLine, Tooltip, XAxis, YAxis } from 'recharts';
import { z } from 'zod';
import { ChartContainer } from '@/components/ui/chart';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLanguage } from '@/contexts/LanguageContext';
import { supabase } from '@/integrations/supabase/client';
import { HEATING_HOURS, SCENARIO_HOURS, projectDoorwayImpact, projectRoomCycle } from '@/lib/energy-shift/room-scenario';
import { readThermalModel } from '../../../../supabase/functions/_shared/planner/models/room/read-model';
import { SLOT_HOURS, type ThermalZoneModel } from '../../../../supabase/functions/_shared/planner/models/room/thermal';
import { THERMAL_REJECTION_EN, THERMAL_REJECTION_SV } from './plan/types';

const roomRow = z.object({
  trained: z.boolean(),
  rejection_reason: z.string().nullable(),
}).catchall(z.unknown());
const scenarioResponse = z.object({
  room: roomRow.nullable(),
  connections: z.array(z.object({
    key: z.string(),
    name: z.string().nullable(),
    model: roomRow.nullable(),
    doorway: z.object({ weight: z.number().positive(), usual: z.number() }).nullable(),
  })),
});
type Connection = z.infer<typeof scenarioResponse>['connections'][number];

const colors = ['hsl(var(--primary))', '#b47724', '#7565c5', '#23826b', '#c05873', '#297b9b'];
const dashes = [undefined, '6 3', '2 3', '8 3 2 3'];
const referenceOutdoorC = 8;
const heatingEnd = HEATING_HOURS / SLOT_HOURS;

function ScenarioInput({ label, value, onChange, min }: {
  label: string; value: string; onChange: (value: string) => void; min?: number;
}) {
  const id = useId();
  return <div className="min-w-0 space-y-1.5">
    <Label htmlFor={id}>{label}</Label>
    <Input id={id} type="number" step="any" min={min} value={value} className="h-11 tabular-nums"
      onChange={event => onChange(event.target.value)} />
  </div>;
}

interface Series { name: string; values: number[] }
type ChartPoint = { hour: number; values: number[] };

function ProjectionChart({ series, label, cycle = false }: { series: Series[]; label: string; cycle?: boolean }) {
  const { language, t } = useLanguage();
  const format = (value: number) => value.toLocaleString(language, { maximumFractionDigits: 2 });
  const data = series[0].values.map((_, index) => ({
    hour: index * SLOT_HOURS, values: series.map(line => line.values[index]),
  }));
  return <ChartContainer className="h-60 w-full min-w-0" config={{}} role="img" aria-label={label}>
    <LineChart data={data} margin={{ top: 12, right: 18, left: 0, bottom: 8 }}>
      <CartesianGrid vertical={false} className="stroke-border" />
      <XAxis dataKey="hour" type="number" domain={[0, SCENARIO_HOURS]}
        ticks={[0, HEATING_HOURS, 4, SCENARIO_HOURS]} tickFormatter={hour => `${hour} h`} />
      <YAxis width={46} domain={['auto', 'auto']} tickFormatter={value => `${format(value)}°`} />
      {cycle ? <>
        <ReferenceArea x1={0} x2={HEATING_HOURS} fill={colors[1]} fillOpacity={0.11} stroke="none" />
        <ReferenceLine x={HEATING_HOURS} stroke={colors[1]} strokeDasharray="3 3" />
      </> : <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" />}
      {series.map((line, index) => <Line key={index} name={line.name}
        dataKey={(point: ChartPoint) => point.values[index]} stroke={colors[index % colors.length]}
        strokeDasharray={dashes[index % dashes.length]} strokeWidth={2.5} dot={false} isAnimationActive={false} />)}
      <Tooltip formatter={(value: number) => `${format(value)} °C`}
        labelFormatter={hour => `${format(Number(hour))} h · ${t('från start', 'from start')}`}
        contentStyle={{ background: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))', borderRadius: 8 }} />
      <Legend wrapperStyle={{ fontSize: 12 }} />
    </LineChart>
  </ChartContainer>;
}

function RoomScenario({ model, connections }: { model: ThermalZoneModel; connections: Connection[] }) {
  const { language, t } = useLanguage();
  const [outdoor, setOutdoor] = useState('-5');
  const [start, setStart] = useState('19');
  const [house, setHouse] = useState('20');
  const [powerOverride, setPower] = useState<string | null>(null);
  const fitPower = model.heating_rate_c_per_h && model.heating_rate_c_per_h > 0
    ? String(Math.round(model.heating_rate_c_per_h / model.gain_c_per_wh) / 1000) : '';
  const power = powerOverride ?? fitPower;
  const controls = [outdoor, start, house, power];
  const scenario = { startC: Number(start), outdoorC: Number(outdoor), houseC: Number(house), heaterW: Number(power) * 1000 };
  const valid = controls.every(value => value.trim()) && Object.values(scenario).every(Number.isFinite) && scenario.heaterW >= 0;
  const temperatures = valid ? projectRoomCycle(model, scenario) : null;
  const reference = valid ? projectRoomCycle(model, { ...scenario, outdoorC: referenceOutdoorC }) : null;
  const format = (value: number, digits = 1) => value.toLocaleString(language, { maximumFractionDigits: digits });
  const temp = (value: number) => `${format(value)} °C`;
  const change = (value: number) => {
    const rounded = Math.round(value * 100) / 100;
    return `${rounded > 0 ? '+' : ''}${format(rounded, 2)} °C`;
  };
  const receivingRooms = connections.map(connection => {
    const name = connection.name || t('Otillgängligt rum', 'Unavailable room');
    const receiver = connection.model?.trained ? readThermalModel(connection.model) : null;
    const values = temperatures && receiver && connection.doorway &&
      connection.doorway.weight <= (receiver.house_coupling_per_h ?? 0) * (1 + 1e-12)
      ? projectDoorwayImpact(receiver, connection.doorway, temperatures, scenario.houseC) : null;
    return { key: connection.key, name, values };
  });
  const peerSeries = receivingRooms.flatMap(room => room.values ? [{ name: room.name, values: room.values }] : []);
  const showComparison = scenario.outdoorC !== referenceOutdoorC;
  const cycleTitle = t('Uppskattad uppvärmning och avsvalning', 'Warm-up and cool-down estimate');
  const doorwayTitle = t('Uppskattad påverkan på anslutna rum', 'Estimated effect on connected rooms');
  return <div className="space-y-4">
    <div className="grid grid-cols-2 gap-3 border-b pb-4 xl:grid-cols-4">
      <ScenarioInput label={t('Ute (°C)', 'Outdoors (°C)')} value={outdoor} onChange={setOutdoor} />
      <ScenarioInput label={t('Rum vid start (°C)', 'Room at start (°C)')} value={start} onChange={setStart} />
      <ScenarioInput label={t('Övriga hemmet (°C)', 'Rest of home (°C)')} value={house} onChange={setHouse} />
      <ScenarioInput label={t('Värmarens effekt (kW)', 'Heater power (kW)')} value={power} onChange={setPower} min={0} />
    </div>
    {temperatures && reference ? (
      <div className="grid gap-5 xl:grid-cols-2">
        <section className="min-w-0 space-y-1">
          <h4 className="font-semibold">{cycleTitle}</h4>
          <p className="text-xs text-muted-foreground">{t(
            'Värmaren går i 2 timmar (skuggat), sedan är den av i 4. Fast utetemperatur, utan sol eller lagrad värme vid start.',
            'Heater on for 2 hours (shaded), then off for 4. Constant outdoor temperature, with no sun or stored heater heat at the start.',
          )}</p>
          <ProjectionChart cycle label={cycleTitle} series={[
            { name: temp(scenario.outdoorC), values: temperatures },
            ...(showComparison ? [{ name: temp(referenceOutdoorC), values: reference }] : []),
          ]} />
          <p className="text-xs tabular-nums" aria-live="polite">{t(
            `Vid ${temp(scenario.outdoorC)} ute · ${temp(temperatures[heatingEnd])} efter 2 h · ${temp(temperatures.at(-1)!)} efter 6 h`,
            `At ${temp(scenario.outdoorC)} outside · ${temp(temperatures[heatingEnd])} after 2 h · ${temp(temperatures.at(-1)!)} after 6 h`,
          )}</p>
        </section>
        <section className="min-w-0 space-y-1">
          <h4 className="font-semibold">{doorwayTitle}</h4>
          {peerSeries.length > 0 && <>
            <p className="text-xs text-muted-foreground">{t(
              `Vid ${temp(scenario.outdoorC)} ute, jämfört med när det valda rummet håller sin vanliga temperatur.`,
              `At ${temp(scenario.outdoorC)} outside, compared with the selected room at its usual temperature.`,
            )}</p>
            <ProjectionChart label={doorwayTitle} series={peerSeries} />
          </>}
          {receivingRooms.length === 0 ? <p className="text-sm text-muted-foreground">{t('Inga sparade rumsanslutningar.', 'No saved room connections.')}</p>
            : <ul className="space-y-1 text-xs" aria-live="polite">
              {receivingRooms.map(room => <li key={room.key}><span className="font-medium">{room.name}</span>
                {room.values ? ` · ${change(room.values[heatingEnd])} ${t('efter', 'after')} 2 h · ${change(room.values.at(-1)!)} ${t('efter', 'after')} 6 h`
                  : ` · ${t('Ingen inlärd påverkan från det valda rummet ännu', 'No learned effect from the selected room yet')}`}
              </li>)}
            </ul>}
        </section>
      </div>
    ) : <p role="status" className="text-sm text-muted-foreground">{t(
      'Ange temperaturer och värmarens effekt för att visa uppskattningen. Ange 0 kW för att se rummet utan uppvärmning.',
      'Enter temperatures and heater power to see the estimate. Enter 0 kW to see the unheated room.',
    )}</p>}
  </div>;
}

export default function ComfortRoomModel({ homeId, roomId }: { homeId: string; roomId: string }) {
  const { t } = useLanguage();
  const query = useQuery({
    queryKey: ['room-model-scenario', homeId, roomId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_energy_room_model_scenario', { p_home_id: homeId, p_room_key: roomId });
      if (error) throw error;
      return scenarioResponse.parse(data);
    },
  });
  const room = query.data?.room;
  const model = room?.trained ? readThermalModel(room) : null;
  const rejection = room?.rejection_reason;
  return <div className="min-w-0 space-y-3 rounded-md border p-4 text-sm">
    <h3 className="font-semibold">{t('Rummets värmemodell', 'Room heating model')}</h3>
    {model && query.data ? <>
      <RoomScenario key={roomId} model={model} connections={query.data.connections} />
      <p className="text-xs text-muted-foreground">{t(
        `Modellen är tränad på ${model.sample_count} kvartar.`, `The model was trained on ${model.sample_count} quarters.`,
      )}</p>
    </> : <p role={query.isError ? 'alert' : 'status'} className="text-muted-foreground">
      {query.isPending ? t('Laddar modell…', 'Loading model…') : query.isError || room?.trained
        ? t('Modellen kunde inte läsas.', 'The model could not be loaded.')
        : rejection && THERMAL_REJECTION_EN[rejection] ? t(THERMAL_REJECTION_SV[rejection], THERMAL_REJECTION_EN[rejection])
          : t('Ingen tränad modell har publicerats för rummet ännu.', 'A trained model has yet to be published for this room.')}
    </p>}
    <Link className="inline-flex min-h-11 items-center font-medium text-primary" to="?tab=setup&section=thermal">
      {t('Visa temperaturhistorik', 'View temperature history')}
    </Link>
  </div>;
}
