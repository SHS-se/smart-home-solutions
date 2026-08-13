// Per-zone thermal model readiness. Lives on the Thermal tab.
//
// Moved verbatim out of the former LoadShiftTab on 2026-08-13.

import React, { useMemo } from 'react';
import { AlertTriangle, CheckCircle2, Clock3 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useLanguage } from '@/contexts/LanguageContext';
import type { OptimisationPlanV5 } from '@/lib/energy-shift/contracts';
import {
  assessThermalReadiness,
  THERMAL_TRAINING_SLOTS,
  type ThermalObservationSummary,
  type ThermalReadinessState,
  type ThermalZoneModelSummary,
} from '@/lib/energy-shift/thermal-readiness';
import type { EmpiricalEnergyDevice } from '../EmpiricalDeviceModelsCard';
import {
  THERMAL_REJECTION_EN,
  THERMAL_REJECTION_SV,
  summariseThermalSlots,
  type ReadinessState,
  type ThermalSlotRow,
  type ZoneModelRow,
} from './types';

const ThermalReadinessRow: React.FC<{
  label: string;
  detail: string;
  state: ReadinessState;
  stateLabel: string;
}> = ({ label, detail, state, stateLabel }) => {
  const Icon = state === 'ready' ? CheckCircle2 : state === 'blocked' ? AlertTriangle : Clock3;
  const tone = state === 'ready'
    ? 'text-emerald-700 dark:text-emerald-400'
    : state === 'blocked'
      ? 'text-amber-700 dark:text-amber-400'
      : 'text-muted-foreground';
  return (
    <div className="flex items-start justify-between gap-4 border-b py-3 last:border-b-0">
      <div className="flex min-w-0 items-start gap-2.5">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} />
        <div>
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
        </div>
      </div>
      <Badge variant="outline" className={`shrink-0 ${tone}`}>{stateLabel}</Badge>
    </div>
  );
};

