//! Pure device transitions. No prices, policy, history, storage or clock.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Battery {
    pub capacity_kwh: f64,
    pub min_soc: f64,
    pub max_soc: f64,
    pub charge_max_w: f64,
    pub discharge_max_w: f64,
    pub charge_efficiency: f64,
    pub discharge_efficiency: f64,
}

impl Battery {
    pub fn available_charge_w(&self, kwh: f64, hours: f64) -> f64 {
        ((self.max_soc * self.capacity_kwh - kwh).max(0.0) * 1000.0
            / hours
            / self.charge_efficiency)
            .min(self.charge_max_w)
    }
    pub fn available_discharge_w(&self, kwh: f64, hours: f64) -> f64 {
        ((kwh - self.min_soc * self.capacity_kwh).max(0.0) * 1000.0 / hours
            * self.discharge_efficiency)
            .min(self.discharge_max_w)
    }
    pub fn step(&self, kwh: f64, charge: f64, discharge: f64, hours: f64) -> f64 {
        kwh + hours / 1000.0
            * (charge * self.charge_efficiency - discharge / self.discharge_efficiency)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CarBattery {
    pub capacity_kwh: f64,
    pub kwh_per_km: f64,
    pub charge_efficiency: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Charger {
    pub voltage_v: f64,
    pub phase_count: u32,
    pub min_current_a: u32,
    pub max_current_a: u32,
    pub current_step_a: u32,
}
impl Charger {
    pub fn watts(&self, amps: u32) -> Option<f64> {
        if amps != 0
            && (amps < self.min_current_a
                || amps > self.max_current_a
                || !(amps - self.min_current_a).is_multiple_of(self.current_step_a))
        {
            return None;
        }
        Some(f64::from(amps) * f64::from(self.phase_count) * self.voltage_v)
    }
    pub fn fitting_amps(&self, limit_w: f64) -> u32 {
        let raw = (limit_w / self.voltage_v / f64::from(self.phase_count)).floor();
        if raw < f64::from(self.min_current_a) {
            return 0;
        }
        let capped = raw.min(f64::from(self.max_current_a)) as u32;
        self.min_current_a
            + (capped - self.min_current_a) / self.current_step_a * self.current_step_a
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct LossPoint {
    pub at_c: f64,
    pub c_per_h: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StandingLoss {
    Linear {
        kw_per_c: f64,
        surroundings_c: Option<f64>,
    },
    Measured {
        points: Vec<LossPoint>,
    },
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ThermalStore {
    pub capacity_kwh_per_c: f64,
    pub loss: StandingLoss,
}
impl ThermalStore {
    pub fn idle_per_hour(&self, water: f64, outdoor: f64) -> f64 {
        match &self.loss {
            StandingLoss::Linear {
                kw_per_c,
                surroundings_c,
            } => -kw_per_c * (water - surroundings_c.unwrap_or(outdoor)) / self.capacity_kwh_per_c,
            StandingLoss::Measured { points } => {
                let mut rate = if water <= points[0].at_c {
                    points[0].c_per_h
                } else {
                    points.last().unwrap().c_per_h
                };
                for pair in points.windows(2) {
                    if water > pair[0].at_c && water <= pair[1].at_c {
                        rate = pair[0].c_per_h
                            + (pair[1].c_per_h - pair[0].c_per_h) * (water - pair[0].at_c)
                                / (pair[1].at_c - pair[0].at_c);
                        break;
                    }
                }
                rate.min(0.0)
            }
        }
    }
    pub fn step(&self, water: f64, heat_w: f64, outdoor: f64, hours: f64) -> f64 {
        water
            + hours
                * (heat_w / 1000.0 / self.capacity_kwh_per_c + self.idle_per_hour(water, outdoor))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StartupPoint {
    pub elapsed_seconds: f64,
    pub electric_fraction: f64,
    pub heat_fraction: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Response {
    Steady,
    Bergvarme { startup: Vec<StartupPoint> },
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RunAge {
    Off,
    Running { seconds: f64 },
    Steady,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HeaterState {
    OffUnobserved,
    Off { seconds: f64 },
    Running { seconds: f64 },
    Steady,
}
impl HeaterState {
    pub fn age(self) -> RunAge {
        match self {
            Self::OffUnobserved | Self::Off { .. } => RunAge::Off,
            Self::Running { seconds } => RunAge::Running { seconds },
            Self::Steady => RunAge::Steady,
        }
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub struct HeaterStart {
    pub off_seconds: Option<f64>,
}
pub struct HeaterTransition {
    pub electric_w: f64,
    pub heat_w: f64,
    pub next: HeaterState,
    pub start: Option<HeaterStart>,
}

fn integral(points: &[StartupPoint], age: f64, seconds: f64, heat: bool) -> f64 {
    let steady_at = points.last().unwrap().elapsed_seconds;
    if age >= steady_at {
        return seconds;
    }
    let end = steady_at.min(age + seconds);
    let mut result = (seconds - (steady_at - age)).max(0.0);
    let value = |p: &StartupPoint| {
        if heat {
            p.heat_fraction
        } else {
            p.electric_fraction
        }
    };
    for pair in points.windows(2) {
        let from = age.max(pair[0].elapsed_seconds);
        let to = end.min(pair[1].elapsed_seconds);
        if to <= from {
            continue;
        }
        let slope = (value(&pair[1]) - value(&pair[0]))
            / (pair[1].elapsed_seconds - pair[0].elapsed_seconds);
        let start = value(&pair[0]) + slope * (from - pair[0].elapsed_seconds);
        result += (2.0 * start + slope * (to - from)) / 2.0 * (to - from);
    }
    result
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Heater {
    pub compressor_w: f64,
    pub auxiliary_w: f64,
    pub heat_w: f64,
    pub response: Response,
}
impl Heater {
    pub fn validate_response(&self) -> Result<(), &'static str> {
        if let Response::Bergvarme { startup } = &self.response {
            if startup.len() < 2
                || startup[0].elapsed_seconds != 0.0
                || startup
                    .windows(2)
                    .any(|a| a[1].elapsed_seconds <= a[0].elapsed_seconds)
                || startup.iter().any(|a| {
                    a.electric_fraction < 0.0
                        || a.heat_fraction < 0.0
                        || a.electric_fraction == 0.0 && a.heat_fraction != 0.0
                })
                || startup.last().unwrap().electric_fraction != 1.0
                || startup.last().unwrap().heat_fraction != 1.0
            {
                return Err("invalid_startup_model");
            }
        }
        Ok(())
    }
    pub fn transition(&self, state: HeaterState, on: bool, seconds: f64) -> HeaterTransition {
        let (electric_w, heat_w, age) = self.step(on, state.age(), seconds);
        let start = if on {
            match state {
                HeaterState::OffUnobserved => Some(HeaterStart { off_seconds: None }),
                HeaterState::Off { seconds } => Some(HeaterStart {
                    off_seconds: Some(seconds),
                }),
                _ => None,
            }
        } else {
            None
        };
        let next = if on {
            match age {
                RunAge::Running { seconds } => HeaterState::Running { seconds },
                RunAge::Steady => HeaterState::Steady,
                RunAge::Off => unreachable!(),
            }
        } else {
            match state {
                HeaterState::OffUnobserved => HeaterState::OffUnobserved,
                HeaterState::Off { seconds: previous } => HeaterState::Off {
                    seconds: previous + seconds,
                },
                _ => HeaterState::Off { seconds },
            }
        };
        HeaterTransition {
            electric_w,
            heat_w,
            next,
            start,
        }
    }
    pub fn step(&self, on: bool, age: RunAge, seconds: f64) -> (f64, f64, RunAge) {
        if !on {
            return (0.0, 0.0, RunAge::Off);
        }
        let (electric, heat, next) = match age {
            RunAge::Steady => (1.0, 1.0, RunAge::Steady),
            _ => {
                let from = match age {
                    RunAge::Running { seconds } => seconds,
                    _ => 0.0,
                };
                let (electric, heat) = match &self.response {
                    Response::Steady => (1.0, 1.0),
                    Response::Bergvarme { startup } => (
                        integral(startup, from, seconds, false) / seconds,
                        integral(startup, from, seconds, true) / seconds,
                    ),
                };
                (
                    electric,
                    heat,
                    RunAge::Running {
                        seconds: from + seconds,
                    },
                )
            }
        };
        (
            self.compressor_w * electric + self.auxiliary_w,
            self.heat_w * heat,
            next,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Deserialize)]
    struct VectorSet {
        response: Response,
        vectors: Vec<Vector>,
    }
    #[derive(Deserialize)]
    struct Vector {
        state: HeaterState,
        on: bool,
        seconds: f64,
        electric_w: f64,
        heat_w: f64,
        next: HeaterState,
        start: Option<HeaterStart>,
    }
    #[test]
    fn shared_heater_transition_vectors() {
        let fixture: VectorSet =
            serde_json::from_str(include_str!("../heater-transitions.json")).unwrap();
        let heater = Heater {
            compressor_w: 3000.0,
            auxiliary_w: 0.0,
            heat_w: 12000.0,
            response: fixture.response,
        };
        for v in fixture.vectors {
            let t = heater.transition(v.state, v.on, v.seconds);
            assert!((t.electric_w - v.electric_w).abs() < 1e-9);
            assert!((t.heat_w - v.heat_w).abs() < 1e-9);
            assert_eq!(t.next, v.next);
            assert_eq!(t.start, v.start);
        }
    }
    #[test]
    fn startup_keeps_auxiliary_draw_and_distinct_heat_integral() {
        let h = Heater {
            compressor_w: 3000.0,
            auxiliary_w: 764.0,
            heat_w: 12000.0,
            response: Response::Bergvarme {
                startup: vec![
                    StartupPoint {
                        elapsed_seconds: 0.0,
                        electric_fraction: 0.5,
                        heat_fraction: 0.0,
                    },
                    StartupPoint {
                        elapsed_seconds: 900.0,
                        electric_fraction: 1.0,
                        heat_fraction: 1.0,
                    },
                ],
            },
        };
        let (draw, heat, age) = h.step(true, RunAge::Off, 900.0);
        assert_eq!(draw, 3014.0);
        assert_eq!(heat, 6000.0);
        assert!(matches!(age, RunAge::Running { seconds: 900.0 }));
        let (draw, heat, _) = h.step(true, age, 900.0);
        assert_eq!((draw, heat), (3764.0, 12000.0));
    }
}
