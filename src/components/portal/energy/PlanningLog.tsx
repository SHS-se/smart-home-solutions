import { Fragment, useEffect, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { AlertCircle, ChevronDown, RefreshCw } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useLanguage } from '@/contexts/LanguageContext';
import { Button } from '@/components/ui/button';
import { useHomeTimeZone } from './HomeTimeZoneContext';
import { formatHomeTime, formatHomeDateTime } from '@/lib/energy-shift/home-time';
import { LOG_PAGE_SIZE, LOG_WINDOW_MS, planningLogText } from '@/lib/energy-shift/planning-log';

export default function PlanningLog({ homeId }: { homeId: string | null }) {
  const { t, language } = useLanguage();
  const timeZone = useHomeTimeZone();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);
  const [windowStart, setWindowStart] = useState(() => Date.now() - LOG_WINDOW_MS);
  const log = useInfiniteQuery({
    queryKey: ['energy-planning-log', homeId, windowStart],
    initialPageParam: null as number | null,
    enabled: !!homeId,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
    queryFn: async ({ pageParam }) => {
      let query = supabase.from('energy_planning_log').select('*').eq('home_id', homeId!)
        .gte('occurred_at', new Date(windowStart).toISOString()).order('sequence', { ascending: false }).limit(LOG_PAGE_SIZE);
      if (pageParam !== null) query = query.lt('sequence', pageParam);
      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
    getNextPageParam: page => page.length === LOG_PAGE_SIZE ? page.at(-1)!.sequence : undefined,
  });
  const entries = (log.data?.pages.flat() ?? []).filter(row => Date.parse(row.occurred_at) >= now - LOG_WINDOW_MS);
  const day = new Intl.DateTimeFormat(language === 'sv' ? 'sv-SE' : 'en-GB', { timeZone, weekday: 'long', month: 'short', day: 'numeric' });
  const refresh = () => {
    const next = Date.now() - LOG_WINDOW_MS;
    if (next === windowStart) void log.refetch(); else setWindowStart(next);
  };
  if (!homeId) return <p className="text-muted-foreground">{t('Välj ett hem för att se loggen.', 'Select a home to view the log.')}</p>;
  return <section className="space-y-4" aria-labelledby="planning-log-title">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 id="planning-log-title" className="text-lg font-medium">{t('Planeringslogg', 'Planning log')}</h2>
        <p className="text-sm text-muted-foreground">{t('Senaste 72 timmarna · hemmets lokala tid', 'Last 72 hours · home local time')}</p>
      </div>
      <Button variant="outline" size="sm" className="min-h-11" disabled={log.isFetching} onClick={refresh}>
        <RefreshCw aria-hidden="true" className={`mr-2 h-4 w-4 ${log.isFetching ? 'animate-spin motion-reduce:animate-none' : ''}`} />
        {t('Uppdatera logg', 'Refresh log')}
      </Button>
    </div>
    {log.isPending && <p role="status">{t('Hämtar logg…', 'Loading log…')}</p>}
    {log.error && <p role="alert" className="text-destructive">{t('Loggen kunde inte hämtas. Försök igen med Uppdatera logg.', 'Could not load the log. Try Refresh log again.')}</p>}
    {!log.isPending && !log.error && entries.length === 0 && <p className="rounded-lg border p-6 text-muted-foreground">
      {t('Inga planeringshändelser under de senaste 72 timmarna.', 'No planning activity in the last 72 hours.')}
    </p>}
    {entries.length > 0 && <div role="region" aria-label={t('Planeringshändelser', 'Planning events')} tabIndex={0}
      className="max-h-[65vh] overflow-y-auto overscroll-contain rounded-lg border focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
      <ol aria-label={t('Planeringslogg', 'Planning log')} className="divide-y">
        {entries.map((row, index) => {
          const date = day.format(new Date(row.occurred_at));
          const showDate = index === 0 || date !== day.format(new Date(entries[index - 1].occurred_at));
          const text = planningLogText(row, t);
          return <Fragment key={row.id}>
            {showDate && <li className="bg-muted/60 px-4 py-2 text-sm font-medium"><h3 className="text-sm font-medium">{date}</h3></li>}
            <li className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-3 px-4 py-3 text-sm">
              <div className="pt-0.5 tabular-nums text-muted-foreground">
                <time dateTime={row.occurred_at} title={formatHomeDateTime(row.occurred_at, timeZone)}>{formatHomeTime(row.occurred_at, timeZone)}</time>
                {row.last_seen_at !== row.occurred_at && <span className="block">
                  <span aria-hidden="true">–</span><time dateTime={row.last_seen_at} title={formatHomeDateTime(row.last_seen_at, timeZone)}>{formatHomeTime(row.last_seen_at, timeZone)}</time>
                </span>}
              </div>
              <div className="min-w-0 break-words">
                <details className="group">
                  <summary className="min-h-11 cursor-pointer list-none space-y-1 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                    <span className="flex items-center gap-2 font-medium">
                      {row.severity !== 'info' && <AlertCircle aria-hidden="true" className={`h-4 w-4 shrink-0 ${row.severity === 'error' ? 'text-destructive' : 'text-amber-700 dark:text-amber-400'}`} />}
                      <span className="min-w-0 flex-1">{text.title}</span>
                      <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground group-open:rotate-180" />
                    </span>
                    <span className="line-clamp-2 group-open:hidden">{text.text}</span>
                  </summary>
                  <p className="mt-1 whitespace-pre-wrap">{text.detail}</p>
                  {row.last_seen_at !== row.occurred_at && <p className="mt-1 text-muted-foreground">{t('Senaste aktivitet', 'Last activity')}: {formatHomeDateTime(row.last_seen_at, timeZone)}</p>}
                </details>
              </div>
            </li>
          </Fragment>;
        })}
      </ol>
      {log.hasNextPage && <div className="border-t p-3 text-center">
        <Button variant="outline" className="min-h-11" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
          {log.isFetchingNextPage ? t('Hämtar…', 'Loading…') : t('Visa äldre händelser', 'Show older events')}
        </Button>
      </div>}
    </div>}
    <p className="text-xs text-muted-foreground">{t('En rad per planering. Överföringar grupperas per timme och upprepade varningar samlas.', 'One row per planning run. Transfers are grouped by hour and repeated warnings are combined.')}</p>
  </section>;
}
