/** Independently generated source evidence and production-stage checkpoints.
 * Generation/encoding happens outside every measured cold worker. */
import { assert, assertEquals } from "@std/assert";
import { cpuConnectedRoomPlanningSource } from "./planner-handler-cpu.fixture.ts";
import { advanceConnectedPlanningCapture } from "../supabase/functions/_shared/connected-room-planning-capture.ts";
import { compactCapture } from "../supabase/functions/_shared/device-model-learning/room-evidence.fixture.ts";
import { encodeRoomEvidenceCapture } from "../supabase/functions/_shared/device-model-learning/room-evidence-capture.ts";
import { decodeRoomResponseFitCapture } from "../supabase/functions/_shared/device-model-learning/room-band-fit-capture.ts";
import { filterConnectedRoomExchange } from "../supabase/functions/_shared/planner/models/room/connected-exchange.ts";
import type { ThermalQuarterRow } from "../supabase/functions/_shared/thermal-training.ts";
import type { HeatingProbeCapture } from "../supabase/functions/_shared/heating-probe-wire.ts";
import type { OptimisationSnapshot } from "../supabase/functions/_shared/planner/planning-contracts.ts";
import type { ModelDatabase } from "../supabase/functions/_shared/device-model-store.ts";

export const CONNECTED_CAPTURE_PHASES = [
  "source",
  "qualify",
  "process",
  "process-resumed",
  "filter",
  "assemble",
] as const;
export type ConnectedCapturePhase = typeof CONNECTED_CAPTURE_PHASES[number];
interface Numeric {
  capture: string;
  sha256: string;
  from_at: string;
  row_count: number;
  header_bytes: number;
  row_bytes: number;
}
interface Block {
  from_at: string;
  to_at: string;
  capture: string;
  sha256: string;
}
export interface ConnectedCpuCheckpoint {
  snapshot: OptimisationSnapshot;
  saved: {
    cursor: number;
    state: Record<string, unknown> | null;
    blocks?: Block[];
    numeric?: Numeric | null;
  };
  source?: HeatingProbeCapture;
}
export const CONNECTED_CPU_OWNER = {
  home_id: "synthetic",
  customer_id: "synthetic",
  job_id: "synthetic",
  fence: 1,
};
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function connectedCaptureReplay(input: ConnectedCpuCheckpoint) {
  let saved = input.saved, reads = 0, checkpoints = 0;
  const db: ModelDatabase = {
    async rpc(name, args) {
      let data: unknown;
      const model = input.snapshot.room_network_capture!.rooms[0]
        .connected_exchange!;
      switch (name) {
        case "load_energy_planning_room_capture": {
          const state = saved.state ? { ...saved.state } : null;
          assertEquals(args.p_node_delta, true);
          if (state && state.phase !== "complete") delete state.nodes;
          let numeric: unknown = saved.numeric;
          if (saved.numeric) {
            const full = saved.numeric;
            const first = state?.phase === 'process' ? Number(state.row) : 0;
            const identified = (state?.diagnostics as {thermal_state_identified?:boolean} | undefined)?.thermal_state_identified;
            const count = state?.phase === 'assemble' && identified ? 0 :
              state?.phase === 'process' ? Math.min(2048, full.row_count - first) : full.row_count;
            // Mirror SQL bytea slicing, without decoding/re-encoding the entire
            // numeric history inside the timed worker.
            const bytes = Uint8Array.from(atob(full.capture), char => char.charCodeAt(0));
            const chunk = new Uint8Array(full.header_bytes + count * full.row_bytes);
            chunk.set(bytes.subarray(0, full.header_bytes));
            chunk.set(bytes.subarray(full.header_bytes + first * full.row_bytes,
              full.header_bytes + (first + count) * full.row_bytes), full.header_bytes);
            let binary = '';
            for (let offset = 0; offset < chunk.length; offset += 8192) binary += String.fromCharCode(...chunk.subarray(offset, offset + 8192));
            const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', chunk));
            numeric = { capture: state?.phase === 'reuse' ? null : btoa(binary),
              sha256: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join(''),
              full_sha256: full.sha256, from_at: full.from_at, row_from: first, total_rows: full.row_count };
          }
          data = { ...saved, state, numeric };
          break;
        }
        case "freeze_energy_connected_planning_sources":
          data = {
            graph: {
              owner: model.basis.graph_owner,
              revision: model.basis.graph_revision,
              topology_hash: model.basis.topology_hash,
            },
            binding: "synthetic",
            policy: "synthetic",
            source_revision: 1,
            next: { from_at: args.p_from,
              to_at: new Date(Math.min(Date.parse(String(args.p_to)), Date.parse(String(args.p_from)) + 10 * 86400_000)).toISOString() },
          };
          break;
        case "load_energy_connected_inference": data = args.p_through_at ? null : []; break;
        case "save_energy_connected_inference": data = true; break;
        case "get_energy_room_operation_facts":
          data = [];
          break;
        case "get_energy_room_thermal_interval_capture": {
          reads++;
          assert(input.source);
          data = {
            ...input.source,
            rows: input.source.rows.filter((row) =>
              row.start_ts >= String(args.p_from) &&
              Date.parse(row.start_ts) + (row.duration_s ?? 900) * 1000 <=
                Date.parse(String(args.p_to))
            ),
          };
          break;
        }
        case "checkpoint_energy_planning_room_capture": {
          assertEquals(args.p_expected_cursor, saved.cursor);
          const boundary = copy(args),
            numeric = boundary.p_numeric as {
              base64: string;
              sha256: string;
              from_at: string;
              row_count: number;
              header_bytes: number;
              row_bytes: number;
            } | null;
          const { completed_nodes, ...update } = boundary.p_state as Record<string, unknown>;
          const nodes = (saved.state?.nodes ?? []) as unknown[];
          saved = {
            ...saved,
            cursor: saved.cursor + 1,
            state: { nodes: nodes.concat(completed_nodes ?? []), ...update },
            ...(numeric
              ? {
                numeric: {
                  capture: numeric.base64,
                  sha256: numeric.sha256,
                  from_at: numeric.from_at,
                  row_count: numeric.row_count,
                  header_bytes: numeric.header_bytes,
                  row_bytes: numeric.row_bytes,
                },
              }
              : {}),
          };
          checkpoints++;
          data = { state: "pending", pending: true };
          break;
        }
        default:
          throw new Error(`Unexpected connected CPU RPC ${name}`);
      }
      // The production RPC result crosses JSON before model code can see it.
      return Promise.resolve({ data: copy(data), error: null });
    },
  };
  return {
    db,
    checkpoint: () => saved,
    check: () => {
      assertEquals(checkpoints, 1);
      assert(reads <= 2);
      assertEquals(saved.state?.warnings, []);
    },
  };
}