const ThermalReadinessPanel: React.FC<{
  devices: EmpiricalEnergyDevice[];
  planDevices: OptimisationPlanV5['device_models'];
  observations: ThermalObservationSummary;
  zoneModels: ThermalZoneModelSummary[];
}> = ({ devices, planDevices, observations, zoneModels }) => {
  const { t } = useLanguage();
  const readiness = useMemo(
    () => assessThermalReadiness(devices, planDevices, observations, zoneModels),
    [devices, planDevices, observations, zoneModels],
  );
  const selectedCount = readiness.selectedDevices.length;
  const allMappingsReady = selectedCount > 0
    && readiness.mappingReadyCount === selectedCount;
  const allHistoryReady = selectedCount > 0
    && readiness.electricalHistoryReadyCount === selectedCount;
  const allForecastsReady = selectedCount > 0
    && readiness.electricalForecastReadyCount === selectedCount;
  const readyLabel = t('Klar', 'Ready');
  const blockedLabel = t('Blockerad', 'Blocked');
  const waitingLabel = t('Väntar', 'Waiting');
  const stateLabels: Record<ThermalReadinessState, string> = {
    ready: readyLabel,
    blocked: blockedLabel,
    waiting: waitingLabel,
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4 py-5 text-left">
      {!readiness.pipelineComplete && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <p className="font-medium">
                {t(
                  'Den termiska modellen väntar på observationer',
                  'The thermal model is waiting on observations',
                )}
              </p>
              <p className="mt-1 text-sm opacity-90">
                {t(
                  'Rumstemperatur, aktuatorstatus och utomhustemperatur samlas in per kvart av integrationen. Raderna nedan visar vad som redan tas emot och vad som saknas.',
                  'Room temperature, actuator state, and outdoor temperature are collected per quarter by the integration. The rows below show what is already arriving and what is still missing.',
                )}
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-lg border px-4">
        <ThermalReadinessRow
          label={t('Värmeenheter valda för börvärdesstyrning', 'Heaters selected for setpoint control')}
          detail={selectedCount > 0
            ? t(`${selectedCount} enheter är valda på webbplatsen.`, `${selectedCount} devices are selected on the website.`)
            : t('Välj Styrbar · Börvärde för minst en värmeenhet.', 'Select Controllable · Setpoint for at least one heater.')}
          state={selectedCount > 0 ? 'ready' : 'blocked'}
          stateLabel={selectedCount > 0 ? readyLabel : blockedLabel}
        />
        <ThermalReadinessRow
          label={t('Lokala Home Assistant-mappningar', 'Local Home Assistant mappings')}
          detail={t(
            `${readiness.mappingReadyCount} av ${selectedCount} valda enheter har en bekräftad mappning.`,
            `${readiness.mappingReadyCount} of ${selectedCount} selected devices have a confirmed mapping.`,
          )}
          state={allMappingsReady ? 'ready' : 'blocked'}
          stateLabel={allMappingsReady ? readyLabel : blockedLabel}
        />
        <ThermalReadinessRow
          label={t('Elektrisk energihistorik', 'Electrical energy history')}
          detail={t(
            `${readiness.electricalHistoryReadyCount} av ${selectedCount} enheter har ${readiness.electricalHistorySampleCount.toLocaleString()} kompletta 15-minutersprover totalt. Detta driver serierna i effektgrafen men beskriver inte rumstemperaturen.`,
            `${readiness.electricalHistoryReadyCount} of ${selectedCount} devices have ${readiness.electricalHistorySampleCount.toLocaleString()} complete 15-minute samples in total. This drives the Power-series forecasts but does not describe room temperature.`,
          )}
          state={allHistoryReady ? 'ready' : 'waiting'}
          stateLabel={allHistoryReady ? readyLabel : waitingLabel}
        />
        <ThermalReadinessRow
          label={t('Elektrisk enhetsprognos i aktuell plan', 'Electrical device forecast in current plan')}
          detail={t(
            `${readiness.electricalForecastReadyCount} av ${selectedCount} värmeenheter finns i den aktuella effektplanen.`,
            `${readiness.electricalForecastReadyCount} of ${selectedCount} heaters are present in the current power plan.`,
          )}
          state={allForecastsReady ? 'ready' : 'waiting'}
          stateLabel={allForecastsReady ? readyLabel : waitingLabel}
        />
        <ThermalReadinessRow
          label={t('Termiska historikvärden', 'Thermal history observations')}
          detail={readiness.thermalState === 'blocked'
            ? t(
              'Rumstemperatur och aktuatorstatus har inte tagits emot från Home Assistant. Uppdatera integrationen och kontrollera att varje zon har en rumsgivare.',
              'No room temperature or actuator state has been received from Home Assistant. Update the integration and check that every zone has a room sensor.',
            )
            : t(
              `${readiness.thermalObservedCount} av ${selectedCount} zoner rapporterar, ${readiness.thermalSlotCount.toLocaleString()} kvartar lagrade.`,
              `${readiness.thermalObservedCount} of ${selectedCount} zones are reporting, ${readiness.thermalSlotCount.toLocaleString()} quarters stored.`,
            )}
          state={readiness.thermalState}
          stateLabel={stateLabels[readiness.thermalState]}
        />
        <ThermalReadinessRow
          label={t('Utomhustemperatur och prognos', 'Outdoor temperature and forecast')}
          detail={readiness.outdoorState === 'blocked'
            ? t(
              'Ingen utomhusgivare är vald i integrationen. Välj en under Prognoser.',
              'No outdoor sensor is selected in the integration. Choose one under Forecasts.',
            )
            : t(
              `${readiness.outdoorSlotCount.toLocaleString()} kvartar med uppmätt utomhustemperatur.`,
              `${readiness.outdoorSlotCount.toLocaleString()} quarters carry a measured outdoor temperature.`,
            )}
          state={readiness.outdoorState}
          stateLabel={stateLabels[readiness.outdoorState]}
        />
        <ThermalReadinessRow
          label={t('Inlärd termisk zonmodell', 'Learned thermal zone model')}
          detail={readiness.trainedZoneCount > 0
            ? t(
              `${readiness.trainedZoneCount} av ${selectedCount} zoner har en anpassad värmemodell.`,
              `${readiness.trainedZoneCount} of ${selectedCount} zones have a fitted thermal model.`,
            )
            : readiness.dominantRejection
              ? t(
                THERMAL_REJECTION_SV[readiness.dominantRejection]
                  ?? 'Ingen zon kunde anpassas ännu.',
                THERMAL_REJECTION_EN[readiness.dominantRejection]
                  ?? 'No zone could be fitted yet.',
              )
              : t(
                `Träning startar när en zon har ${THERMAL_TRAINING_SLOTS.toLocaleString()} kvartar med både rums- och utomhustemperatur.`,
                `Training starts once a zone has ${THERMAL_TRAINING_SLOTS.toLocaleString()} quarters of both room and outdoor temperature.`,
              )}
          state={readiness.modelState}
          stateLabel={stateLabels[readiness.modelState]}
        />
      </div>

      {readiness.mappingBlockers.length > 0 && (
        <div className="rounded-lg border p-4 text-sm">
          <p className="font-medium">
            {t('Enheter som fortfarande behöver mappas', 'Devices that still need mapping')}
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
            {readiness.mappingBlockers.map(device => (
              <li key={device.device_key}>
                {device.name}{device.mapping_error ? ` — ${device.mapping_error}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default ThermalReadinessPanel;
