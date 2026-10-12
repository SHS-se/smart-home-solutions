"""Prepare ROI-only solar hours; requires scripts/roi-solar-requirements.txt.

Usage: python reconstruct-roi-solar.py --config config.json --actual-hours measured.json
       --cache-dir private-weather-cache --output prepared-solar.json
No database writes. The output is published atomically by publish-roi-solar.ts.
"""
import argparse
import asyncio
import hashlib
import json
import math
from datetime import datetime, timedelta, timezone
from importlib.metadata import version
from pathlib import Path
from zoneinfo import ZoneInfo

from open_meteo_solar_forecast import OpenMeteoSolarForecast

PROVIDER = "https://historical-forecast-api.open-meteo.com"
UTC = timezone.utc


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def bounds(month, time_zone):
    year, number = map(int, month.split("-"))
    start = datetime(year, number, 1, tzinfo=ZoneInfo(time_zone))
    end = datetime(year + (number == 12), number % 12 + 1, 1, tzinfo=start.tzinfo)
    return start.astimezone(UTC), end.astimezone(UTC)


def iso(at):
    return at.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


class HistoricalForecast(OpenMeteoSolarForecast):
    """Adapt only the API period; keep the provider's PV physics unchanged."""

    async def _request(self, uri, *, params=None):
        query = dict(params)
        query.pop("past_days")
        query.pop("forecast_days")
        query.update(start_date=self.period_start, end_date=self.period_end, timezone="UTC")
        path = self.cache_dir / (digest({"provider": PROVIDER, "query": query}) + ".json")
        if path.exists():
            data = json.loads(path.read_text())
        else:
            data = await super()._request(uri, params=query)
            path.write_text(canonical(data))
            path.chmod(0o600)
        self.weather_hash = digest(data)
        return data


async def month_hours(month, config, cache_dir):
    start, end = bounds(month, config["time_zone"])
    pv = config["pv"]
    async with HistoricalForecast(
        latitude=pv["latitude"], longitude=pv["longitude"],
        declination=pv["tilt_degrees"], azimuth=pv["compass_azimuth_degrees"] - 180,
        dc_kwp=pv["peak_kw"], ac_kwp=pv["inverter_kw"],
        efficiency_factor=pv["efficiency"], damping_morning=pv["morning_damping"],
        damping_evening=pv["evening_damping"], base_url=PROVIDER, weather_model="best_match",
    ) as forecast:
        # Radiation is interval-ending; padding covers the initial temperature
        # and the last interval. wh_period_15m already exposes interval STARTS.
        forecast.period_start = (start - timedelta(days=1)).date().isoformat()
        forecast.period_end = (end + timedelta(days=1)).date().isoformat()
        forecast.cache_dir = cache_dir
        estimate = await forecast.estimate()
        quarters = {at.astimezone(UTC): wh / 1000 for at, wh in estimate.wh_period_15m.items()}
        hours = {}
        at = start
        while at < end:
            values = [quarters.get(at + timedelta(minutes=15 * i)) for i in range(4)]
            if any(value is None or not math.isfinite(value) or value < 0 for value in values):
                raise ValueError(f"Incomplete historical forecast at {iso(at)}")
            hours[iso(at)] = sum(values)
            at += timedelta(hours=1)
        return hours, forecast.weather_hash


def compare(month, raw, actual, time_zone):
    start, end = bounds(month, time_zone)
    expected = int((end - start).total_seconds() / 3600)
    if len(raw) != expected or any(at not in actual for at in raw):
        raise ValueError(f"Calibration requires a complete measured month: {month}")
    measured = sum(actual[at] for at in raw)
    predicted = sum(raw.values())
    if measured <= 0 or predicted <= 0:
        raise ValueError(f"No positive production for calibration month {month}")
    return {"month": month, "hours": expected, "actual_kwh": measured, "raw_kwh": predicted}


async def prepare(args):
    config = json.loads(args.config.read_text())
    records = json.loads(args.actual_hours.read_text())
    actual = {}
    for row in records:
        value = row["actual"].get("solar_production_kwh")
        if value is None:
            continue
        if not isinstance(value, (float, int)) or not math.isfinite(value) or value < 0:
            raise ValueError("Invalid measured solar energy")
        at = datetime.fromisoformat(row["start_ts"]).astimezone(UTC)
        if at.minute or at.second or iso(at) in actual:
            raise ValueError("Duplicate or non-hourly actual reading")
        actual[iso(at)] = value
    first, last = config["reconstruction_months"]
    months = []
    year, number = map(int, first.split("-"))
    while f"{year:04d}-{number:02d}" <= last:
        months.append(f"{year:04d}-{number:02d}")
        year, number = year + (number == 12), number % 12 + 1
    training = config["training_months"]
    validation = config["validation_months"]
    if not months or not training or not validation or set(training) & set(validation):
        raise ValueError("Choose reconstruction, training and independent validation months")
    if any(month >= config["solar_installed_month"] for month in months):
        raise ValueError("Reconstruction must end before the installation month")
    if any(month <= config["solar_installed_month"] for month in training + validation):
        raise ValueError("Fit and validate using full months after installation")
    args.cache_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    modeled, weather = {}, {}
    for month in sorted(set(months + training + validation)):
        modeled[month], weather[month] = await month_hours(month, config, args.cache_dir)
    evidence = {month: compare(month, modeled[month], actual, config["time_zone"]) for month in training + validation}
    scale = sum(evidence[m]["actual_kwh"] for m in training) / sum(evidence[m]["raw_kwh"] for m in training)
    for item in evidence.values():
        item["corrected_kwh"] = sum(min(value * scale, config["pv"]["inverter_kw"]) for value in modeled[item["month"]].values())
        item["bias_percent"] = (item["corrected_kwh"] / item["actual_kwh"] - 1) * 100
    hours = [{"start_ts": at, "raw_kwh": raw, "modeled_kwh": min(raw * scale, config["pv"]["inverter_kw"])} for month in months for at, raw in modeled[month].items()]
    start, _ = bounds(first, config["time_zone"])
    _, end = bounds(last, config["time_zone"])
    output = {"start_ts": iso(start), "end_ts": iso(end), "hours": hours, "provenance": {
        "provider": "open_meteo_historical_forecast", "library_version": version("open-meteo-solar-forecast"),
        "library_commit": "5a8f3da2620c163e6f360f3c063823e273a7e140",
        "method": "provider_pv_physics_energy_weighted_scale_v1", "config": config, "weather_hashes": weather,
        "scale": scale, "training": [evidence[m] for m in training], "validation": [evidence[m] for m in validation],
        "actual_hash": digest(records),
    }}
    output["profile_hash"] = digest(output)
    args.output.write_text(canonical(output))
    args.output.chmod(0o600)
    print(json.dumps({"hours": len(hours), "scale": scale, "evidence": evidence}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("config", "actual-hours", "cache-dir", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    asyncio.run(prepare(parser.parse_args()))
