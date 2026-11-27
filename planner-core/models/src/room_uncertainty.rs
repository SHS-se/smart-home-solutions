//! Numerical probability primitives for joint room trajectories. No scheduling policy.

/// Philox4x32-10: each draw is addressed by trajectory pair, stream, time and
/// coordinate. Antithetic partners and resumed batches therefore share exactly
/// the same innovations, independently of execution order or work partition.
fn philox(seed: [u32; 2], mut counter: [u32; 4]) -> [u32; 4] {
    let mut key = seed;
    for _ in 0..10 {
        let a = 0xD2511F53u64 * counter[0] as u64;
        let b = 0xCD9E8D57u64 * counter[2] as u64;
        counter = [
            (b >> 32) as u32 ^ counter[1] ^ key[0],
            b as u32,
            (a >> 32) as u32 ^ counter[3] ^ key[1],
            a as u32,
        ];
        key[0] = key[0].wrapping_add(0x9E3779B9);
        key[1] = key[1].wrapping_add(0xBB67AE85);
    }
    counter
}
pub fn uniform(seed: [u32; 2], trajectory: u32, stream: u32, step: u32, coordinate: u32) -> f64 {
    let words = philox(seed, [trajectory / 2, stream, step, coordinate]);
    let value = (words[0] as f64 + 0.5) / 4294967296.;
    if trajectory.is_multiple_of(2) {
        value
    } else {
        1. - value
    }
}
pub fn normal(seed: [u32; 2], trajectory: u32, stream: u32, step: u32, coordinate: u32) -> f64 {
    let words = philox(seed, [trajectory / 2, stream, step, coordinate / 2]);
    let u = (words[0] as f64 + 0.5) / 4294967296.;
    let v = (words[1] as f64 + 0.5) / 4294967296.;
    let angle = std::f64::consts::TAU * v;
    let value = (-2. * u.ln()).sqrt()
        * if coordinate.is_multiple_of(2) {
            angle.cos()
        } else {
            angle.sin()
        };
    if trajectory.is_multiple_of(2) {
        value
    } else {
        -value
    }
}

