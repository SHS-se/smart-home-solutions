//! Conditional receiving-process trajectories. No controls or comfort policy.
use crate::room_uncertainty::{normal, uniform};
use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize)]
pub struct ResetPrior {
    pub from: usize,
    pub center_mean: f64,
    pub center_variance: f64,
    pub log_reversion_mean: f64,
    pub log_reversion_sd: f64,
    pub stationary_variance_scale: f64,
    pub constant_probability: f64,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Hazard {
    pub shape: f64,
    pub rate_h: f64,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Value {
    Constant {
        per_h: f64,
    },
    Ou {
        log: f64,
        center: f64,
        reversion: f64,
        variance: f64,
    },
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Process {
    pub value: Value,
    pub hazard_per_h: f64,
    pub hazard: Option<Hazard>,
    pub prior: Option<ResetPrior>,
    pub through_h: f64,
    pub next_reset_h: Option<f64>,
    pub resets: u32,
    pub innovations: u32,
}

fn gamma_unit(shape: f64, seed: [u32; 2], draw: u32, node: u32, edge: u32) -> f64 {
    // Marsaglia–Tsang, with the exact small-shape transformation. Rejection
    // draws have their own addresses, independent of the execution partition.
    let boosted = if shape < 1. { shape + 1. } else { shape };
    let d = boosted - 1. / 3.;
    let c = (9. * d).sqrt().recip();
    let mut attempt = 0;
    let value = loop {
        let x = normal(seed, draw, 0x4000_0000 + node, edge, attempt * 2);
        let v = 1. + c * x;
        let u = uniform(seed, draw, 0x4100_0000 + node, edge, attempt);
        attempt += 1;
        if v <= 0. {
            continue;
        }
        let cube = v * v * v;
        if u < 1. - 0.0331 * x.powi(4) || u.ln() < 0.5 * x * x + d * (1. - cube + cube.ln()) {
            break d * cube;
        }
    };
    if shape < 1. {
        value * uniform(seed, draw, 0x4200_0000 + node, edge, 0).powf(1. / shape)
    } else {
        value
    }
}

impl Process {
    pub fn new(
        value: Value,
        prior: Option<ResetPrior>,
        hazard: Option<&Hazard>,
    ) -> Result<Self, String> {
        let hazard = if let Some(p) = &prior {
            if !p.center_mean.is_finite()
                || !p.log_reversion_mean.is_finite()
                || [
                    p.center_variance,
                    p.log_reversion_sd,
                    p.stationary_variance_scale,
                ]
                .iter()
                .any(|x| !x.is_finite() || *x < 0.)
                || !(0. ..=1.).contains(&p.constant_probability)
            {
                return Err("Invalid frozen room reset prior".into());
            }
            let h = hazard.ok_or("Missing identified-edge reset hazard")?;
            if !h.shape.is_finite() || h.shape <= 0. || !h.rate_h.is_finite() || h.rate_h <= 0. {
                return Err("Invalid room reset hazard".into());
            }
            Some(h.clone())
        } else {
            None
        };
        Ok(Self {
            value,
            prior,
            hazard_per_h: 0.,
            hazard,
            through_h: 0.,
            next_reset_h: None,
            resets: 0,
            innovations: 0,
        })
    }
    fn next_after(
        &self,
        at: f64,
        seed: [u32; 2],
        draw: u32,
        node: usize,
        edge: usize,
    ) -> Option<f64> {
        (self.hazard_per_h > 0.).then(|| {
            at - uniform(
                seed,
                draw,
                0x6100_0000 + node as u32,
                self.resets,
                edge as u32,
            )
            .ln()
                / self.hazard_per_h
        })
    }
    fn propagate(&mut self, to: f64, seed: [u32; 2], draw: u32, node: usize, edge: usize) {
        let hours = to - self.through_h;
        if hours > 0. {
            if let Value::Ou {
                log,
                center,
                reversion,
                variance,
            } = &mut self.value
            {
                let decay = (-*reversion * hours).exp();
                let sd = (*variance * -(-2. * *reversion * hours).exp_m1()).sqrt();
                *log = *center
                    + decay * (*log - *center)
                    + sd * normal(
                        seed,
                        draw,
                        0x1000_0000 + node as u32,
                        self.innovations,
                        edge as u32,
                    );
            }
            self.innovations += 1;
            self.through_h = to;
        }
    }
    /// Returns (complete, reset work used). A high but valid reset intensity
    /// advances through durable work boundaries instead of blocking a worker.
    pub fn advance(
        &mut self,
        to: f64,
        budget: usize,
        seed: [u32; 2],
        draw: u32,
        node: usize,
        edge: usize,
    ) -> Result<(bool, usize), String> {
        let mut used = 0;
        while self.next_reset_h.is_some_and(|at| at <= to) {
            if used == budget {
                return Ok((false, used));
            }
            let at = self.next_reset_h.unwrap();
            self.propagate(at, seed, draw, node, edge);
            let prior = self.prior.as_ref().ok_or("Reset has no frozen prior")?;
            let base = (edge as u32) * 4;
            let center = prior.center_mean
                + prior.center_variance.sqrt()
                    * normal(seed, draw, 0x5000_0000 + node as u32, self.resets, base);
            let constant = uniform(
                seed,
                draw,
                0x5100_0000 + node as u32,
                self.resets,
                edge as u32,
            ) < prior.constant_probability;
            let reversion = if constant {
                0.
            } else {
                (prior.log_reversion_mean
                    + prior.log_reversion_sd
                        * normal(seed, draw, 0x5000_0000 + node as u32, self.resets, base + 1))
                .exp()
            };
            let variance = if constant {
                0.
            } else {
                prior.stationary_variance_scale
                    * normal(seed, draw, 0x5000_0000 + node as u32, self.resets, base + 2).abs()
            };
            if !center.is_finite() || !reversion.is_finite() || !variance.is_finite() {
                return Err("Non-finite sampled room regime".into());
            }
            self.value = Value::Ou {
                log: center,
                center,
                reversion,
                variance,
            };
            self.resets += 1;
            self.next_reset_h = self.next_after(at, seed, draw, node, edge);
            used += 1;
        }
        self.propagate(to, seed, draw, node, edge);
        Ok((true, used))
    }
    pub fn rate(&self) -> f64 {
        match self.value {
            Value::Constant { per_h } => per_h,
            Value::Ou { log, .. } => log.exp(),
        }
    }
}

/// Integrate Gamma intensities out of the first-event/no-event split. Given the
/// first event, Gamma conjugacy supplies the same fixed-intensity future law.
pub struct EventStrata {
    pub no_event_weight: f64,
    pub event_weight: f64,
    pub event: Option<Vec<Vec<Process>>>,
}
pub fn event_branch(
    processes: &[Vec<Process>],
    horizon_h: f64,
    seed: [u32; 2],
    draw: u32,
) -> Result<EventStrata, String> {
    let hazards: Vec<_> = processes
        .iter()
        .flatten()
        .filter_map(|p| p.hazard.as_ref())
        .collect();
    let negative_log_survival = |t: f64| {
        hazards
            .iter()
            .map(|h| {
                // Avoid overflow of t/b without truncating the represented intensity.
                let log_ratio = if t > h.rate_h {
                    t.ln() - h.rate_h.ln() + (h.rate_h / t).ln_1p()
                } else {
                    (t / h.rate_h).ln_1p()
                };
                h.shape * log_ratio
            })
            .sum::<f64>()
    };
    let exponent = negative_log_survival(horizon_h);
    let no_event = (-exponent).exp();
    let probability = -(-exponent).exp_m1();
    if probability == 0. {
        return Ok(EventStrata {
            no_event_weight: 1.,
            event_weight: 0.,
            event: None,
        });
    }
    let target = -(-uniform(seed, draw, 0x4300_0000, 0, 0) * probability).ln_1p();
    let (mut lower, mut upper) = (0., horizon_h);
    let at = loop {
        let middle = lower + (upper - lower) / 2.;
        if middle == lower || middle == upper {
            break middle;
        }
        let value = negative_log_survival(middle);
        if value == target {
            break middle;
        }
        if value < target {
            lower = middle;
        } else {
            upper = middle;
        }
    };
    let highest = hazards
        .iter()
        .map(|h| h.shape.ln() - (h.rate_h + at).ln())
        .fold(f64::NEG_INFINITY, f64::max);
    let intensity = |h: &Hazard| (h.shape.ln() - (h.rate_h + at).ln() - highest).exp();
    let total: f64 = hazards.iter().map(|h| intensity(h)).sum();
    let pick = uniform(seed, draw, 0x4300_0000, 0, 1) * total;
    let mut accumulated = 0.;
    let mut selected = false;
    let mut branch = processes.to_vec();
    for (node, edges) in branch.iter_mut().enumerate() {
        for (edge, process) in edges.iter_mut().enumerate() {
            let Some(hazard) = &process.hazard else {
                continue;
            };
            accumulated += intensity(hazard);
            let first = !selected && accumulated >= pick;
            selected |= first;
            process.hazard_per_h = gamma_unit(
                hazard.shape + if first { 1. } else { 0. },
                seed,
                draw,
                node as u32,
                edge as u32,
            ) / (hazard.rate_h + at);
            if !process.hazard_per_h.is_finite() {
                return Err("Non-finite conditional room reset intensity".into());
            }
            process.next_reset_h = if first {
                Some(at)
            } else {
                process.next_after(at, seed, draw, node, edge)
            };
        }
    }
    Ok(EventStrata {
        no_event_weight: no_event,
        event_weight: probability,
        event: Some(branch),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn prior() -> ResetPrior {
        ResetPrior {
            from: 1,
            center_mean: 0.2_f64.ln(),
            center_variance: 0.,
            log_reversion_mean: 0.,
            log_reversion_sd: 0.,
            stationary_variance_scale: 0.,
            constant_probability: 1.,
        }
    }
    #[test]
    fn rare_gamma_events_are_integrated_even_when_ordinary_paths_would_miss_them() {
        let mut event_mass = 0.;
        let mut first_half_mass = 0.;
        let count = 16384;
        for draw in 0..count {
            let process = Process::new(
                Value::Constant { per_h: 0. },
                Some(prior()),
                Some(&Hazard {
                    shape: 1.,
                    rate_h: 32727.,
                }),
            )
            .unwrap();
            let EventStrata {
                no_event_weight: idle,
                event_weight: event,
                event: branch,
            } = event_branch(&[vec![process]], 72., [51, 79], draw).unwrap();
            assert!((idle + event - 1.).abs() < 2e-16);
            assert!(event > 0.);
            let first = branch.unwrap()[0][0].next_reset_h.unwrap();
            assert!((0. ..=72.).contains(&first));
            event_mass += event;
            first_half_mass += if first <= 36. { event } else { 0. };
        }
        assert!((event_mass / count as f64 - 72. / (32727. + 72.)).abs() < 0.00004);
        assert!((first_half_mass / count as f64 - 36. / (32727. + 36.)).abs() < 0.00004);
    }
    #[test]
    fn reset_activation_keeps_exact_zero_until_the_event_and_other_edges_unchanged() {
        let mut zero = Process::new(
            Value::Constant { per_h: 0. },
            Some(prior()),
            Some(&Hazard {
                shape: 1.,
                rate_h: 1.,
            }),
        )
        .unwrap();
        zero.next_reset_h = Some(1.);
        zero.advance(0.5, 10, [3, 4], 0, 0, 0).unwrap();
        assert_eq!(zero.rate(), 0.);
        zero.advance(1., 10, [3, 4], 0, 0, 0).unwrap();
        assert!((zero.rate() - 0.2).abs() < 1e-15);
        let mut other = Process::new(Value::Constant { per_h: 0.3 }, None, None).unwrap();
        other.advance(72., 1, [3, 4], 0, 0, 1).unwrap();
        assert_eq!(other.rate(), 0.3);
        assert_eq!(other.resets, 0);
    }
    #[test]
    fn reset_event_work_partitions_and_serialization_preserve_the_same_path() {
        let process = Process::new(
            Value::Ou {
                log: -2.,
                center: -1.,
                reversion: 1.,
                variance: 0.3,
            },
            Some(prior()),
            Some(&Hazard {
                shape: 4.,
                rate_h: 0.2,
            }),
        )
        .unwrap();
        let EventStrata { event: branch, .. } =
            event_branch(&[vec![process]], 2., [29, 97], 4).unwrap();
        let mut complete = branch.unwrap()[0][0].clone();
        let mut divided = complete.clone();
        complete.advance(2., 10000, [29, 97], 4, 0, 0).unwrap();
        while !divided.advance(2., 1, [29, 97], 4, 0, 0).unwrap().0 {
            divided = serde_json::from_str(&serde_json::to_string(&divided).unwrap()).unwrap();
        }
        assert_eq!(
            serde_json::to_value(complete).unwrap(),
            serde_json::to_value(divided).unwrap()
        );
    }
}
