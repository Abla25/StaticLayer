import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  decodeCanonicalPayload,
  encodeCanonicalPayload,
  hexToBytes,
  parseNonce,
  ProtocolError,
  serializeNonce,
  utf8EncodeStrict,
} from '../src/index.ts';
import { VECTORS } from './test-vectors.ts';

const A = VECTORS.A;

function payloadA(nonce: string | bigint = A.nonce): Parameters<typeof encodeCanonicalPayload>[0] {
  return {
    version: VECTORS.version,
    hostContext: A.hostContext,
    articlePath: A.articlePath,
    nickname: A.nickname,
    body: A.body,
    challengeId: hexToBytes(A.challengeIdHex),
    nonce: typeof nonce === 'string' ? BigInt(nonce) : nonce,
  };
}

describe('encodeCanonicalPayload — fixed vector A', () => {
  it('produces EXACTLY the independently computed canonical byte sequence', () => {
    const bytes = encodeCanonicalPayload(payloadA());
    expect(bytes.length).toBe(A.payloadLen);
    expect(bytesToHex(bytes)).toBe(A.canonicalPayloadHex);
  });

  it('decodes vector A back to the same logical payload', () => {
    const decoded = decodeCanonicalPayload(hexToBytes(A.canonicalPayloadHex));
    expect(decoded.version).toBe(VECTORS.version);
    expect(decoded.hostContext).toBe(A.hostContext);
    expect(decoded.articlePath).toBe(A.articlePath);
    expect(decoded.nickname).toBe(A.nickname);
    expect(decoded.body).toBe(A.body);
    expect(bytesToHex(decoded.challengeId)).toBe(A.challengeIdHex);
    expect(decoded.nonce).toBe(BigInt(A.nonce));
  });

  it('round-trips encode -> decode -> encode identically', () => {
    const first = encodeCanonicalPayload(payloadA());
    const decoded = decodeCanonicalPayload(first);
    const second = encodeCanonicalPayload(decoded);
    expect(bytesToHex(second)).toBe(bytesToHex(first));
  });
});

describe('encodeCanonicalPayload — boundary vector B', () => {
  it('accepts fields at exactly their maximum lengths and matches the fixed digest', async () => {
    const { sha256 } = await import('../src/index.ts');
    const bytes = encodeCanonicalPayload({
      version: VECTORS.version,
      hostContext: VECTORS.B.hostContext,
      articlePath: VECTORS.B.articlePath,
      nickname: VECTORS.B.nickname,
      body: VECTORS.B.body,
      challengeId: hexToBytes(A.challengeIdHex),
      nonce: 0n,
    });
    expect(bytes.length).toBe(VECTORS.B.payloadLen);
    expect(bytesToHex(await sha256(bytes))).toBe(VECTORS.B.payloadSha256Hex);
  });
});

