"""Read-only rolling-origin baseline experiment; never publishes forecasts or commands.

Input is a private JSON object with timezone and quarters [{start, energy_kwh}].
The caller must establish the same measured residual/device partition for every
candidate. Final repaired observations are not historical acquisition vintages.
Requires the sibling app source; reuses its real baseline estimator.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import importlib
import json
from math import isfinite
from pathlib import Path
import sys
from zoneinfo import ZoneInfo


def stamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def metrics(pairs):
    predicted = sum(p for p, _ in pairs)
    actual = sum(a for _, a in pairs)
    larger = sum(max(p, a) for p, a in pairs)
    return {"quarters": len(pairs), "predicted_kwh": predicted, "actual_kwh": actual,
            "bias_kwh": predicted - actual,
            "bias_percent": 100 * (predicted - actual) / actual if actual else None,
            "absolute_error_kwh": sum(abs(p-a) for p, a in pairs),
            "overlap_percent": 100 * sum(min(p, a) for p, a in pairs) / larger if larger else None}


@contextmanager
def centre(module, expected_energy):
    # Standalone research process only. Reuse all three fitting stages coherently,
    # rather than copying the app's estimator or changing just its shape centre.
    original = module._weighted_quantile
    if expected_energy:
        def mean(pairs, fraction):
            if fraction != .5:
                raise ValueError("The experiment only defines a central estimate")
            return module._weighted_trimmed_mean(pairs)
        module._weighted_quantile = mean
    try:
        yield
    finally:
        module._weighted_quantile = original


def run(document, module):
    tz = ZoneInfo(document["timezone"])
    quarters = sorted((stamp(q["start"]), float(q["energy_kwh"])) for q in document["quarters"])
    if not quarters or len({at for at, _ in quarters}) != len(quarters):
        raise ValueError("Nonempty, unique residual quarters are required")
    if any(not isfinite(kwh) or kwh < 0 for _, kwh in quarters):
        raise ValueError("Residual energy must be finite and nonnegative")
    first, last = quarters[0][0], quarters[-1][0] + timedelta(minutes=15)
    origins = []
    day = first.astimezone(tz).date() + timedelta(days=1)
    while True:
        origin = datetime.combine(day, datetime.min.time(), tzinfo=tz).astimezone(timezone.utc)
        end = datetime.combine(day+timedelta(days=1), datetime.min.time(), tzinfo=tz).astimezone(timezone.utc)
        if end > last:
            break
        if origin-first >= timedelta(days=10):
            origins.append((origin, end))
        day += timedelta(days=1)
    if len(origins) < 2:
        raise ValueError("Research needs validation origins and a separate final full local day")
    names = ("existing", "expected_energy", "recent_level")
    folds = []
    for origin, end in origins:
        train = [(at, kwh) for at, kwh in quarters if origin-timedelta(days=10) <= at < origin]
        test = [(at, kwh) for at, kwh in quarters if origin <= at < end]
        rows = [{"start": at.isoformat(), "total_load_kwh": kwh} for at, kwh in train]
        forecasts = {}
        for name in names:
            with centre(module, name == "expected_energy"):
                fitted = module.build_base_load_model(rows, document["timezone"], now=origin, minimum_samples=2)
            def power(at):
                local = at.astimezone(tz)
                return fitted["by_weekday"][local.weekday()][local.hour*4+local.minute//15]["median_w"]
            correction = 0.0
            if name == "recent_level":
                recent = [(at, kwh) for at, kwh in train if at >= origin-timedelta(days=3)]
                weights = [(kwh*4000-power(at), 2**(-(origin-at).total_seconds()/86400)) for at, kwh in recent]
                correction = sum(error*w for error, w in weights) / sum(w for _, w in weights)
            forecasts[name] = [(max(0, power(at)+correction)/4000, actual) for at, actual in test]
        folds.append({"day": str(origin.astimezone(tz).date()), "origin": origin.isoformat(),
                      "training_quarters": len(train), "pairs": forecasts})
    def total(selected, name):
        return metrics([pair for fold in selected for pair in fold["pairs"][name]])
    validation = {name: total(folds[:-1], name) for name in names}
    # Selection uses only earlier folds; the final local day remains untouched.
    selected = max(names, key=lambda name: (validation[name]["overlap_percent"], -validation[name]["absolute_error_kwh"]))
    return {"protocol": "10 elapsed training days; daily local origins; final full day held out; fixed candidates",
            "primary_metric": "quarter energy overlap", "validation": validation, "selected_before_holdout": selected,
            "holdout": {name: total(folds[-1:], name) for name in names},
            "folds": [{"day": f["day"], "origin": f["origin"], "training_quarters": f["training_quarters"],
                       "scores": {name: metrics(f["pairs"][name]) for name in names}} for f in folds],
            "deployment": "research_only",
            "limitations": ["Uses final measured residuals, not acquisition-time vintages.",
                            "Forecast skill alone does not establish better planner cost or battery delivery.",
                            "No live estimator, settings, permissions or models are changed."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--app-repo", required=True, type=Path)
    args = parser.parse_args()
    if any((parent/".git").exists() for parent in args.out.resolve().parents):
        raise ValueError("Private research output must stay outside repositories")
    if args.out.exists():
        raise FileExistsError("Refusing to overwrite a research report")
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(args.app_repo.resolve()/"custom_components"/"shs_energy"))
    module = importlib.import_module("shs_core.optimisation")
    result = run(json.loads(args.input.read_text()), module)
    args.out.write_text(json.dumps(result, indent=2)+"\n")
    print(json.dumps({"validation_origins": len(result["folds"])-1,
                      "selected_before_holdout": result["selected_before_holdout"], "holdout": result["holdout"]}, indent=2))


if __name__ == "__main__":
    main()
