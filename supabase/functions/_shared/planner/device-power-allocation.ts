/** The same measured allocation policy for live plans and historical models. */
export interface DeviceMember { key: string; watts: number }
interface Meter { key: string; active_power_w: number | null; forecast_w_by_slot: readonly number[] }
export function deviceMembers(models: readonly Meter[], total: number): DeviceMember[] {
  const weights = models.map(model => Math.max(model.active_power_w ?? 0, ...model.forecast_w_by_slot));
  const measured = weights.reduce((sum, value) => sum + value, 0);
  return models.map((model, index) => ({ key: model.key, watts: measured > 0 ? weights[index] : total / models.length }));
}
export function allocateDevicePower(members: readonly DeviceMember[], watts: number, into: Record<string, number>): void {
  const total = members.reduce((sum, member) => sum + member.watts, 0);
  if (members.length && watts > 0 && !(total > 0)) throw new Error('Physical device members require measured allocation powers');
  for (const member of members) into[member.key] = total > 0 ? watts * member.watts / total : 0;
}
