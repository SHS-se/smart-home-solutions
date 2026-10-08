import { builderRecipe } from "./ready-problem.ts";
import { createWasmPlanner } from "./core.ts";
import { readyProblemSchema } from "./ready-schema.ts";

interface Build {
  abi: number;
  wasm_sha256: string;
  source_sha256: string;
  qualification: string;
}
interface Recipe {
  work_grant: number;
  beam_width: number;
  max_actions: number;
  finalists: number;
  witness_trials: number;
  repair_trials: number;
}

/** Diagnostic endpoint: no database client, forecast fetch, dispatch or publication API. */
export function createPlannerProbe(
  base64: string,
  build: Build,
  recipe: Recipe,
  secret: string,
  projectUrl: string,
) {
  let loaded:
    | { planner: ReturnType<typeof createWasmPlanner>; cold_compile_ms: number }
    | undefined;
  return async (request: Request): Promise<Response> => {
    const started = performance.now();
    // This lane may run only on TEST. Auth is service-to-service; not a portal API.
    if (new URL(projectUrl).hostname !== "vxqpgbzseckgceopitpm.supabase.co") {
      return Response.json({ error: "test_lane_only" }, { status: 403 });
    }
    if (
      !secret || request.headers.get("authorization") !== `Bearer ${secret}`
    ) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (request.method !== "POST") {
      return Response.json({ error: "post_required" }, { status: 405 });
    }
    // Operational bounds for this diagnostic fixture lane, not forecast validity.
    const reader = request.body?.getReader();
    if (!reader) {
      return Response.json({ error: "ready_problem_required" }, {
        status: 400,
      });
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256_000) {
        await reader.cancel();
        return Response.json({ error: "probe_payload_too_large" }, {
          status: 413,
        });
      }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return Response.json({ error: "invalid_ready_json" }, { status: 400 });
    }
    const parsed = readyProblemSchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json({
        error: "invalid_ready_problem",
        issues: parsed.error.issues,
      }, {
        status: 400,
      });
    }
    const p = parsed.data;
    if (
      p.slots.length > 289 || p.work_grant !== recipe.work_grant ||
      JSON.stringify(p.recipe) !== JSON.stringify(builderRecipe(recipe))
    ) {
      return Response.json({ error: "unsupported_probe_recipe" }, {
        status: 400,
      });
    }
    const wasCold = !loaded;
    if (!loaded) {
      const before = performance.now();
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
      if (
        hash !== build.wasm_sha256 || build.abi !== 4 ||
        build.qualification !== "test_live_candidate"
      ) throw new Error("Invalid TEST candidate artifact.");
      try {
        loaded = {
          planner: createWasmPlanner(bytes),
          cold_compile_ms: performance.now() - before,
        };
      } catch (error) {
        // Compiler diagnostics contain no household input. Fail explicitly; do not
        // retry with another engine or hide an unsupported hosted runtime.
        const message = error instanceof Error
          ? error.message.slice(0, 300)
          : "unknown";
        console.error(
          JSON.stringify({ event: "planner_probe_compile_failed", message }),
        );
        return Response.json(
          { code: "planner_probe_compile_failed", message },
          { status: 500 },
        );
      }
    }
    const beforeSolve = performance.now();
    let solved: ReturnType<typeof loaded.planner.solve>;
    try {
      solved = loaded.planner.solve(p);
    } catch (error) {
      const message = error instanceof WebAssembly.RuntimeError ||
          (error instanceof Error && error.constructor === Error)
        ? error.message.slice(0, 300)
        : error instanceof Error
        ? error.name
        : "unknown";
      console.error(
        JSON.stringify({ event: "planner_probe_solve_failed", message }),
      );
      return Response.json({ code: "planner_probe_solve_failed", message }, {
        status: 500,
      });
    }
    const { outcome, wasm_memory_bytes, input_bytes, output_bytes } = solved;
    const solve_elapsed_ms = performance.now() - beforeSolve;
    const response = Response.json({
      qualification: "test_live_candidate",
      build,
      recipe,
      outcome,
      cold: wasCold,
      cold_compile_ms: wasCold ? loaded.cold_compile_ms : 0,
      solve_elapsed_ms,
      wasm_memory_bytes,
      input_bytes,
      output_bytes,
      handler_preencode_ms: performance.now() - started,
    });
    // Hosted shutdown logs are required for CPU; elapsed time is never labelled CPU.
    console.log(
      JSON.stringify({
        event: "planner_probe_complete",
        wasm_sha256: build.wasm_sha256,
        cold: wasCold,
        solve_elapsed_ms,
        handler_elapsed_ms: performance.now() - started,
        body_bytes: size,
        wasm_memory_bytes,
        input_bytes,
        output_bytes,
      }),
    );
    return response;
  };
}
