import { assertEquals } from "@std/assert";
import { sha256Hex } from "./ha-device-auth.ts";
import { hashOwnedSnapshot } from "./owned-snapshot-hash.ts";

Deno.test("streamed execution seal matches full JavaScript serialization in original member and node order", async () => {
  // Synthetic JSON exercises member order, escaped text, floating point and
  // integer-like keys that JS enumerates before ordinary string keys.
  const nodes = [{ "2": "å", "1": "雪", nested: [1e-9, 1e23, -0, null] }, { note: "a\"b/\\c\n🚪\ud800", edges: [] }];
  const networkFields = { mode: "synthetic", detail: { nodes, "quo\"te": "a:b" } };
  for (const network of [{ nodes, ...networkFields }, { mode: "synthetic", nodes, detail: networkFields.detail }, { ...networkFields, nodes }]) {
    const surroundings = { "9": "index", memo: { nodes, room_network: { nodes } } };
    for (const snapshot of [{ room_network: network, ...surroundings }, { ...surroundings, room_network: network, after: true }]) {
      const calls: number[] = [];
      const header = { snapshot: { ...snapshot, room_network: { ...network, nodes: [] } }, node_count: nodes.length };
      const digest = await hashOwnedSnapshot(header, (i) => { calls.push(i); return Promise.resolve(nodes[i]); });
      assertEquals(digest, await sha256Hex(JSON.stringify(snapshot)));
      assertEquals(calls, [0, 1]);
      assertEquals(await hashOwnedSnapshot(header, (i) => Promise.resolve(i ? null : nodes[i])), null);
    }
  }
});

Deno.test("empty and absent connected networks seal without reading a node", async () => {
  const read = () => { throw new Error("unexpected node read"); };
  for (const snapshot of [{ key: "synthetic" }, { room_network: null }, { room_network: { nodes: [] } }]) {
    assertEquals(await hashOwnedSnapshot({ snapshot, node_count: 0 }, read), await sha256Hex(JSON.stringify(snapshot)));
  }
});
