import { useLanguage } from '@/contexts/LanguageContext';
import { DEFAULT_SETTINGS } from '@/lib/home-baseline/controller';
import type { BaselineCapture } from '@/lib/home-baseline/browser';
import { formatHomeStamp } from '@/lib/energy-shift/home-time';

/** Inspection data stays available without pushing the chart down the page. */
export default function BaselineModelDetails({ capture }: { capture: BaselineCapture }) {
  const { t } = useLanguage();
  const { input, result } = capture;
  const p = input.problem;
  const number = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const stamp = (at: string) => formatHomeStamp(at, input.timeZone);
  const demand = input.evDemandKwh.reduce((sum, value) => sum + value, 0);
  return <details className="rounded-lg border p-4" data-testid="baseline-details">
    <summary className="cursor-pointer text-sm font-medium">{t('Modelldetaljer', 'Model details')}</summary>
    <div className="mt-4 space-y-4 text-sm" data-testid="baseline-models">
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[auto_1fr]">
        {p.battery && <><dt className="font-medium">{t('Batteri', 'Battery')}</dt><dd>
          {t('Maximal egenförbrukning', 'Maximum self consumption')} · {number(p.battery.capacity_kwh)} kWh · {number(p.battery.min_soc * 100)}–{number(p.battery.max_soc * 100)}% SOC
          <br />{number(p.battery.charge_max_w / 1000)} / {number(p.battery.discharge_max_w / 1000)} kW · {t('verkningsgrad', 'efficiency')} {number(p.battery.charge_efficiency * 100)} / {number(p.battery.discharge_efficiency * 100)}%
        </dd></>}
        {p.car && p.charger && <><dt className="font-medium">{input.carName}</dt><dd>
          {t('80% från midnatt', '80% from midnight')} · {t('lastbalanserad', 'load balanced')} · {number(p.car.capacity_kwh)} kWh · {number(p.charger.max_current_a)} A · {p.charger.phase_count} × {number(p.charger.voltage_v)} V
          <br />{t('Laddningsverkningsgrad', 'Charge efficiency')} {number(p.car.charge_efficiency * 100)}% · {t('körbehov', 'driving demand')} {number(demand)} kWh
        </dd></>}
        {p.pool_store && p.heater && <><dt className="font-medium">Pool</dt><dd>
          {t('Start', 'Start')} {number(DEFAULT_SETTINGS.poolStartC)}°C · {t('stopp', 'stop')} {number(p.pool_stop_c)}°C · {t('cirkulation', 'circulation')} {input.idlePumpW} W
          <br />{t('Kompressor / värme / full pump', 'Compressor / heat / full pump')}: {number(p.heater.compressor_w / 1000)} / {number(p.heater.heat_w / 1000)} / {number((p.heater.auxiliary_w + input.idlePumpW) / 1000)} kW
          <br />{number(p.pool_store.capacity_kwh_per_c)} kWh/°C · {p.heater.response.kind} · {t('värmeförlust', 'heat loss')}: {p.pool_store.loss.kind === 'linear'
            ? `${number(p.pool_store.loss.kw_per_c)} kW/°C`
            : `${p.pool_store.loss.points.length} ${t('mätpunkter', 'measured points')}`}
        </dd></>}
        <dt className="font-medium">{t('Nätgränser', 'Grid limits')}</dt><dd>{number(p.limits.import_w / 1000)} / {number(p.limits.export_w / 1000)} kW</dd>
      </dl>
      {p.car && <table className="w-full text-left">
        <caption className="sr-only">{t('Dagligt körbehov', 'Daily driving demand')}</caption>
        <thead><tr><th>{t('Dag', 'Day')}</th><th>{t('Körbehov (kWh)', 'Driving demand (kWh)')}</th></tr></thead>
        <tbody>{input.evDailyDemand.map(day => <tr key={day.day}><td>{day.day}</td><td>{number(day.kwh)}</td></tr>)}</tbody>
      </table>}
      <div className="space-y-1 text-muted-foreground" data-testid="baseline-assumptions">
        {input.recovery.hours > 0 && <p data-testid="baseline-hourly-recovery">{input.recovery.hours} {t('timmar från HA:s historik; energi fördelas jämnt och SOC använder timmedelvärden.', 'hours from HA history; energy is spread evenly and SOC uses hourly means.')}
          {input.recovery.balanceHours > 0 && ` ${input.recovery.balanceHours} ${t('timmar med husförbrukning beräknad från elflöden.', 'hours with household demand reconstructed from electricity flows.')}`}
          {input.recovery.deviceSumHours > 0 && ` ${input.recovery.deviceSumHours} ${t('timmar med baslast summerad från övriga enheter.', 'hours with baseline demand summed from other devices.')}`}
          {input.recovery.invalidReadings > 0 && ` ${input.recovery.invalidReadings} ${t('ogiltiga energivärden utelämnade.', 'invalid energy readings omitted.')}`}
        </p>}
        <p>{t('Indata', 'Inputs')}: {t('uppmätt förbrukning, solproduktion och elpriser', 'recorded consumption, solar and electricity prices')}. {input.timeZone}.</p>
        <p>{input.priceArea} · {input.reconstructedPriceQuarters} {t('kvartar med återskapade elpriser', 'quarters with reconstructed electricity prices')}. {t('Nätavgifter enligt hemmets valda historiska tariff.', 'Grid costs use the home’s configured historical tariff.')}</p>
        {input.assumedPriceQuarters > 0 && <p>{input.assumedPriceQuarters} {t('kvartar med antaget historiskt leverantörspåslag.', 'quarters with an assumed historical supplier markup.')}</p>}
        <p>{t('Saknade nätimport- / exportkvartar', 'Missing grid import / export quarters')}: {input.recorded.missingImportQuarters} / {input.recorded.missingExportQuarters}.</p>
        {(input.energyGaps.householdQuarters > 0 || input.energyGaps.solarQuarters > 0 || input.energyGaps.deviceReadings > 0) && <p data-testid="baseline-energy-gaps">
          {t('Saknad energi räknas som 0', 'Missing energy counts as 0')}: {input.energyGaps.deviceReadings} {t('enhetsvärden', 'device readings')}, {input.energyGaps.solarQuarters} {t('solkvartar', 'solar quarters')}.
          {' '}{input.energyGaps.householdQuarters} {t('kvartar med förbrukning summerad från övriga enheter.', 'quarters with consumption summed from other devices.')}
        </p>}
        {input.batteryInitialAssumed && <p data-testid="baseline-battery-start">{t('Batteriets start-SOC saknas; modellen börjar med ett tomt batteri (0%).', 'Initial battery SOC is missing; the model starts with an empty battery (0%).')}</p>}
        <p>{t('Modeller fångade', 'Models captured')}: {stamp(input.modelCapturedAt)}. {t('Startkvart', 'Initial quarter')}: {stamp(input.initialObservedAt)}.</p>
        {input.evInitialAssumed && <p data-testid="baseline-ev-start">{t('Bilens start-SOC saknas; modellen börjar på 80%. Första avläsningen blir referens för körbehov.', 'Initial car SOC is missing; the model starts at 80%. The first reading establishes the driving-demand reference.')}</p>}
        {input.poolInitialAssumed && <p data-testid="baseline-pool-start">{t('Poolens starttemperatur saknas; modellen börjar på 30°C.', 'Initial pool temperature is missing; the model starts at 30°C.')}</p>}
        {input.evInitialObservedAt && <p>{t('Bilens start-SOC', 'Initial car SOC')}: {stamp(input.evInitialObservedAt)}.</p>}
        {p.car && <p>{t('SOC-minskningar ger körbehov; tidigare laddning ignoreras. Nattladdning antas vara tillgänglig.', 'Recorded SOC declines give driving demand; previous charging is ignored. Overnight charging is assumed available.')}</p>}
        {p.car && input.evMissingSocQuarters > 0 && <p>{input.evMissingSocQuarters} {t('kvartar utan SOC; minskningar räknas vid nästa avläsning.', 'quarters without SOC; declines count at the next reading.')}</p>}
        {p.pool_store && <p>{t('Värmepumpens starttillstånd: av, historisk startfas okänd.', 'Heat pump initial state: off, historical startup phase unknown.')}</p>}
        <p>{t('Använd solel = produktion minus export, inklusive batteriladdning. Export räknas som solel; mätaren anger inte energins ursprung.', 'Solar consumption = generation minus exports, including battery charging. Exports are counted as solar; the meter does not identify energy origin.')}</p>
        <p>{t('Grafkostnader exkluderar fasta avgifter och SHS-abonnemang.', 'Graph costs exclude fixed fees and SHS subscription')}</p>
        <p>{t('Beräkning', 'Calculation')}: {Math.round(result.projectionMs)} ms. {t('Fullständiga indata finns i modellexporten.', 'Full inputs are available in the model export.')}</p>
      </div>
    </div>
  </details>;
}
