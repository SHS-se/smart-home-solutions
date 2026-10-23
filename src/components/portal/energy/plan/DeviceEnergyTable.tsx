import DeviceName from '../DeviceName';
import { deviceColour, type DeviceColour } from '@/lib/energy-shift/device-colours';
// Per-device energy and cost for the selected window, as numbers: the table
// view of DeviceEnergyChart.
//
// ENERGY_OPTIMISATION_ARCHITECTURE.md §1.3.7.4. Four energy columns because
// only one of them costs anything: a device's SEK is its share of the grid
// energy that served the load in the same quarter, at that quarter's all-in
// marginal price. Solar and battery energy are priced at zero.

import React from 'react';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useLanguage } from '@/contexts/LanguageContext';
import { totalRow, type AttributionResult } from '@/lib/energy-shift/energy-attribution';

const kwh = (value: number) => value.toFixed(value >= 100 ? 0 : 2);

const DeviceEnergyTable: React.FC<{ result: AttributionResult; devices: readonly DeviceColour[] }> = ({ result, devices }) => {
  const { t } = useLanguage();
  const totals = totalRow(result.rows);

  if (result.rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t('Ingen förbrukning i den valda perioden.', 'No consumption in the selected period.')}
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('Enhet', 'Device')}</TableHead>
          <TableHead className="text-right">{t('Nät', 'Grid')}</TableHead>
          <TableHead className="text-right">{t('Sol', 'Solar')}</TableHead>
          <TableHead className="text-right">{t('Batteri', 'Battery')}</TableHead>
          <TableHead className="text-right">{t('Totalt', 'Total')}</TableHead>
          <TableHead className="text-right">{t('Kostnad', 'Cost')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {result.rows.map(row => (
          <TableRow key={row.key} className={row.kind === 'device' ? '' : 'text-muted-foreground'}>
            <TableCell className="font-medium">
              {row.kind === 'device' ? <DeviceName name={row.name} colour={deviceColour(devices, row.key)} deviceKey={row.key} /> : row.name}
              {!row.fullyPriced && (
                <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                  {t('· delvis prissatt', '· partly priced')}
                </span>
              )}
            </TableCell>
            <TableCell className="text-right tabular-nums">{kwh(row.gridKwh)}</TableCell>
            <TableCell className="text-right tabular-nums">{kwh(row.solarKwh)}</TableCell>
            <TableCell className="text-right tabular-nums">{kwh(row.batteryKwh)}</TableCell>
            <TableCell className="text-right font-medium tabular-nums">{kwh(row.totalKwh)}</TableCell>
            <TableCell className="text-right tabular-nums">{row.costSek.toFixed(2)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell>{t('Summa', 'Total')}</TableCell>
          <TableCell className="text-right tabular-nums">{kwh(totals.gridKwh)}</TableCell>
          <TableCell className="text-right tabular-nums">{kwh(totals.solarKwh)}</TableCell>
          <TableCell className="text-right tabular-nums">{kwh(totals.batteryKwh)}</TableCell>
          <TableCell className="text-right tabular-nums">{kwh(totals.totalKwh)}</TableCell>
          <TableCell className="text-right tabular-nums">{totals.costSek.toFixed(2)}</TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  );
};

/** How the figures were reached, shared by the chart and the table. */
export const DeviceEnergyNotes: React.FC<{
  result: AttributionResult;
  /** Planned windows have no meter, so the balance note is measured-only. */
  showBalance?: boolean;
}> = ({ result, showBalance = false }) => {
  const { t } = useLanguage();
  const unpriced = result.rows.some(row => !row.fullyPriced);
  const { unexplainedLoadKwh, excessSupplyKwh } = result.summary;
  if (result.rows.length === 0) return null;
  return (
    <>
      <p className="mt-2 text-xs text-muted-foreground">
        {t(
          'Energi i kWh, kostnad i SEK. Bara nätenergi kostar pengar: varje enhet får sin andel av kvartens nätimport till kvartens marginalpris. Sol och batteri räknas som noll — slitage på paneler och celler ingår inte. Raden Batteriladdning bär den nätenergi som laddade batteriet, så de uppmätta kvartarnas nätenergi summerar till mätarens import. Planerade kvartar, kvartar utan publicerat pris och last som tillförselmätarna inte täcker är uppskattningar och visas randiga i diagrammet.',
          'Energy in kWh, cost in SEK. Only grid energy costs money: each device takes its share of the quarter\'s grid import at that quarter\'s marginal price. Solar and battery count as zero — panel and cell degradation are not included. The battery charging row carries the grid energy that charged the battery, so the measured quarters\' grid energy totals the metered import. Planned quarters, quarters with no published price yet, and load the supply meters did not cover are estimates and are striped in the chart.',
        )}
      </p>
      {unpriced && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t(
            'Vissa kvartar saknar både pris och prisuppskattning. Kostnaden gäller bara de prissatta och märks med ≥ i diagrammet.',
            'Some quarters have neither a price nor an estimate of one. The cost covers only the priced ones and is marked ≥ in the chart.',
          )}
        </p>
      )}
      {showBalance && unexplainedLoadKwh >= 0.05 && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t(
            `Mätarbalans: ${unexplainedLoadKwh.toFixed(2)} kWh av husets last förklaras inte av nät, sol och batteri. Skillnaden visas hellre än fördelas ut på enheterna.`,
            `Meter balance: ${unexplainedLoadKwh.toFixed(2)} kWh of house load is not explained by grid, solar and battery. The difference is shown rather than spread across the devices.`,
          )}
        </p>
      )}
      {showBalance && excessSupplyKwh >= 0.05 && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t(
            `Mätarbalans: ${excessSupplyKwh.toFixed(2)} kWh från nät, sol och batteri motsvaras inte av någon last — bortkopplad sol eller en mätare som visar för lågt. Den energin hålls utanför kolumnerna i stället för att skrivas på enheterna.`,
            `Meter balance: ${excessSupplyKwh.toFixed(2)} kWh from grid, solar and battery has no load to match it — curtailed solar, or a meter reading low. That energy is held out of the columns rather than charged to the devices.`,
          )}
        </p>
      )}
    </>
  );
};

export default DeviceEnergyTable;
