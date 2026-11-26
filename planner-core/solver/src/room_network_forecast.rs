//! Resumable joint trajectories. Commands are fixed; uncertainty affects physical
//! temperatures, thermostat latches and electricity together, never a power margin.
use crate::room_heating::Plan;
use crate::room_network::{
    commands, project_minute, Input as NetworkInput, MinuteOutput, NetworkState, Output,
    ReplayKernels,
};
use serde::{Deserialize, Serialize};
use shs_planner_models::room_network::use_fast_memory_transform;
use shs_planner_models::room_regime::{
    event_branch, EventStrata, Hazard, Process, ResetPrior, Value,
};
use shs_planner_models::room_uncertainty::{covariance_root, normal, thermal_noise_root, uniform};
use std::collections::HashMap;

const SETS: usize = 3;
pub const REVISION: &str = "joint_regime_replicas_philox_v3";
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Dynamics {
    Constant {
        from: usize,
        per_h: f64,
    },
    LogOu {
        from: usize,
        mean_log_per_h: f64,
        reversion_per_h: f64,
        stationary_variance: f64,
    },
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Posterior {
    pub temperature_c: f64,
    pub log_rates: Vec<f64>,
    pub log_centers: Option<Vec<f64>>,
    pub covariance: Vec<Vec<f64>>,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Hypothesis {
    pub log_weight: f64,
    pub incoming: Vec<Dynamics>,
    pub posterior: Posterior,
    pub hazards: Option<Vec<Hazard>>,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct NodeBelief {
    pub hypotheses: Vec<Hypothesis>,
    pub thermal_noise_c2_per_h: f64,
    pub bounded_thermal: bool,
    pub reset_priors: Option<Vec<ResetPrior>>,
}
#[derive(Deserialize)]
pub struct Input {
    pub network: NetworkInput,
    pub beliefs: Vec<NodeBelief>,
    pub seed: [u32; 2],
    pub identity: String,
    pub replicate_count: usize,
    pub target_trajectories: usize,
    pub max_minute_steps: usize,
    pub work: Option<Work>,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Replicate {
    pub trajectories: usize,
    #[serde(with = "crate::packed_f64")]
    pub total: Vec<f64>,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Statistics {
    pub trajectories: usize,
    pub replayed_paths: usize,
    #[serde(with = "crate::packed_f64")]
    pub total: Vec<f64>,
    pub replicates: Vec<Replicate>,
    pub infeasible: [usize; SETS],
}
#[derive(Clone, Deserialize, Serialize)]
struct Path {
    incoming_nodes: Vec<Vec<usize>>,
    processes: Vec<Vec<Process>>,
    rate_cursor: usize,
    weight: f64,
    states: Vec<NetworkState>,
    mandatory: Vec<NetworkState>,
    starts: Vec<NetworkState>,
    energy: Vec<Vec<Vec<f64>>>,
    means: Vec<Vec<f64>>,
    peaks: [f64; SETS],
    mandatory_peaks: [f64; SETS],
    feasible: [bool; SETS],
    #[serde(with = "crate::packed_f64")]
    prefix_cost: Vec<f64>,
    quarter_rates: Vec<Vec<Vec<f64>>>,
    quarter_noise: Vec<Vec<f64>>,
}
#[derive(Clone, Deserialize, Serialize)]
struct InitialTrajectory {
    incoming_nodes: Vec<Vec<usize>>,
    processes: Vec<Vec<Process>>,
    state: NetworkState,
    weight: f64,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Work {
    pub revision: String,
    pub identity: String,
    pub seed: [u32; 2],
    pub replicate_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    replica: Option<usize>,
    pub cursor: usize,
    pub slot: usize,
    pub minute: usize,
    pub statistics: Statistics,
    pub deterministic: bool,
    path: Option<Path>,
    pending: Option<InitialTrajectory>,
}
#[derive(Serialize)]
pub struct Advanced {
    pub work: Work,
    pub reached_target: bool,
    pub assessment: Assessment,
    pub statistics: Option<NumericStatistics>,
}
#[derive(Serialize)]
pub struct NumericReplicate {
    pub trajectories: usize,
    pub total: Vec<f64>,
}
#[derive(Serialize)]
pub struct NumericStatistics {
    pub trajectories: usize,
    pub replayed_paths: usize,
    pub total: Vec<f64>,
    pub replicates: Vec<NumericReplicate>,
    pub infeasible: [usize; SETS],
}
impl NumericStatistics {
    fn from(stats: &Statistics) -> Self {
        Self {
            trajectories: stats.trajectories,
            replayed_paths: stats.replayed_paths,
            total: stats.total.clone(),
            infeasible: stats.infeasible,
            replicates: stats
                .replicates
                .iter()
                .map(|r| NumericReplicate {
                    trajectories: r.trajectories,
                    total: r.total.clone(),
                })
                .collect(),
        }
    }
}
#[derive(Serialize)]
pub struct Assessment {
    pub proposal_rejection: Option<Rejection>,
    pub deadline_resolved: bool,
    pub unresolved_deadline_prefixes: usize,
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Rejection {
    HorizonShortfall {
        room: usize,
        horizon_shortfall_difference_c_h: f64,
        twice_standard_error_c_h: f64,
    },
    PrefixCost {
        room: usize,
        cost_difference: f64,
        twice_standard_error: f64,
        new_miss: bool,
        no_improvement: bool,
    },
}
fn horizon_shortfall_difference(values: &[f64], input: &NetworkInput, room: usize) -> f64 {
    let (slots, rooms, nodes, stride) = dimensions(input);
    (0..slots)
        .map(|slot| {
            let index = (rooms + 2 * nodes + room) * slots + slot;
            (values[index] - values[stride + index]) * input.hours[slot]
        })
        .sum()
}
/// The literal comparator owns these deadline predicates. Numerical integration
/// certifies the same booleans; it never substitutes a shortfall deadband.
fn deadline_flags(proposed: f64, literal: f64) -> (bool, bool) {
    (
        proposed > 1e-6 && literal <= 1e-6,
        literal > 1e-6 && proposed <= 1e-6,
    )
}
#[derive(Clone, Copy)]
struct ShortfallEstimate {
    mean_c: f64,
    twice_standard_error_c: f64,
}
#[derive(Debug)]
struct DeadlineCertificate {
    new_certain: bool,
    new_possible: bool,
    improved_certain: bool,
    improved_possible: bool,
}
/// Intersect the marginal intervals with the common-path difference interval.
/// A new miss requires a > epsilon >= b, hence a-b > 0; an improvement requires
/// a-b < 0. These necessary inequalities eliminate impossible rectangle corners
/// without changing either deadline predicate. In particular, identical paired
/// shortfalls cannot create a new miss merely because their common uncertainty
/// straddles epsilon. These remain numerical 2SE certificates, not physical bounds.
fn deadline_certificate(
    proposed: ShortfallEstimate,
    literal: ShortfallEstimate,
    difference_twice_standard_error_c: f64,
) -> DeadlineCertificate {
    let corners = [
        deadline_flags(
            proposed.mean_c - proposed.twice_standard_error_c,
            literal.mean_c - literal.twice_standard_error_c,
        ),
        deadline_flags(
            proposed.mean_c - proposed.twice_standard_error_c,
            literal.mean_c + literal.twice_standard_error_c,
        ),
        deadline_flags(
            proposed.mean_c + proposed.twice_standard_error_c,
            literal.mean_c - literal.twice_standard_error_c,
        ),
        deadline_flags(
            proposed.mean_c + proposed.twice_standard_error_c,
            literal.mean_c + literal.twice_standard_error_c,
        ),
    ];
    let difference = proposed.mean_c - literal.mean_c;
    DeadlineCertificate {
        new_certain: corners.iter().all(|flags| flags.0),
        new_possible: corners.iter().any(|flags| flags.0)
            && difference + difference_twice_standard_error_c > 0.,
        improved_certain: corners.iter().all(|flags| flags.1),
        improved_possible: corners.iter().any(|flags| flags.1)
            && difference - difference_twice_standard_error_c < 0.,
    }
}
fn replicate_error(stats: &Statistics, functional: impl Fn(&[f64]) -> f64) -> f64 {
    let means: Vec<_> = stats
        .replicates
        .iter()
        .map(|r| functional(&r.total) / r.trajectories as f64)
        .collect();
    let count = means.len() as f64;
    let mean = means.iter().sum::<f64>() / count;
    2. * (means.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / (count * (count - 1.))).sqrt()
}
fn assessment(input: &NetworkInput, work: &Work) -> Assessment {
    let mut result = Assessment {
        proposal_rejection: None,
        deadline_resolved: false,
        unresolved_deadline_prefixes: 0,
    };
    let stats = &work.statistics;
    if work.path.is_some()
        || work.pending.is_some()
        || stats.trajectories == 0
        || stats.replicates.len() < 2
        || stats.replicates.iter().any(|r| r.trajectories < 2)
    {
        return result;
    }
    let (slots, rooms, nodes, stride) = dimensions(input);
    let means: Vec<_> = stats
        .total
        .iter()
        .map(|value| value / stats.trajectories as f64)
        .collect();
    for room in 0..rooms {
        let difference = horizon_shortfall_difference(&means, input, room);
        let error = replicate_error(stats, |values| {
            horizon_shortfall_difference(values, input, room)
        });
        if difference > error + 1e-8 {
            result.proposal_rejection = Some(Rejection::HorizonShortfall {
                room,
                horizon_shortfall_difference_c_h: difference,
                twice_standard_error_c_h: error,
            });
            result.deadline_resolved = true;
            return result;
        }
    }
    // A prefix uses OR over its quarter predicates. One certified true witness
    // resolves an OR even if other quarters remain numerically ambiguous.
    let (mut new_certain, mut new_possible, mut improved_certain, mut improved_possible) =
        (false, false, false, false);
    for room in 0..rooms {
        for slot in 0..slots {
            let a = (rooms + 2 * nodes + room) * slots + slot;
            let b = stride + a;
            let ae = replicate_error(stats, |values| values[a]);
            let be = replicate_error(stats, |values| values[b]);
            let certificate = deadline_certificate(
                ShortfallEstimate {
                    mean_c: means[a],
                    twice_standard_error_c: ae,
                },
                ShortfallEstimate {
                    mean_c: means[b],
                    twice_standard_error_c: be,
                },
                replicate_error(stats, |values| values[a] - values[b]),
            );
            new_certain |= certificate.new_certain;
            new_possible |= certificate.new_possible;
            improved_certain |= certificate.improved_certain;
            improved_possible |= certificate.improved_possible;
        }
        let a = stride - rooms + room;
        let b = stride + a;
        let difference = means[a] - means[b];
        let error = replicate_error(stats, |values| values[a] - values[b]);
        let penalty_certain = new_certain || !improved_possible;
        let penalty_possible = new_possible || !improved_certain;
        if difference > error + 1e-8 && penalty_certain {
            result.proposal_rejection = Some(Rejection::PrefixCost {
                room,
                cost_difference: difference,
                twice_standard_error: error,
                new_miss: new_certain,
                no_improvement: !improved_possible,
            });
            result.deadline_resolved = true;
            return result;
        }
        if difference + error > 1e-8 && penalty_certain != penalty_possible {
            result.unresolved_deadline_prefixes += 1;
        }
    }
    result.deadline_resolved = result.unresolved_deadline_prefixes == 0;
    result
}
fn dimensions(input: &NetworkInput) -> (usize, usize, usize, usize) {
    let slots = input.hours.len();
    let rooms = input.rooms.len();
    let nodes = input.nodes.len();
    (
        slots,
        rooms,
        nodes,
        (2 * rooms
            + 2 * nodes
            + input
                .rooms
                .iter()
                .map(|r| r.input.thermostats.len())
                .sum::<usize>())
            * slots
            + rooms,
    )
}
fn deterministic(beliefs: &[NodeBelief]) -> bool {
    beliefs.iter().all(|node| {
        node.thermal_noise_c2_per_h == 0.
            && node
                .reset_priors
                .as_ref()
                .is_none_or(|priors| priors.is_empty())
            && (node.hypotheses.is_empty()
                || (node.hypotheses.len() == 1 && {
                    let h = &node.hypotheses[0];
                    h.posterior.covariance.iter().enumerate().all(|(i, row)| {
                        i == 1
                            || (node.bounded_thermal && i == 0)
                            || row.iter().enumerate().all(|(j, v)| {
                                j == 1 || (node.bounded_thermal && j == 0) || *v == 0.
                            })
                    }) && h.incoming.iter().all(|edge| match edge {
                        Dynamics::Constant { .. } => true,
                        Dynamics::LogOu {
                            stationary_variance,
                            reversion_per_h,
                            ..
                        } => *stationary_variance == 0. || *reversion_per_h == 0.,
                    })
                }))
    })
}
fn initial(input: &NetworkInput) -> NetworkState {
    NetworkState {
        temperatures: input.nodes.iter().map(|n| n.start_c).collect(),
        heat: input.nodes.iter().map(|n| n.start_stored_heat_c).collect(),
        masks: input
            .rooms
            .iter()
            .map(|room| {
                room.input
                    .thermostats
                    .iter()
                    .enumerate()
                    .filter(|(_, t)| t.hvac_action == "heating")
                    .map(|(i, _)| 1 << i)
                    .sum()
            })
            .collect(),
    }
}
fn start_path(
    input: &Input,
    trajectory: usize,
) -> Result<(Path, Option<InitialTrajectory>), String> {
    let mut state = initial(&input.network);
    let mut hypotheses = Vec::new();
    let mut logs = Vec::new();
    let mut centers = Vec::new();
    for (i, belief) in input.beliefs.iter().enumerate() {
        if belief.hypotheses.is_empty() {
            hypotheses.push(0);
            logs.push(vec![]);
            centers.push(vec![]);
            continue;
        }
        let high = belief
            .hypotheses
            .iter()
            .map(|h| h.log_weight)
            .fold(f64::NEG_INFINITY, f64::max);
        let weights: Vec<_> = belief
            .hypotheses
            .iter()
            .map(|h| (h.log_weight - high).exp())
            .collect();
        let sum: f64 = weights.iter().sum();
        if !sum.is_finite() || sum <= 0. {
            return Err("Invalid process hypothesis weights".into());
        }
        let draw = uniform(input.seed, trajectory as u32, i as u32, 0, u32::MAX) * sum;
        let mut cumulative = 0.;
        let index = weights
            .iter()
            .position(|w| {
                cumulative += w;
                cumulative >= draw
            })
            .unwrap_or(weights.len() - 1);
        let hypothesis = &belief.hypotheses[index];
        let count = hypothesis.posterior.log_rates.len();
        let center_count = hypothesis
            .posterior
            .log_centers
            .as_ref()
            .map_or(0, Vec::len);
        if hypothesis.posterior.log_centers.is_some() && center_count != count
            || hypothesis
                .incoming
                .iter()
                .filter(|edge| matches!(edge, Dynamics::LogOu { .. }))
                .count()
                != count
        {
            return Err("Invalid process posterior coordinates".into());
        }
        let width = 2 + count + center_count;
        let coordinates: Vec<_> = if belief.bounded_thermal {
            (2..width).collect()
        } else {
            std::iter::once(0).chain(2..width).collect()
        };
        if hypothesis.posterior.covariance.len() != width
            || hypothesis
                .posterior
                .covariance
                .iter()
                .any(|row| row.len() != width)
        {
            return Err("Invalid process posterior dimensions".into());
        }
        let covariance: Vec<Vec<f64>> = coordinates
            .iter()
            .map(|&r| {
                coordinates
                    .iter()
                    .map(|&c| hypothesis.posterior.covariance[r][c])
                    .collect()
            })
            .collect();
        let root = covariance_root(&covariance)?;
        let normals: Vec<_> = (0..coordinates.len())
            .map(|j| normal(input.seed, trajectory as u32, i as u32, 0, j as u32))
            .collect();
        let noise: Vec<f64> = root
            .iter()
            .map(|row| row.iter().zip(&normals).map(|(a, z)| a * z).sum())
            .collect();
        if !belief.bounded_thermal {
            state.temperatures[i] = hypothesis.posterior.temperature_c + noise[0];
        }
        // Q is captured electrical carry, not a random Gaussian inventory.
        logs.push(
            hypothesis
                .posterior
                .log_rates
                .iter()
                .zip(&noise[if belief.bounded_thermal { 0 } else { 1 }..])
                .map(|(z, n)| z + n)
                .collect(),
        );
        centers.push(if let Some(values) = &hypothesis.posterior.log_centers {
            values
                .iter()
                .zip(&noise[usize::from(!belief.bounded_thermal) + count..])
                .map(|(value, delta)| value + delta)
                .collect()
        } else {
            hypothesis
                .incoming
                .iter()
                .filter_map(|edge| match edge {
                    Dynamics::LogOu { mean_log_per_h, .. } => Some(*mean_log_per_h),
                    Dynamics::Constant { .. } => None,
                })
                .collect()
        });
        hypotheses.push(index);
    }
    let mut processes = Vec::new();
    for (node, belief) in input.beliefs.iter().enumerate() {
        if belief.hypotheses.is_empty() {
            processes.push(vec![]);
            continue;
        }
        let h = &belief.hypotheses[hypotheses[node]];
        if h.hazards
            .as_ref()
            .is_some_and(|values| values.len() != h.incoming.len())
        {
            return Err("Invalid incoming-edge hazard alignment".into());
        }
        let mut log = 0;
        let mut row = Vec::new();
        for (edge, dynamics) in h.incoming.iter().enumerate() {
            let (from, value) = match dynamics {
                Dynamics::Constant { from, per_h } => (*from, Value::Constant { per_h: *per_h }),
                Dynamics::LogOu {
                    from,
                    reversion_per_h,
                    stationary_variance,
                    ..
                } => {
                    let value = Value::Ou {
                        log: logs[node][log],
                        center: centers[node][log],
                        reversion: *reversion_per_h,
                        variance: *stationary_variance,
                    };
                    log += 1;
                    (*from, value)
                }
            };
            let prior = belief
                .reset_priors
                .as_ref()
                .and_then(|priors| priors.iter().find(|p| p.from == from))
                .cloned();
            row.push(Process::new(
                value,
                prior,
                h.hazards.as_ref().map(|values| &values[edge]),
            )?);
        }
        processes.push(row);
    }
    let incoming_nodes: Vec<Vec<usize>> = input
        .beliefs
        .iter()
        .enumerate()
        .map(|(i, b)| {
            b.hypotheses.get(hypotheses[i]).map_or_else(Vec::new, |h| {
                h.incoming
                    .iter()
                    .map(|e| match e {
                        Dynamics::Constant { from, .. } | Dynamics::LogOu { from, .. } => *from,
                    })
                    .collect()
            })
        })
        .collect();
    let horizon = input.network.hours.iter().sum();
    let EventStrata {
        no_event_weight,
        event_weight,
        event,
    } = event_branch(&processes, horizon, input.seed, trajectory as u32)?;
    let pending = event.map(|processes| InitialTrajectory {
        incoming_nodes: incoming_nodes.clone(),
        processes,
        state: state.clone(),
        weight: event_weight,
    });
    let initial = InitialTrajectory {
        incoming_nodes,
        processes,
        state,
        weight: no_event_weight,
    };
    if no_event_weight == 0. {
        Ok((
            path_from_initial(input, pending.ok_or("Missing nonzero reset stratum")?),
            None,
        ))
    } else {
        Ok((path_from_initial(input, initial), pending))
    }
}
fn path_from_initial(input: &Input, initial: InitialTrajectory) -> Path {
    let (_, rooms, nodes, _) = dimensions(&input.network);
    let states = vec![initial.state; SETS];
    Path {
        incoming_nodes: initial.incoming_nodes,
        processes: initial.processes,
        rate_cursor: 0,
        weight: initial.weight,
        mandatory: states.clone(),
        starts: states.clone(),
        states,
        energy: (0..SETS)
            .map(|_| {
                input
                    .network
                    .rooms
                    .iter()
                    .map(|r| vec![0.; r.input.thermostats.len()])
                    .collect()
            })
            .collect(),
        means: vec![vec![0.; nodes]; SETS],
        peaks: [0.; SETS],
        mandatory_peaks: [0.; SETS],
        feasible: [true; SETS],
        prefix_cost: vec![0.; SETS * rooms],
        quarter_rates: vec![],
        quarter_noise: vec![],
    }
}
fn apply_rates(network: &mut NetworkInput, rates: &[Vec<f64>]) {
    for (node, values) in network.nodes.iter_mut().zip(rates) {
        for (edge, rate) in node.incoming.iter_mut().zip(values) {
            if edge.rates.len() == 1 && edge.rates[0].len() == 1 {
                edge.rates[0][0] = *rate;
            } else {
                edge.rates = vec![vec![*rate]];
            }
        }
    }
}
struct MinuteInnovations {
    rates: Vec<Vec<f64>>,
    noise: Vec<f64>,
}
struct InnovationAdvance {
    minute: Option<MinuteInnovations>,
    work: usize,
}
fn innovations(
    input: &Input,
    path: &mut Path,
    trajectory: usize,
    slot: usize,
    minute: usize,
    noise_cache: &mut HashMap<Vec<u64>, Vec<Vec<f64>>>,
    reset_budget: usize,
) -> Result<InnovationAdvance, String> {
    let network = &input.network;
    let steps = (network.hours[slot] * 60.).ceil() as usize;
    let dt = if steps > 0 {
        network.hours[slot] / steps as f64
    } else {
        0.
    };
    let time_index = network.hours[..slot]
        .iter()
        .map(|h| (h * 60.).ceil() as u32)
        .sum::<u32>()
        .wrapping_add(minute as u32 + 1);
    let target = network.hours[..slot].iter().sum::<f64>() + (minute as f64 + 0.5) * dt;
    let mut used = 0;
    let mut coordinate = 0;
    for (node, edges) in path.processes.iter_mut().enumerate() {
        for (edge, process) in edges.iter_mut().enumerate() {
            if coordinate >= path.rate_cursor {
                let (complete, spent) = process.advance(
                    target,
                    reset_budget - used,
                    input.seed,
                    trajectory as u32,
                    node,
                    edge,
                )?;
                used += spent;
                if !complete {
                    return Ok(InnovationAdvance {
                        minute: None,
                        work: used,
                    });
                }
                path.rate_cursor += 1;
            }
            coordinate += 1;
        }
    }
    path.rate_cursor = 0;
    let mut rates: Vec<Vec<f64>> = network
        .nodes
        .iter()
        .map(|n| vec![0.; n.incoming.len()])
        .collect();
    for (i, incoming) in path.incoming_nodes.iter().enumerate() {
        for (&from, process) in incoming.iter().zip(&path.processes[i]) {
            let rate = process.rate();
            if !rate.is_finite() || rate < 0. {
                return Err("Non-finite sampled room exchange".into());
            }
            let edge_index = network.nodes[i]
                .incoming
                .iter()
                .position(|edge| edge.node == from)
                .ok_or("Process hypothesis is outside the captured topology")?;
            rates[i][edge_index] = rate;
        }
    }
    let n = network.nodes.len();
    if input
        .beliefs
        .iter()
        .all(|node| node.thermal_noise_c2_per_h == 0.)
    {
        return Ok(InnovationAdvance {
            minute: Some(MinuteInnovations {
                rates,
                noise: vec![0.; n],
            }),
            work: used,
        });
    }
    let mut generator = vec![0.; n * n];
    for (i, node) in network.nodes.iter().enumerate() {
        generator[i * n + i] = -node.outdoor_per_h;
        for (edge, rate) in node.incoming.iter().zip(&rates[i]) {
            generator[i * n + i] -= rate;
            generator[i * n + edge.node] += rate;
        }
    }
    let diffusion: Vec<_> = input
        .beliefs
        .iter()
        .map(|b| b.thermal_noise_c2_per_h)
        .collect();
    let mut key: Vec<_> = generator
        .iter()
        .chain(&diffusion)
        .map(|v| v.to_bits())
        .collect();
    key.push(dt.to_bits());
    if !noise_cache.contains_key(&key) {
        let root = thermal_noise_root(&generator, &diffusion, dt)?;
        if noise_cache.len() * (n * n * 8 + key.len() * 8) > 1024 * 1024 {
            noise_cache.clear();
        }
        noise_cache.insert(key.clone(), root);
    }
    let root = &noise_cache[&key];
    let normals: Vec<_> = (0..n)
        .map(|j| {
            normal(
                input.seed,
                trajectory as u32,
                u32::MAX,
                time_index,
                j as u32,
            )
        })
        .collect();
    let noise = root
        .iter()
        .map(|row| row.iter().zip(&normals).map(|(a, z)| a * z).sum())
        .collect();
    Ok(InnovationAdvance {
        minute: Some(MinuteInnovations { rates, noise }),
        work: used,
    })
}
fn finish_quarter(
    input: &mut Input,
    path: &mut Path,
    sets: &[Vec<Plan>],
    mandatory: &[Plan],
    slot: usize,
    kernels: &mut ReplayKernels,
    work: &mut Work,
) -> Result<(), String> {
    let (slots, rooms, nodes, stride) = dimensions(&input.network);
    let hours = input.network.hours[slot];
    for (set, set_commands) in sets.iter().enumerate().take(SETS) {
        if path.peaks[set] > input.network.headroom_w[slot].max(path.mandatory_peaks[set]) + 1e-6 {
            path.feasible[set] = false;
        }
        for j in 0..rooms {
            let room = &input.network.rooms[j];
            let q = &room.input.quarters[slot];
            let temperature = path.states[set].temperatures[room.node];
            if q.transition.carry == 0. && temperature > q.maximum_c + 1e-9 {
                let maximum = q.maximum_c;
                let node = room.node;
                let mut commands = set_commands.clone();
                commands[j] = mandatory[j].clone();
                let mut state = path.starts[set].clone();
                for minute in 0..path.quarter_rates.len() {
                    apply_rates(&mut input.network, &path.quarter_rates[minute]);
                    project_minute(
                        &input.network,
                        &commands,
                        slot,
                        minute,
                        &mut state,
                        kernels,
                        &path.quarter_noise[minute],
                    );
                }
                if temperature > maximum.max(state.temperatures[node]) + 1e-9 {
                    path.feasible[set] = false;
                }
            }
            add_value(
                work,
                set * stride + j * slots + slot,
                path.weight * path.energy[set][j].iter().sum::<f64>(),
            );
            add_value(
                work,
                set * stride + (rooms + 2 * nodes + j) * slots + slot,
                path.weight
                    * (input.network.rooms[j].input.quarters[slot].required_c - temperature)
                        .max(0.),
            );
        }
        let mut actuator = 0;
        for energy in &path.energy[set] {
            for wh in energy {
                add_value(
                    work,
                    set * stride + (2 * rooms + 2 * nodes + actuator) * slots + slot,
                    path.weight * wh,
                );
                actuator += 1;
            }
        }
        let mut watts = 0.;
        for room in 0..rooms {
            if hours > 0. {
                watts += path.energy[set][room].iter().sum::<f64>() / hours;
            }
            let solar = watts.min(input.network.surplus_w[slot].max(0.));
            path.prefix_cost[set * rooms + room] += hours / 1000.
                * (solar * input.network.export_sek_per_kwh[slot]
                    + (watts - solar) * input.network.import_sek_per_kwh[slot]);
        }
        for node in 0..nodes {
            add_value(
                work,
                set * stride + (rooms + node) * slots + slot,
                path.weight * path.states[set].temperatures[node],
            );
            let mean = if hours > 0. {
                path.means[set][node] / hours
            } else {
                path.states[set].temperatures[node]
            };
            add_value(
                work,
                set * stride + (rooms + nodes + node) * slots + slot,
                path.weight * mean,
            );
        }
    }
    Ok(())
}
fn add_value(work: &mut Work, index: usize, value: f64) {
    work.statistics.total[index] += value;
    if work.replica.is_none() {
        let replica = (work.statistics.trajectories / 2) % work.replicate_count;
        work.statistics.replicates[replica].total[index] += value;
    }
}
fn finish_path(work: &mut Work, path: Path) {
    let rooms = path.prefix_cost.len() / SETS;
    let stride = work.statistics.total.len() / SETS;
    for set in 0..SETS {
        for room in 0..rooms {
            add_value(
                work,
                set * stride + stride - rooms + room,
                path.weight * path.prefix_cost[set * rooms + room],
            );
        }
    }
    let stats = &mut work.statistics;
    let replicate = (stats.trajectories / 2) % work.replicate_count;
    stats.replayed_paths += 1;
    if work.pending.is_none() {
        stats.trajectories += 1;
        if work.replica.is_none() {
            stats.replicates[replicate].trajectories += 1;
        }
    }
    for set in 0..SETS {
        if !path.feasible[set] {
            stats.infeasible[set] += 1;
        }
    }
}

pub fn advance(input: Input) -> Result<Advanced, String> {
    run(input, None)
}
fn run(mut input: Input, provider: Option<&ReplicaProvider>) -> Result<Advanced, String> {
    if input.beliefs.len() != input.network.nodes.len()
        || input.replicate_count == 0
        || input.max_minute_steps == 0
    {
        return Err("Invalid joint forecast work request".into());
    }
    let (_, _, _, stride) = dimensions(&input.network);
    let deterministic = provider.map_or_else(
        || deterministic(&input.beliefs),
        |p| p.headers.iter().all(|h| h.deterministic),
    );
    let mut work = input.work.take().unwrap_or_else(|| Work {
        revision: REVISION.into(),
        identity: input.identity.clone(),
        seed: input.seed,
        replicate_count: input.replicate_count,
        replica: provider.map(|p| p.replica),
        cursor: 0,
        slot: 0,
        minute: 0,
        deterministic,
        path: None,
        pending: None,
        statistics: Statistics {
            trajectories: 0,
            replayed_paths: 0,
            total: vec![0.; SETS * stride],
            replicates: (0..if provider.is_some() {
                0
            } else {
                input.replicate_count
            })
                .map(|_| Replicate {
                    trajectories: 0,
                    total: vec![0.; SETS * stride],
                })
                .collect(),
            infeasible: [0; SETS],
        },
    });
    if work.revision != REVISION
        || work.identity != input.identity
        || work.seed != input.seed
        || work.replicate_count != input.replicate_count
        || work.replica != provider.map(|p| p.replica)
        || work.deterministic != deterministic
        || work.statistics.total.len() != SETS * stride
    {
        return Err("Joint forecast continuation does not match its frozen input".into());
    }
    let target = if deterministic {
        1
    } else {
        input.target_trajectories
    };
    let proposal = input
        .network
        .accepted
        .clone()
        .ok_or("Joint forecast needs completed ordered commands")?;
    let literal = input
        .network
        .rooms
        .iter()
        .map(|r| commands(&r.input, true))
        .collect();
    let mandatory: Vec<_> = input
        .network
        .rooms
        .iter()
        .map(|r| commands(&r.input, false))
        .collect();
    let sets = vec![proposal, literal, mandatory.clone()];
    // Fixed command sets often coincide for a quarter (and the feasible seed
    // always equals its mandatory counterfactual). Share only exactly identical
    // commands and physical states; uncertainty and thermostat latches remain
    // common and no independently different policy result is approximated.
    let command_groups: Vec<Vec<usize>> = (0..input.network.hours.len())
        .map(|slot| {
            (0..SETS)
                .map(|set| {
                    (0..set)
                        .find(|&previous| {
                            sets[set]
                                .iter()
                                .zip(&sets[previous])
                                .all(|(a, b)| a.targets_c[slot] == b.targets_c[slot])
                        })
                        .unwrap_or(set)
                })
                .collect()
        })
        .collect();
    let mut kernels = ReplayKernels::default();
    let mut noise_cache = HashMap::new();
    let mut steps = 0;
    let mut spent = 0usize;
    while work.statistics.trajectories < target && spent < input.max_minute_steps {
        if work.path.is_none() {
            let trajectory = global_draw(work.replica, work.statistics.trajectories)?;
            if let Some(provider) = provider {
                let Some(beliefs) = provider.selected(input.seed, trajectory)? else {
                    break;
                };
                input.beliefs = beliefs;
            }
            let (path, pending) = start_path(&input, trajectory)?;
            work.path = Some(path);
            work.pending = pending;
        }
        let mut path = work.path.take().unwrap();
        let slot = work.slot;
        let quarter_steps = (input.network.hours[slot] * 60.).ceil() as usize;
        if quarter_steps > 0 {
            let InnovationAdvance {
                minute: prepared,
                work: reset_work,
            } = innovations(
                &input,
                &mut path,
                global_draw(work.replica, work.statistics.trajectories)?,
                slot,
                work.minute,
                &mut noise_cache,
                input.max_minute_steps - spent,
            )?;
            spent += reset_work;
            steps += reset_work;
            let Some(MinuteInnovations { rates, noise }) = prepared else {
                work.path = Some(path);
                break;
            };
            let dt = input.network.hours[slot] / quarter_steps as f64;
            let thermal_norm = input
                .network
                .nodes
                .iter()
                .zip(&rates)
                .map(|(node, rates)| node.outdoor_per_h + 2. * rates.iter().sum::<f64>())
                .fold(0., f64::max);
            let stiffness = input
                .network
                .nodes
                .iter()
                .zip(&rates)
                .map(|(node, rates)| {
                    (node.outdoor_per_h + rates.iter().sum::<f64>()).max(
                        if node.lag_h > 0.
                            && !use_fast_memory_transform(node.lag_h, dt, thermal_norm)
                        {
                            1. / node.lag_h
                        } else {
                            0.
                        },
                    )
                })
                .fold(0., f64::max)
                * dt;
            if !stiffness.is_finite() {
                return Err("Non-finite sampled thermal generator".into());
            }
            // Ordinary sparse uniformization grows with its Poisson order.
            // The stiff branch instead builds a dense scaled exponential over
            // temperatures and lag stores. Account for its cubic matrix work
            // and logarithmic squaring count, rather than clipping rates or
            // forcing cheap sparse minutes through the same tiny batch.
            let minute_work = if stiffness <= 16. {
                1 + stiffness.floor() as usize
            } else {
                let dimension = input.network.nodes.len()
                    + input
                        .network
                        .nodes
                        .iter()
                        .filter(|node| {
                            node.lag_h > 0.
                                && !use_fast_memory_transform(node.lag_h, dt, thermal_norm)
                        })
                        .count();
                let dimension_ratio = dimension as f64 / input.network.nodes.len() as f64;
                (6. * dimension_ratio.powi(3) * (1. + (stiffness / 16.).log2().ceil())).ceil()
                    as usize
            };
            spent = spent.saturating_add(minute_work);
            apply_rates(&mut input.network, &rates);
            path.quarter_rates.push(rates);
            path.quarter_noise.push(noise.clone());
            let mut minute_cache: Vec<(usize, NetworkState, NetworkState, MinuteOutput)> =
                Vec::new();
            let mut shared_step = |set: usize, state: &mut NetworkState| {
                let group = command_groups[slot][set];
                if let Some((_, _, after, result)) = minute_cache
                    .iter()
                    .find(|(key, before, _, _)| *key == group && before == state)
                {
                    *state = after.clone();
                    return result.clone();
                }
                let before = state.clone();
                let result = project_minute(
                    &input.network,
                    &sets[set],
                    slot,
                    work.minute,
                    state,
                    &mut kernels,
                    &noise,
                );
                minute_cache.push((group, before, state.clone(), result.clone()));
                result
            };
            for set in 0..SETS {
                let result = shared_step(set, &mut path.states[set]);
                for (sum, energy) in path.energy[set].iter_mut().flatten().zip(result.energy) {
                    *sum += energy;
                }
                for (sum, value) in path.means[set].iter_mut().zip(result.mean_integral) {
                    *sum += value;
                }
                path.peaks[set] = path.peaks[set].max(result.peak);
                let reference = shared_step(SETS - 1, &mut path.mandatory[set]);
                path.mandatory_peaks[set] = path.mandatory_peaks[set].max(reference.peak);
            }
        }
        if quarter_steps == 0 {
            spent += 1;
        }
        work.minute += 1;
        steps += 1;
        if work.minute >= quarter_steps {
            finish_quarter(
                &mut input,
                &mut path,
                &sets,
                &mandatory,
                slot,
                &mut kernels,
                &mut work,
            )?;
            work.slot += 1;
            work.minute = 0;
            if work.slot == input.network.hours.len() {
                finish_path(&mut work, path);
                work.slot = 0;
                if let Some(pending) = work.pending.take() {
                    work.path = Some(path_from_initial(&input, pending));
                }
            } else {
                path.starts = path.states.clone();
                path.mandatory = path.states.clone();
                for set in 0..SETS {
                    for energy in &mut path.energy[set] {
                        energy.fill(0.);
                    }
                    path.means[set].fill(0.);
                }
                path.peaks = [0.; SETS];
                path.mandatory_peaks = [0.; SETS];
                path.quarter_rates.clear();
                path.quarter_noise.clear();
                work.path = Some(path);
            }
        } else {
            work.path = Some(path);
        }
    }
    work.cursor += steps;
    let assessment = assessment(&input.network, &work);
    let statistics =
        (work.statistics.trajectories >= target).then(|| NumericStatistics::from(&work.statistics));
    Ok(Advanced {
        reached_target: work.statistics.trajectories >= target,
        work,
        assessment,
        statistics,
    })
}
/// Expected positive-part shortfall is accumulated before this comparator.
/// Every ordered room prefix must qualify; a later room cannot buy earlier loss.
pub fn choose(network: &NetworkInput, work: &Work) -> Result<Output, String> {
    let (slots, rooms, nodes, stride) = dimensions(network);
    let count = work.statistics.trajectories as f64;
    if count == 0. || work.path.is_some() || work.pending.is_some() {
        return Err("Joint forecast has no complete numerical result".into());
    }
    let means: Vec<_> = work.statistics.total.iter().map(|v| v / count).collect();
    let mut dominates = true;
    for room in 0..rooms {
        if horizon_shortfall_difference(&means, network, room) > 1e-8 {
            dominates = false;
        }
    }

    for end in 0..rooms {
        let cost = [means[stride - rooms + end], means[2 * stride - rooms + end]];
        let mut shortfall = [0.; 2];
        let mut improved = false;
        let mut new_miss = false;
        for slot in 0..slots {
            for room in 0..=end {
                let a = means[(rooms + 2 * nodes + room) * slots + slot];
                let b = means[stride + (rooms + 2 * nodes + room) * slots + slot];
                shortfall[0] += a * network.hours[slot];
                shortfall[1] += b * network.hours[slot];
                // Deadline status is based on expected positive-part shortfall.
                let flags = deadline_flags(a, b);
                new_miss |= flags.0;
                improved |= flags.1;
            }
        }
        if shortfall[0] > shortfall[1] + 1e-8
            || (cost[0] > cost[1] + 1e-8 && (new_miss || !improved))
        {
            dominates = false;
        }
    }
    let selected =
        if work.statistics.infeasible[0] == 0 && (work.statistics.infeasible[1] > 0 || dominates) {
            0
        } else if work.statistics.infeasible[1] == 0 {
            1
        } else if work.statistics.infeasible[2] == 0 {
            2
        } else {
            return Err(
                "Joint room feasible incumbent is inconsistent with its mandatory counterfactual"
                    .into(),
            );
        };
    let commands = network
        .accepted
        .clone()
        .ok_or("Missing ordered room commands")?;
    let literal: Vec<_> = network
        .rooms
        .iter()
        .map(|r| commands_for_literal(&r.input))
        .collect();
    let materialize = |set: usize, mut plans: Vec<Plan>| {
        let mut actuator_offset = 0;
        for (i, plan) in plans.iter_mut().enumerate() {
            plan.power_w = (0..slots)
                .map(|q| {
                    if network.hours[q] > 0. {
                        means[set * stride + i * slots + q] / network.hours[q]
                    } else {
                        0.
                    }
                })
                .collect();
            let actuator_count = network.rooms[i].input.thermostats.len();
            plan.thermostat_w = (0..slots)
                .map(|q| {
                    (0..actuator_count)
                        .map(|j| {
                            if network.hours[q] > 0. {
                                means[set * stride
                                    + (2 * rooms + 2 * nodes + actuator_offset + j) * slots
                                    + q]
                                    / network.hours[q]
                            } else {
                                0.
                            }
                        })
                        .collect()
                })
                .collect();
            actuator_offset += actuator_count;
            plan.temperature_c = (0..slots)
                .map(|q| means[set * stride + (rooms + network.rooms[i].node) * slots + q])
                .collect();
            plan.shortfall_c = (0..slots)
                .map(|q| means[set * stride + (rooms + 2 * nodes + i) * slots + q])
                .collect();
        }
        plans
    };
    let plans = materialize(
        selected,
        if selected == 0 {
            commands
        } else if selected == 1 {
            literal.clone()
        } else {
            network
                .rooms
                .iter()
                .map(|r| commands_for_minimum(&r.input))
                .collect()
        },
    );
    let temperatures = (0..nodes)
        .map(|node| {
            (0..slots)
                .map(|q| means[selected * stride + (rooms + node) * slots + q])
                .collect()
        })
        .collect();
    let mean_temperature = (0..nodes)
        .map(|node| {
            (0..slots)
                .map(|q| means[selected * stride + (rooms + nodes + node) * slots + q])
                .collect()
        })
        .collect();
    Ok(Output {
        plans,
        temperature_c: temperatures,
        mean_temperature_c: mean_temperature,
        literal: materialize(1, literal),
    })
}
fn commands_for_literal(input: &crate::room_heating::Input) -> Plan {
    commands(input, true)
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Outcome {
    Advanced { result: Box<Advanced> },
    Failed { issue: String },
}
pub fn advance_json(bytes: &[u8]) -> Vec<u8> {
    let result = serde_json::from_slice::<Input>(bytes)
        .map_err(|e| format!("Invalid joint room forecast input: {e}"))
        .and_then(advance);
    serde_json::to_vec(&match result {
        Ok(result) => Outcome::Advanced {
            result: Box::new(result),
        },
        Err(issue) => Outcome::Failed { issue },
    })
    .expect("finite joint room forecast work")
}
#[derive(Deserialize)]
struct FinalizeInput {
    network: NetworkInput,
    work: Work,
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Finalized {
    Planned { plan: Output },
    Failed { issue: String },
}
pub fn finalize_json(bytes: &[u8]) -> Vec<u8> {
    let result = serde_json::from_slice::<FinalizeInput>(bytes)
        .map_err(|e| format!("Invalid joint forecast result: {e}"))
        .and_then(|input| choose(&input.network, &input.work));
    serde_json::to_vec(&match result {
        Ok(plan) => Finalized::Planned { plan },
        Err(issue) => Finalized::Failed { issue },
    })
    .expect("finite joint forecast result")
}

fn commands_for_minimum(input: &crate::room_heating::Input) -> Plan {
    commands(input, false)
}

/// Compact immutable probability directory. Native arithmetic owns the CDF so
/// indexed catalog reads select exactly the same component as direct replay.
#[derive(Clone, Deserialize, Serialize)]
pub struct NodeHeader {
    cdf: Vec<f64>,
    weight_sum: f64,
    count: usize,
    deterministic: bool,
    thermal_noise_c2_per_h: f64,
    bounded_thermal: bool,
    reset_priors: Vec<ResetPrior>,
}
#[derive(Deserialize)]
struct SelectedHypothesis {
    node: usize,
    index: usize,
    json: String,
}
struct ReplicaProvider {
    headers: Vec<NodeHeader>,
    replica: usize,
    selected: HashMap<(usize, usize), Hypothesis>,
}
fn global_draw(replica: Option<usize>, local: usize) -> Result<usize, String> {
    let draw = match replica {
        Some(r) => (local / 2)
            .checked_mul(8)
            .and_then(|x| x.checked_add(2 * r + local % 2)),
        None => Some(local),
    };
    draw.filter(|&n| n <= u32::MAX as usize)
        .ok_or_else(|| "Forecast random address exhausted".into())
}
fn validate_hypothesis(h: &Hypothesis) -> Result<(), String> {
    if !h.log_weight.is_finite() || !h.posterior.temperature_c.is_finite() {
        return Err("Invalid process hypothesis".into());
    }
    let count = h
        .incoming
        .iter()
        .filter(|e| matches!(e, Dynamics::LogOu { .. }))
        .count();
    if count != h.posterior.log_rates.len()
        || h.posterior
            .log_centers
            .as_ref()
            .is_some_and(|x| x.len() != count)
        || h.posterior
            .log_rates
            .iter()
            .chain(h.posterior.log_centers.iter().flatten())
            .any(|x| !x.is_finite())
        || h.posterior.covariance.len()
            != 2 + count + h.posterior.log_centers.as_ref().map_or(0, Vec::len)
        || h.hazards
            .as_ref()
            .is_some_and(|x| x.len() != h.incoming.len())
    {
        return Err("Invalid process posterior coordinates".into());
    }
    covariance_root(&h.posterior.covariance)?;
    for (i, edge) in h.incoming.iter().enumerate() {
        let valid = match edge {
            Dynamics::Constant { per_h, .. } => per_h.is_finite() && *per_h >= 0.,
            Dynamics::LogOu {
                mean_log_per_h,
                reversion_per_h,
                stationary_variance,
                ..
            } => {
                mean_log_per_h.is_finite()
                    && reversion_per_h.is_finite()
                    && *reversion_per_h >= 0.
                    && stationary_variance.is_finite()
                    && *stationary_variance >= 0.
            }
        };
        if !valid {
            return Err("Invalid process dynamics".into());
        }
        let value = match edge {
            Dynamics::Constant { per_h, .. } => Value::Constant { per_h: *per_h },
            Dynamics::LogOu {
                mean_log_per_h,
                reversion_per_h,
                stationary_variance,
                ..
            } => Value::Ou {
                log: *mean_log_per_h,
                center: *mean_log_per_h,
                reversion: *reversion_per_h,
                variance: *stationary_variance,
            },
        };
        Process::new(value, None, h.hazards.as_ref().map(|v| &v[i]))?;
    }
    Ok(())
}
fn node_header(belief: NodeBelief) -> Result<NodeHeader, String> {
    if !belief.thermal_noise_c2_per_h.is_finite() || belief.thermal_noise_c2_per_h < 0. {
        return Err("Invalid thermal noise".into());
    }
    for h in &belief.hypotheses {
        validate_hypothesis(h)?;
        for prior in belief.reset_priors.iter().flatten() {
            let index = h
                .incoming
                .iter()
                .position(|edge| match edge {
                    Dynamics::Constant { from, .. } | Dynamics::LogOu { from, .. } => {
                        *from == prior.from
                    }
                })
                .ok_or("Reset prior is outside incoming topology")?;
            Process::new(
                Value::Constant { per_h: 0. },
                Some(prior.clone()),
                h.hazards.as_ref().map(|hazards| &hazards[index]),
            )?;
        }
    }
    let high = belief
        .hypotheses
        .iter()
        .map(|h| h.log_weight)
        .fold(f64::NEG_INFINITY, f64::max);
    let mut weight_sum = 0.;
    let cdf = belief
        .hypotheses
        .iter()
        .map(|h| {
            weight_sum += (h.log_weight - high).exp();
            weight_sum
        })
        .collect();
    Ok(NodeHeader {
        cdf,
        weight_sum,
        count: belief.hypotheses.len(),
        deterministic: deterministic(std::slice::from_ref(&belief)),
        thermal_noise_c2_per_h: belief.thermal_noise_c2_per_h,
        bounded_thermal: belief.bounded_thermal,
        reset_priors: belief.reset_priors.unwrap_or_default(),
    })
}
impl NodeHeader {
    fn index(&self, seed: [u32; 2], draw: usize, node: usize) -> Result<Option<usize>, String> {
        if self.cdf.len() != self.count
            || !self.weight_sum.is_finite()
            || self.cdf.iter().any(|v| !v.is_finite() || *v < 0.)
            || self.cdf.windows(2).any(|v| v[0] > v[1])
            || (self.count > 0
                && (self.weight_sum <= 0. || self.cdf.last() != Some(&self.weight_sum)))
            || (self.count == 0 && self.weight_sum != 0.)
        {
            return Err("Invalid native hypothesis directory".into());
        }
        if self.count == 0 {
            return Ok(None);
        }
        let point = uniform(seed, draw as u32, node as u32, 0, u32::MAX) * self.weight_sum;
        Ok(Some(
            self.cdf.partition_point(|&v| v < point).min(self.count - 1),
        ))
    }
    fn empty_belief(&self) -> NodeBelief {
        NodeBelief {
            hypotheses: vec![],
            thermal_noise_c2_per_h: self.thermal_noise_c2_per_h,
            bounded_thermal: self.bounded_thermal,
            reset_priors: Some(self.reset_priors.clone()),
        }
    }
}
impl ReplicaProvider {
    fn selected(&self, seed: [u32; 2], draw: usize) -> Result<Option<Vec<NodeBelief>>, String> {
        let mut beliefs = Vec::with_capacity(self.headers.len());
        for (node, header) in self.headers.iter().enumerate() {
            let mut belief = header.empty_belief();
            if let Some(index) = header.index(seed, draw, node)? {
                let Some(h) = self.selected.get(&(node, index)) else {
                    return Ok(None);
                };
                belief.hypotheses.push(h.clone());
            }
            beliefs.push(belief);
        }
        Ok(Some(beliefs))
    }
}
#[derive(Deserialize)]
struct HeaderInput {
    belief: NodeBelief,
}
#[derive(Deserialize)]
struct SelectInput {
    node_headers: Vec<NodeHeader>,
    seed: [u32; 2],
    replica: usize,
    local_draws: Vec<usize>,
}
#[derive(Serialize)]
struct DrawSelection {
    local_draw: usize,
    global_draw: usize,
    hypothesis_indexes: Vec<Option<usize>>,
}
fn select(input: SelectInput) -> Result<Vec<DrawSelection>, String> {
    if input.replica >= 4 {
        return Err("Invalid forecast replica".into());
    }
    input
        .local_draws
        .into_iter()
        .map(|local_draw| {
            let global_draw = global_draw(Some(input.replica), local_draw)?;
            let hypothesis_indexes = input
                .node_headers
                .iter()
                .enumerate()
                .map(|(i, h)| h.index(input.seed, global_draw, i))
                .collect::<Result<_, _>>()?;
            Ok(DrawSelection {
                local_draw,
                global_draw,
                hypothesis_indexes,
            })
        })
        .collect()
}
#[derive(Deserialize, Serialize)]
struct ReplicaStatistics {
    trajectories: usize,
    replayed_paths: usize,
    #[serde(with = "crate::packed_f64")]
    total: Vec<f64>,
    infeasible: [usize; SETS],
}
#[derive(Deserialize, Serialize)]
struct ReplicaWork {
    revision: String,
    identity: String,
    seed: [u32; 2],
    replica: usize,
    cursor: usize,
    slot: usize,
    minute: usize,
    deterministic: bool,
    statistics: ReplicaStatistics,
    path: Option<Path>,
    pending: Option<InitialTrajectory>,
}
impl ReplicaWork {
    fn into_work(self) -> Work {
        Work {
            revision: self.revision,
            identity: self.identity,
            seed: self.seed,
            replicate_count: 4,
            replica: Some(self.replica),
            cursor: self.cursor,
            slot: self.slot,
            minute: self.minute,
            deterministic: self.deterministic,
            path: self.path,
            pending: self.pending,
            statistics: Statistics {
                trajectories: self.statistics.trajectories,
                replayed_paths: self.statistics.replayed_paths,
                total: self.statistics.total,
                infeasible: self.statistics.infeasible,
                replicates: vec![],
            },
        }
    }
    fn from_work(work: Work) -> Self {
        Self {
            revision: work.revision,
            identity: work.identity,
            seed: work.seed,
            replica: work.replica.expect("replica-owned work"),
            cursor: work.cursor,
            slot: work.slot,
            minute: work.minute,
            deterministic: work.deterministic,
            path: work.path,
            pending: work.pending,
            statistics: ReplicaStatistics {
                trajectories: work.statistics.trajectories,
                replayed_paths: work.statistics.replayed_paths,
                total: work.statistics.total,
                infeasible: work.statistics.infeasible,
            },
        }
    }
}
#[derive(Deserialize)]
struct ReplicaInput {
    network: NetworkInput,
    node_headers: Vec<NodeHeader>,
    seed: [u32; 2],
    identity: String,
    replica: usize,
    target_local_draws: usize,
    max_work: usize,
    work: Option<ReplicaWork>,
    selected_hypotheses: Vec<SelectedHypothesis>,
}
#[derive(Serialize)]
struct ReplicaAdvanced {
    work: ReplicaWork,
    reached_target: bool,
    needs_global_draw: Option<usize>,
}
fn replica_advance(input: ReplicaInput) -> Result<ReplicaAdvanced, String> {
    if input.replica >= 4
        || input.node_headers.len() != input.network.nodes.len()
        || input.target_local_draws == 0
    {
        return Err("Invalid replica request".into());
    }
    if input.node_headers.iter().all(|h| h.deterministic) && input.replica != 0 {
        return Err("Deterministic forecast belongs to replica zero".into());
    }
    let mut selected = HashMap::new();
    for record in input.selected_hypotheses {
        if record.node >= input.node_headers.len()
            || record.index >= input.node_headers[record.node].count
        {
            return Err("Selected hypothesis is outside catalog".into());
        }
        let hypothesis: Hypothesis = serde_json::from_str(&record.json)
            .map_err(|e| format!("Invalid selected hypothesis: {e}"))?;
        validate_hypothesis(&hypothesis)?;
        if selected
            .insert((record.node, record.index), hypothesis)
            .is_some()
        {
            return Err("Duplicate selected hypothesis record".into());
        }
    }
    let provider = ReplicaProvider {
        headers: input.node_headers,
        replica: input.replica,
        selected,
    };
    let result = run(
        Input {
            network: input.network,
            beliefs: provider
                .headers
                .iter()
                .map(NodeHeader::empty_belief)
                .collect(),
            seed: input.seed,
            identity: input.identity,
            replicate_count: 4,
            target_trajectories: input.target_local_draws,
            max_minute_steps: input.max_work,
            work: input.work.map(ReplicaWork::into_work),
        },
        Some(&provider),
    )?;
    let next = global_draw(Some(input.replica), result.work.statistics.trajectories)?;
    let needs_global_draw = if !result.reached_target
        && result.work.path.is_none()
        && provider.selected(input.seed, next)?.is_none()
    {
        Some(next)
    } else {
        None
    };
    Ok(ReplicaAdvanced {
        work: ReplicaWork::from_work(result.work),
        reached_target: result.reached_target,
        needs_global_draw,
    })
}
#[derive(Deserialize)]
struct MergeInput {
    network: NetworkInput,
    identity: String,
    seed: [u32; 2],
    replicas: Vec<ReplicaWork>,
}
#[derive(Serialize)]
struct Merged {
    work: Work,
    statistics: NumericStatistics,
    assessment: Assessment,
}
fn merge(mut input: MergeInput) -> Result<Merged, String> {
    input.replicas.sort_by_key(|w| w.replica);
    let first = input.replicas.first().ok_or("Missing forecast replicas")?;
    let deterministic = first.deterministic;
    if input.replicas.len() != if deterministic { 1 } else { 4 } {
        return Err("Incomplete forecast barrier".into());
    }
    let count = first.statistics.trajectories;
    let (_, _, _, stride) = dimensions(&input.network);
    if count == 0 || (deterministic && count != 1) || (!deterministic && count % 2 != 0) {
        return Err("Unbalanced forecast barrier".into());
    }
    let mut stats = Statistics {
        trajectories: 0,
        replayed_paths: 0,
        total: vec![0.; SETS * stride],
        replicates: vec![],
        infeasible: [0; SETS],
    };
    let mut cursor = 0;
    for (replica, w) in input.replicas.into_iter().enumerate() {
        if w.replica != replica
            || w.revision != REVISION
            || w.identity != input.identity
            || w.seed != input.seed
            || w.deterministic != deterministic
            || w.statistics.trajectories != count
            || w.path.is_some()
            || w.pending.is_some()
            || w.slot != 0
            || w.minute != 0
            || w.statistics.total.len() != stats.total.len()
        {
            return Err("Forecast barrier identity or completion mismatch".into());
        }
        cursor += w.cursor;
        stats.trajectories += w.statistics.trajectories;
        stats.replayed_paths += w.statistics.replayed_paths;
        for (a, b) in stats.total.iter_mut().zip(&w.statistics.total) {
            *a += b;
        }
        for (a, b) in stats.infeasible.iter_mut().zip(w.statistics.infeasible) {
            *a += b;
        }
        stats.replicates.push(Replicate {
            trajectories: count,
            total: w.statistics.total,
        });
    }
    // The frozen integration identity always has four replica slots. Exact
    // deterministic physics evaluates only slot zero; unused slots are zero.
    if deterministic {
        for _ in 1..4 {
            stats.replicates.push(Replicate {
                trajectories: 0,
                total: vec![0.; SETS * stride],
            });
        }
    }
    let work = Work {
        revision: REVISION.into(),
        identity: input.identity,
        seed: input.seed,
        replicate_count: 4,
        replica: None,
        cursor,
        slot: 0,
        minute: 0,
        statistics: stats,
        deterministic,
        path: None,
        pending: None,
    };
    Ok(Merged {
        statistics: NumericStatistics::from(&work.statistics),
        assessment: assessment(&input.network, &work),
        work,
    })
}
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ApiResult<T: Serialize> {
    Ready { result: T },
    Failed { issue: String },
}
fn api<I: serde::de::DeserializeOwned, O: Serialize>(
    bytes: &[u8],
    f: impl FnOnce(I) -> Result<O, String>,
) -> Vec<u8> {
    let result = serde_json::from_slice(bytes)
        .map_err(|e| format!("Invalid replica API input: {e}"))
        .and_then(f);
    serde_json::to_vec(&match result {
        Ok(result) => ApiResult::Ready { result },
        Err(issue) => ApiResult::Failed { issue },
    })
    .expect("finite replica API output")
}
pub fn header_json(bytes: &[u8]) -> Vec<u8> {
    api(bytes, |i: HeaderInput| node_header(i.belief))
}
pub fn select_json(bytes: &[u8]) -> Vec<u8> {
    api(bytes, select)
}
pub fn replica_json(bytes: &[u8]) -> Vec<u8> {
    api(bytes, replica_advance)
}
pub fn merge_json(bytes: &[u8]) -> Vec<u8> {
    api(bytes, merge)
}

#[cfg(test)]
mod deadline_certificate_tests {
    use super::{deadline_certificate, deadline_flags, ShortfallEstimate};

    fn estimate(mean_c: f64, twice_standard_error_c: f64) -> ShortfallEstimate {
        ShortfallEstimate {
            mean_c,
            twice_standard_error_c,
        }
    }

    #[test]
    fn identical_common_shortfall_does_not_create_deadline_changes() {
        let shared = estimate(1e-6, 2e-6);
        let exact_pair = deadline_certificate(shared, shared, 0.);
        assert!(!exact_pair.new_certain && !exact_pair.new_possible);
        assert!(!exact_pair.improved_certain && !exact_pair.improved_possible);
        // Equal point estimates alone do not establish paired equality.
        let uncertain_pair = deadline_certificate(shared, shared, 1e-6);
        assert!(uncertain_pair.new_possible && uncertain_pair.improved_possible);
    }

    #[test]
    fn unequal_threshold_crossings_keep_the_original_strict_predicates() {
        let high = estimate(1.25e-6, 0.1e-6);
        let low = estimate(0.75e-6, 0.1e-6);
        let worse = deadline_certificate(high, low, 0.1e-6);
        assert!(worse.new_certain && worse.new_possible);
        assert!(!worse.improved_certain && !worse.improved_possible);
        let better = deadline_certificate(low, high, 0.1e-6);
        assert!(better.improved_certain && better.improved_possible);
        assert!(!better.new_certain && !better.new_possible);
        let ambiguous =
            deadline_certificate(estimate(1.1e-6, 0.4e-6), estimate(0.9e-6, 0.4e-6), 0.6e-6);
        assert!(!ambiguous.new_certain && !ambiguous.improved_certain);
        assert!(ambiguous.new_possible && ambiguous.improved_possible);
        let at = estimate(1e-6, 0.);
        let above = estimate(1.25e-6, 0.);
        let below = estimate(0.75e-6, 0.);
        assert!(deadline_certificate(above, at, 0.).new_certain);
        assert!(deadline_certificate(at, above, 0.).improved_certain);
        let both_met = deadline_certificate(at, below, 0.);
        assert!(!both_met.new_possible && !both_met.improved_possible);
    }

    #[test]
    fn paired_intersection_retains_every_admissible_deadline_outcome() {
        // An independent finite grid checks interval logic on both sides of
        // the exact deadline, including equality and zero-width paired bounds.
        let points = [0., 0.5e-6, 1e-6, 1.5e-6, 2e-6];
        let errors = [0., 0.5e-6, 2e-6];
        for a in points {
            for b in points {
                for ae in errors {
                    for be in errors {
                        for de in errors {
                            let certificate =
                                deadline_certificate(estimate(a, ae), estimate(b, be), de);
                            for actual_a in points {
                                for actual_b in points {
                                    if actual_a < a - ae
                                        || actual_a > a + ae
                                        || actual_b < b - be
                                        || actual_b > b + be
                                        || actual_a - actual_b < a - b - de
                                        || actual_a - actual_b > a - b + de
                                    {
                                        continue;
                                    }
                                    let (new_miss, improved) = deadline_flags(actual_a, actual_b);
                                    assert!(!new_miss || certificate.new_possible);
                                    assert!(!improved || certificate.improved_possible);
                                    assert!(!certificate.new_certain || new_miss);
                                    assert!(!certificate.improved_certain || improved);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
