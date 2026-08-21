// A readable audit of the 72-hour solve.
//
// The store table explains the horizon-wide auction. The quarter table then
// shows its chronological consequence without pretending that the grid made a
// second decision: import and export are the residual balance after forecast
// PV, planned demand and battery dispatch.

import React from 'react';
import { AlertTriangle, Check, Minus } from 'lucide-react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useLanguage } from '@/contexts/LanguageContext';
import type { TimelineRange, TimelineRow } from '@/lib/energy-shift/energy-timeline';
import type { PlanModel } from './usePlanModel';

const ACTIVE_W = 10;
const CONTROLLED_ACTION_CATEGORIES = new Set([
  'pool_heating',
  'ev_charging',
  'hot_water',
  'heating',
  'cooling',
]);

/** Which per-slot column carries each stateful store's scheduled input. */
const POWER_FIELD: Record<string, 'pool_w' | 'ev_w' | 'battery_charge_w'> = {
  pool: 'pool_w',
  ev: 'ev_w',
  battery: 'battery_charge_w',
};

function windowedEnergy(
  slots: PlanModel['active']['slots'],
): Record<string, { inputKwh: number; outputKwh: number; inputHours: number; outputHours: number }> {
  const totals: Record<string, {
    inputKwh: number;
    outputKwh: number;
    inputHours: number;
    outputHours: number;
  }> = {};
  for (const [key, field] of Object.entries(POWER_FIELD)) {
    let inputKwh = 0;
    let outputKwh = 0;
    let inputSlots = 0;
    let outputSlots = 0;
    for (const slot of slots) {
      const watts = Number(slot[field] ?? 0);
      if (watts > ACTIVE_W) {
        inputKwh += watts / 4_000;
        inputSlots += 1;
      }
      if (key === 'battery' && slot.battery_discharge_w > ACTIVE_W) {
        outputKwh += slot.battery_discharge_w / 4_000;
        outputSlots += 1;
      }
    }
    totals[key] = {
      inputKwh,
      outputKwh,
      inputHours: inputSlots * 0.25,
      outputHours: outputSlots * 0.25,
    };
  }
  return totals;
}

type Reason =
  | 'scheduled'
  | 'state_above_curve'
  | 'value_below_price'
  | 'outbid'
  | 'not_controllable'
  | 'disconnected'
  | 'state_unavailable'
  | 'no_price_reference';

interface Row {
  key: string;
  unit: string;
  state: number | null;
  marginal_value_sek_per_kwh: number | null;
  cheapest_energy_sek_per_kwh: number | null;
  planned_kwh: number;
  returned_kwh: number;
  reason: Reason;
}

const UNCONSIDERED: ReadonlySet<Reason> = new Set<Reason>([
  'not_controllable',
  'disconnected',
  'state_unavailable',
  'no_price_reference',
]);

const STORE_LABEL: Record<string, [string, string]> = {
  pool: ['Pool', 'Pool'],
  ev: ['Bil', 'Car'],
  battery: ['Hembatteri', 'Home battery'],
  hot_water: ['Varmvatten', 'Hot water'],
};

const formatState = (unit: string, state: number | null): string => {
  if (state === null) return '—';
  if (unit === 'celsius') return `${state.toFixed(1)} °C`;
  if (unit === 'km') return `${Math.round(state)} km`;
  if (unit === 'kwh') return `${state.toFixed(1)} kWh`;
  return String(state);
};

const sek = (value: number | null): string =>
  value === null ? '—' : `${value.toFixed(2)} SEK/kWh`;

