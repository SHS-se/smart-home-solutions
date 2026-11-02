/** Bounded native XML/ZIP transport shared by market-data adapters. */
import JSZip from "npm:jszip@3.10.1";
const XML_LIMIT = 2 * 1024 * 1024;
const TOTAL_LIMIT = 16 * 1024 * 1024;
function preflightZip(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (
    let at = bytes.length - 22;
    at >= Math.max(0, bytes.length - 65_557);
    at--
  ) {
    if (
      view.getUint32(at, true) === 0x06054b50 &&
      at + 22 + view.getUint16(at + 20, true) === bytes.length
    ) {
      end = at;
      break;
    }
  }
  if (
    end < 0 || view.getUint16(end + 4, true) !== 0 ||
    view.getUint16(end + 6, true) !== 0
  ) throw new Error("Unsupported market ZIP directory");
  const count = view.getUint16(end + 10, true),
    size = view.getUint32(end + 12, true),
    offset = view.getUint32(end + 16, true);
  if (count >= 200) {
    throw new Error(
      "Market ZIP may be truncated at the provider document limit",
    );
  }
  if (view.getUint16(end + 8, true) !== count || offset + size > end) {
    throw new Error("Invalid market ZIP directory");
  }
  let cursor = offset, total = 0;
  const names = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error("Invalid market ZIP member");
    }
    const flags = view.getUint16(cursor + 8, true),
      method = view.getUint16(cursor + 10, true);
    const compressed = view.getUint32(cursor + 20, true),
      expanded = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true),
      extraLength = view.getUint16(cursor + 30, true),
      commentLength = view.getUint16(cursor + 32, true);
    if (
      flags & 1 || ![0, 8].includes(method) || compressed === 0xffffffff ||
      expanded > XML_LIMIT || view.getUint32(cursor + 42, true) === 0xffffffff
    ) throw new Error("Unsupported or oversized market ZIP member");
    if (
      cursor + 46 + nameLength + extraLength + commentLength > offset + size
    ) throw new Error("Invalid market ZIP filename");
    const name = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
    );
    if (
      !name.endsWith(".xml") || name.startsWith("/") ||
      name.split("/").includes("..") || names.has(name)
    ) throw new Error("Unsupported market ZIP filename");
    names.add(name);
    total += expanded;
    if (total > TOTAL_LIMIT) {
      throw new Error("Market ZIP exceeds total expanded size limit");
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== offset + size) {
    throw new Error("Invalid market ZIP central directory size");
  }
  return count;
}
export async function marketXmlBodies(bytes: Uint8Array): Promise<string[]> {
  if (
    bytes.length >= 4 &&
    new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true) ===
      0x04034b50
  ) {
    const expectedCount = preflightZip(bytes);
    const zip = await JSZip.loadAsync(bytes);
    const members = Object.values(zip.files);
    if (members.length !== expectedCount) {
      throw new Error("Market ZIP member count mismatch");
    }
    let total = 0;
    const bodies: string[] = [];
    for (const member of members) {
      const chunks: Uint8Array[] = [];
      let size = 0;
      await new Promise<void>((resolve, reject) => {
        // JSZip 3.10.1 implements file.internalStream but omits it from its typings.
        const stream = (member as JSZip.JSZipObject & {
          internalStream(
            type: "uint8array",
          ): JSZip.JSZipStreamHelper<Uint8Array>;
        }).internalStream("uint8array");
        stream.on("data", (chunk) => {
          size += chunk.length;
          total += chunk.length;
          if (size > XML_LIMIT || total > TOTAL_LIMIT) {
            stream.pause();
            reject(new Error("Market ZIP expanded size exceeds limit"));
            return;
          }
          chunks.push(chunk);
        }).on("error", reject).on("end", resolve).resume();
      });
      const body = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) {
        body.set(chunk, at);
        at += chunk.length;
      }
      bodies.push(new TextDecoder("utf-8", { fatal: true }).decode(body));
    }
    return bodies;
  }
  if (bytes.length > XML_LIMIT) {
    throw new Error("Market XML exceeds size limit");
  }
  return [new TextDecoder("utf-8", { fatal: true }).decode(bytes)];
}
