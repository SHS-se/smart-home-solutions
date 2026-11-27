/** Bounded native XML/ZIP transport shared by market-data adapters. */
import JSZip from "npm:jszip@3.10.1";
const XML_LIMIT = 2 * 1024 * 1024;
const TOTAL_LIMIT = 16 * 1024 * 1024;
export interface MarketZipLimits { memberBytes: number; totalBytes: number; maxMembers: number; extensions: string[] }
const DEFAULT_LIMITS: MarketZipLimits = { memberBytes: XML_LIMIT, totalBytes: TOTAL_LIMIT, maxMembers: 199, extensions: [".xml"] };
export interface MarketZipEntry { name: string; bytes: number; compressed: number; method: number; localOffset: number }
export function marketZipDirectory(bytes: Uint8Array, limits: MarketZipLimits = DEFAULT_LIMITS): MarketZipEntry[] {
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
  if (count > limits.maxMembers) {
    throw new Error(
      "Market ZIP may be truncated at the provider document limit",
    );
  }
  if (view.getUint16(end + 8, true) !== count || offset + size > end) {
    throw new Error("Invalid market ZIP directory");
  }
  let cursor = offset, total = 0;
  const names = new Set<string>();
  const entries: MarketZipEntry[] = [];
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
      expanded > limits.memberBytes || view.getUint32(cursor + 42, true) === 0xffffffff
    ) throw new Error("Unsupported or oversized market ZIP member");
    if (
      cursor + 46 + nameLength + extraLength + commentLength > offset + size
    ) throw new Error("Invalid market ZIP filename");
    const name = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
    );
    if (
      !limits.extensions.some(extension => name.endsWith(extension)) || name.startsWith("/") ||
      name.split("/").includes("..") || names.has(name)
    ) throw new Error("Unsupported market ZIP filename");
    names.add(name);
    entries.push({ name, bytes: expanded, compressed, method, localOffset: view.getUint32(cursor + 42, true) });
    total += expanded;
    if (total > limits.totalBytes) {
      throw new Error("Market ZIP exceeds total expanded size limit");
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== offset + size) {
    throw new Error("Invalid market ZIP central directory size");
  }
  return entries;
}
export async function marketXmlBodies(bytes: Uint8Array, limits: MarketZipLimits = DEFAULT_LIMITS): Promise<string[]> {
  if (
    bytes.length >= 4 &&
    new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true) ===
      0x04034b50
  ) {
    const expectedCount = marketZipDirectory(bytes, limits).length;
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
      for await (const chunk of marketZipStream(member, limits.memberBytes)) {
        size += chunk.length;
        total += chunk.length;
        if (total > limits.totalBytes) throw new Error("Market ZIP expanded size exceeds limit");
        chunks.push(chunk);
      }
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
  if (bytes.length > limits.memberBytes) {
    throw new Error("Market XML exceeds size limit");
  }
  return [new TextDecoder("utf-8", { fatal: true }).decode(bytes)];
}


/** Backpressure keeps large native domain XML out of memory. */
export function marketZipStream(member: JSZip.JSZipObject, maxBytes: number): ReadableStream<Uint8Array> {
  let size = 0;
  let finished = false;
  const stream = (member as JSZip.JSZipObject & {
    internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array>;
  }).internalStream("uint8array");
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on("data", chunk => {
        if (finished) return;
        size += chunk.length;
        if (size > maxBytes) {
          stream.pause();
          finished = true;
          controller.error(new Error("Market XML expanded size exceeds limit"));
          return;
        }
        controller.enqueue(chunk);
        if ((controller.desiredSize ?? 0) <= 0) stream.pause();
      }).on("error", error => {
        if (finished) return;
        finished = true;
        controller.error(error);
      }).on("end", () => {
        if (finished) return;
        finished = true;
        controller.close();
      });
    },
    pull() { if (!finished) stream.resume(); },
    cancel() { finished = true; stream.pause(); },
  });
}

/** Native inflation avoids burning the hosted JavaScript CPU budget on large nested bundles. */
export async function marketZipMemberBytes(bytes: Uint8Array, entry: MarketZipEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = entry.localOffset;
  if (offset + 30 > bytes.length || view.getUint32(offset,true) !== 0x04034b50 ||
      view.getUint16(offset+6,true) & 1 || view.getUint16(offset+8,true) !== entry.method) throw new Error("Invalid market ZIP local header");
  const nameLength = view.getUint16(offset+26,true), extraLength = view.getUint16(offset+28,true);
  const start = offset+30+nameLength+extraLength;
  const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset+30,offset+30+nameLength));
  if (name !== entry.name || start+entry.compressed > bytes.length) throw new Error("Invalid market ZIP member bounds");
  if (!(bytes.buffer instanceof ArrayBuffer)) throw new Error("Unsupported shared ZIP buffer");
  const compressed = new Uint8Array(bytes.buffer,bytes.byteOffset+start,entry.compressed);
  if (entry.method === 0) {
    if (compressed.length !== entry.bytes) throw new Error("Market ZIP expanded size mismatch");
    return compressed.slice();
  }
  const input = new ReadableStream<BufferSource>({start(controller){controller.enqueue(compressed);controller.close();}});
  const output = input.pipeThrough(new DecompressionStream("deflate-raw"));
  const result = new Uint8Array(entry.bytes);
  let at = 0;
  for await (const chunk of output) {
    if (at+chunk.length > result.length) throw new Error("Market ZIP expanded size mismatch");
    result.set(chunk,at); at+=chunk.length;
  }
  if (at !== result.length) throw new Error("Market ZIP expanded size mismatch");
  return result;
}
