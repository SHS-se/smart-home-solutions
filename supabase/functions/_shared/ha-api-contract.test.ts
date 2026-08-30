import { assertEquals } from "jsr:@std/assert@1";
import {
  describeThrown,
  HA_API_VERSION,
  HA_SUPPORTED_PLAN_SCHEMA_VERSIONS,
  HA_SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS,
  haApiResponse,
  validatePlanningNegotiation,
} from "./ha-api-contract.ts";
import { dispatchedEvPlanFixture } from "../../../scripts/generate-ha-plan-fixture.ts";

const contractUrl = new URL(
  "../../../contracts/ha-api/openapi.json",
  import.meta.url,
);

Deno.test("runtime API versions match the normative OpenAPI contract", async () => {
  const contract = JSON.parse(await Deno.readTextFile(contractUrl));
  const versions = contract["x-shs-versioning"];

  assertEquals(versions.api_version, HA_API_VERSION);
  assertEquals(
    versions.supported_snapshot_schema_versions,
    [...HA_SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS],
  );
  assertEquals(
    versions.supported_plan_schema_versions,
    [...HA_SUPPORTED_PLAN_SCHEMA_VERSIONS],
  );
  assertEquals(
    Object.keys(contract.paths).sort(),
    [
      "/energy-optimisation-ingest",
      "/energy-optimisation-plan-ack",
      "/ha-energy-ingest",
      "/integration-prices",
      "/integration-status",
      "/integration-tariff",
      "/pair-device",
    ],
  );
});

Deno.test("all HA errors carry a stable structured envelope and correlation id", async () => {
  const response = haApiResponse(
    "2e3fdcdb-53a3-49ef-a5ca-8b8f49daab3b",
    { error: "invalid_body", detail: "snapshot.services[0]" },
    400,
  );
  const payload = await response.json();

  assertEquals(response.headers.get("x-request-id"), payload.request_id);
  assertEquals(payload.api_version, 1);
  assertEquals(payload.ok, false);
  assertEquals(payload.error, "invalid_body");
  assertEquals(payload.error_info.code, "invalid_body");
  assertEquals(payload.error_info.path, "snapshot.services[0]");
  assertEquals(payload.error_info.retryable, false);
});

Deno.test("planning negotiation fails before an unreadable plan can be emitted", () => {
  const rejected = validatePlanningNegotiation({
    api_version: 1,
    integration_version: "0.7.0-beta.30",
    accepted_plan_schema_versions: [5],
  }, 6);
  assertEquals(rejected?.code, "client_upgrade_required");

  const accepted = validatePlanningNegotiation({
    api_version: 1,
    integration_version: "0.7.0-beta.30",
    accepted_plan_schema_versions: [5, 6],
  }, 6);
  assertEquals(accepted, null);
});

Deno.test("the dispatched-EV consumer fixture is emitted by the real planner", async () => {
  const fixtureUrl = new URL(
    "../../../contracts/ha-api/fixtures/schema-6-dispatched-ev-plan.json",
    import.meta.url,
  );
  const stored = JSON.parse(await Deno.readTextFile(fixtureUrl));
  const generated = dispatchedEvPlanFixture();

  assertEquals(stored, generated);
  const priority = stored.plan.plans.priority;
  assertEquals(priority.dispatched_devices.includes("ev"), true);
  assertEquals(
    priority.slots.some((slot: Record<string, number>) =>
      slot.ev_target_current_a >= 5 && slot.ev_max_current_a === 16
    ),
    true,
  );
});

Deno.test("a database failure names itself rather than reading as a bad snapshot", () => {
  // What PostgREST actually throws: a plain object, not an Error. Reported as
  // "invalid snapshot" it said only that something had gone wrong, and said it
  // in words that blamed the integration for sending bad data.
  assertEquals(
    describeThrown({
      message: 'column "solar_w_per_m2" does not exist',
      code: "42703",
      hint: null,
      details: null,
    }),
    'column "solar_w_per_m2" does not exist · code 42703',
  );
  assertEquals(
    describeThrown({
      message:
        "permission denied for function get_energy_thermal_training_moments",
      code: "42501",
      details: "some detail",
      hint: "some hint",
    }),
    "permission denied for function get_energy_thermal_training_moments · " +
      "code 42501 · some detail · some hint",
  );
});

Deno.test("an Error still speaks for itself", () => {
  assertEquals(
    describeThrown(
      new Error("bathroom: no trained thermal model is available"),
    ),
    "bathroom: no trained thermal model is available",
  );
});

Deno.test("something with nothing to say falls back rather than printing junk", () => {
  assertEquals(describeThrown(null), "invalid snapshot");
  assertEquals(describeThrown(undefined), "invalid snapshot");
  assertEquals(describeThrown("a bare string"), "invalid snapshot");
  assertEquals(describeThrown({}), "invalid snapshot");
});
