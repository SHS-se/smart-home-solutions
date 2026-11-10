"""Collect regional Open Data weather independently of household planning."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from functools import lru_cache
import json
import math
import subprocess
import tempfile
import time
from threading import local

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

HOUR = 3600
DAY = 24 * HOUR
STEP = 3 * HOUR
CYCLE = 6 * HOUR
HISTORY_DAYS = 30
PROJECTS = ("vxqpgbzseckgceopitpm", "oosxndduqzhvrorgogaw")
ECMWF = "https://storage.googleapis.com/ecmwf-open-data"
GFS = "https://api.dynamical.org/v1"
GFS_VARIABLES = ("wind_u_100m", "wind_v_100m", "temperature_2m", "downward_short_wave_radiation_flux_surface")
ECMWF_VARIABLES = ("100u", "100v", "2t", "ssrd")
SERIES = ("wind_speed_120m", "temperature_2m", "shortwave_radiation")
THREAD = local()


def iso(at):
    return datetime.fromtimestamp(at, timezone.utc).isoformat().replace("+00:00", "Z")


def ts(value):
    return int(datetime.fromisoformat(value).timestamp())


def deno(*args, data=None):
    result = subprocess.run(["deno", "run", "scripts/price-weather-feed.ts", *args],
                            input=data, text=True, capture_output=True, check=True)
    return json.loads(result.stdout)


def query(project, sql):
    with tempfile.NamedTemporaryFile(mode="w", suffix=".sql") as file:
        file.write(sql)
        file.flush()
        result = subprocess.run(["supabase", "db", "query", "--linked", "--project-ref", project,
                                 "--file", file.name, "--agent", "no", "--output", "json", "--yes"],
                                text=True, capture_output=True, check=True)
    return json.loads(result.stdout)


def request(method, url, **options):
    if not hasattr(THREAD, "session"):
        THREAD.session = requests.Session()
        retry = Retry(total=3, backoff_factor=1, status_forcelist=[429, 500, 502, 503, 504],
                      allowed_methods={"GET", "HEAD", "POST"})
        THREAD.session.mount("https://", HTTPAdapter(max_retries=retry))
        THREAD.session.headers["User-Agent"] = "SHS regional electricity price weather collector"
    return THREAD.session.request(method, url, timeout=(10, 45), **options)


def site_series(points, site_count):
    """Convert hourly vectors in timestamp order to the shared model input."""
    sites = [{"times": [], "series": {key: [] for key in SERIES}} for _ in range(site_count)]
    for at, values in sorted(points.items()):
        if values is None:
            continue
        for i, site in enumerate(sites):
            site["times"].append(iso(at))
            for key, vector in zip(SERIES, values):
                site["series"][key].append(vector[i])
    return sites


def wind_speed(u, v):
    return None if u is None or v is None else math.hypot(u, v)


def gfs_weather(sites, now, _previous):
    def batch(path, product, **options):
        response = request("POST", f"{GFS}/{path}", json={"queries": [
            {"dataProductId": product, "location": site, "queryId": str(i), "variables": GFS_VARIABLES, **options}
            for i, site in enumerate(sites)
        ]})
        response.raise_for_status()
        rows = sorted(response.json()["results"], key=lambda row: int(row["queryId"]))
        if [int(row["queryId"]) for row in rows] != list(range(len(sites))):
            raise ValueError("GFS point batch did not match the requested sites")
        return rows

    def decode(rows, time_key):
        times = rows[0][time_key]
        if any(row[time_key] != times for row in rows):
            raise ValueError("GFS points had different time axes")
        points = {}
        for i, time_value in enumerate(times):
            at = ts(time_value)
            window = (at // HOUR) % 6 or 6
            winds, temps, radiation = [], [], []
            for row in rows:
                u, v, temp, flux = (row["data"][key] for key in GFS_VARIABLES)
                previous = flux[i - 1] if i and ts(times[i - 1]) == at - HOUR else None
                watts = flux[i] if window == 1 else (
                    max(0, flux[i] * window - previous * (window - 1))
                    if flux[i] is not None and previous is not None else None
                )
                winds.append(wind_speed(u[i], v[i]))
                temps.append(temp[i])
                radiation.append(watts)
            points[at] = (winds, temps, radiation)
        return points

    run_rows = batch("forecasts", "noaa-gfs-forecast", maxLeadTimeHours=108)
    forecast_rows = [row["forecasts"][0] for row in run_rows]
    cycle = ts(forecast_rows[0]["initTime"])
    if any(ts(row["initTime"]) != cycle for row in forecast_rows):
        raise ValueError("GFS points had different cycles")
    start = now // DAY * DAY - HISTORY_DAYS * DAY
    history = decode(batch("analyses", "noaa-gfs-analysis", startTime=iso(start), endTime=iso(cycle + HOUR)), "analysisTimes")
    forecast = decode(forecast_rows, "validTimes")
    if cycle in history:
        forecast[cycle] = history[cycle]
    return cycle, history, forecast


def ecmwf_url(cycle, lead):
    dt = datetime.fromtimestamp(cycle, timezone.utc)
    return f"{ECMWF}/{dt:%Y%m%d}/{dt:%H}z/ifs/0p25/oper/{dt:%Y%m%d%H}0000-{lead}h-oper-fc"


def ecmwf_weather(sites, now, previous):
    import eccodes

    lats = [site["latitude"] for site in sites]
    lons = [site["longitude"] for site in sites]
    tail = 108
    for cycle in range(now // CYCLE * CYCLE, now // CYCLE * CYCLE - 2 * DAY, -CYCLE):
        response = request("HEAD", ecmwf_url(cycle, tail) + ".index")
        if response.ok:
            break
        if response.status_code != 404:
            response.raise_for_status()
    else:
        raise RuntimeError("No ECMWF cycle is available from the public mirror")

    @lru_cache(maxsize=None)
    def load(cycle_at, lead):
        url = ecmwf_url(cycle_at, lead)
        response = request("GET", url + ".index")
        if response.status_code == 404:
            return None
        response.raise_for_status()
        fields = [field for line in response.text.splitlines() if (field := json.loads(line))["levtype"] == "sfc"
                  and field["param"] in ECMWF_VARIABLES]
        values = {}
        for field in fields:
            start = field["_offset"]
            end = start + field["_length"] - 1
            message = request("GET", url + ".grib2", headers={"Range": f"bytes={start}-{end}"})
            message.raise_for_status()
            if message.status_code != 206 or not message.headers["Content-Range"].startswith(f"bytes {start}-{end}/"):
                raise ValueError("ECMWF response did not match the requested field range")
            handle = eccodes.codes_new_from_message(message.content)
            try:
                param = field["param"]
                if eccodes.codes_get(handle, "shortName") != param:
                    raise ValueError("ECMWF indexed parameter did not match the GRIB field")
                if param == "ssrd" and (eccodes.codes_get(handle, "startStep"), eccodes.codes_get(handle, "endStep")) != (0, lead):
                    raise ValueError("ECMWF solar accumulation did not match the forecast step")
                points = eccodes.codes_grib_find_nearest_multiple(handle, False, lats, lons)
                values[param] = [point["value"] for point in points]
            finally:
                eccodes.codes_release(handle)
        required = ECMWF_VARIABLES if lead else ECMWF_VARIABLES[:-1]
        return values if all(key in values for key in required) else None

    def short(at):
        issued = (at - 1) // CYCLE * CYCLE
        return issued, (at - issued) // HOUR

    def native(at, forecasting):
        issued, lead = (cycle, (at - cycle) // HOUR) if forecasting and at > cycle else short(at)
        current = load(issued, lead)
        earlier = load(issued, lead - 3) if lead > 3 else None
        wind = load(cycle, 0) if forecasting and at == cycle else current
        if current is None or wind is None or (lead > 3 and earlier is None):
            return None
        previous_solar = earlier["ssrd"] if earlier else [0] * len(sites)
        return wind, [max(0, (value - previous) / STEP) for value, previous in zip(current["ssrd"], previous_solar)]

    old_hours = {row[0] // 1000 for row in previous.get("history", [])}
    start = cycle - HISTORY_DAYS * DAY
    missing = [at for at in range(start, cycle, HOUR) if at not in old_hours]
    reuse = previous.get("forecast_cycle") and ts(previous["forecast_cycle"]) == cycle and len(previous["forecast"]) == tail + 1
    forecast_times = range(cycle, cycle + tail * HOUR + 1, HOUR) if not reuse else ()
    history_native = {bound for at in missing for bound in (at // STEP * STEP, -(-at // STEP) * STEP)}
    forecast_native = range(cycle, cycle + tail * HOUR + 1, STEP) if not reuse else ()
    # Preload each distinct message once before interpolation. Only compact
    # regional samples are kept, never the global GRIB fields.
    needed = set()
    for at in history_native | ({cycle} if not reuse else set()):
        issued, lead = short(at)
        needed.add((issued, lead))
        if lead > 3:
            needed.add((issued, lead - 3))
    needed.update((cycle, (at - cycle) // HOUR) for at in forecast_native)
    with ThreadPoolExecutor(max_workers=20) as pool:
        for _ in pool.map(lambda point: load(*point), sorted(needed)):
            pass

    def hourly(times, forecasting):
        native_values = {}
        result = {}
        for at in times:
            low = at // STEP * STEP
            high = -(-at // STEP) * STEP
            for bound in {low, high} - native_values.keys():
                native_values[bound] = native(bound, forecasting)
            left, right = native_values[low], native_values[high]
            if left is None or right is None:
                continue
            a, b = left[0], right[0]
            w = (at - low) / STEP

            def vector(key):
                return [(1 - w) * x + w * y for x, y in zip(a[key], b[key])]

            result[at] = ([math.hypot(u, v) for u, v in zip(vector("100u"), vector("100v"))],
                          [value - 273.15 for value in vector("2t")], right[1])
        return result

    return cycle, hourly(missing, False), hourly(forecast_times, True) if not reuse else None


def refresh(project, source):
    rows = query(project, f"SELECT forecast_cycle, history, forecast FROM public.energy_price_weather_feeds WHERE source='{source}';")
    previous = rows[0] if rows else {}
    sites = deno("sites")
    now = int(time.time())
    collect = ecmwf_weather if source == "ecmwf" else gfs_weather
    cycle, history, forecast = collect(sites, now, previous)
    packed = deno(data=json.dumps({"history": site_series(history, len(sites)),
                                   "forecast": site_series(forecast or {}, len(sites))}, allow_nan=False))
    if forecast is None:
        packed["forecast"] = previous["forecast"]
    hours = {row[0]: row for row in previous.get("history", [])}
    hours.update({row[0]: row for row in packed["history"]})
    merged = [row for at, row in sorted(hours.items()) if (cycle - HISTORY_DAYS * DAY) * 1000 <= at < cycle * 1000]
    if not packed["forecast"]:
        raise RuntimeError("Weather provider returned no usable forecast hours")
    history_json = json.dumps(merged, separators=(",", ":"), allow_nan=False)
    forecast_json = json.dumps(packed["forecast"], separators=(",", ":"), allow_nan=False)
    query(project, f"""
      INSERT INTO public.energy_price_weather_feeds (source, forecast_cycle, history, forecast)
      VALUES ('{source}', '{iso(cycle)}', '{history_json}'::jsonb, '{forecast_json}'::jsonb)
      ON CONFLICT (source) DO UPDATE SET forecast_cycle=EXCLUDED.forecast_cycle,
        collected_at=clock_timestamp(), history=EXCLUDED.history, forecast=EXCLUDED.forecast
      WHERE energy_price_weather_feeds.forecast_cycle <= EXCLUDED.forecast_cycle;
      SELECT true AS refreshed;
    """)
    print(f"{source} {iso(cycle)}: {len(merged)} history hours, {len(packed['forecast'])} forecast hours")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True, choices=PROJECTS)
    parser.add_argument("--source", required=True, choices=("ecmwf", "gfs"))
    args = parser.parse_args()
    refresh(args.project, args.source)
