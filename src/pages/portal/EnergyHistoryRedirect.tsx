import { Navigate, useLocation } from 'react-router-dom';

/**
 * Energy history is no longer a page. Its bills and recorded changes live under
 * Energy optimisation → Setup and the energy class on the portal overview, so
 * every old link, for customers and for staff in customer view, lands there.
 */
export default function EnergyHistoryRedirect() {
  const { pathname, search } = useLocation();
  const base = pathname.replace(/\/energy-history\/?$/, '');
  const tab = new URLSearchParams(search).get('tab');
  if (tab === 'performance') return <Navigate to={base === '/portal' ? base : `${base}/overview`} replace />;
  const section = tab === 'data' ? '?tab=setup&section=data' : tab === 'events' ? '?tab=setup&section=changes' : '';
  return <Navigate to={`${base}/energy-modeling${section}`} replace />;
}