const REASON_TEXT: Record<Reason, { sv: [string, string]; en: [string, string] }> = {
  scheduled: {
    sv: ['Schemalagd', 'Minst en kvart vann sin värde–kostnadsjämförelse över 72 timmar'],
    en: ['Scheduled', 'At least one quarter won its value-versus-cost comparison across 72 hours'],
  },
  state_above_curve: {
    sv: ['Redan mättad', 'Ytterligare energi är värd noll vid starttillståndet'],
    en: ['Already satisfied', 'Another kWh is worth nothing at the initial state'],
  },
  value_below_price: {
    sv: ['Avstod', 'Startbudet låg under varje tillgänglig energikostnad i horisonten'],
    en: ['Declined', 'The initial bid was below every available energy cost in the horizon'],
  },
  outbid: {
    sv: ['Överbjuden', 'Startbudet klarade bottenpriset, men tid, gränser eller en annan allokering hindrade ett vinnande drag'],
    en: ['Outbid', 'The initial bid cleared the floor, but timing, limits or another allocation prevented a winning move'],
  },
  not_controllable: {
    sv: ['Planeras inte', 'Ingen mätare är satt till styrbar för den här tjänsten'],
    en: ['Not planned', 'No meter is set to controllable for this service'],
  },
  disconnected: {
    sv: ['Inte ansluten', 'Ingenting är inkopplat att ladda'],
    en: ['Not connected', 'Nothing is plugged in to charge'],
  },
  state_unavailable: {
    sv: ['Saknar mätvärde', 'Sensorn som värdekurvan använder saknas eller är otillgänglig'],
    en: ['No measured state', 'The sensor used by the value curve is missing or unavailable'],
  },
  no_price_reference: {
    sv: ['Inget prisunderlag', 'Inga priser fanns att värdera lagrad energi mot'],
    en: ['No price reference', 'No prices were available to value stored energy against'],
  },
};

const joinNatural = (values: string[], conjunction: string): string => {
  if (values.length <= 1) return values[0] ?? '';
  return `${values.slice(0, -1).join(', ')} ${conjunction} ${values.at(-1)}`;
};

