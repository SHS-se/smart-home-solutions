//! Exact room Bellman search. Grid, action order and minute thermostat physics
//! match the former TypeScript search; ingestion no longer pays for its JS heap.
use serde::{Deserialize, Serialize};
use shs_planner_models::room::{
    project, project_traced, temperature, Interval, Projection, State, Thermostat, Transition,
};

#[derive(Deserialize)]
pub struct Quarter {
    #[serde(flatten)]
    physics: Interval,
    transition: Transition,
    required_c: f64,
    maximum_c: f64,
    maximum_w: f64,
    relay_w: Vec<f64>,
    thermostat_power_w: Option<Vec<f64>>,
    fixed_relays: Vec<Option<bool>>,
    fixed_targets_c: Vec<Option<f64>>,
    import_sek_per_kwh: f64,
    export_sek_per_kwh: f64,
    surplus_w: f64,
    room_target: Option<RoomTarget>,
}
#[derive(Deserialize)]
struct RoomTarget {
    preferred_c: f64,
    fixed_c: Option<f64>,
    fixed_switches: Vec<Option<bool>>,
}

fn room_device_target(
    room: &RoomTarget,
    q: &Quarter,
    i: usize,
    t: &Thermostat,
    target: f64,
) -> f64 {
    if let Some(on) = room.fixed_switches[i] {
        return if on { f64::MAX } else { -f64::MAX };
    }
    if let Some(fixed) = q.fixed_targets_c[i] {
        return fixed;
    }
    if t.relay {
        return target;
    }
    let index = js_round((target + t.sensor_offset_c - t.minimum_c) / t.step_c + 1e-9);
    let last = ((t.maximum_c - t.minimum_c) / t.step_c + 1e-9).floor();
    js_round((t.minimum_c + index.clamp(0., last) * t.step_c) * 1e9) / 1e9
}
#[derive(Deserialize)]
pub struct Input {
    start_c: f64,
    start_delivered_w: f64,
    thermostats: Vec<Thermostat>,
    quarters: Vec<Quarter>,
}
#[derive(Default, Debug, Deserialize, Serialize, PartialEq)]
pub struct Plan {
    power_w: Vec<f64>,
    thermostat_w: Vec<Vec<f64>>,
    targets_c: Vec<Vec<f64>>,
    relays_on: Vec<Vec<bool>>,
    temperature_c: Vec<f64>,
    shortfall_c: Vec<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    room_targets_c: Vec<f64>,
}
// A kernel contains exact physical outcomes, not choices or scores. Only
// adjacent, bit-identical quarter physics share it. The 32 MiB payload budget
// limits memo storage; every uncached cell still evaluates all native actions.
#[derive(Default)]
struct ProjectionMemo {
    physics: Vec<u64>,
    actions: Vec<CachedAction>,
    rows: Vec<Option<CachedRow>>,
    cursor: usize,
    enabled: bool,
    replay: bool,
    payload_limit: usize,
}
#[derive(Clone, Copy)]
struct CachedRow {
    start: usize,
    end: usize,
    bounds: RoomBounds,
}
#[derive(Clone, Copy)]
struct RoomBounds {
    passive: f64,
    committed_peak: f64,
    committed_next: f64,
}
#[derive(Clone, Copy)]
struct CachedAction {
    next: f64,
    peak: f64,
    watts: f64,
    future: FutureRead,
}
#[derive(Clone, Copy)]
struct FutureRead {
    indices: [usize; 4],
    tf: f64,
    df: f64,
}
impl FutureRead {
    fn read(&self, table: Option<&[f64]>) -> f64 {
        let Some(table) = table else {
            return 0.;
        };
        let [a, b, c, d] = self.indices;
        let bottom = table[a] * (1. - self.df) + table[b] * self.df;
        let top = table[c] * (1. - self.df) + table[d] * self.df;
        bottom * (1. - self.tf) + top * self.tf
    }
}
fn physics_key(q: &Quarter) -> Vec<u64> {
    let mut key = vec![
        q.physics.hours.to_bits(),
        q.physics.steps as u64,
        q.physics.step.decay.to_bits(),
        q.physics.step.offset_c.to_bits(),
        q.physics.step.delivered_gain_c_per_w.to_bits(),
        q.physics.step.gain_c_per_w.to_bits(),
        q.physics.step.carry.to_bits(),
        q.transition.decay.to_bits(),
        q.transition.offset_c.to_bits(),
        q.transition.delivered_gain_c_per_w.to_bits(),
        q.transition.gain_c_per_w.to_bits(),
        q.transition.carry.to_bits(),
    ];
    key.extend(q.relay_w.iter().map(|w| w.to_bits()));
    if let Some(power) = &q.thermostat_power_w {
        key.push(power.len() as u64);
        key.extend(power.iter().map(|w| w.to_bits()));
    }
    key.extend(q.fixed_relays.iter().map(|v| match v {
        None => 0,
        Some(false) => 1,
        Some(true) => 2,
    }));
    key.extend(
        q.fixed_targets_c
            .iter()
            .map(|v| v.map_or(u64::MAX, f64::to_bits)),
    );
    if let Some(room) = &q.room_target {
        key.push(q.physics.relay_budget_w.map_or(u64::MAX, f64::to_bits));
        key.extend([
            room.preferred_c.to_bits(),
            room.fixed_c.map_or(u64::MAX, f64::to_bits),
        ]);
        key.extend(room.fixed_switches.iter().map(|on| match on {
            None => 0,
            Some(false) => 1,
            Some(true) => 2,
        }));
    }
    key
}
impl ProjectionMemo {
    fn quarter(&mut self, q: &Quarter, previous: Option<&Quarter>) {
        let key = physics_key(q);
        self.replay = self.enabled && self.physics == key;
        if !self.replay {
            self.actions.clear();
            self.rows.clear();
        }
        self.enabled = self.replay || previous.is_some_and(|p| physics_key(p) == key);
        self.physics = key;
        self.cursor = 0;
    }
}
fn score(
    q: &Quarter,
    bounds: RoomBounds,
    next: f64,
    peak: f64,
    watts: f64,
    future: f64,
) -> Option<f64> {
    let RoomBounds {
        passive,
        committed_peak,
        committed_next,
    } = bounds;
    if peak > q.maximum_w.max(committed_peak) + 1e-6
        || q.transition.carry == 0. && next > q.maximum_c.max(passive).max(committed_next) + 1e-9
    {
        return None;
    }
    Some(
        crate::room_policy::RoomObjective {
            hours: q.physics.hours,
            surplus_w: q.surplus_w,
            export_price: q.export_sek_per_kwh,
            import_price: q.import_sek_per_kwh,
            required: q.required_c,
            maximum: q.maximum_c.max(passive),
        }
        .cost(next, watts, future),
    )
}
struct Grid {
    low: f64,
    step: f64,
    temperatures: usize,
    delivered_step: f64,
    points: usize,
    masks: usize,
}
impl Grid {
    fn lookup(&self, state: State) -> FutureRead {
        let tp = ((state.temperature - self.low) / self.step)
            .max(0.)
            .min((self.temperatures - 1) as f64);
        let ti = (tp.floor() as usize).min(self.temperatures - 2);
        let dp = if self.points > 1 {
            (state.delivered / self.delivered_step)
                .max(0.)
                .min((self.points - 1) as f64)
        } else {
            0.
        };
        let di = (dp.floor() as usize).min(self.points.saturating_sub(2));
        let at = |t, d: usize| (t * self.points + d.min(self.points - 1)) * self.masks + state.mask;
        FutureRead {
            indices: [
                at(ti, di),
                at(ti, di + 1),
                at(ti + 1, di),
                at(ti + 1, di + 1),
            ],
            tf: tp - ti as f64,
            df: dp - di as f64,
        }
    }
}
struct RelayChoice {
    on: Vec<bool>,
    watts: f64,
}
struct Choice {
    room_target_c: f64,
    score: f64,
    watts: f64,
    targets: Vec<f64>,
    relays: Vec<bool>,
    state: State,
    thermostat_w: Vec<f64>,
}
struct Search<'a> {
    memo: ProjectionMemo,
    thermostats: &'a [Thermostat],
    projection: Projection,
    committed: Projection,
    targets: Vec<f64>,
    native_targets: Vec<Vec<f64>>,
    first: Vec<i64>,
    last: Vec<i64>,
    indices: Vec<i64>,
    /// An action was scored against a table cell that was never computed.
    unreached: bool,
}
fn js_round(value: f64) -> f64 {
    let floor = value.floor();
    let rounded = if value - floor < 0.5 {
        floor
    } else {
        floor + 1.
    };
    if rounded == 0. && value < 0. {
        -0.
    } else {
        rounded
    }
}
impl<'a> Search<'a> {
    fn new(thermostats: &'a [Thermostat], payload_limit: usize) -> Self {
        let n = thermostats.len();
        // Cache native command conversion, never quantize a new command.
        // Oversized ranges use identical arithmetic only when visited.
        let native_targets: Vec<Vec<f64>> = thermostats
            .iter()
            .map(|t| {
                let count = (((t.maximum_c - t.minimum_c) / t.step_c + 1e-9).floor() as usize)
                    .saturating_add(1);
                if count > payload_limit / std::mem::size_of::<f64>() / n.max(1) {
                    Vec::new()
                } else {
                    (0..count)
                        .map(|i| js_round((t.minimum_c + i as f64 * t.step_c) * 1e9) / 1e9)
                        .collect()
                }
            })
            .collect();
        let target_bytes = native_targets
            .iter()
            .map(|v| v.len() * std::mem::size_of::<f64>())
            .sum::<usize>();
        Self {
            memo: ProjectionMemo {
                payload_limit: payload_limit.saturating_sub(target_bytes),
                ..ProjectionMemo::default()
            },
            thermostats,
            projection: Projection::new(n),
            committed: Projection::new(n),
            targets: vec![0.; n],
            native_targets,
            first: vec![0; n],
            last: vec![0; n],
            indices: vec![0; n],
            unreached: false,
        }
    }
    fn choose<const SHARED: bool>(
        &mut self,
        initial: State,
        q: &Quarter,
        relays: &[RelayChoice],
        table: Option<&[f64]>,
        grid: &Grid,
        mut output: Option<&mut Choice>,
    ) -> Result<f64, String> {
        let room = if SHARED { q.room_target.as_ref() } else { None };
        let memo_row = self.memo.cursor;
        if self.memo.replay && output.is_none() {
            if let Some(row) = self.memo.rows.get(memo_row).copied().flatten() {
                let mut best = f64::INFINITY;
                let mut best_watts = f64::INFINITY;
                for action in &self.memo.actions[row.start..row.end] {
                    if let Some(value) = score(
                        q,
                        row.bounds,
                        action.next,
                        action.peak,
                        action.watts,
                        action.future.read(table),
                    ) {
                        self.unreached |= value.is_nan();
                        if best == f64::INFINITY
                            || value < best - 1e-9
                            || (value - best).abs() <= 1e-9 && action.watts < best_watts
                        {
                            best = value;
                            best_watts = action.watts;
                        }
                    }
                }
                return if best.is_finite() {
                    Ok(best)
                } else {
                    Err("No native room command fits the configured electrical headroom".into())
                };
            }
        }
        let capture = self.memo.enabled && !self.memo.replay && output.is_none();
        let memo_start = self.memo.actions.len();
        let memo_limit = self.memo.payload_limit / std::mem::size_of::<CachedAction>();
        let mut memo_complete = capture;
        let passive = temperature(q.transition, initial, 0.);
        let total: f64 =
            self.thermostats.iter().map(|t| t.power_w).sum::<f64>() + q.relay_w.iter().sum::<f64>();
        let full = temperature(q.transition, initial, total);
        for (j, t) in self.thermostats.iter().enumerate() {
            let last = ((t.maximum_c - t.minimum_c) / t.step_c + 1e-9).floor() as i64;
            let index = |c: f64| {
                (((c - t.minimum_c) / t.step_c).floor() as i64)
                    .max(0)
                    .min(last)
            };
            self.first[j] = index(initial.temperature.min(passive) + t.sensor_offset_c - 0.5);
            self.last[j] =
                (index(initial.temperature.max(full) + t.sensor_offset_c + 0.5) + 1).min(last);
            self.targets[j] = q.fixed_targets_c[j].unwrap_or(t.minimum_c);
        }
        let committed_relay: f64 = q
            .relay_w
            .iter()
            .enumerate()
            .map(|(j, w)| {
                if q.fixed_relays[j] == Some(true) {
                    *w
                } else {
                    0.
                }
            })
            .sum();
        if let Some(room) = room {
            for (j, t) in self.thermostats.iter().enumerate() {
                self.targets[j] = if room.fixed_c.is_some()
                    || room.fixed_switches[j].is_some()
                    || q.fixed_targets_c[j].is_some()
                {
                    room_device_target(room, q, j, t, room.fixed_c.unwrap_or(room.preferred_c))
                } else if t.relay {
                    -f64::MAX
                } else {
                    t.minimum_c
                };
            }
        }
        let has_commitment = room.is_some_and(|room| {
            room.fixed_c.is_some() || room.fixed_switches.iter().any(Option::is_some)
        }) || q.fixed_targets_c.iter().any(Option::is_some)
            || q.fixed_relays.iter().any(Option::is_some);
        let minimum_can_heat = self
            .thermostats
            .iter()
            .any(|t| initial.temperature.min(passive) + t.sensor_offset_c < t.minimum_c);
        if has_commitment || minimum_can_heat {
            project(
                &q.physics,
                self.thermostats,
                initial,
                &self.targets,
                committed_relay,
                &mut self.committed,
            );
        } else {
            self.committed.peak = 0.;
            self.committed.state.temperature = passive;
        }
        let mut best_score = f64::INFINITY;
        let mut best_watts = f64::INFINITY;
        let (first_room, last_room) = if SHARED {
            let native_margin = self
                .thermostats
                .iter()
                .filter(|t| !t.relay)
                .map(|t| t.step_c.max(0.5))
                .reduce(f64::max);
            // A relay's stop threshold is 0.25 °C above the target and
            // its start threshold is strict. Beyond these bounds the
            // reachable room temperatures cannot change either decision.
            let lower = initial.temperature.min(passive) - native_margin.unwrap_or(0.25);
            let upper = initial.temperature.max(full) + native_margin.unwrap_or(0.1);
            ((lower * 10.).floor() as i64, (upper * 10.).ceil() as i64)
        } else {
            (0, 0)
        };
        for relay in relays {
            // Only targets vary inside this loop. Reuse requires an exact
            // proof of every minute's latch decision, never similar outcomes.
            let mut projected = false;
            let mut evaluation: Option<(CachedAction, Option<f64>)> = None;
            self.indices.copy_from_slice(&self.first);
            let mut room_index = first_room;
            loop {
                let room_target = room.map(|room| {
                    room.fixed_c.unwrap_or(if room_index == first_room {
                        room.preferred_c
                    } else {
                        (room_index - 1) as f64 / 10.
                    })
                });
                for (j, t) in self.thermostats.iter().enumerate() {
                    // JavaScript Math.round rounds ties towards positive infinity.
                    self.targets[j] = if let (Some(room), Some(target)) = (room, room_target) {
                        room_device_target(room, q, j, t, target)
                    } else {
                        q.fixed_targets_c[j].unwrap_or_else(|| {
                            self.native_targets[j]
                                .get(self.indices[j] as usize)
                                .copied()
                                .unwrap_or_else(|| {
                                    js_round(
                                        (t.minimum_c + self.indices[j] as f64 * t.step_c) * 1e9,
                                    ) / 1e9
                                })
                        })
                    };
                }
                if !projected
                    || !self.projection.reproduces_targets(
                        &self.targets,
                        self.thermostats,
                        q.physics.relay_budget_w.is_some(),
                    )
                {
                    project_traced(
                        &q.physics,
                        self.thermostats,
                        initial,
                        &self.targets,
                        relay.watts,
                        &mut self.projection,
                    );
                    projected = true;
                    let action = CachedAction {
                        next: self.projection.state.temperature,
                        peak: self.projection.peak,
                        watts: relay.watts + self.projection.power.iter().sum::<f64>(),
                        future: grid.lookup(self.projection.state),
                    };
                    let value = score(
                        q,
                        RoomBounds {
                            passive,
                            committed_peak: self.committed.peak,
                            committed_next: self.committed.state.temperature,
                        },
                        action.next,
                        action.peak,
                        action.watts,
                        action.future.read(table),
                    );
                    evaluation = Some((action, value));
                    if capture {
                        if self.memo.actions.len() < memo_limit {
                            self.memo.actions.push(action);
                        } else {
                            memo_complete = false;
                        }
                    }
                }
                // The trace proves the complete physical outcome is identical.
                // Evaluate that outcome once while retaining every target action
                // and the original tie-breaking/order below.
                let (action, value) =
                    evaluation.expect("a room action must have a projected trajectory");
                let watts = action.watts;
                if let Some(value) = value {
                    self.unreached |= value.is_nan();
                    if best_score == f64::INFINITY
                        || value < best_score - 1e-9
                        || (value - best_score).abs() <= 1e-9 && watts < best_watts
                    {
                        best_score = value;
                        best_watts = watts;
                        if let Some(out) = output.as_deref_mut() {
                            out.room_target_c = room_target.unwrap_or(0.);
                            out.score = value;
                            out.watts = watts;
                            out.state = self.projection.state;
                            out.targets.copy_from_slice(&self.targets);
                            out.relays.copy_from_slice(&relay.on);
                            out.thermostat_w.copy_from_slice(&self.projection.power);
                        }
                    }
                }
                if let Some(room) = room {
                    if room.fixed_c.is_some() || room_index > last_room {
                        break;
                    }
                    room_index += 1;
                    continue;
                }
                // Same lexicographic Cartesian product as the original action list.
                let mut j = self.indices.len();
                while j > 0 {
                    j -= 1;
                    if q.fixed_targets_c[j].is_none() && self.indices[j] < self.last[j] {
                        self.indices[j] += 1;
                        break;
                    }
                    self.indices[j] = self.first[j];
                }
                if self.indices.is_empty()
                    || j == 0
                        && (q.fixed_targets_c[0].is_some() || self.indices[0] == self.first[0])
                {
                    break;
                }
            }
        }
        if capture {
            if self.memo.rows.len() <= memo_row {
                self.memo.rows.resize(memo_row + 1, None);
            }
            if memo_complete {
                self.memo.rows[memo_row] = Some(CachedRow {
                    start: memo_start,
                    end: self.memo.actions.len(),
                    bounds: RoomBounds {
                        passive,
                        committed_peak: self.committed.peak,
                        committed_next: self.committed.state.temperature,
                    },
                });
            } else {
                self.memo.actions.truncate(memo_start);
            }
        }
        if best_score == f64::INFINITY {
            return Err("No native room command fits the configured electrical headroom".into());
        }
        Ok(best_score)
    }
}
fn relay_choices(q: &Quarter) -> Vec<RelayChoice> {
    let mut rows = vec![RelayChoice {
        on: vec![],
        watts: 0.,
    }];
    for (j, w) in q.relay_w.iter().enumerate() {
        rows = rows
            .into_iter()
            .flat_map(|row| {
                let options = match q.fixed_relays[j] {
                    Some(on) => vec![on],
                    None => vec![false, true],
                };
                options.into_iter().map(move |on| {
                    let mut values = row.on.clone();
                    values.push(on);
                    RelayChoice {
                        on: values,
                        watts: row.watts + if on { *w } else { 0. },
                    }
                })
            })
            .collect();
    }
    rows
}
pub fn plan(input: &Input) -> Result<Plan, String> {
    plan_with_memo_budget(input, 32 * 1024 * 1024)
}
/// The temperature rows of each quarter's table that the plan can read, as
/// inclusive row ranges; `None` for the first quarter, whose table is never
/// read. A room left alone cools no faster than its passive transition and a
/// room heated with everything it has warms no faster than its full one, so a
/// quarter's states lie between those two carried forward from the start, and
/// the rows a state's actions read are the two around each next temperature.
/// Returns `None` where the transition is not monotone, and the whole table is
/// then computed.
fn reachable_rows(input: &Input, grid: &Grid, top: f64) -> Option<Vec<Option<(usize, usize)>>> {
    // Minute steps and the quarter's own transition round differently.
    const SLACK_C: f64 = 1e-6;
    let thermostat_w: f64 = input.thermostats.iter().map(|t| t.power_w).sum();
    let mut rows = vec![None; input.quarters.len()];
    let (mut coldest, mut warmest) = (input.start_c, input.start_c);
    let row = |c: f64| {
        let position = ((c - grid.low) / grid.step)
            .max(0.)
            .min((grid.temperatures - 1) as f64);
        (position.floor() as usize).min(grid.temperatures - 2)
    };
    // A quarter's rows follow from the states of the quarter before it.
    for (rows, before) in rows.iter_mut().skip(1).zip(&input.quarters) {
        let s = before.transition;
        let heater_w = before
            .thermostat_power_w
            .as_ref()
            .map_or(thermostat_w, |w| w.iter().sum());
        let total = heater_w + before.relay_w.iter().sum::<f64>();
        // Written so that a NaN fails the test.
        if !(s.decay >= 0.
            && s.delivered_gain_c_per_w >= 0.
            && s.gain_c_per_w >= 0.
            && total >= 0.
            && top >= total
            && input.start_delivered_w >= 0.)
        {
            return None;
        }
        let idle = State {
            temperature: coldest,
            delivered: 0.,
            mask: 0,
        };
        let heated = State {
            temperature: warmest,
            delivered: top,
            mask: 0,
        };
        let passive = temperature(s, idle, 0.) - SLACK_C;
        let full = temperature(s, heated, total) + SLACK_C;
        if !(passive.is_finite() && full.is_finite()) {
            return None;
        }
        let (from, to) = (row(passive), row(full) + 1);
        *rows = Some((from, to));
        coldest = grid.low + from as f64 * grid.step;
        warmest = grid.low + to as f64 * grid.step;
    }
    Some(rows)
}
fn plan_with_memo_budget(input: &Input, payload_limit: usize) -> Result<Plan, String> {
    // Only the rows the plan can read are searched. Should a read ever fall
    // outside them, the whole table is computed instead, as it always was.
    if let Some(plan) = plan_rows(input, payload_limit, true)? {
        return Ok(plan);
    }
    plan_rows(input, payload_limit, false)?
        .ok_or_else(|| "Room search read a table cell it never computed".into())
}
/// `Ok(None)` when `restrict` left out a cell that the plan then read.
fn plan_rows(input: &Input, payload_limit: usize, restrict: bool) -> Result<Option<Plan>, String> {
    let Input {
        start_c,
        start_delivered_w,
        thermostats,
        quarters,
    } = input;
    if quarters.iter().any(|q| {
        q.thermostat_power_w
            .as_ref()
            .is_some_and(|power| power.len() != thermostats.len())
            || q.fixed_targets_c.len() != thermostats.len()
            || q.fixed_relays.len() != q.relay_w.len()
            || q.room_target
                .as_ref()
                .is_some_and(|room| room.fixed_switches.len() != thermostats.len())
    }) {
        return Err("Room command arrays do not match their devices".into());
    }
    let mut low = *start_c;
    let mut high = *start_c;
    for q in quarters {
        low = low.min(q.required_c).min(q.maximum_c);
        high = high.max(q.required_c).max(q.maximum_c);
    }
    low -= 2.;
    let delayed = quarters.iter().any(|q| q.transition.carry > 0.);
    let base_thermostat_w = thermostats.iter().map(|t| t.power_w).sum::<f64>();
    let thermostat_w = quarters
        .iter()
        .filter_map(|q| q.thermostat_power_w.as_ref())
        .map(|power| power.iter().sum())
        .fold(base_thermostat_w, f64::max);
    let top = start_delivered_w.max(
        thermostat_w
            + quarters
                .iter()
                .map(|q| q.relay_w.iter().sum::<f64>())
                .fold(0., f64::max),
    );
    let relay_only = !thermostats.is_empty() && thermostats.iter().all(|t| t.relay);
    let points = if !delayed || top == 0. {
        1
    } else if relay_only {
        // Binary relays use a smaller delivered-heat grid. The forward pass
        // still carries the actual continuous heat and projects each switch.
        4
    } else {
        7
    };
    let step = if delayed || thermostats.iter().any(|t| t.relay) {
        0.1
    } else {
        0.05
    };
    let grid = Grid {
        low,
        step,
        temperatures: (((high + 2. - low) / step).ceil() as usize + 1).max(2),
        delivered_step: if points > 1 {
            top / (points - 1) as f64
        } else {
            0.
        },
        points,
        masks: 1usize
            .checked_shl(thermostats.len() as u32)
            .ok_or("Room latch grid size overflow")?,
    };
    let size = grid
        .temperatures
        .checked_mul(points)
        .and_then(|n| n.checked_mul(grid.masks))
        .ok_or("Room grid size overflow")?;
    let options: Vec<_> = quarters.iter().map(relay_choices).collect();
    let mut values: Vec<Vec<f64>> = vec![vec![]; quarters.len() + 1];
    // Outdoor draw is fixed per quarter and independent of the candidate target.
    // The exact target trace can continue to compare thermostat latch decisions.
    let quarter_thermostats: Vec<_> = quarters
        .iter()
        .map(|q| {
            q.thermostat_power_w.as_ref().map(|power| {
                thermostats
                    .iter()
                    .zip(power)
                    .map(|(t, &power_w)| Thermostat {
                        power_w,
                        ..t.clone()
                    })
                    .collect::<Vec<_>>()
            })
        })
        .collect();
    let mut search = Search::new(thermostats, payload_limit);
    let reachable = if restrict {
        reachable_rows(input, &grid, top)
    } else {
        None
    };
    for i in (0..quarters.len()).rev() {
        search.thermostats = quarter_thermostats[i].as_deref().unwrap_or(thermostats);
        search
            .memo
            .quarter(&quarters[i], i.checked_sub(1).map(|j| &quarters[j]));
        // A cell left out stays NaN, so a read of it cannot pass for a value.
        let rows = match &reachable {
            Some(rows) => rows[i],
            None => Some((0, grid.temperatures - 1)),
        };
        let mut table = vec![if reachable.is_some() { f64::NAN } else { 0. }; size];
        let next = if i + 1 == quarters.len() {
            None
        } else {
            Some(values[i + 1].as_slice())
        };
        for t in rows.map_or(0..0, |(from, to)| from..to + 1) {
            for d in 0..points {
                for mask in 0..grid.masks {
                    search.memo.cursor = (t * points + d) * grid.masks + mask;
                    let state = State {
                        temperature: low + t as f64 * step,
                        delivered: d as f64 * grid.delivered_step,
                        mask,
                    };
                    let q = &quarters[i];
                    table[(t * points + d) * grid.masks + mask] = if q.room_target.is_some() {
                        search.choose::<true>(state, q, &options[i], next, &grid, None)?
                    } else {
                        search.choose::<false>(state, q, &options[i], next, &grid, None)?
                    };
                }
            }
        }
        if reachable.is_some() && search.unreached {
            return Ok(None);
        }
        values[i] = table;
    }
    search.memo = ProjectionMemo::default();
    let mut result = Plan::default();
    let mut state = State {
        temperature: *start_c,
        delivered: *start_delivered_w,
        mask: thermostats
            .iter()
            .enumerate()
            .filter(|(_, t)| t.hvac_action == "heating")
            .map(|(j, _)| 1 << j)
            .sum(),
    };
    for (i, q) in quarters.iter().enumerate() {
        search.thermostats = quarter_thermostats[i].as_deref().unwrap_or(thermostats);
        let mut out = Choice {
            room_target_c: 0.,
            score: 0.,
            watts: 0.,
            targets: vec![0.; thermostats.len()],
            relays: vec![false; q.relay_w.len()],
            state,
            thermostat_w: vec![0.; thermostats.len()],
        };
        let next = if i + 1 == quarters.len() {
            None
        } else {
            Some(values[i + 1].as_slice())
        };
        if q.room_target.is_some() {
            search.choose::<true>(state, q, &options[i], next, &grid, Some(&mut out))?;
        } else {
            search.choose::<false>(state, q, &options[i], next, &grid, Some(&mut out))?;
        }
        result.power_w.push(out.watts);
        result.thermostat_w.push(out.thermostat_w);
        result.targets_c.push(out.targets);
        if q.room_target.is_some() {
            result.room_targets_c.push(out.room_target_c);
        }
        result.relays_on.push(out.relays);
        result.temperature_c.push(out.state.temperature);
        result
            .shortfall_c
            .push((q.required_c - out.state.temperature).max(0.));
        state = out.state;
    }
    if reachable.is_some() && search.unreached {
        return Ok(None);
    }
    Ok(Some(result))
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Outcome {
    Planned { plan: Plan },
    Failed { issue: String },
}
pub fn plan_json(bytes: &[u8]) -> Vec<u8> {
    let result = serde_json::from_slice::<Input>(bytes)
        .map_err(|e| format!("Invalid room input: {e}"))
        .and_then(|input| plan(&input));
    let outcome = match result {
        Ok(plan) => Outcome::Planned { plan },
        Err(issue) => Outcome::Failed { issue },
    };
    serde_json::to_vec(&outcome).expect("finite room plan")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_original_room_commands_and_physics() {
        let vectors: serde_json::Value = serde_json::from_slice(include_bytes!(
            "../../../tests/room-heating-native.fixture.json"
        ))
        .unwrap();
        for vector in vectors.as_array().unwrap() {
            let input: Input = serde_json::from_value(vector["input"].clone()).unwrap();
            let expected: Plan = serde_json::from_value(vector["plan"].clone()).unwrap();
            assert_eq!(plan(&input).unwrap(), expected, "{}", vector["name"]);
        }
    }

    #[test]
    fn memo_capacity_and_invalidation_preserve_all_original_results() {
        let vectors: serde_json::Value = serde_json::from_slice(include_bytes!(
            "../../../tests/room-heating-native.fixture.json"
        ))
        .unwrap();
        for vector in vectors.as_array().unwrap() {
            let input: Input = serde_json::from_value(vector["input"].clone()).unwrap();
            let expected: Plan = serde_json::from_value(vector["plan"].clone()).unwrap();
            // Zero storage, a partial-row budget, and several complete rows.
            // Changing-physics vectors invalidate kernels during these runs.
            for bytes in [0, 1, 64 * std::mem::size_of::<CachedAction>()] {
                assert_eq!(
                    plan_with_memo_budget(&input, bytes).unwrap(),
                    expected,
                    "{} with {bytes} memo bytes",
                    vector["name"]
                );
            }
        }
    }

    #[test]
    fn reachable_rows_give_the_full_table_plan_without_falling_back() {
        let vectors: serde_json::Value = serde_json::from_slice(include_bytes!(
            "../../../tests/room-heating-native.fixture.json"
        ))
        .unwrap();
        for vector in vectors.as_array().unwrap() {
            let input: Input = serde_json::from_value(vector["input"].clone()).unwrap();
            let full = plan_rows(&input, 32 * 1024 * 1024, false).unwrap();
            for bytes in [0, 32 * 1024 * 1024] {
                let restricted = plan_rows(&input, bytes, true).unwrap();
                assert!(
                    restricted.is_some(),
                    "{} read a cell outside its reachable rows",
                    vector["name"]
                );
                assert_eq!(restricted, full, "{}", vector["name"]);
            }
        }
    }

    #[test]
    fn a_transition_that_is_not_monotone_searches_the_whole_table() {
        let vectors: serde_json::Value = serde_json::from_slice(include_bytes!(
            "../../../tests/room-heating-native.fixture.json"
        ))
        .unwrap();
        let mut input: Input =
            serde_json::from_value(vectors.as_array().unwrap()[0]["input"].clone()).unwrap();
        let grid = Grid {
            low: 0.,
            step: 0.1,
            temperatures: 400,
            delivered_step: 0.,
            points: 1,
            masks: 1,
        };
        assert!(reachable_rows(&input, &grid, 1e6).is_some());
        input.quarters[0].transition.gain_c_per_w = -1e-6;
        assert!(reachable_rows(&input, &grid, 1e6).is_none());
        input.quarters[0].transition.gain_c_per_w = f64::NAN;
        assert!(reachable_rows(&input, &grid, 1e6).is_none());
    }

    #[test]
    fn native_target_cache_is_bounded_and_retains_commands() {
        let mut thermostats = vec![Thermostat {
            minimum_c: 1.0000000005,
            maximum_c: 2.0000000005,
            step_c: 0.5,
            power_w: 800.,
            sensor_offset_c: 0.,
            hvac_action: "idle".into(),
            relay: false,
        }];
        let search = Search::new(&thermostats, 128);
        assert_eq!(
            search.native_targets[0],
            vec![1.000000001, 1.500000001, 2.000000001]
        );
        assert_eq!(
            search.memo.payload_limit,
            128 - 3 * std::mem::size_of::<f64>()
        );
        let uncached = Search::new(&thermostats, 0);
        assert!(uncached.native_targets[0].is_empty());
        thermostats[0].step_c = 1e-12;
        let oversized = Search::new(&thermostats, 128);
        assert!(oversized.native_targets[0].is_empty());
        assert_eq!(oversized.memo.payload_limit, 128);
    }

    #[test]
    fn native_rounding_matches_javascript_half_boundaries() {
        assert_eq!(js_round(0.49999999999999994), 0.);
        assert_eq!(js_round(0.5), 1.);
        assert_eq!(js_round(-0.5).to_bits(), (-0.0_f64).to_bits());
        assert_eq!(js_round(-0.5000000000000001), -1.);
        assert_eq!(js_round(18_500_000_000.0), 18_500_000_000.0);
    }
}
