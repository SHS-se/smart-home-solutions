import { createHash } from "node:crypto";

export interface OwnedSnapshotHashHeader {
  snapshot: Record<string, unknown> & { room_network?: { nodes?: unknown[] } | null };
  node_count: number;
}

/** Replay JSON.stringify on the immutable execution snapshot in its original
 * property order. Only the receiving nodes are delivered separately. */
export async function hashOwnedSnapshot(
  { snapshot, node_count }: OwnedSnapshotHashHeader,
  readNode: (index: number) => Promise<unknown | null>,
): Promise<string | null> {
  const hash = createHash("sha256");
  const network = snapshot.room_network;
  if (!Number.isSafeInteger(node_count) || node_count < 0 ||
    (Array.isArray(network?.nodes) ? network.nodes.length !== 0 : node_count !== 0)) {
    throw new Error("Invalid owned snapshot hash header");
  }
  if (node_count === 0) return hash.update(JSON.stringify(snapshot)).digest("hex");

  hash.update("{");
  for (const [i, [key, value]] of Object.entries(snapshot).entries()) {
    if (i) hash.update(",");
    hash.update(JSON.stringify(key) + ":");
    if (key !== "room_network") {
      hash.update(JSON.stringify(value));
      continue;
    }
    hash.update("{");
    for (const [j, [member, field]] of Object.entries(network!).entries()) {
      if (j) hash.update(",");
      hash.update(JSON.stringify(member) + ":");
      if (member !== "nodes") {
        hash.update(JSON.stringify(field));
        continue;
      }
      hash.update("[");
      for (let index = 0; index < node_count; index++) {
        const node = await readNode(index);
        if (node === null) return null;
        if (index) hash.update(",");
        hash.update(JSON.stringify(node));
      }
      hash.update("]");
    }
    hash.update("}");
  }
  return hash.update("}").digest("hex");
}
