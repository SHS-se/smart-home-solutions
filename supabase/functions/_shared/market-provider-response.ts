/** Bounded provider acquisition. Only retained, credential-redacted bytes are hashed. */
export async function readMarketProvider(
  url: URL,
  token: string,
  fetchProvider: typeof fetch,
) {
  try {
    const response = await fetchProvider(url, {
      signal: AbortSignal.timeout(60_000),
      redirect: "error",
    });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 8 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("Provider body exceeds limit");
      }
      chunks.push(part.value);
    }
    let bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    if (bytes[0] !== 80 || bytes[1] !== 75) {
      let body = new TextDecoder().decode(bytes);
      for (
        const secret of new Set([
          token,
          encodeURIComponent(token),
          new URLSearchParams({ token }).toString().slice(6),
        ])
      ) if (secret) body = body.replaceAll(secret, "[REDACTED]");
      bytes = new TextEncoder().encode(body);
    }
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return {
      bytes,
      http_status: response.status,
      body_sha256: Array.from(digest, (b) => b.toString(16).padStart(2, "0"))
        .join(""),
    };
  } catch {
    return null;
  }
}
export function marketBodyBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