/// Semidefinite Cholesky, tolerating only floating-point roundoff. No diagonal
/// jitter or physical variance floor is introduced by the numerical solver.
pub fn covariance_root(covariance: &[Vec<f64>]) -> Result<Vec<Vec<f64>>, String> {
    let n = covariance.len();
    if covariance
        .iter()
        .any(|r| r.len() != n || r.iter().any(|x| !x.is_finite()))
    {
        return Err("Invalid joint room covariance".into());
    }
    let scale = covariance
        .iter()
        .flatten()
        .map(|v| v.abs())
        .fold(0., f64::max);
    let tolerance = 64. * f64::EPSILON * n as f64 * scale;
    for (i, row) in covariance.iter().enumerate() {
        for (j, other) in covariance.iter().take(i).enumerate() {
            if (row[j] - other[i]).abs() > tolerance {
                return Err("Joint room covariance is not symmetric".into());
            }
        }
    }
    let mut root = vec![vec![0.; n]; n];
    for i in 0..n {
        for j in 0..=i {
            let value = 0.5 * (covariance[i][j] + covariance[j][i])
                - (0..j).map(|k| root[i][k] * root[j][k]).sum::<f64>();
            if i == j {
                if value < -tolerance {
                    return Err("Joint room covariance is not positive semidefinite".into());
                }
                root[i][j] = value.max(0.).sqrt();
            } else if root[j][j] > 0. {
                root[i][j] = value / root[j][j];
            } else if value.abs() > tolerance {
                return Err("Joint room covariance has an unsupported singular direction".into());
            }
        }
    }
    Ok(root)
}
fn multiply(a: &[f64], b: &[f64], n: usize) -> Vec<f64> {
    let mut out = vec![0.; n * n];
    for i in 0..n {
        for k in 0..n {
            let value = a[i * n + k];
            if value != 0. {
                for j in 0..n {
                    out[i * n + j] += value * b[k * n + j];
                }
            }
        }
    }
    out
}
fn transpose(a: &[f64], n: usize) -> Vec<f64> {
    (0..n * n).map(|i| a[(i % n) * n + i / n]).collect()
}
/// Integral exp(A s) D exp(A' s) ds. The Lyapunov Taylor series is evaluated at
/// a scaled interval and doubled with Q <- Q + E Q E'. Unlike the Van Loan
/// inverse-generator block, this never exponentiates a stiff unstable -A'.
pub fn thermal_noise_root(
    generator: &[f64],
    diffusion: &[f64],
    hours: f64,
) -> Result<Vec<Vec<f64>>, String> {
    let n = diffusion.len();
    if generator.len() != n * n
        || hours < 0.
        || !hours.is_finite()
        || diffusion.iter().any(|d| !d.is_finite() || *d < 0.)
    {
        return Err("Invalid room diffusion interval".into());
    }
    if diffusion.iter().all(|d| *d == 0.) || hours == 0. {
        return Ok(vec![vec![0.; n]; n]);
    }
    let norm = generator
        .chunks(n)
        .map(|r| r.iter().map(|v| v.abs()).sum::<f64>())
        .fold(0., f64::max)
        * hours;
    if !norm.is_finite() {
        return Err("Non-finite room diffusion generator".into());
    }
    let squares = if norm > 0.25 {
        (norm / 0.25).log2().ceil() as u32
    } else {
        0
    };
    let dt = hours * 2_f64.powi(-(squares as i32));
    let a: Vec<_> = generator.iter().map(|v| v * dt).collect();
    let mut term = vec![0.; n * n];
    for i in 0..n {
        term[i * n + i] = diffusion[i] * dt;
    }
    let mut covariance = term.clone();
    for order in 1..=24 {
        let left = multiply(&a, &term, n);
        // Every Lyapunov term is symmetric, so term*A'=(A*term)'.
        // This also preserves sparse receiving generators instead of spending
        // a second dense multiplication on the transposed right factor.
        for i in 0..n {
            for j in 0..n {
                let index = i * n + j;
                term[index] = (left[index] + left[j * n + i]) / (order as f64 + 1.);
                covariance[index] += term[index];
            }
        }
        let magnitude = term.iter().map(|v| v.abs()).fold(0., f64::max);
        let total = covariance.iter().map(|v| v.abs()).fold(0., f64::max);
        if magnitude <= f64::EPSILON * total {
            break;
        }
    }
    if squares > 0 {
        let mut e = vec![0.; n * n];
        for i in 0..n {
            e[i * n + i] = 1.;
        }
        // All Taylor terms have the same right factor. Omit its structural
        // zeros while accumulating each output in the original inner-index order.
        let generator_rows: Vec<Vec<(usize, f64)>> = a
            .chunks_exact(n)
            .map(|row| {
                row.iter()
                    .copied()
                    .enumerate()
                    .filter(|&(_, coefficient)| coefficient != 0.)
                    .collect()
            })
            .collect();
        let mut term = e.clone();
        let mut product = vec![0.; n * n];
        for order in 1..=24 {
            product.fill(0.);
            for (source, target) in term.chunks_exact(n).zip(product.chunks_exact_mut(n)) {
                for (&value, coefficients) in source.iter().zip(&generator_rows) {
                    if value != 0. {
                        for &(column, coefficient) in coefficients {
                            target[column] += value * coefficient;
                        }
                    }
                }
            }
            std::mem::swap(&mut term, &mut product);
            for v in &mut term {
                *v /= order as f64;
            }
            for (v, t) in e.iter_mut().zip(&term) {
                *v += t;
            }
        }
        for step in 0..squares {
            let increment = multiply(&multiply(&e, &covariance, n), &transpose(&e, n), n);
            for (v, d) in covariance.iter_mut().zip(increment) {
                *v += d;
            }
            if step + 1 < squares {
                e = multiply(&e, &e, n);
            }
        }
    }
    covariance_root(&covariance.chunks(n).map(|r| r.to_vec()).collect::<Vec<_>>())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn philox_reference_and_antithetic_addresses() {
        assert_eq!(
            philox([0, 0], [0, 0, 0, 0]),
            [0x6627e8d5, 0xe169c58d, 0xbc57ac4c, 0x9b00dbd8]
        );
        for coordinate in 0..9 {
            assert_eq!(
                normal([3, 7], 10, 4, 91, coordinate),
                -normal([3, 7], 11, 4, 91, coordinate)
            );
        }
    }
    #[test]
    fn exact_scalar_diffusion_includes_integrator_and_stiff_limits() {
        for loss in [0., 0.1, 1000000.] {
            let root = thermal_noise_root(&[-loss], &[0.3], 0.25).unwrap();
            let expected = if loss == 0. {
                0.3 * 0.25
            } else {
                0.3 * -(-2. * loss * 0.25).exp_m1() / (2. * loss)
            };
            assert!((root[0][0] * root[0][0] - expected).abs() < 1e-12, "{loss}");
        }
    }
    #[test]
    fn sparse_scaled_diffusion_preserves_dense_accumulation_bits() {
        // Synthetic one-way three-room chain with five covariance doublings.
        // The full dense Taylor product supplies the exact reference values.
        let generator = [-13., 12., 0., 0., -3., 2., 0., 0., -1.];
        let root = thermal_noise_root(&generator, &[0.4, 0.2, 0.7], 0.25).unwrap();
        let actual: Vec<_> = root.iter().flatten().map(|value| value.to_bits()).collect();
        assert_eq!(
            actual,
            [
                0x3fc6861bd8e1ee37,
                0,
                0,
                0x3fbdebf9fae36e2d,
                0x3fc1cd208c17592a,
                0,
                0x3fb55673d6278594,
                0x3fbff06d18fd1004,
                0x3fd5b8f235aad185,
            ]
        );
    }
    #[test]
    fn coupled_noise_preserves_common_and_difference_modes() {
        let root = thermal_noise_root(&[-2., 2., 2., -2.], &[0.3, 0.3], 0.25).unwrap();
        let q00 = root[0].iter().map(|v| v * v).sum::<f64>();
        let q01 = root[0]
            .iter()
            .zip(&root[1])
            .map(|(a, b)| a * b)
            .sum::<f64>();
        assert!((q00 + q01 - 0.3 * 0.25).abs() < 1e-12);
        assert!((q00 - q01 - 0.3 * -(-2_f64).exp_m1() / 8.).abs() < 1e-12);
    }
}
