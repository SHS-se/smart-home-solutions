//! Ordered scalar proposals with authoritative simultaneous command replay.
use crate::room_heating::{self, room_device_target, Input as RoomInput, Plan};
use serde::{Deserialize, Serialize};
use shs_planner_models::{
    room::{project, Interval, Projection, State, Thermostat, Transition},
    room_network::{advance_cached, NetworkKernels, Node},
};

#[derive(Deserialize)]
pub struct Room {
    pub(crate) node: usize,
    pub(crate) input: RoomInput,
}
#[derive(Deserialize)]
struct FixedHeater {
    node: usize,
    watts: Vec<f64>,
}
#[derive(Deserialize)]
pub struct Input {
    #[serde(default)]
    fixed_heaters: Vec<FixedHeater>,
    pub(crate) nodes: Vec<Node>,
    pub(crate) rooms: Vec<Room>,
    pub(crate) stage: usize,
    pub(crate) hours: Vec<f64>,
    pub(crate) headroom_w: Vec<f64>,
    pub(crate) import_sek_per_kwh: Vec<f64>,
    pub(crate) export_sek_per_kwh: Vec<f64>,
    pub(crate) surplus_w: Vec<f64>,
    pub(crate) accepted: Option<Vec<Plan>>,
}
impl Input {
    pub(crate) fn validate_fixed_heaters(&self) -> Result<(), String> {
        for (index, heater) in self.fixed_heaters.iter().enumerate() {
            if heater.node >= self.nodes.len()
                || self.rooms.iter().any(|room| room.node == heater.node)
                || self.fixed_heaters[..index]
                    .iter()
                    .any(|prior| prior.node == heater.node)
                || heater.watts.len() != self.hours.len()
                || heater.watts.iter().any(|w| !w.is_finite() || *w < 0.)
            {
                return Err("Invalid fixed heater input".into());
            }
        }
        Ok(())
    }
}
#[derive(Serialize)]
pub struct ProposalOutput {
    pub plans: Vec<Plan>,
    pub temperature_c: Vec<Vec<f64>>,
    pub mean_temperature_c: Vec<Vec<f64>>,
}
#[derive(Serialize)]
pub struct Output {
    pub plans: Vec<Plan>,
    pub temperature_c: Vec<Vec<f64>>,
    pub mean_temperature_c: Vec<Vec<f64>>,
    pub literal: Vec<Plan>,
}
#[derive(Clone, Deserialize, Serialize, PartialEq)]
pub(crate) struct NetworkState {
    pub(crate) temperatures: Vec<f64>,
    pub(crate) heat: Vec<f64>,
    pub(crate) masks: Vec<usize>,
}
struct Replay {
    plans: Vec<Plan>,
    temperature: Vec<Vec<f64>>,
    means: Vec<Vec<f64>>,
}
#[derive(Default)]
pub(crate) struct ReplayKernels {
    thermal: NetworkKernels,
    slot: Option<usize>,
    thermostats: Vec<Vec<Thermostat>>,
    projections: Vec<Projection>,
    watts: Vec<f64>,
}
const IDENTITY: Transition = Transition {
    decay: 1.,
    offset_c: 0.,
    stored_heat_release: 0.,
    gain_c_per_w: 0.,
    stored_heat_gain_c_per_w: 0.,
    carry: 1.,
};