describe('encodeCanonicalPayload — fail closed on invalid input', () => {
  it('rejects an unsupported version', () => {
    expect(() => encodeCanonicalPayload({ ...payloadA(), version: 2 })).toThrow(ProtocolError);
  });

  it('rejects a nickname longer than 50 UTF-8 bytes', () => {
    expect(() => encodeCanonicalPayload({ ...payloadA(), nickname: 'a'.repeat(51) })).toThrow(
      /nickname/,
    );
  });

  it('rejects a body longer than 3000 UTF-8 bytes', () => {
    expect(() => encodeCanonicalPayload({ ...payloadA(), body: 'b'.repeat(3001) })).toThrow(
      /body/,
    );
  });

  it('rejects an articlePath longer than 255 UTF-8 bytes', () => {
    expect(() => encodeCanonicalPayload({ ...payloadA(), articlePath: '/'.repeat(256) })).toThrow(
      /articlePath/,
    );
  });

  it('rejects a hostContext longer than 255 UTF-8 bytes', () => {
    expect(() => encodeCanonicalPayload({ ...payloadA(), hostContext: 'h'.repeat(256) })).toThrow(
      /hostContext/,
    );
  });

  it('rejects an unpaired surrogate (invalid UTF-8 encoding) — fails closed', () => {
    // A lone low surrogate must NOT silently become U+FFFD in the encoding.
    expect(() => encodeCanonicalPayload({ ...payloadA(), body: 'bad \uDC00 text' })).toThrow(
      /surrogate/,
    );
  });

  it('rejects a challengeId that is not exactly 32 bytes', () => {
    expect(() => encodeCanonicalPayload({ ...payloadA(), challengeId: new Uint8Array(31) })).toThrow(
      /32 bytes/,
    );
  });

  it('rejects a nonce outside uint64 range', () => {
    expect(() => encodeCanonicalPayload({ ...payloadA(), nonce: -1n })).toThrow(/uint64/);
    expect(() => encodeCanonicalPayload({ ...payloadA(), nonce: 1n << 64n })).toThrow(/uint64/);
  });

  it('rejects a non-integer version (runtime check)', () => {
    expect(() => encodeCanonicalPayload({ ...payloadA(), version: 1.5 })).toThrow(ProtocolError);
  });
});

describe('decodeCanonicalPayload — fail closed on malformed bytes', () => {
  it('rejects trailing bytes', () => {
    const bytes = hexToBytes(A.canonicalPayloadHex);
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes);
    padded[bytes.length] = 0x00;
    expect(() => decodeCanonicalPayload(padded)).toThrow(/trailing/);
  });

  it('rejects a truncated payload', () => {
    const bytes = hexToBytes(A.canonicalPayloadHex);
    expect(() => decodeCanonicalPayload(bytes.subarray(0, bytes.length - 1))).toThrow(
      /truncated/,
    );
  });

  it('rejects a declared body length larger than the available bytes', () => {
    const bytes = hexToBytes(A.canonicalPayloadHex);
    // Corrupt the body length (u32 BE) to a huge value.
    const corrupted = new Uint8Array(bytes);
    // body_len starts at offset: 1 + 2+11 + 2+17 + 2+5 = 40
    corrupted[40] = 0xff;
    corrupted[41] = 0xff;
    corrupted[42] = 0xff;
    corrupted[43] = 0xff;
    expect(() => decodeCanonicalPayload(corrupted)).toThrow();
  });
});

describe('nonce JSON serialization', () => {
  it('serializes safe nonces as numbers', () => {
    expect(serializeNonce(91134n)).toBe(91134);
    expect(parseNonce(91134)).toBe(91134n);
  });

  it('serializes large nonces as decimal strings without precision loss', () => {
    const big = 0x0102030405060708n; // > Number.MAX_SAFE_INTEGER
    expect(typeof serializeNonce(big)).toBe('string');
    expect(parseNonce(serializeNonce(big))).toBe(big);
  });

  it('rejects unsafe or malformed nonces', () => {
    expect(() => parseNonce(Number.MAX_SAFE_INTEGER + 1)).toThrow(/safe integer/);
    expect(() => parseNonce('12.5')).toThrow(ProtocolError);
    expect(() => parseNonce('-1')).toThrow(ProtocolError);
    expect(() => parseNonce(null)).toThrow(ProtocolError);
  });
});

describe('utf8 strictness', () => {
  it('encodes valid multibyte UTF-8 correctly (byte-accurate)', () => {
    // '€' is 3 bytes E2 82 AC; '日本語' is 3 chars -> 9 bytes E6 97 A5 E6 9C AC E8 AA 9E
    expect(bytesToHex(utf8EncodeStrict('€'))).toBe('e282ac');
    expect(bytesToHex(utf8EncodeStrict('日本語'))).toBe('e697a5e69cace8aa9e');
  });

  it('rejects lone high surrogates', () => {
    expect(() => utf8EncodeStrict('\uD800')).toThrow(ProtocolError);
  });
});
