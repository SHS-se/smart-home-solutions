import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useLanguage } from '@/contexts/LanguageContext';
import { useHomeTimeZone } from './HomeTimeZoneContext';
import type { AccuracyReport } from '../../../../supabase/functions/_shared/forecast-accuracy';
import type { InputAccuracy, InputCheck } from '../../../../supabase/functions/_shared/input-accuracy';

const colours = {green: 'text-emerald-700 dark:text-emerald-400', lime: 'text-lime-700 dark:text-lime-400',
  yellow: 'text-yellow-700 dark:text-yellow-400', orange: 'text-orange-700 dark:text-orange-400', red: 'text-red-700 dark:text-red-400'};
type Translate = (sv: string, en: string) => string;
const value = (percentage: number | null | undefined) => percentage == null ? '—' : String(percentage);

/** Live input health from Home Assistant beside the cloud's historical accuracy. */
export default function AccuracyButtons({report, error, input, inputUnavailable}: {
  report: AccuracyReport | null; error?: string | null; input: InputAccuracy | null; inputUnavailable?: boolean;
}) {
  const {t} = useLanguage();
  const homeTimeZone = useHomeTimeZone();
  const [open, setOpen] = useState<'input' | 'historical' | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const labels = {input: t('Indatanoggrannhet %', 'Input accuracy %'), historical: t('Historisk noggrannhet %', 'Historical accuracy %')};
  const timeZone = report?.timezone ?? homeTimeZone;
  const stamp = report ? new Date(report.calculated_at).toLocaleString(undefined, {timeZone}) : '';
  const scores = {input, historical: report?.historical};
  return <><div className="flex flex-wrap gap-2" data-testid="forecast-accuracy">
    {(['input', 'historical'] as const).map(kind => {
      const score = scores[kind];
      return <Button key={kind} variant="ghost" size="sm" className="gap-2 text-xs text-muted-foreground"
        title={kind === 'historical' ? error || stamp : ''}
        onClick={event => {trigger.current = event.currentTarget; setOpen(kind);}}>
        {labels[kind]} <span className={`font-semibold tabular-nums ${score?.grade ? colours[score.grade] : ''}`}>{value(score?.percentage)}</span>
      </Button>;
    })}</div>
    <Dialog open={open !== null} onOpenChange={visible => {if (!visible) setOpen(null);}}>
      <DialogContent className="max-w-sm" aria-describedby={undefined} onCloseAutoFocus={event => {event.preventDefault(); trigger.current?.focus();}}>
        <DialogHeader><DialogTitle>{open ? labels[open] : ''}</DialogTitle></DialogHeader>
        {open === 'input' ? <InputChecks input={input} unavailable={inputUnavailable} timeZone={timeZone} t={t} /> : <>
          {error ? <p role="status" className="text-sm text-muted-foreground">{error}</p> : <>
            <section aria-labelledby="accuracy-energy">
              <h3 id="accuracy-energy" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('Elförbrukning', 'Electricity')}</h3>
              {!report?.historical.devices.length ? <p className="py-2 text-sm text-muted-foreground">{t('Lär sig', 'Learning')}</p> :
                <ul className="divide-y">{report.historical.devices.map(row => <li key={row.key} className="flex justify-between gap-4 py-2 text-sm">
                  <span>{row.name}</span><span className={`font-medium tabular-nums ${row.grade ? colours[row.grade] : 'text-muted-foreground'}`}>
                    {value(row.percentage)}{row.percentage !== null ? '%' : ''}</span>
                </li>)}</ul>}
            </section>
            {report?.room_temperature && <RoomTemperatures accuracy={report.room_temperature} t={t} />}
          </>}
          <AccuracyFooter report={report} stamp={stamp} />
        </>}
      </DialogContent>
    </Dialog></>;
}

/**
 * Planned room temperatures against the readings, apart from electricity: a
 * room can be warmed exactly as planned with a meter forecast that is off,
 * and the other way round.
 */
function RoomTemperatures({accuracy, t}: {accuracy: NonNullable<AccuracyReport['room_temperature']>; t: Translate}) {
  const degrees = (c: number) => `${c.toFixed(1)} °C`;
  return <section aria-labelledby="accuracy-rooms" data-testid="room-temperature-accuracy">
    <h3 id="accuracy-rooms" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('Rumstemperatur', 'Room temperature')}</h3>
    <ul className="divide-y">{accuracy.rooms.map(room => <li key={room.key} className="flex justify-between gap-4 py-2 text-sm">
      <span className="flex min-w-0 flex-col"><span>{room.name}</span>
        <span className="text-xs text-muted-foreground">{room.quarters === 0 || room.mean_absolute_error_c === null
          ? t('Inga avläsningar jämförda ännu', 'No readings compared yet')
          : t(`±${degrees(room.mean_absolute_error_c)} i snitt · ${room.quarters} kvartar`,
            `±${degrees(room.mean_absolute_error_c)} on average · ${room.quarters} quarters`)}</span></span>
      <span className={`font-medium tabular-nums ${room.grade ? colours[room.grade] : 'text-muted-foreground'}`}>
        {value(room.percentage)}{room.percentage !== null ? '%' : ''}</span>
    </li>)}</ul>
  </section>;
}

