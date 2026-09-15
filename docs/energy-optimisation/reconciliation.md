# Reconciliation record

## Participation changes are not delivered actions — 15 September 2026

Acknowledged inclusion, planning, physical-authority and supply-scope revisions must match the reconciled plan/policy. Verification commands never create delivered demand changes or released headroom. Scope membership changes invalidate dependent unsent decisions but do not erase actual energy, prior costs or possible effects. Scope attribution is an accounting convention and must not be presented as measured appliance-level source delivery.

See the [agreed participation and battery supply specification](device-participation-and-battery-supply.md).
Documentation only; replacement implementation and coordinated rollout remain pending.

[Architecture index](../../ENERGY_OPTIMISATION_ARCHITECTURE.md) · [Outstanding decisions](../../ENERGY_OPTIMISATION_ARCHITECTURE_REVIEW.md)

On 2026-09-06 the original architecture was split into current topic specifications and a separately labelled historical record. The full 5,370-line source, including new 6 September workbench notes, is preserved in [history](history/README.md). Current specifications take precedence over historical prose. This record describes documentation changes, not runtime fixes.

The earlier review's 30 findings were handled as follows. A resolved mathematical or wording issue is removed from the active review; implementation follow-through belongs to the verification backlog. Only unresolved product/commissioning choices remain there.

| Earlier finding | Documentation disposition |
|---|---|
| 1. Cost minimisation | Corrected: service constraints can make cost minimisation well-posed |
| 2. Room schedule semantics | Corrected false uniqueness claim; remaining service promise is D1 |
| 3. Hard versus priced service | Separated constraints from penalties; removed automatic hard 80% target instruction; acceptable service trade-offs are D1/D3 |
| 4. MILP and runtime claims | Removed exactness/free-complexity assertions; formulation and runtime are engineering evidence |
| 5. Utility and temporal units | Defined utility versus marginal utility and objective units; precise weights are solver specification, approved service valuation is D3 |
| 6. Forecast-derived preferences | Removed claim static preferences cannot schedule; household shortfall valuation is D3 |
| 7. Thermal stores | Clarified physical storage versus limited current control contracts |
| 8. Bellman guarantee | Replaced with explicitly approximate continuation value and sufficient-state requirement |
| 9. Uncertainty | Removed deterministic-depletion and exact-insurance claims; scenario construction is engineering work, protection policy is D3 |
| 10. Demand state | Defined state per tariff statistic and partial window |
| 11. Peak/cap/tariff conflation | Separated all three, removed competing numeric defaults; approved ceiling/cost trade-off is D4 |
| 12. Universal spreading/order | Conditioned scenarios on loads, prices, and constraints; no universal merit order |
| 13. Wear semantics | Removed no-wear inference and annual saving extrapolation as requirements; parameter meaning/value is D3 |
| 14. EV and policy ownership | Confirmed approved customer intent; automatic learning is suggestive; absent-departure/readiness conflict is D2 |
| 15. Residual | Corrected planned/confirmed delta arithmetic with worked examples |
| 16. Response-time ranking | Replaced ambiguous ratio with response eligibility, removable power, and service cost; restoration uses current grant priorities |
| 17. Conflicting guarantees | Made safety precedence explicit and bounded claims to actual controllability; commissioned grid scope is D4 |
| 18. Stale setpoints | Specified authority revocation and baseline handover; removed safe-by-construction claim |
| 19. Failure/commitment | Separated publication, validity, cadence, and capability eligibility; unresolved policy is D5 |
| 20. Thermal identification | Corrected electrical/thermal interpretation and gamma/a arithmetic; mixed-device validation is engineering work, first hardware scope is D6 |
| 21. Seasonal/equipment claims | Removed physical overgeneralisations; summer comfort policy is D1 and shared equipment commissioning is D6 |
| 22. Price provenance | Required published-only observed training and separate as-issued records; estimator tests are engineering work, retention is D7 |
| 23. Fit certainty | Removed actual-comfort guarantees from model feasibility/fitted-mean claims |
| 24. Failure meanings | Distinguished missing input, infeasible problem, search failure, invalid output, and feasible candidate; independent safety validation retained |
| 25. Search/comparison proof | Restricted conclusions to feasible schedules under equal inputs/permissions; ties and local stability are not global certificates |
| 26. Version/archive | Model/build identity must track changed algorithms; latest-state storage is not an audit archive; retention/claims are D7 |
| 27. Savings | Separated bill components, forecast, utility, and actual benefit; commercial baseline/claims are D7 |
| 28. Attribution | Labelled proportional allocation as accounting and retained unmatched residual; no claim of exact per-device physical provenance |
| 29. Reporting assumptions | Removed population-validation/authenticity guarantees; treatment of priors, renovation and certificate trust is D8 |
| 30. Current-state summary | Replaced conflicting chronology with topic ownership, explicit precedence, implementation limitations, and historical section lookup |

## Additions encountered during the split

The 6 September notes now distinguish an energy-only workbench cost, curve clamping to reachable hardware state, and current-preference experiments. Their evidence is preserved. The current reporting specification clarifies that published prices multiplied by forecast consumption still yield a forecast, and that current-setting experiments are different from exact replay of a previously issued plan. Unreachable EV preference versus SOC cap is retained in D2.
