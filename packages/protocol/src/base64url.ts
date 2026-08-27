import { ProtocolError } from './errors.ts';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LOOKUP: Int16Array = buildLookup();

function buildLookup(): Int16Array {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) {
    table[ALPHABET.charCodeAt(i)] = i;
  }
  return table;
}

/**
 * RFC 4648 §5 base64url WITHOUT padding.
 * Used for `challenge_id` and `signature` in the API JSON.
 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = i + 1 < bytes.length ? (bytes[i + 1] as number) : undefined;
    const b2 = i + 2 < bytes.length ? (bytes[i + 2] as number) : undefined;

    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 !== undefined) {
      out += ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    }
    if (b2 !== undefined) {
      out += ALPHABET[b2 & 0x3f];
    }
  }
  return out;
}

/**
 * Strict base64url (no padding) decoder. Rejects padding, whitespace and any
 * character outside the base64url alphabet (fail closed).
 */
export function base64UrlToBytes(input: string): Uint8Array {
  if (input.length === 0) return new Uint8Array(0);
  if (input.includes('=')) {
    throw new ProtocolError('base64url input must not contain padding');
  }
  if (input.length % 4 === 1) {
    throw new ProtocolError('base64url input has invalid length');
  }

  const out: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    const value = code < 128 ? LOOKUP[code] : -1;
    if (value < 0) {
      throw new ProtocolError(`invalid base64url character at index ${i}`);
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** Hex encoding (lowercase) — used for test vectors and debugging only. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/** Strict hex decoder (even length, [0-9a-fA-F] only). */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new ProtocolError('hex input must have even length');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = parseInt(hex[i * 2] as string, 16);
    const lo = parseInt(hex[i * 2 + 1] as string, 16);
    if (Number.isNaN(hi) || Number.isNaN(lo)) {
      throw new ProtocolError('hex input contains non-hex characters');
    }
    out[i] = (hi << 4) | lo;
  }
  return out;
}
