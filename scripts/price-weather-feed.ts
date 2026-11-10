import { ZONE_STATIONS } from '../supabase/functions/_shared/market-wind.ts';
import { regionalWeatherHours, type WeatherSite } from '../supabase/functions/_shared/price-weather.ts';

if (Deno.args[0] === 'sites') {
  console.log(JSON.stringify(ZONE_STATIONS.SE3.map(({ latitude, longitude }) => ({ latitude, longitude }))));
} else {
  const { history, forecast } = await new Response(Deno.stdin.readable).json() as {
    history: WeatherSite[];
    forecast: WeatherSite[];
  };
  console.log(JSON.stringify({ history: regionalWeatherHours(history), forecast: regionalWeatherHours(forecast) }));
}
