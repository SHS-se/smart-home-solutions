import { useLanguage } from '@/contexts/LanguageContext';
import type { RoiInstallation } from '@/lib/home-baseline/installations';

export default function ActualInstallations({ events }: { events: RoiInstallation[] }) {
  const { t } = useLanguage();
  if (!events.length) return null;
  const names = { solar: t('Solceller', 'Solar'), battery: t('Batteri', 'Battery'), bergvarme: 'Bergvärme' };
  const notes = {
    solar: t('Solcellerna installerades denna månad. Faktiska data före installationen innehåller ingen solel.', 'Solar panels were installed this month. Actual data before installation contains no solar generation.'),
    battery: t('Hembatteriet installerades denna månad.', 'The home battery was installed this month.'),
    bergvarme: t('Bergvärmen togs i drift denna månad.', 'The ground-source heat pump came online this month.'),
  };
  return <details className="mt-1 min-w-44 max-w-64 whitespace-normal text-left text-xs font-normal text-muted-foreground" data-testid="actual-installations">
    <summary className="min-h-6 cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">{events.map(event => names[event.equipment]).join(' + ')} · {t('i drift', 'online')}</summary>
    <div className="mt-1 space-y-1">{events.map(event => <p key={event.equipment}>{notes[event.equipment]}</p>)}</div>
  </details>;
}
