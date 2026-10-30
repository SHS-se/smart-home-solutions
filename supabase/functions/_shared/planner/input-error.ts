/** Invalid captured domain input; transport policy belongs outside the planner. */
export class PlanningInputError extends Error {
  readonly kind = "invalid_input";
  constructor(message: string) { super(message); this.name = "PlanningInputError"; }
}
