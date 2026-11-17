/** The room topology and its current binding are read together. */
export interface DoorwayProbeRow {
  room_key: string;
  other_key: string;
  room_source: string;
  other_source: string;
  quarters: [startMs: number, peerC: number, receiverC?: number][];
}

export async function readDoorwayProbes(
  // deno-lint-ignore no-explicit-any
  db: {
    rpc: (
      ...args: any[]
    ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  },
  homeId: string,
  roomKeys: string[],
  from: string | null,
  to: string,
): Promise<DoorwayProbeRow[]> {
  const { data, error } = await db.rpc("get_energy_doorway_probes", {
    p_home_id: homeId,
    p_room_keys: roomKeys,
    p_from: from,
    p_to: to,
  });
  if (error) throw new Error(error.message);
  if (!Array.isArray(data)) throw new Error("Invalid doorway observations");
  return data as DoorwayProbeRow[];
}