pub(crate) fn commands(input: &RoomInput, literal: bool) -> Plan {
    let mut plan = Plan::default();
    for q in &input.quarters {
        let policy = q
            .room_target
            .as_ref()
            .expect("network room has shared target");
        let minimum = input
            .thermostats
            .iter()
            .filter(|t| !t.relay)
            .map(|t| t.minimum_c - t.sensor_offset_c)
            .reduce(f64::min)
            .unwrap_or(-1e100);
        let target = policy
            .fixed_c
            .unwrap_or(if literal { policy.preferred_c } else { minimum });
        plan.targets_c.push(
            input
                .thermostats
                .iter()
                .enumerate()
                .map(|(j, t)| {
                    if !literal
                        && t.relay
                        && policy.fixed_c.is_none()
                        && policy.fixed_switches[j].is_none()
                        && q.fixed_targets_c[j].is_none()
                    {
                        -1e100
                    } else {
                        room_device_target(policy, q, j, t, target)
                    }
                })
                .collect(),
        );
        plan.room_targets_c.push(target);
        plan.relays_on.push(vec![]);
    }
    plan
}
fn replay(input: &Input, commands: &[Plan], kernels: &mut ReplayKernels) -> Replay {
    let n = input.nodes.len();
    let slots = input.hours.len();
    let mut temperatures: Vec<_> = input.nodes.iter().map(|n| n.start_c).collect();
    let mut heat: Vec<_> = input.nodes.iter().map(|n| n.start_stored_heat_c).collect();
    let mut masks: Vec<usize> = input
        .rooms
        .iter()
        .map(|r| {
            r.input
                .thermostats
                .iter()
                .enumerate()
                .filter(|(_, t)| t.hvac_action == "heating")
                .map(|(j, _)| 1 << j)
                .sum()
        })
        .collect();
    let mut out = Replay {
        plans: commands.to_vec(),
        temperature: vec![vec![]; n],
        means: vec![vec![]; n],
    };
    for plan in &mut out.plans {
        plan.power_w.clear();
        plan.thermostat_w.clear();
        plan.temperature_c.clear();
        plan.shortfall_c.clear();
    }
    for i in 0..slots {
        let (totals, mean, _peak) = project_slot(
            input,
            commands,
            i,
            &mut temperatures,
            &mut heat,
            &mut masks,
            kernels,
        );
        for node in 0..n {
            out.temperature[node].push(temperatures[node]);
            out.means[node].push(if input.hours[i] > 0. {
                mean[node] / input.hours[i]
            } else {
                temperatures[node]
            });
        }
        for (j, room) in input.rooms.iter().enumerate() {
            let power: Vec<_> = totals[j]
                .iter()
                .map(|v| {
                    if input.hours[i] > 0. {
                        v / input.hours[i]
                    } else {
                        0.
                    }
                })
                .collect();
            let plan = &mut out.plans[j];
            plan.power_w.push(power.iter().sum());
            plan.thermostat_w.push(power);
            plan.temperature_c.push(temperatures[room.node]);
            plan.shortfall_c
                .push((room.input.quarters[i].required_c - temperatures[room.node]).max(0.));
        }
    }
    out
}
#[derive(Clone)]
pub(crate) struct MinuteOutput {
    pub energy: Vec<f64>,
    pub mean_integral: Vec<f64>,
    pub peak: f64,
}
/// The one actuator/thermal step used by both proposal replay and stochastic
/// qualification. A common thermal innovation is applied after the exact drift.
pub(crate) fn project_minute(
    input: &Input,
    commands: &[Plan],
    slot: usize,
    minute: usize,
    state: &mut NetworkState,
    kernels: &mut ReplayKernels,
    noise: &[f64],
) -> MinuteOutput {
    let steps = (input.hours[slot] * 60.).ceil() as usize;
    let dt = if steps > 0 {
        input.hours[slot] / steps as f64
    } else {
        0.
    };
    if kernels.slot != Some(slot) {
        kernels.watts.resize(input.nodes.len(), 0.);
        for heater in &input.fixed_heaters {
            kernels.watts[heater.node] = heater.watts[slot];
        }
        kernels.thermostats = input
            .rooms
            .iter()
            .map(|room| {
                let mut thermostats = room.input.thermostats.clone();
                if let Some(power) = &room.input.quarters[slot].thermostat_power_w {
                    for (t, p) in thermostats.iter_mut().zip(power) {
                        t.power_w = *p;
                    }
                }
                thermostats
            })
            .collect();
        kernels.projections = kernels
            .thermostats
            .iter()
            .map(|ts| Projection::new(ts.len()))
            .collect();
        kernels.slot = Some(slot);
    }
    let mut reserved = 0.;
    let mut energy = Vec::new();
    for (j, room) in input.rooms.iter().enumerate() {
        let q = &room.input.quarters[slot];
        let thermostats = &kernels.thermostats[j];
        let interval = Interval {
            hours: dt,
            steps: 1,
            memory_scale: None,
            step: IDENTITY,
            relay_budget_w: q
                .physics
                .relay_budget_w
                .map(|budget| budget.min((input.headroom_w[slot] - reserved).max(0.))),
        };
        let projection = &mut kernels.projections[j];
        project(
            &interval,
            thermostats,
            State {
                temperature: state.temperatures[room.node],
                stored_heat: state.heat[room.node],
                mask: state.masks[j],
            },
            &commands[j].targets_c[slot],
            0.,
            projection,
        );
        state.masks[j] = projection.state.mask;
        kernels.watts[room.node] = projection.power.iter().sum();
        if j <= input.stage {
            reserved += projection.peak;
        }
        energy.extend(projection.power.iter().map(|p| p * dt));
    }
    let mut mean_integral: Vec<_> = state.temperatures.iter().map(|t| t * 0.5 * dt).collect();
    let mean_correction = advance_cached(
        &input.nodes,
        shs_planner_models::room_network::NetworkInterval {
            slot,
            step: minute,
            hours: dt,
        },
        &mut state.temperatures,
        &mut state.heat,
        &kernels.watts,
        &mut kernels.thermal,
    );
    for (i, t) in state.temperatures.iter_mut().enumerate() {
        *t += noise.get(i).copied().unwrap_or(0.);
        mean_integral[i] += *t * 0.5 * dt + mean_correction.get(i).copied().unwrap_or(0.);
    }
    MinuteOutput {
        energy,
        mean_integral,
        peak: reserved,
    }
}
fn project_slot(
    input: &Input,
    commands: &[Plan],
    slot: usize,
    temperatures: &mut Vec<f64>,
    heat: &mut Vec<f64>,
    masks: &mut Vec<usize>,
    kernels: &mut ReplayKernels,
) -> (Vec<Vec<f64>>, Vec<f64>, f64) {
    let mut state = NetworkState {
        temperatures: std::mem::take(temperatures),
        heat: std::mem::take(heat),
        masks: std::mem::take(masks),
    };
    let mut totals: Vec<Vec<f64>> = input
        .rooms
        .iter()
        .map(|room| vec![0.; room.input.thermostats.len()])
        .collect();
    let mut mean = vec![0.; input.nodes.len()];
    let mut peak: f64 = 0.;
    for minute in 0..(input.hours[slot] * 60.).ceil() as usize {
        let step = project_minute(input, commands, slot, minute, &mut state, kernels, &[]);
        for (total, energy) in totals.iter_mut().flatten().zip(step.energy) {
            *total += energy;
        }
        for (m, value) in mean.iter_mut().zip(step.mean_integral) {
            *m += value;
        }
        peak = peak.max(step.peak);
    }
    *temperatures = state.temperatures;
    *heat = state.heat;
    *masks = state.masks;
    (totals, mean, peak)
}

