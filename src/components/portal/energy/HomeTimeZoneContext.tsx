import React, { createContext, useContext, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  FALLBACK_HOME_TIME_ZONE,
  resolveHomeTimeZone,
} from '@/lib/energy-shift/home-time';

/**
 * The timezone the plan was built in, shared by every panel that prints a time.
 *
 * A context rather than a prop because the zone is a property of the home, not
 * of any one chart: threading it through the workspace, its sections, its
 * tooltips and its axis formatters would be the same value restated a dozen
 * times, and the one place someone forgot to pass it would silently fall back
 * to the reader's own clock — which is the bug this exists to prevent.
 */
const HomeTimeZoneContext = createContext<string>(FALLBACK_HOME_TIME_ZONE);

export const useHomeTimeZone = (): string => useContext(HomeTimeZoneContext);

export const HomeTimeZoneProvider: React.FC<{
  customerId: string | null;
  homeId: string | null;
  children: React.ReactNode;
}> = ({ customerId, homeId, children }) => {
  // Only the zone is selected out of the snapshot. The column also holds every
  // quarter of the horizon, and none of it is wanted here.
  const { data } = useQuery({
    queryKey: ['home-time-zone', customerId, homeId],
    enabled: Boolean(customerId && homeId),
    staleTime: 60 * 60 * 1000,
    queryFn: async () => {
      // The result type is stated rather than inferred: the generated types
      // cannot follow a `->>` path into a jsonb column and give up with
      // "type instantiation is excessively deep" on the select string alone.
      const { data, error } = await supabase
        .from('energy_optimisation_current')
        .select<string, { timezone: string | null }>('snapshot->>timezone')
        .eq('customer_id', customerId!)
        .eq('home_id', homeId!)
        .maybeSingle();
      if (error) throw error;
      return data?.timezone ?? null;
    },
  });

  const timeZone = useMemo(() => resolveHomeTimeZone(data), [data]);

  return (
    <HomeTimeZoneContext.Provider value={timeZone}>
      {children}
    </HomeTimeZoneContext.Provider>
  );
};

export default HomeTimeZoneProvider;
