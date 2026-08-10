import React, { useMemo, useState } from 'react';
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceArea, ReferenceLine, Legend,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/contexts/LanguageContext';
import { buildPlans, type SimSlot } from '@/lib/energy-shift/model';
import {
  ISSUED_AT, BINDING_UNTIL_SLOT, INITIAL, PLANT, DEVICES,
  GRID_IMPORT_SEK, GRID_EXPORT_SEK, PV_FORECAST_DAILY_KWH, MEASURED_DAILY_KWH,
} from '@/lib/energy-shift/inputs';

type PlanKey = 'baseline' | 'stack' | 'cost';

const COLORS = {
  base: '#64748b',
  boiler: '#38bdf8',
  pool: '#14b8a6',
  car: '#a78bfa',
  pv: '#f59e0b',
  soc: '#f43f5e',
};

const LoadShiftTab: React.FC = () => {
  const { t } = useLanguage();
  const [planKey, setPlanKey] = useState<PlanKey>('stack');

  const plans = useMemo(() => buildPlans(), []);
  const runs = {
    baseline: plans.baseline,
    stack: plans.stack,
    cost: plans.cost,
  };
  const active = runs[planKey];

  const chartData = useMemo(
    () => active.slots.map((s: SimSlot) => ({
      i: s.index,
      label: s.label,
      pv: Math.round(s.pvW),
      base: Math.round(s.baseW),
      boiler: Math.round(s.boilerW),
      pool: Math.round(s.poolW),
      car: Math.round(s.carW),
      soc: Number((s.soc * 100).toFixed(1)),
      price: s.importSek,
    })),
    [active],
  );

  // Day boundaries for axis ticks: one label every 4 hours.
  const ticks = useMemo(
    () => active.slots.filter((s) => s.minute === 0 && s.hour % 4 === 0).map((s) => s.index),
    [active],
  );

  const minSoc = (r: typeof active) => Math.min(...r.slots.map((s) => s.soc));
  const floorSlots = (r: typeof active) => r.slots.filter((s) => s.soc <= 0.055).length;
  const eod = (r: typeof active, day: string) => {
    const last = r.slots.filter((s) => s.day === day && s.pvW > 200).pop();
    return last ? last.soc : null;
  };
  const SOLAR_DAYS = ['2026-08-10', '2026-08-11', '2026-08-12'];

  const pct = (n: number | null) => (n === null ? '—' : `${(n * 100).toFixed(0)}%`);
  const kwh = (n: number) => `${n.toFixed(1)} kWh`;

  const planMeta: Record<PlanKey, { label: string; sub: string }> = {
    baseline: {
      label: t('A · Nuläge', 'A · Baseline'),
      sub: t('bilen laddar direkt, poolen kör fast middagsblock',
            'car charges immediately, pool on a fixed midday block'),
    },
    stack: {
      label: t('B · Prioritetsordning', 'B · Priority stack'),
      sub: t('batteriet reserveras till 80 % före pool och bil',
            'battery reserved to 80% before pool and car get any sun'),
    },
    cost: {
      label: t('C · Kostnadsstyrd', 'C · Cost-led'),
      sub: t('samma ordning, men ingen sol hålls tillbaka',
            'same ranking, but no sun is held back'),
    },
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-lg">
                {t('Lastförflyttning mot solprognos', 'Shifting load onto forecast solar')}
              </CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                {t(
                  `72 timmar i 15-minutersupplösning · plan utfärdad ${ISSUED_AT.slice(0, 16).replace('T', ' ')}`,
                  `72 hours at 15-minute resolution · plan issued ${ISSUED_AT.slice(0, 16).replace('T', ' ')}`,
                )}
              </p>
            </div>
            <div className="flex gap-1.5">
              {(Object.keys(planMeta) as PlanKey[]).map((k) => (
                <Button
                  key={k}
                  size="sm"
                  variant={planKey === k ? 'default' : 'outline'}
                  onClick={() => setPlanKey(k)}
                >
                  {planMeta[k].label}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">{planMeta[planKey].sub}</p>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
            <Kpi
              label={t('Lägsta SOC', 'Battery low point')}
              value={pct(minSoc(active))}
              detail={floorSlots(active) === 0
                ? t('rör aldrig golvet', 'never touches the floor')
                : t(`${floorSlots(active)} kvartar på 5 %-golvet`, `${floorSlots(active)} quarters on the 5% floor`)}
              tone={floorSlots(active) === 0 ? 'good' : 'bad'}
            />
            <Kpi
              label={t('Import', 'Grid import')}
              value={kwh(active.totals.importKwh)}
              detail={t(`av ${kwh(active.totals.loadKwh)} last`, `of ${kwh(active.totals.loadKwh)} load`)}
            />
            <Kpi
              label={t('Export', 'Exported')}
              value={kwh(active.totals.exportKwh)}
              detail={t('sista utvägen', 'sink of last resort')}
            />
            <Kpi
              label={t('Batteri vid soldagens slut', 'Battery, end of solar day')}
              value={SOLAR_DAYS.map((d) => pct(eod(active, d))).join(' / ')}
              detail={t('mål > 80 %', 'target >80%')}
            />
            <Kpi
              label={t('Nettokostnad', 'Net cost')}
              value={`${active.totals.netCost.toFixed(2)} SEK`}
              detail={t('endast prissatt fönster', 'priced window only')}
            />
          </div>

          <ResponsiveContainer width="100%" height={340}>
            <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
              {/* Numeric axis, not categorical: ReferenceArea x1/x2 have to be
                  compared as numbers for the advisory shading to land on the
                  right slot boundary. */}
              <XAxis
                dataKey="i"
                type="number"
                domain={[0, chartData.length - 1]}
                ticks={ticks}
                tickFormatter={(i) => chartData[i as number]?.label.slice(6) ?? ''}
                tick={{ fontSize: 11 }}
                interval={0}
              />
              <YAxis
                yAxisId="p"
                tick={{ fontSize: 11 }}
                tickFormatter={(w) => `${(w / 1000).toFixed(0)}`}
                label={{ value: 'kW', angle: -90, position: 'insideLeft', fontSize: 11 }}
              />
              <YAxis
                yAxisId="s"
                orientation="right"
                domain={[0, 100]}
                tick={{ fontSize: 11 }}
                tickFormatter={(v) => `${v}%`}
              />

              {/* Everything past the published price series is advisory. */}
              <ReferenceArea
                yAxisId="p"
                x1={BINDING_UNTIL_SLOT}
                x2={chartData.length - 1}
                fill="currentColor"
                className="text-muted"
                fillOpacity={0.28}
              />
              <ReferenceLine
                yAxisId="s"
                y={PLANT.socMin * 100}
                stroke={COLORS.soc}
                strokeDasharray="3 3"
                strokeOpacity={0.6}
              />

              <Area yAxisId="p" type="monotone" dataKey="pv" name={t('Solprognos', 'PV forecast')}
                stroke={COLORS.pv} fill={COLORS.pv} fillOpacity={0.16} strokeWidth={1.5} dot={false} />
              <Area yAxisId="p" type="step" dataKey="base" stackId="l" name={t('Baslast', 'Base load')}
                stroke={COLORS.base} fill={COLORS.base} fillOpacity={0.85} strokeWidth={0} dot={false} />
              <Area yAxisId="p" type="step" dataKey="boiler" stackId="l" name={t('Varmvatten', 'Hot water')}
                stroke={COLORS.boiler} fill={COLORS.boiler} fillOpacity={0.9} strokeWidth={0} dot={false} />
              <Area yAxisId="p" type="step" dataKey="pool" stackId="l" name={t('Pool', 'Pool heating')}
                stroke={COLORS.pool} fill={COLORS.pool} fillOpacity={0.9} strokeWidth={0} dot={false} />
              <Area yAxisId="p" type="step" dataKey="car" stackId="l" name={t('Bil', 'Car charging')}
                stroke={COLORS.car} fill={COLORS.car} fillOpacity={0.9} strokeWidth={0} dot={false} />
              <Line yAxisId="s" type="monotone" dataKey="soc" name={t('Batteri SOC', 'Battery SOC')}
                stroke={COLORS.soc} strokeWidth={2} dot={false} />

              <Tooltip
                contentStyle={{ fontSize: 12, borderRadius: 8 }}
                labelFormatter={(i) => chartData[i as number]?.label ?? ''}
                formatter={(v, n) => [n === 'Battery SOC' || n === 'Batteri SOC'
                  ? `${v}%` : `${((v as number) / 1000).toFixed(2)} kW`, n]}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
            </ComposedChart>
          </ResponsiveContainer>

          <p className="text-xs text-muted-foreground mt-2">
            {t(
              `Skuggat område = rådgivande. Spotpris finns bara till 2026-08-10 23:45 (${BINDING_UNTIL_SLOT} av ${chartData.length} kvartar).`,
              `Shaded region is advisory. Spot price exists only to 2026-08-10 23:45 — ${BINDING_UNTIL_SLOT} of ${chartData.length} quarter-hours are binding.`,
            )}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {t('Prioritetslistan har två tolkningar', 'The priority list has two readings')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground text-xs uppercase tracking-wide">
                  <th className="text-left font-medium py-2">{t('Plan', 'Plan')}</th>
                  <th className="text-right font-medium py-2">{t('Import', 'Import')}</th>
                  <th className="text-right font-medium py-2">{t('Export', 'Export')}</th>
                  <th className="text-right font-medium py-2">{t('Netto', 'Net')}</th>
                  <th className="text-right font-medium py-2">{t('Kvartar på golv', 'Floor quarters')}</th>
                  {SOLAR_DAYS.map((d) => (
                    <th key={d} className="text-right font-medium py-2">{d.slice(5)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(Object.keys(planMeta) as PlanKey[]).map((k) => (
                  <tr key={k} className={`border-t ${k === planKey ? 'bg-muted/40' : ''}`}>
                    <td className="py-2">{planMeta[k].label}</td>
                    <td className="text-right tabular-nums">{runs[k].totals.importKwh.toFixed(1)}</td>
                    <td className="text-right tabular-nums">{runs[k].totals.exportKwh.toFixed(1)}</td>
                    <td className="text-right tabular-nums">{runs[k].totals.netCost.toFixed(2)}</td>
                    <td className="text-right tabular-nums">{floorSlots(runs[k])}</td>
                    {SOLAR_DAYS.map((d) => (
                      <td key={d} className="text-right tabular-nums">{pct(eod(runs[k], d))}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-sm text-muted-foreground mt-4">
            {t(
              'Att läsa "batteri > 80 % vid soldagens slut" som en hård reservation innebär att sol hålls tillbaka från poolen, som då måste köra på nattimport. Vilken tolkning som gäller är beslutet i arkitekturdokumentets avsnitt 8.2 som ännu inte är fattat.',
              'Reading “battery >80% by end of solar day” as a hard reservation means holding sun back from the pool, which then runs on night import. Which reading applies is the decision in architecture §8.2 that has not been made yet.',
            )}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('Varifrån siffrorna kommer', 'Where the numbers come from')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Row k={t('Solprognos', 'PV forecast')}
            v={SOLAR_DAYS.map((d) => PV_FORECAST_DAILY_KWH[d].toFixed(1)).join(' / ') + ' kWh'}
            s="meteo_solar_production_forecast_estimate_* · 96-point watts attribute, 15 min native" />
          <Row k={t('Spotpris', 'Spot price')} v="0.157–0.404 SEK/kWh"
            s="tibber.get_prices · 15 min native · published to 2026-08-10 only" />
          <Row k={t('Nättariff', 'Grid tariff')} v={`${GRID_IMPORT_SEK} / ${GRID_EXPORT_SEK} SEK/kWh`}
            s="smart_home_solutions_grid_import_price.forecast · flat across every published slot" />
          <Row k={t('Batteri', 'Battery')}
            v={`${PLANT.batteryCapacityKwh} kWh @ ${(INITIAL.batterySoc * 100).toFixed(1)}%`}
            s="sigen_plant_rated_energy_capacity · _battery_state_of_charge, measured" />
          <Row k={t('Bil', 'Car')}
            v={`${(INITIAL.carSoc * 100).toFixed(0)}% → ${(DEVICES.car.targetSoc * 100).toFixed(0)}%`}
            s="tesla_model_y_charge_cable = on · energy_remaining 55.26 kWh implies a 75.7 kWh pack" />
          <Row k={t('Poolbehov', 'Pool requirement')} v={`${DEVICES.pool.dailyRequirementKwh} kWh/${t('dygn', 'day')}`}
            s={`median of ${MEASURED_DAILY_KWH.pool.length} measured days — the helper says ${DEVICES.pool.configuredTargetKwh}`}
            warn />
          <Row k={t('Varmvattenbehov', 'Hot water requirement')} v={`${DEVICES.boiler.dailyRequirementKwh} kWh/${t('dygn', 'day')}`}
            s={`median of ${MEASURED_DAILY_KWH.boiler.length} measured days — the helper says ${DEVICES.boiler.configuredTargetKwh}`}
            warn />
          <Row k={t('Baslast', 'Base load')} v="18.2 kWh/day"
            s="derived: 2026-08-01 total load minus the four modelled devices · hourly source, held flat" />

          <div className="pt-3 border-t">
            <Badge variant={plans.problems.length ? 'destructive' : 'secondary'}>
              {plans.problems.length
                ? t(`${plans.problems.length} invarianter bröts`, `${plans.problems.length} invariant failures`)
                : t('Alla invarianter håller', 'All invariants hold')}
            </Badge>
            <p className="text-xs text-muted-foreground mt-2">
              {plans.problems.length
                ? plans.problems.slice(0, 5).join(' · ')
                : t(
                  `Energibalansen stämmer inom 1 W över ${active.slots.length * 3} simulerade kvartar · SOC håller sig inom [5 %, 100 %] · ingen import över ${PLANT.gridImportMaxW / 1000} kW · aldrig import och export samtidigt · aldrig laddning och urladdning samtidigt.`,
                  `Per-slot energy balance closes within 1 W across ${active.slots.length * 3} simulated quarter-hours · SOC stays inside [5%, 100%] · import never exceeds ${PLANT.gridImportMaxW / 1000} kW · no slot both imports and exports · no slot both charges and discharges.`,
                )}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

const Kpi: React.FC<{ label: string; value: string; detail: string; tone?: 'good' | 'bad' }> = ({
  label, value, detail, tone,
}) => (
  <div className="rounded-lg border p-3">
    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
    <div className={`text-xl font-medium mt-1 tabular-nums ${
      tone === 'good' ? 'text-emerald-600 dark:text-emerald-400'
        : tone === 'bad' ? 'text-rose-600 dark:text-rose-400' : ''
    }`}>{value}</div>
    <div className="text-[11px] text-muted-foreground mt-0.5">{detail}</div>
  </div>
);

const Row: React.FC<{ k: string; v: string; s: string; warn?: boolean }> = ({ k, v, s, warn }) => (
  <div className="grid grid-cols-1 md:grid-cols-[200px_180px_1fr] gap-x-4 gap-y-0.5">
    <div className="font-medium">{k}</div>
    <div className="tabular-nums">{v}</div>
    <div className={`text-xs ${warn ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>{s}</div>
  </div>
);

export default LoadShiftTab;
