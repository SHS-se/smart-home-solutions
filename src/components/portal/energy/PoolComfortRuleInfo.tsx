import { useLanguage } from '@/contexts/LanguageContext';
import { poolComfortExposure } from '../../../../supabase/functions/_shared/planner-wasm/pool-comfort';
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
  const examples = [0, 1, 1.1, 1.5, 2, 2.5, 3].map(shortfall => ({ shortfall,
    points: -factor * poolComfortExposure(0, -shortfall, -shortfall, .25) }));
  const description = <div className="max-w-prose space-y-2 text-sm text-muted-foreground">
    <p>{t(
      'Poolen får vara upp till 1 °C under önskad temperatur utan avdrag. Därefter växer avdraget linjärt: med standardinställningen ger varje ytterligare 0.1 °C ett avdrag på 0.1 poäng per kvart. Kallare vatten ger alltid större avdrag.',
      'The pool can be up to 1 °C below the desired temperature without a deduction. Beyond that, the deduction grows linearly: at the default setting each additional 0.1 °C deducts 0.1 point per quarter. Colder water always receives a larger deduction.')}</p>
    <table className="w-full text-left tabular-nums">
      <caption className="pb-1 text-left">{coefficient === undefined ? t('Exempel med standardinställningen', 'Examples at the default setting')
        : t('Exempel med denna inställning', 'Examples at this setting')}</caption>
      <thead><tr><th scope="col" className="py-1 font-medium">{t('Under målet', 'Below target')}</th><th scope="col" className="py-1 text-right font-medium">{t('Poäng / 15 min', 'Points / 15 min')}</th></tr></thead>
      <tbody>{examples.map(({shortfall, points}) => <tr key={shortfall} className="border-t border-border">
        <th scope="row" className="py-1 font-normal">{shortfall.toFixed(1)} °C</th>
        <td className="py-1 text-right">{points < 0 ? '−' : ''}{Math.abs(points).toFixed(2)}</td>
      </tr>)}</tbody>
    </table>
    <p>{t('Exemplen gäller oförändrad temperatur. Temperaturförändringar och kortare intervall räknas med i kvartens avdrag.',
      'The examples assume a constant temperature. Temperature changes and shorter intervals are included in the quarter’s deduction.')}</p>
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