const StoreDecisions: React.FC<{
  model: PlanModel;
  /** The same timeline window the chart above is showing, so the two agree. */
  rows: TimelineRow[];
  range: TimelineRange;
}> = ({ model, rows: timeline, range }) => {
  const { t, language } = useLanguage();
  const rows = (model.active.store_diagnostics ?? []) as Row[];
  const windowRows = React.useMemo(
    () => timeline.slice(range.from, range.to),
    [range.from, range.to, timeline],
  );
  const inWindow = React.useMemo(() => {
    const first = windowRows[0]?.startMs;
    const last = windowRows.at(-1)?.startMs;
    if (first === undefined || last === undefined) return [];
    return model.active.slots.filter(slot => {
      const at = Date.parse(slot.start);
      return at >= first && at <= last;
    });
  }, [model.active.slots, windowRows]);
  const energy = windowedEnergy(inWindow);

  const ordered = [...rows].sort((left, right) => {
    const rank = (row: Row) =>
      row.reason === 'scheduled' ? 0 : UNCONSIDERED.has(row.reason) ? 2 : 1;
    return rank(left) - rank(right) || left.key.localeCompare(right.key);
  });
  const unconsidered = ordered.filter(row => UNCONSIDERED.has(row.reason));
  const modelByKey = new Map(model.deviceRoleView.visibleModels.map(device => [device.key, device]));

  const actionNames = (slot: PlanModel['active']['slots'][number]) => {
    const values: string[] = [];
    const represented = new Set<string>();
    for (const [key, watts] of Object.entries(slot.device_loads_w)) {
      if (watts <= ACTIVE_W) continue;
      const device = modelByKey.get(key);
      // A device moved to base load since this plan was issued is part of the
      // situation, not an action. The refreshed plan will fold it into base.
      if (!device) continue;
      // Other empirical device rows are forecasts the plan has to serve, not
      // controls it chose. Calling an oven forecast a plan action would make
      // the causal ledger as misleading as the aggregate it replaces.
      if (!CONTROLLED_ACTION_CATEGORIES.has(device.category)) {
        continue;
      }
      represented.add(device.category);
      values.push(`${device.name} ${(watts / 1_000).toFixed(2)} kW`);
    }
    if (!represented.has('pool_heating') && slot.pool_w > ACTIVE_W) {
      values.push(`${t('Pool', 'Pool')} ${(slot.pool_w / 1_000).toFixed(2)} kW`);
    }
    if (!represented.has('ev_charging') && slot.ev_w > ACTIVE_W) {
      values.push(`${t('Bil', 'EV')} ${(slot.ev_w / 1_000).toFixed(2)} kW`);
    }
    if (!represented.has('hot_water') && slot.boiler_expected_w > ACTIVE_W) {
      values.push(`${t('Varmvatten', 'Hot water')} ${(slot.boiler_expected_w / 1_000).toFixed(2)} kW`);
    }
    const roomW = Object.values(slot.room_heating_w).reduce((sum, watts) => sum + watts, 0);
    const roomRepresented = represented.has('heating') || represented.has('cooling');
    if (!roomRepresented && roomW > ACTIVE_W) {
      values.push(`${t('Rumsvärme', 'Space heating')} ${(roomW / 1_000).toFixed(2)} kW`);
    }
    if (slot.battery_charge_w > ACTIVE_W) {
      values.push(`${t('Batteriladdning', 'Battery charge')} ${(slot.battery_charge_w / 1_000).toFixed(2)} kW`);
    }
    if (slot.battery_discharge_w > ACTIVE_W) {
      values.push(`${t('Batteriurladdning', 'Battery discharge')} ${(slot.battery_discharge_w / 1_000).toFixed(2)} kW`);
    }
    return values;
  };

  const why = (slot: PlanModel['active']['slots'][number]) => {
    const parts: string[] = [];
    const economicAction = slot.pool_w > ACTIVE_W
      || slot.ev_w > ACTIVE_W
      || slot.battery_charge_w > ACTIVE_W;
    const requiredAction = slot.boiler_expected_w > ACTIVE_W
      || Object.values(slot.room_heating_w).some(watts => watts > ACTIVE_W);

    if (economicAction && model.plan.schema_version >= 6) {
      parts.push(t(
        'Lagringen vann en värde–kostnadsjämförelse som gjordes över hela 72-timmarshorisonten.',
        'The store won a value-versus-cost comparison made across the full 72-hour horizon.',
      ));
    } else if (economicAction) {
      parts.push(t(
        'Den flexibla lasten placerades i denna kvart av planens horisontschema.',
        'The flexible load was placed in this quarter by the horizon schedule.',
      ));
    }
    if (requiredAction) {
      parts.push(t(
        'Värme eller varmvatten körs för att uppfylla sitt service- eller komfortkrav.',
        'Heating or hot water runs to meet its service or comfort requirement.',
      ));
    }
    if (slot.battery_discharge_w > ACTIVE_W && model.plan.schema_version >= 6) {
      parts.push(t(
        'Batteriet urladdas eftersom värdet av att undvika import eller sälja energin översteg värdet av att behålla den.',
        'The battery discharges because avoiding import or selling the energy was worth more than retaining it.',
      ));
    } else if (slot.battery_discharge_w > ACTIVE_W) {
      parts.push(t(
        'Batteriet täcker underskott enligt den äldre planmodellens batteriregel.',
        'The battery covers the shortfall under the older plan model’s battery rule.',
      ));
    }
    if (slot.grid_import_w > ACTIVE_W) {
      parts.push(t(
        `Efter sol och batteri återstod ${(slot.grid_import_w / 1_000).toFixed(2)} kW av den planerade lasten. Nätet balanserar resten; importen är inte ett separat ja/nej-beslut.`,
        `After solar and battery dispatch, ${(slot.grid_import_w / 1_000).toFixed(2)} kW of planned demand remained. The grid balances the remainder; import is not a separate yes/no decision.`,
      ));
    } else if (slot.grid_export_w > ACTIVE_W) {
      parts.push(t(
        `Efter last och laddning återstod ${(slot.grid_export_w / 1_000).toFixed(2)} kW. Ingen ytterligare lagringsallokering accepterades, så resten säljs.`,
        `After load and charging, ${(slot.grid_export_w / 1_000).toFixed(2)} kW remained. No further store allocation was accepted, so the remainder is sold.`,
      ));
    } else if (slot.curtailed_w > ACTIVE_W) {
      parts.push(t(
        'Exportgränsen nåddes, så återstående överskott begränsas.',
        'The export limit was reached, so the remaining surplus is curtailed.',
      ));
    } else {
      parts.push(t(
        'Sol, last och batteri balanserar inom huset, så inget nätflöde återstår.',
        'Solar, demand and battery balance within the home, leaving no grid flow.',
      ));
    }
    if (slot.unserved_w > ACTIVE_W) {
      parts.push(t(
        `${(slot.unserved_w / 1_000).toFixed(2)} kW kunde inte levereras eftersom importgränsen nåddes.`,
        `${(slot.unserved_w / 1_000).toFixed(2)} kW could not be served because the import limit was reached.`,
      ));
    }
    return parts.join(' ');
  };

  if (inWindow.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t(
          'Den valda perioden ligger före den aktuella planen. Grafen visar uppmätta värden där, men den här planen fattade inga beslut för perioden.',
          'The selected period is before the current plan. The chart shows measured values there, but this plan made no decisions for that period.',
        )}
      </p>
    );
  }

  return (
    <Accordion type="multiple" className="w-full">
      <AccordionItem value="stores">
        <AccordionTrigger className="py-3 text-sm hover:no-underline">
          {t('Lagringarnas 72-timmarsbeslut', 'The stores’ 72-hour decision')}
        </AccordionTrigger>
        <AccordionContent className="space-y-3">
          <p className="text-[11px] text-muted-foreground">
            {t(
              'Startbud och lägsta tillgängliga kostnad gäller hela horisonten. Den lägsta kostnaden är totalt köppris när energi måste köpas, eller förlorat totalt säljpris när prognosen har solelöverskott. Den är alltså varken ett genomsnittligt köppris eller enbart elbörspriset. Planerat gäller den valda perioden.',
              'Initial bid and lowest available cost cover the full horizon. Lowest cost is the all-in import price when energy must be bought, or the forgone all-in export price when forecast solar is in surplus. It is therefore neither an average import tariff nor the wholesale electricity price alone. Planned covers the selected period.',
            )}
          </p>
          {model.planView === 'unplanned' && (
            <p className="text-[11px] text-muted-foreground">
              {t(
                'Detta är motfaktiska värden från vyn Utan plan; Home Assistant kör vyn Med plan.',
                'These are counterfactual values from the Without plan view; Home Assistant executes the With plan view.',
              )}
            </p>
          )}

          {ordered.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Lagring', 'Store')}</TableHead>
                  <TableHead className="text-right">{t('Starttillstånd', 'Initial state')}</TableHead>
                  <TableHead className="text-right">{t('Startbud', 'Initial bid')}</TableHead>
                  <TableHead className="text-right">{t('Lägsta tillgängliga kostnad', 'Lowest available cost')}</TableHead>
                  <TableHead className="text-right">{t('Planerat i perioden', 'Planned in window')}</TableHead>
                  <TableHead>{t('Utfall', 'Outcome')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ordered.map(row => {
                  const text = REASON_TEXT[row.reason] ?? REASON_TEXT.outbid;
                  const [headline, detail] = language === 'sv' ? text.sv : text.en;
                  const absent = UNCONSIDERED.has(row.reason);
                  const label = STORE_LABEL[row.key] ?? [row.key, row.key];
                  const flow = energy[row.key];
                  return (
                    <TableRow key={row.key} className={absent ? 'bg-amber-50/60 dark:bg-amber-950/20' : undefined}>
                      <TableCell className="font-medium">{language === 'sv' ? label[0] : label[1]}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatState(row.unit, row.state)}</TableCell>
                      <TableCell className="text-right tabular-nums">{sek(row.marginal_value_sek_per_kwh)}</TableCell>
                      <TableCell className="text-right tabular-nums">{sek(row.cheapest_energy_sek_per_kwh)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {(flow?.inputKwh ?? 0) > 0.05 && (
                          <span className="block">
                            {flow.inputKwh.toFixed(1)} kWh {t('in', 'in')}
                            <span className="block text-[11px] text-muted-foreground">{flow.inputHours.toFixed(1)} h</span>
                          </span>
                        )}
                        {(flow?.outputKwh ?? 0) > 0.05 && (
                          <span className="block">
                            {flow.outputKwh.toFixed(1)} kWh {t('ut', 'out')}
                            <span className="block text-[11px] text-muted-foreground">{flow.outputHours.toFixed(1)} h</span>
                          </span>
                        )}
                        {(flow?.inputKwh ?? 0) <= 0.05 && (flow?.outputKwh ?? 0) <= 0.05 && '—'}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-start gap-1.5">
                          {absent
                            ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-500" aria-hidden />
                            : row.reason === 'scheduled'
                              ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-500" aria-hidden />
                              : <Minus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />}
                          <span>
                            <span className="font-medium">{headline}</span>
                            <span className="block text-[11px] text-muted-foreground">{detail}</span>
                          </span>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t(
                'Den här planen har inga fysiska lagringsbud. Kvartsföljden visar ändå hur planerad last och sol gav nätflödet.',
                'This plan has no physical-store bids. The quarter sequence still shows how planned demand and solar produced the grid flow.',
              )}
            </p>
          )}

          {unconsidered.length > 0 && (
            <p className="rounded-md border border-amber-300 bg-amber-50/70 p-2 text-[11px] text-amber-900 dark:border-amber-800 dark:bg-amber-950/25 dark:text-amber-200">
              {t(
                'Markerade rader deltog aldrig i avvägningen. De förlorade inte på värde; en mappning, anslutning eller sensor måste rättas.',
                'Highlighted rows never entered the trade-off. They did not lose on value; a mapping, connection or sensor must be corrected.',
              )}
            </p>
          )}
        </AccordionContent>
      </AccordionItem>

      <AccordionItem value="sequence">
        <AccordionTrigger className="py-3 text-sm hover:no-underline">
          {t('Beslutsföljd per 15 minuter', '15-minute decision sequence')}
        </AccordionTrigger>
        <AccordionContent>
          <p className="mb-2 text-[11px] text-muted-foreground">
            {t(
              'Köp och sälj visar totalpriset som objektivet använde. Publicerat betyder verkligt dag-före-pris; modellerat betyder husets prisprognos efter den publicerade perioden.',
              'Buy and sell show the all-in prices used by the objective. Published means an actual day-ahead price; modelled means this home’s price forecast beyond the published period.',
            )}
          </p>
          <div className="[&>div]:max-h-[38rem] [&>div]:rounded-md [&>div]:border">
            <Table className="min-w-[1100px]">
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead>{t('Kvart', 'Quarter')}</TableHead>
                <TableHead>{t('Situation före batteriet', 'Before battery')}</TableHead>
                <TableHead>{t('Planåtgärder', 'Plan actions')}</TableHead>
                <TableHead>{t('Nätresultat', 'Grid result')}</TableHead>
                <TableHead>{t('Totalpriser använda', 'All-in prices used')}</TableHead>
                <TableHead className="min-w-[360px]">{t('Varför', 'Why')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {inWindow.map(slot => {
                const balanceW = slot.pv_w - slot.load_w;
                const actions = actionNames(slot);
                const published = slot.import_price_sek_per_kwh !== null
                  && slot.export_price_sek_per_kwh !== null;
                const grid = slot.grid_import_w > ACTIVE_W
                  ? `${t('Import', 'Import')} ${(slot.grid_import_w / 1_000).toFixed(2)} kW`
                  : slot.grid_export_w > ACTIVE_W
                    ? `${t('Export', 'Export')} ${(slot.grid_export_w / 1_000).toFixed(2)} kW`
                    : t('Inget nätflöde', 'No grid flow');
                return (
                  <TableRow key={slot.start}>
                    <TableCell className="whitespace-nowrap align-top tabular-nums">
                      {new Date(slot.start).toLocaleString([], {
                        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
                      })}
                    </TableCell>
                    <TableCell className="whitespace-nowrap align-top tabular-nums">
                      <span className="block">{t('Sol', 'PV')} {(slot.pv_w / 1_000).toFixed(2)} · {t('last', 'demand')} {(slot.load_w / 1_000).toFixed(2)} kW</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {Math.abs(balanceW) <= ACTIVE_W
                          ? t('i balans', 'balanced')
                          : balanceW > 0
                            ? `${(balanceW / 1_000).toFixed(2)} kW ${t('överskott', 'surplus')}`
                            : `${(-balanceW / 1_000).toFixed(2)} kW ${t('underskott', 'shortfall')}`}
                      </span>
                    </TableCell>
                    <TableCell className="align-top">
                      {actions.length > 0
                        ? joinNatural(actions, t('och', 'and'))
                        : <span className="text-muted-foreground">{t('Ingen flexibel eller batteriåtgärd', 'No flexible or battery action')}</span>}
                    </TableCell>
                    <TableCell className="whitespace-nowrap align-top font-medium tabular-nums">{grid}</TableCell>
                    <TableCell className="whitespace-nowrap align-top tabular-nums">
                      <span className="block">{t('Köp', 'Buy')} {slot.shadow_import_sek_per_kwh.toFixed(3)} SEK/kWh</span>
                      <span className="block">{t('Sälj', 'Sell')} {slot.shadow_export_sek_per_kwh.toFixed(3)} SEK/kWh</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {published ? t('publicerat', 'published') : t('modellerat', 'modelled')}
                      </span>
                    </TableCell>
                    <TableCell className="align-top text-xs text-muted-foreground">{why(slot)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
            </Table>
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
};

export default StoreDecisions;
