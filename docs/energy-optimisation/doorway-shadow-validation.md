# Doorway shadow validation

Run the offline comparison on a private capture for one usually-open doorway,
one receiving room, and one revision of the room map.

```sh
deno run --allow-read scripts/validate-doorway-shadow.ts /path/to/private-capture.json
```

Each origin contains the target room's starting temperature and delivered
heater state, the training quarters available at capture, and the weather,
heater input and indoor boundary forecasts for the selected horizon. The
training series uses quarter means, matches the current probe bindings, and
retains missing readings as null. The residual house boundary uses other
rooms' probes, excluding the target room and its explicitly modelled
neighbours. Freeze those inputs at the forecast origin, including the exact
room map and probe binding identifiers in the private capture's provenance.
The separately gathered target-room outcomes are used for scoring. The input
types are `DoorwayValidationInput`, `ShadowForecastOrigin` and
`DoorwayObservation`.

The pilot holds the baseline's total indoor exchange, heater response,
outdoor exchange and solar coefficients fixed. It estimates the share of
indoor exchange explained by one doorway and refits the background term.
The estimate describes the receiving room's response in °C per hour per °C
of difference. Fit the baseline again for each origin. Use identical forecast
weather, heater input and initial state for both models, and compare
temperature error and bias at 1, 6, 12 and 24 hours over matched origins.

Keep variable doors outside the steady-door pilot. Start a new comparison
when an endpoint, doorway type or probe changes. The experiment scores
conditional temperature forecasts. Testing the effect of optimising heater
schedules is a separate comparison.
