const encoder = new TextEncoder();

export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error(`odd-length hex string: ${hex}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? utf8(data) : data;
  // TS 5.7+ types Uint8Array as generic over ArrayBufferLike, but
  // crypto.subtle.digest requires an ArrayBuffer-backed view. Copying into a
  // fresh Uint8Array satisfies that without a cast and without forcing every
  // caller to thread a narrower type.
  const view = new Uint8Array(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', view);
  return new Uint8Array(digest);
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  return '0x' + toHex(await sha256(data));
}