const CHECKS: Record<InputCheck['key'], [string, string]> = {prices: ['Priser', 'Prices'], solar_forecast: ['Solprognos', 'Solar forecast'],
  sensors: ['Givare', 'Sensors'], measurements: ['Mätningar', 'Measurements'], battery: ['Batteri', 'Battery'],
  room_models: ['Rummodeller', 'Room models']};

/** Home Assistant names a room's fit issue by the fit's own reason code. */
const ROOM_ISSUES: Record<string, [string, string]> = {
  waiting: ['ingen anpassning ännu', 'no fit yet'], unidentified: ['ingen modell', 'no model'], insufficient_samples: ['för lite historik', 'too little history'],
  insufficient_heating: ['för lite uppvärmning', 'too little heating'], singular: ['ingen användbar variation', 'no usable variation'],
  poor_fit: ['dålig anpassning', 'poor fit'], non_physical: ['orimlig anpassning', 'implausible fit'],
  sensor_tracks_outdoor: ['givaren följer utetemperaturen', 'sensor follows the outdoor temperature'],
};
const roomIssue = (issue: string, t: Translate) => {
  const at = issue.lastIndexOf(': ');
  if (at < 0) return issue;
  const reasons = issue.slice(at + 2).split(',').map(code => code.trim());
  return `${issue.slice(0, at)}: ${reasons.map(code => ROOM_ISSUES[code] ? t(...ROOM_ISSUES[code]) : code).join(', ')}`;
};

/**
 * Live checks are healthy readings over the readings each expects. Prices is
 * the cloud's latest comparison of the last estimate with the published price.
 */
function InputChecks({input, unavailable, timeZone, t}: {input: InputAccuracy | null; unavailable?: boolean; timeZone: string; t: Translate}) {
  if (!input?.checks.length) return <p role="status" className="text-sm text-muted-foreground">{unavailable
    ? t('TEST tar inte emot aktuell status från Home Assistant.', 'TEST does not receive live status from Home Assistant.')
    : t('Väntar på den första indatakontrollen från Home Assistant.', 'Waiting for the first input check from Home Assistant.')}</p>;
  const time = (iso: string) => new Date(iso).toLocaleString(undefined, {timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit'});
  const detail = (check: InputCheck) => check.quarters !== undefined
    ? check.quarters ? t(`Uppskattning mot publicerat pris, ${check.quarters} kvartar`, `Estimates against published prices, ${check.quarters} quarters`)
      : t('Inget publicerat pris jämfört ännu', 'No published price compared yet')
    : check.key === 'measurements' ? t(`${check.healthy} av ${check.expected} kvartar kompletta`, `${check.healthy} of ${check.expected} quarters complete`)
    : check.key === 'battery' ? t(`${check.healthy} av ${check.expected} laddmål nådda`, `${check.healthy} of ${check.expected} charge targets reached`)
    : check.key === 'room_models' ? t(`${check.healthy} av ${check.expected} rum med värmemodell`, `${check.healthy} of ${check.expected} rooms modelled`)
      : t(`${check.healthy} av ${check.expected} användbara`, `${check.healthy} of ${check.expected} usable`);
  const issues = (check: InputCheck) => check.quarters !== undefined
    ? check.calculated_at ? ` · ${time(check.calculated_at)}` : '' : !check.issues.length ? ''
    : check.key === 'room_models' ? `: ${check.issues.map(issue => roomIssue(issue, t)).join('; ')}`
    : `: ${(check.key === 'measurements' || check.key === 'battery' ? check.issues.map(time) : check.issues).join(', ')}`;
  return <>
    <ul className="divide-y">{input.checks.map(check => <li key={check.key} className="flex justify-between gap-4 py-2 text-sm">
      <span className="flex min-w-0 flex-col"><span>{t(...CHECKS[check.key])}</span>
        <span className="break-words text-xs text-muted-foreground">{detail(check)}{issues(check)}</span></span>
      <span className={`font-medium tabular-nums ${check.grade ? colours[check.grade] : 'text-muted-foreground'}`}>
        {value(check.percentage)}{check.percentage !== null ? '%' : ''}</span>
    </li>)}</ul>
    <p className="text-xs text-muted-foreground" data-testid="input-accuracy-observed">
      {t('Kontrollerad', 'Checked')} <time dateTime={input.observed_at}>{new Date(input.observed_at).toLocaleString(undefined, {timeZone})}</time>
    </p>
  </>;
}

/** When this report was calculated. */
function AccuracyFooter({report, stamp}: {report: AccuracyReport | null; stamp: string}) {
  const {t} = useLanguage();
  return <div className="space-y-0.5 text-xs text-muted-foreground" data-testid="accuracy-schedule">
    {report && <p>{t('Beräknad', 'Calculated')} <time dateTime={report.calculated_at}>{stamp}</time></p>}
  </div>;
}