fn transition(loss: f64, lag: f64, hours: f64, forcing: f64, gain: f64) -> Transition {
    let decay = (-loss * hours).exp();
    let effect = if loss == 0. {
        hours
    } else {
        -(-loss * hours).exp_m1() / loss
    };
    let carry = if lag > 0. { (-hours / lag).exp() } else { 0. };
    let b = if lag == 0. {
        0.
    } else if ((loss - 1. / lag) * hours).abs() < 1e-7 {
        hours * decay
    } else {
        (carry - decay) / (loss - 1. / lag)
    };
    Transition {
        decay,
        offset_c: forcing * effect,
        stored_heat_release: if hours == 0. {
            0.
        } else if lag > 0. {
            b / lag
        } else {
            decay
        },
        gain_c_per_w: gain * (effect - b),
        stored_heat_gain_c_per_w: if lag > 0. {
            gain * lag * (1. - carry)
        } else {
            0.
        },
        carry,
    }
}
fn conditional(input: &Input, base: &Replay) -> RoomInput {
    let mut room = input.rooms[input.stage].input.clone();
    let node = &input.nodes[input.rooms[input.stage].node];
    for (i, q) in room.quarters.iter_mut().enumerate() {
        let mut loss = node.outdoor_per_h;
        let mut forcing = node.forcing_c_per_h[i];
        for edge in &node.incoming {
            let rates = &edge.rates[i];
            let rate = if rates.is_empty() {
                0.
            } else {
                rates.iter().sum::<f64>() / rates.len() as f64
            };
            loss += rate;
            forcing += rate * base.means[edge.node][i];
        }
        q.transition = transition(
            loss,
            node.lag_h,
            q.physics.hours,
            forcing,
            node.gain_c_per_wh[i],
        );
        q.physics.step = transition(
            loss,
            node.lag_h,
            if q.physics.steps > 0 {
                q.physics.hours / q.physics.steps as f64
            } else {
                0.
            },
            forcing,
            node.gain_c_per_wh[i],
        );
        let used = base.plans[..input.stage]
            .iter()
            .map(|p| p.power_w[i])
            .sum::<f64>();
        q.maximum_w = q.maximum_w.min((input.headroom_w[i] - used).max(0.));
        q.physics.relay_budget_w = q.physics.relay_budget_w.map(|v| v.min(q.maximum_w));
    }
    room
}
pub fn plan(input: &Input) -> Result<ProposalOutput, String> {
    input.validate_fixed_heaters()?;
    let mut kernels = ReplayKernels::default();
    if input.stage >= input.rooms.len() {
        return Err("Invalid connected room stage".into());
    }
    let mut accepted = input.accepted.clone().unwrap_or_else(|| {
        input
            .rooms
            .iter()
            .map(|r| commands(&r.input, false))
            .collect()
    });
    if accepted.len() != input.rooms.len() {
        return Err("Invalid connected room continuation".into());
    }
    let baseline = replay(input, &accepted, &mut kernels);
    let scalar = conditional(input, &baseline);
    accepted[input.stage] = room_heating::plan(&scalar)?;
    let proposed = replay(input, &accepted, &mut kernels);
    // This is only an ordered command proposal. The final joint trajectory
    // barrier owns literal/deadline/cost qualification and electrical demand.
    Ok(ProposalOutput {
        plans: proposed.plans,
        temperature_c: proposed.temperature,
        mean_temperature_c: proposed.means,
    })
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Outcome {
    Planned { plan: ProposalOutput },
    Failed { issue: String },
}
pub fn plan_json(bytes: &[u8]) -> Vec<u8> {
    let result = serde_json::from_slice::<Input>(bytes)
        .map_err(|e| format!("Invalid connected room input: {e}"))
        .and_then(|i| plan(&i));
    serde_json::to_vec(&match result {
        Ok(plan) => Outcome::Planned { plan },
        Err(issue) => Outcome::Failed { issue },
    })
    .expect("finite connected room plan")
}