export async function connectedCaptureCpuInputs(): Promise<
  Record<ConnectedCapturePhase, Uint8Array<ArrayBuffer>>
> {
  const s = cpuConnectedRoomPlanningSource().snapshot,
    node = s.room_network!.nodes[0],
    zone = s.thermal_zones![0];
  const model = node.model,
    from = Date.parse(model.basis.history_from),
    to = Date.parse(s.captured_at),
    count = 400 * 96;
  model.basis.source_policy = "synthetic";
  s.room_network_capture = {
    rooms: [{ ...zone, connected_exchange: model }],
    observations: [],
  };
  delete s.room_network;
  const raw: ThermalQuarterRow[] = [];
  let temperature = 19, heat = 0;
  for (let i = 0; i < count; i++) {
    const outside = 5 + 5 * Math.sin(i / 400), watts = i % 19 < 7 ? 800 : 0;
    const peers = model.incoming.map((_, j) =>
      20 + 2 * Math.sin(i / (47 + j * 29) + j)
    );
    const rates = model.incoming.map((_, j) =>
      (.02 + j * .01) *
      Math.exp(.5 * Math.sin(i / (j === 0 ? 5 : j === 1 ? 150 : 960)))
    );
    let mean = 0;
    const derivative = (
      t: number,
      q: number,
    ) => [
      -.025 * (t - outside) + rates.reduce((sum, k, j) =>
        sum + k * (peers[j] - t), 0) +
      q / 2,
      .0015 * watts - q / 2,
    ];
    const dt = .25 / 30;
    for (let step = 0; step < 30; step++) {
      const a = derivative(temperature, heat),
        midT = temperature + a[0] * dt / 2,
        midQ = heat + a[1] * dt / 2,
        b = derivative(midT, midQ);
      mean += midT / 30;
      temperature += b[0] * dt;
      heat += b[1] * dt;
    }
    const own = i % 251 === 0 ? null : mean + .02 * Math.sin(i * .13);
    raw.push({
      room_key: zone.key,
      room_name: "Synthetic connected CPU receiver",
      active_power_w: 800,
      start_ts: new Date(from + i * 900000).toISOString(),
      duration_s: 900,
      cooling: false,
      room_temperature_c: own,
      outdoor_temperature_c: outside,
      house_temperature_c: null,
      heat_w: i % 997 === 0 ? null : watts,
      solar_w_per_m2: 0,
      temperature_source_key: "synthetic-receiver-probe",
      probe_evidence: Array.from(
        { length: 12 },
        (_, p) => ({
          source_key: p === 0
            ? "synthetic-receiver-probe"
            : `synthetic-peer-${p}`,
          area_key: p === 0
            ? zone.key
            : p <= 3
            ? model.incoming[p - 1].from
            : `synthetic-unconnected-${p}`,
          cohort_key: null,
          mean: p === 0
            ? own
            : p <= 3
            ? peers[p - 1]
            : 19 + Math.sin(i / 25 + p),
          unchanged: false,
          joint_unchanged: false,
          reported: true,
          unavailable: false,
        }),
      ),
    });
  }
  const blocks: Block[] = [];
  for (let i = 0; i < count; i += 960) {
    const start = new Date(from + i * 900000).toISOString(),
      end = new Date(from + (i + 960) * 900000).toISOString();
    const encoded = await encodeRoomEvidenceCapture(
      raw.slice(i, i + 960),
      start,
      end,
    );
    blocks.push({
      from_at: start,
      to_at: end,
      capture: encoded.base64,
      sha256: encoded.sha256,
    });
  }
  const source: ConnectedCpuCheckpoint = {
    snapshot: s,
    saved: { cursor: 0, state: null },
    source: compactCapture(raw.slice(0, 964)),
  };
  const sourceReplay = connectedCaptureReplay(source);
  await advanceConnectedPlanningCapture(
    sourceReplay.db,
    CONNECTED_CPU_OWNER,
    s,
  );
  sourceReplay.check();
  const qualified: ConnectedCpuCheckpoint = {
    snapshot: s,
    saved: {
      ...sourceReplay.checkpoint(),
      state: {
        ...sourceReplay.checkpoint().state,
        phase: "qualify",
        next_from_at: new Date(to).toISOString(),
      },
      blocks,
    },
  };
  const qualificationReplay = connectedCaptureReplay(qualified);
  await advanceConnectedPlanningCapture(
    qualificationReplay.db,
    CONNECTED_CPU_OWNER,
    s,
  );
  qualificationReplay.check();
  const process: ConnectedCpuCheckpoint = {
    snapshot: s,
    saved: { ...qualificationReplay.checkpoint(), blocks: undefined },
  };
  assertEquals(process.saved.numeric?.row_count, count);
  const resume = connectedCaptureReplay(copy(process));
  await advanceConnectedPlanningCapture(resume.db, CONNECTED_CPU_OWNER, s);
  resume.check();
  const resumed: ConnectedCpuCheckpoint = {
    snapshot: s,
    saved: resume.checkpoint(),
  };
  const filtering: ConnectedCpuCheckpoint = {
    snapshot: s,
    saved: {
      ...process.saved,
      state: { ...process.saved.state, phase: "filter", row: 0 },
    },
  };
  const numeric = process.saved.numeric!;
  const rows = await decodeRoomResponseFitCapture(
    numeric.capture,
    numeric.from_at,
    numeric.sha256,
  );
  const filtered = filterConnectedRoomExchange(model, rows, to);
  const assembly: ConnectedCpuCheckpoint = {
    snapshot: s,
    saved: {
      ...process.saved,
      state: {
        ...process.saved.state,
        phase: "assemble",
        row: rows.length,
        // The independently synthetic native fixture stores its accepted
        // process belief on the node, not in the deduplicated model body.
        process_response: { ...model, reference_state: filtered.posterior,
          process_belief: { ...node.process_belief, hypotheses: node.process_belief.hypotheses.map(h => ({
            ...h, posterior: filtered.posterior, thermal_state_identified: filtered.diagnostics.thermal_state_identified,
          })) } },
        posterior: filtered.posterior,
        diagnostics: filtered.diagnostics,
      },
    },
  };
  const encode = (value: ConnectedCpuCheckpoint) =>
    new TextEncoder().encode(JSON.stringify(value));
  return {
    source: encode(source),
    qualify: encode(qualified),
    process: encode(process),
    "process-resumed": encode(resumed),
    filter: encode(filtering),
    assemble: encode(assembly),
  };
}
