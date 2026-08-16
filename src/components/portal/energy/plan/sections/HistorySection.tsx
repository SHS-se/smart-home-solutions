// What the house actually did, and what it cost.
//
// Split off the Plan tab on 2026-08-13 (ENERGY_OPTIMISATION_ARCHITECTURE.md
// §1.3.7). The measured chart moved here unchanged; the window summary and the
// per-device table are new.

import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useLanguage } from '@/contexts/LanguageContext';
import type { ActualEnergySlot } from '@/lib/energy-shift/contracts';
import {
  attributeEnergy,
  type SupplySlotInput,
} from '@/lib/energy-shift/energy-attribution';
import type { EmpiricalEnergyDevice } from '../../EmpiricalDeviceModelsCard';
import { Kpi, WindowDaysToggle } from '../ui';
import {
  WINDOW_SLOTS_PER_DAY,
  type EmpiricalDeviceSlotMatrix,
  type PriceSlotRow,
  type WindowDays,
} from '../types';

const HistorySection: React.FC<{
  actuals: ActualEnergySlot[];
  devices: EmpiricalEnergyDevice[];
  deviceActuals: EmpiricalDeviceSlotMatrix[];
  prices: PriceSlotRow[];
  windowDays: WindowDays;
  onWindowDaysChange: (value: WindowDays) => void;
}> = ({
  actuals,
  devices,
  deviceActuals,
  prices,
  windowDays,
  onWindowDaysChange,
}) => {
  const { t } = useLanguage();

  // Only devices the integration has actually mapped. Energy Dashboard
  // discovery reports every metered thing in the house, so the freezer, the
  // oven and a dozen unnamed power points arrived with no control type and
  // showed up as "· undefined" on the chart and as their own table rows. They
  // are real consumption and still belong in the house total — they belong in
  // base load, which is exactly what base load is for.
  const configuredDevices = useMemo(
    () => devices.filter(device => device.mapping_status === 'ready'),
    [devices],
  );

  // The full 72 hours are already loaded, so narrowing the window is a slice
  // rather than a refetch.
  const windowed = useMemo(
    () => actuals.slice(Math.max(0, actuals.length - windowDays * WINDOW_SLOTS_PER_DAY)),
    [actuals, windowDays],
  );

  const attribution = useMemo(() => {
    const deviceEnergyByStart = new Map(
      deviceActuals.map(slot => [slot.start_ts, slot.device_energy_kwh]),
    );
    const priceByStart = new Map(prices.map(price => [price.start_ts, price]));
    const slots: SupplySlotInput[] = windowed.map(slot => {
      const price = priceByStart.get(slot.start_ts) ?? null;
      return {
        start: slot.start_ts,
        loadKwh: slot.total_load_kwh,
        solarKwh: slot.solar_production_kwh,
        gridImportKwh: slot.grid_import_kwh,
        gridExportKwh: slot.grid_export_kwh,
        batteryChargeKwh: slot.battery_charge_kwh,
        batteryDischargeKwh: slot.battery_discharge_kwh,
        deviceKwh: deviceEnergyByStart.get(slot.start_ts) ?? {},
        importPriceSekPerKwh: price?.import_price_sek_per_kwh ?? null,
        exportPriceSekPerKwh: price?.export_price_sek_per_kwh ?? null,
      };
    });
    return attributeEnergy(
      slots,
      new Map(configuredDevices.map(device => [device.id, device.name])),
      {
        baseLoad: t('Baslast — allt övrigt', 'Base load — everything else'),
        batteryCharging: t('Batteriladdning', 'Battery charging'),
      },
    );
  }, [configuredDevices, deviceActuals, prices, t, windowed]);

  const { summary } = attribution;
  const unpriced = summary.pricedSlotCount < summary.slotCount;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-lg">{t('Uppmätt period', 'Measured period')}</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                {t(
                  `${summary.slotCount} kvartar till och med nu`,
                  `${summary.slotCount} quarters up to now`,
                )}
                {unpriced && ` · ${t(
                  `${summary.pricedSlotCount} prissatta`,
                  `${summary.pricedSlotCount} priced`,
                )}`}
              </p>
            </div>
            <WindowDaysToggle value={windowDays} onChange={onWindowDaysChange} />
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Kpi
              label={t('Husets förbrukning', 'House consumption')}
              value={`${summary.loadKwh.toFixed(1)} kWh`}
              detail={t('all last i perioden', 'all load in the period')}
            />
            <Kpi
              label={t('Solproduktion', 'Solar production')}
              value={`${summary.solarKwh.toFixed(1)} kWh`}
              detail={t('uppmätt vid växelriktaren', 'measured at the inverter')}
            />
            <Kpi
              label={t('Nätimport', 'Grid import')}
              value={`${summary.gridImportKwh.toFixed(1)} kWh`}
              detail={`${summary.importCostSek.toFixed(2)} SEK`}
            />
            <Kpi
              label={t('Nätexport', 'Grid export')}
              value={`${summary.gridExportKwh.toFixed(1)} kWh`}
              detail={`−${summary.exportCreditSek.toFixed(2)} SEK`}
            />
            <Kpi
              label={t('Nettokostnad', 'Net cost')}
              value={`${summary.netCostSek.toFixed(2)} SEK`}
              detail={unpriced
                ? t('endast prissatta kvartar', 'priced quarters only')
                : t('import minus exportersättning', 'import minus export credit')}
              tone={summary.netCostSek > 0 ? undefined : 'good'}
            />
          </div>
        </CardContent>
      </Card>

    </div>
  );
};

export default HistorySection;
