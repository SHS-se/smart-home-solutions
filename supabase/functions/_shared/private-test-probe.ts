import { MAX_PLANNING_BODY_BYTES } from "./planning-transport-limits.ts";

/** Private diagnostic transport only; never authorizes production or publication. */
export async function readPrivateTestProbe(request: Request, secret: string, projectUrl: string): Promise<{ payload: unknown; bytes: number } | Response> {
  if (new URL(projectUrl).hostname !== "vxqpgbzseckgceopitpm.supabase.co") {
    return Response.json({ error: "test_lane_only" }, { status: 403 });
  }
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (request.method !== "POST") return Response.json({ error: "post_required" }, { status: 405 });
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ error: "ready_problem_required" }, { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PLANNING_BODY_BYTES) {
      await reader.cancel();
      return Response.json({ error: "probe_payload_too_large" }, { status: 413 });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return { payload: JSON.parse(new TextDecoder().decode(bytes)), bytes: size }; }
  catch { return Response.json({ error: "invalid_ready_json" }, { status: 400 }); }
}
