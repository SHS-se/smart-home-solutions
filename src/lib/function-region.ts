// Edge Functions execute in the region nearest the *browser*, not the region
// holding the database. For this app that is the wrong optimisation: the
// functions do almost nothing but talk to Postgres, so running them beside the
// caller puts the whole round trip on every query instead of on one response.
//
// A replan clicked from Perth executed in ap-southeast-2 while its database sat
// in eu-central-1. Five sequential reads and a 2 MB write each crossed the
// planet, and the request spent 8.9 seconds of wall clock doing about half a
// second of work. Pinning every invocation to the database's own region puts
// the distance back where it belongs — once, between the browser and the edge.
//
// The query parameter rather than the `x-region` header: supabase-js's own
// `region` option sets both, and the header is the half that breaks. Every
// function answers its own CORS preflight with a fixed
// `Access-Control-Allow-Headers` list, so an unlisted request header is
// rejected by the browser before the request is ever sent — every function
// would have to be edited first. Supabase documents the parameter for exactly
// this case, and the gateway honours either.
export const FUNCTION_REGION_PARAM = 'forceFunctionRegion';

const FUNCTION_PATH_PREFIX = '/functions/v1/';

/**
 * Add the region pin to an Edge Function URL, leaving every other URL alone.
 *
 * The same fetch carries PostgREST, auth and storage traffic, and PostgREST
 * reads unknown query parameters as column filters — an unfiltered pin there
 * would turn every table read into an error about a column that does not
 * exist. So the path is checked rather than assumed.
 */
export function pinFunctionRegion(
  rawUrl: string,
  region: string | undefined,
): string {
  if (!region) return rawUrl;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // Not something with an origin to reason about; hand it back untouched.
    return rawUrl;
  }

  if (!url.pathname.startsWith(FUNCTION_PATH_PREFIX)) return rawUrl;
  // A caller that pinned a region deliberately keeps it.
  if (url.searchParams.has(FUNCTION_REGION_PARAM)) return rawUrl;

  url.searchParams.set(FUNCTION_REGION_PARAM, region);
  return url.toString();
}
