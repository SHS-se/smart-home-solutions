import { useLanguage } from '@/contexts/LanguageContext';
import { RULE_DEFAULTS } from '../../../../supabase/functions/_shared/planner-wasm/rule-policy';

/** Read-only explanation shared by the live plan and the bench rule settings. */
export default function PoolComfortRuleInfo({ coefficient, water, expandable = false }: {
  /** Only supplied when the saved coefficient is known; otherwise examples say “default”. */
  coefficient?: number;
  water?: { beforeC: number | null; afterC: number | null; hours: number; targetC: number | null };
  expandable?: boolean;
}) {
  const { t } = useLanguage();
  const factor = coefficient ?? -RULE_DEFAULTS.pool_shortfall.points;
  const examples = [factor / 4, factor].map(value => value.toFixed(2));
  const description = <div className="max-w-prose space-y-2 text-sm text-muted-foreground">
    <p>{t(
      'Avdraget växer med hur långt och hur länge poolen är under önskad temperatur. Upp till 2 °C under målet växer kostnaden med temperaturskillnaden i kvadrat. Därefter ökar den linjärt, utan något steg vid gränsen. Vatten vid eller över målet ger inget avdrag.',
      'The deduction grows with how far and how long the pool is below the desired temperature. Up to 2 °C below the target, the cost grows with the square of the shortfall. Beyond that it grows linearly, with no jump at the boundary. Water at or above the target has no deduction.')}</p>
    <p>{coefficient === undefined ? t('Exempel med standardinställningen:', 'Examples at the default setting:')
      : t('Exempel med denna inställning:', 'Examples at this setting:')}{' '}{t(
      `15 minuter vid 1 °C under målet ger ${examples[0]} poäng i avdrag; vid 2 °C blir det ${examples[1]} poäng. Temperaturförändringar under kvarten räknas med.`,
      `15 minutes at 1 °C below target deducts ${examples[0]} points; at 2 °C it deducts ${examples[1]} points. Temperature changes during the quarter are included.`)}</p>
    <p>{t(
      'En poäng värderas som 1 SEK när planeraren väger komfort mot elkostnad. Elräkningen visas separat. Varmare vatten ger inga extra komfortpoäng, men kan fungera som värmebuffert inför dyrare timmar inom utrustningens temperaturgräns.',
      'One point is valued at 1 SEK when the planner balances comfort against electricity cost. The electricity bill is shown separately. Warmer water earns no extra comfort points, but can store heat ahead of expensive hours within the equipment temperature limit.')}</p>
  </div>;
  return <div className="space-y-1">
    {water && <p data-pool-comfort-evidence className="text-sm text-muted-foreground">
      {water.beforeC !== null && water.afterC !== null && <>{t('Planerat vatten', 'Predicted water')}: <span className="tabular-nums">{water.beforeC.toFixed(2)} → {water.afterC.toFixed(2)} °C</span> · </>}
      {water.targetC !== null && <>{t('Önskad temperatur', 'Desired temperature')}: <span className="tabular-nums">{water.targetC.toFixed(2)} °C</span> · </>}
      <span className="tabular-nums">{(water.hours * 60).toFixed(1).replace(/\.0$/, '')} min</span>
    </p>}
    {expandable ? <details className="text-sm">
      <summary className="min-h-11 cursor-pointer content-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {t('Så räknas poolens komfortavdrag', 'How pool comfort deductions work')}
      </summary>
      {description}
    </details> : description}
  </div>;
}
