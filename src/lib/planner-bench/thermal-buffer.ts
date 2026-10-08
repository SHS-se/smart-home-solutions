// Independent point-policy replay from saved physical inputs, never native awards.
import { stepThermalStore } from '../../../supabase/functions/_shared/planner/device-models';
import type { BenchSeries } from './types';

export interface BufferEvent {
  /** Full horizon-relative 24-hour event, with an exclusive end. */
  from: number;
  to: number;
  reheatQuarter: number;
  highPrices: boolean;
  lowSolar: boolean;
}
export interface BufferQuarter { earns: boolean; event: BufferEvent | null }

/** Null marks stale evaluations that need physical evidence recomputed. */
export function thermalBufferTrace(s: BenchSeries, threshold: number, reheatMargin: number, cycleSeconds: number): BufferQuarter[] | null {
  const n = s.start.length, context = s.poolThermal;
  if (!context || !s.comfort || context.outdoorC.length !== n || context.localMonth.length !== n || s.poolStart?.length !== n) return null;
  const summer = (month: number) => month >= 5 && month <= 9;
  const days = Array.from({ length: Math.ceil(n / 96) }, (_, day) => {
    let hours = 0, price = 0, solar = 0;
    for (let i = day * 96; i < Math.min(n, (day + 1) * 96); i++) {
      hours += s.hours[i];
      price += s.importPrice[i] * s.hours[i];
      solar += s.solarW[i] * s.hours[i] / 1000;
    }
    return { price: price / hours, solar };
  });
  const needs: (BufferEvent | null)[] = Array.from({ length: n }, (_, i) => {
    let water = s.comfort!.pool_target_c;
    for (let j = i + 1; j < n; j++) {
      water = stepThermalStore(context.store, water, 0, context.outdoorC[j], s.hours[j]);
      if (water >= s.comfort!.pool_target_c - reheatMargin) continue;
      const today = Math.floor(i / 96), future = Math.floor(j / 96);
      if (future <= today || (future + 1) * 96 > n) return null;
      const highPrices = days[future].price > days[today].price * 1.1;
      const lowSolar = summer(context.localMonth[i]) && summer(context.localMonth[j]) && days[future].solar < days[today].solar * .9;
      return highPrices || lowSolar ? { from: future * 96, to: (future + 1) * 96, reheatQuarter: j, highPrices, lowSolar } : null;
    }
    return null;
  });
  let phase: 'available' | 'active' | 'spent' = 'available';
  let event: BufferEvent | null = null;
  const claimed = new Set<number>();
  return needs.map((need, i) => {
    const off = s.poolStart![i]?.off_seconds;
    if (off !== null && off !== undefined) {
      if (off >= cycleSeconds) { phase = 'available'; event = null; }
      else if (phase === 'active') { phase = 'spent'; event = null; }
    }
    const warm = s.poolC[i] !== null && s.poolC[i]! > s.comfort!.pool_target_c + threshold;
    if (phase === 'available' && warm && need && !claimed.has(need.from)) {
      claimed.add(need.from); event = need; phase = 'active';
    }
    if (phase === 'active' && event) {
      if (warm && (event.highPrices || summer(context.localMonth[i])) && i <= event.reheatQuarter) return { earns: true, event };
      phase = 'spent'; event = null;
    }
    return { earns: false, event: null };
  });
}
