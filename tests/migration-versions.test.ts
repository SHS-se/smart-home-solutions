import { assertEquals } from "jsr:@std/assert@1";

Deno.test("Supabase migration versions are unique across all SQL files", async () => {
  const byVersion = new Map<string, string[]>();
  for await (const entry of Deno.readDir("supabase/migrations")) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    const version = entry.name.split("_", 1)[0];
    const files = byVersion.get(version) ?? [];
    files.push(entry.name);
    byVersion.set(version, files);
  }
  const duplicates = [...byVersion.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([version, files]) => ({ version, files: files.sort() }));
  assertEquals(
    duplicates,
    [],
    "Supabase keys migration history by timestamp, not filename",
  );
});
