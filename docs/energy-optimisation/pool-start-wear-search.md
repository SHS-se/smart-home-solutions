# Pool startup wear and search refinement — 10 October 2026

The planner and benchmark now charge 3 SEK once per actual pool-heater start.
Grid cash and startup electricity/heat are unchanged. Continuing a running heater
has no new start charge; partial quarters pay once rather than a prorated fee.
The existing 2 SEK deduction for restarting within twelve hours still applies.
No heat-pump wear per kWh was added.

`cost-policy.ts` owns the producer/referee default. ABI 7 requires the startup
cost explicitly; old ready inputs fail rather than acquiring an assumed default.
Scorer v31 and referee v16 require historical outcomes to be recomputed. Bill
`wear_sek` now includes battery discharge and heater starts; per-quarter
`wearSek` and `battery_wear_sek` remain battery-only measurements.
Economic audit v13 uses the same wear calculation when judging alternative
schedules, including any additional pool starts. Audit tests independently
replay its proposed schedules and verify the full wear difference.

## Search

All retained finalists compete after bounded refinement, rather than selecting
one before any refinement. Half the remaining work is shared among them and the
rest goes to the best refined candidate. Each adopted change is still scored
exactly with physical projection, rules, declared wear and terminal credit.

Run prefixes and suffixes can move into cheaper gaps without relocating the
whole run. Resizing can compete with its conditional battery response. The
proposal estimate now caps added store credit at the terminal target and accounts
for removing energy through that cap; previously it valued unlimited extra
energy whenever the incumbent ended below target. Estimates shortlist and rank
proposals; exact scoring decides whether to adopt them.

Recipe v8 retains beam width 16 and four finalists, and increases the deterministic
work grant from 760 million to 1.52 billion. No new validity bound, forecast gate,
minimum runtime or 8 kW cap is introduced.

## Same-input comparison

All 24 saved cases use the same forecasts, recorded conditions, household and
rule overrides. The old schedules reproduce the dashboard total −2992.7077.
The new schedules are independently refereed against recorded conditions.

| Comparison | Previous | New | Gain |
|---|---:|---:|---:|
| Previous scoring scale, excluding pool-start wear on both | −2992.7077 | −2992.1281 | +0.5796 |
| Current scoring scale, 3 SEK/start on both | −3211.7077 | −3172.1281 | +39.5796 |

Pool starts fall from 73 to 60. Electricity spending across the separate cases
falls from 4389.6079 to 4361.9536 SEK. Fifteen cases improve and nine worsen under
same-cost scoring. All pass physical validation, with no additional pool-low,
pool-cold, pool-hot, EV-low or EV-short deductions. No new pool run is an hour
or less; the shortest is ninety minutes.

Startup-only search at the same 1.52-billion grant scores −3178.3513, so the
search changes add 6.2232 points over merely increasing the grant. Search remains
bounded: C-1219 is still 2.1625 points worse than the old feasible schedule under
equal startup pricing. The change reduces, rather than eliminates, that regression.

| Case | Old dashboard | Old with startup wear | New with startup wear | Fair gain |
|---|---:|---:|---:|---:|
| C-0103 | -598.0015 | -604.0015 | -605.2329 | -1.2314 |
| C-0217 | -641.0406 | -650.0406 | -647.1641 | +2.8765 |
| C-0327 | -91.3744 | -100.3744 | -98.3181 | +2.0563 |
| C-0401 | -117.7179 | -129.7179 | -127.5603 | +2.1576 |
| C-0523 | 20.9445 | 11.9445 | 11.9210 | -0.0235 |
| C-0616 | 70.3984 | 61.3984 | 61.6390 | +0.2406 |
| C-0627 | 21.7887 | 9.7887 | 20.7991 | +11.0104 |
| C-0717 | -20.1560 | -29.1560 | -28.9389 | +0.2171 |
| C-0810 | 37.8939 | 28.8939 | 28.0546 | -0.8393 |
| C-0816 | 57.3640 | 48.3640 | 48.5284 | +0.1644 |
| C-0822 | 19.7740 | 10.7740 | 14.5466 | +3.7726 |
| C-0827 | -49.5120 | -61.5120 | -62.2688 | -0.7568 |
| C-0905 | -2.7477 | -11.7477 | -11.9965 | -0.2488 |
| C-0912 | -4.4959 | -13.4959 | -13.2211 | +0.2748 |
| C-0919 | -70.7176 | -79.7176 | -76.6614 | +3.0562 |
| C-0920 | -73.6502 | -79.6502 | -79.6658 | -0.0156 |
| C-0924 | -173.7107 | -185.7107 | -185.8088 | -0.0981 |
| C-0927 | -96.7182 | -108.7182 | -109.1226 | -0.4044 |
| C-0928a | -145.6183 | -157.6183 | -153.3498 | +4.2685 |
| C-0928b | -137.4936 | -149.4936 | -140.7408 | +8.7528 |
| C-1005 | -66.6202 | -75.6202 | -71.7276 | +3.8926 |
| C-1011 | -132.3341 | -135.3341 | -135.2096 | +0.1245 |
| C-1123 | -615.6141 | -621.6141 | -619.1190 | +2.4951 |
| C-1219 | -183.3482 | -189.3482 | -191.5107 | -2.1625 |
| Total | -2992.7077 | -3211.7077 | -3172.1281 | +39.5796 |

## Captured replay

The captured first hour is preserved exactly, including its partial initial
quarter. The 10 October 14:00–14:45 run disappears. Selected pool runs, Stockholm:

- 10 October 11:15–17:15.
- 11 October 10:00–15:15.
- 12 October 00:30–03:30.

Starts fall from four to three; the shortest run is three hours. Under equal
startup pricing the forecast score improves from −178.8801 to −175.1132.
Grid cash rises from 181.7391 to 186.3239 SEK and the pool ends at 30.4650°C
versus 30.2736°C; the full score values the additional stored energy. The minimum
pool temperature rises from 29.6345°C to 30.4650°C. Stacked quarters above 8 kW
fall from 25 to 22, but stacking remains a separate issue.

## Validation and timing

The native startup tests cover actual starts, continuing heaters, partial
quarters and unchanged electricity/heat. Search tests cover capped terminal
credit, a partial EV-run transfer, the small exhaustive pool oracle, commitments
and work reservations. Native/Wasm parity checks commands, trajectories, accounts
and deterministic work exactly. HA consumer fixtures are regenerated.

Final validation passes: `deno task test` (1710 tests), Rust tests (45), native/Wasm
parity, `npm run build:test` and `npm run test:e2e:local` (63 tests). Full
`npm run lint` reports zero errors and 27 existing warnings. The frontend build
retains its large-chunk warning. A fresh run after the economic-audit correction
reproduces all 24 schedules and scores exactly.

Local Wasm median solve time changes from 292.0 to 503.6 ms; maximum from 311.9 to 564.2 ms. These are local diagnostics, not hosted latency qualification.
