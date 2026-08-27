import { describe, expect, it } from 'vitest';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToHex,
  constantTimeEqual,
  hashPayload,
  hexToBytes,
  hmacSha256,
  ProtocolError,
} from '../src/index.ts';
import { VECTORS } from './test-vectors.ts';

const A = VECTORS.A;

describe('hashPayload — fixed vector A (SHA-256 over canonical bytes)', () => {
  it('matches the independently computed digest', async () => {
    const digest = await hashPayload(hexToBytes(A.canonicalPayloadHex));
    expect(bytesToHex(digest)).toBe(A.payloadSha256Hex);
  });

  it('changes when any single byte of the payload changes (sanity)', async () => {
    const base = hexToBytes(A.canonicalPayloadHex);
    const mutated = new Uint8Array(base);
    mutated[mutated.length - 1] ^= 0x01; // flip last byte (nonce LSB)
    const h1 = bytesToHex(await hashPayload(base));
    const h2 = bytesToHex(await hashPayload(mutated));
    expect(h1).not.toBe(h2);
  });
});

describe('HMAC-SHA256 — fixed vector A (challenge signature)', () => {
  it('matches the independently computed signature', async () => {
    const sig = await hmacSha256(
      new TextEncoder().encode(VECTORS.powSecret),
      hexToBytes(A.canonicalChallengeHex),
    );
    expect(bytesToHex(sig)).toBe(A.challengeSignatureHex);
  });
});

describe('base64url (RFC 4648 §5, no padding)', () => {
  it('encodes the challenge id to the fixed base64url value', () => {
    expect(bytesToBase64Url(hexToBytes(A.challengeIdHex))).toBe(A.challengeIdBase64Url);
  });

  it('decodes the fixed base64url value back to the raw bytes', () => {
    expect(bytesToHex(base64UrlToBytes(A.challengeIdBase64Url))).toBe(A.challengeIdHex);
  });

  it('round-trips arbitrary byte strings', () => {
    for (const len of [0, 1, 2, 3, 4, 5, 6, 7, 8, 16, 32, 33, 64]) {
      const data = new Uint8Array(len).map((_, i) => (i * 37 + 11) & 0xff);
      expect(base64UrlToBytes(bytesToBase64Url(data))).toEqual(data);
    }
  });

  it('encodes empty input to empty output', () => {
    expect(bytesToBase64Url(new Uint8Array(0))).toBe('');
    expect(base64UrlToBytes('')).toEqual(new Uint8Array(0));
  });

  it('rejects padded input (fail closed)', () => {
    expect(() => base64UrlToBytes('Ck3FaT7LBDiGGc2iEfJtETAlUOpWdrJ10pubs4R74kE=')).toThrow(
      /padding/,
    );
  });

  it('rejects invalid characters and invalid lengths (fail closed)', () => {
    expect(() => base64UrlToBytes('abc+')).toThrow(ProtocolError);
    expect(() => base64UrlToBytes('abc/')).toThrow(ProtocolError);
    expect(() => base64UrlToBytes('abc=')).toThrow(ProtocolError);
    expect(() => base64UrlToBytes('abcde')).toThrow(/length/); // len % 4 == 1
    expect(() => base64UrlToBytes('ab c')).toThrow(ProtocolError);
  });
});

describe('hex helpers', () => {
  it('round-trips', () => {
    const bytes = hexToBytes(A.challengeIdHex);
    expect(bytesToHex(bytes)).toBe(A.challengeIdHex);
    expect(bytesToHex(hexToBytes('deadbeef'))).toBe('deadbeef');
  });

  it('rejects malformed hex (fail closed)', () => {
    expect(() => hexToBytes('abc')).toThrow(/even length/);
    expect(() => hexToBytes('zz')).toThrow(/non-hex/);
  });
});

describe('constantTimeEqual', () => {
  it('returns true for identical bytes', () => {
    expect(constantTimeEqual(hexToBytes(A.challengeSignatureHex), hexToBytes(A.challengeSignatureHex))).toBe(true);
  });

  it('returns false for different bytes', () => {
    const a = hexToBytes(A.challengeSignatureHex);
    const b = hexToBytes(A.challengeSignatureHex);
    b[0] ^= 0x01;
    expect(constantTimeEqual(a, b)).toBe(false);
  });

  it('returns false for length mismatch without reading out of bounds', () => {
    expect(constantTimeEqual(new Uint8Array(31), new Uint8Array(32))).toBe(false);
    expect(constantTimeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });
});
