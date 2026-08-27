import { describe, expect, it } from 'vitest';
import {
  encodeCanonicalPayload,
  hexToBytes,
  leadingZeroBits,
  mineNonce,
  ProtocolError,
  verifyPow,
  verifyPowFields,
} from '../src/index.ts';
import { VECTORS } from './test-vectors.ts';

const A = VECTORS.A;
const C = VECTORS.C;

function base(overrides: Partial<Parameters<typeof encodeCanonicalPayload>[0]> = {}) {
  return {
    version: VECTORS.version,
    hostContext: A.hostContext,
    articlePath: A.articlePath,
    nickname: A.nickname,
    body: A.body,
    challengeId: hexToBytes(A.challengeIdHex),
    nonce: 0n,
    ...overrides,
  } as Parameters<typeof encodeCanonicalPayload>[0];
}

describe('leadingZeroBits', () => {
  it('counts leading zero bits of the fixed PoW digest', () => {
    expect(leadingZeroBits(hexToBytes(C.sha256Hex))).toBe(C.leadingZeroBits);
  });

  it('handles the all-zero digest (256 bits) and edge cases', () => {
    expect(leadingZeroBits(new Uint8Array(32))).toBe(256);
    expect(leadingZeroBits(new Uint8Array(32).fill(0xff))).toBe(0);
    expect(leadingZeroBits(new Uint8Array(32).fill(0x80))).toBe(0);
  });
});

describe('verifyPow — fixed vector C', () => {
  it('accepts the mined nonce for difficulty 16 (and any difficulty <= 17)', async () => {
    const payload = encodeCanonicalPayload(base({ nonce: BigInt(C.nonce) }));
    await expect(verifyPow(payload, 16)).resolves.toBe(true);
    await expect(verifyPow(payload, 17)).resolves.toBe(true);
  });

  it('REJECTS the same proof when the difficulty is raised above its strength', async () => {
    const payload = encodeCanonicalPayload(base({ nonce: BigInt(C.nonce) }));
    await expect(verifyPow(payload, 18)).resolves.toBe(false);
    await expect(verifyPow(payload, 32)).resolves.toBe(false);
    await expect(verifyPow(payload, 256)).resolves.toBe(false);
  });

  it('REJECTS a different nonce (arbitrary wrong proof)', async () => {
    const payload = encodeCanonicalPayload(base({ nonce: BigInt(C.nonce) + 1n }));
    await expect(verifyPow(payload, 16)).resolves.toBe(false);
  });

  it('accepts the nominal vector A nonce for difficulty 0 (no work required)', async () => {
    const payload = encodeCanonicalPayload(base({ nonce: BigInt(A.nonce) }));
    await expect(verifyPow(payload, 0)).resolves.toBe(true);
  });

  it('verifyPowFields agrees with verifyPow on the same logical payload', async () => {
    const payload = base({ nonce: BigInt(C.nonce) });
    const encoded = encodeCanonicalPayload(payload);
    await expect(verifyPowFields(payload, 16)).resolves.toBe(
      await verifyPow(encoded, 16),
    );
  });

  it('rejects invalid difficulty values (fail closed)', async () => {
    const payload = encodeCanonicalPayload(base({ nonce: BigInt(C.nonce) }));
    await expect(verifyPow(payload, -1)).rejects.toThrow(/difficulty/);
    await expect(verifyPow(payload, 257)).rejects.toThrow(/difficulty/);
    await expect(verifyPow(payload, 16.5)).rejects.toThrow(/difficulty/);
  });
});

describe('mineNonce', () => {
  it('finds a nonce that verifyPow accepts (difficulty 8)', async () => {
    const nonce = await mineNonce(base(), 8, { maxAttempts: 4096n });
    const payload = encodeCanonicalPayload(base({ nonce }));
    await expect(verifyPow(payload, 8)).resolves.toBe(true);
  });

  it('reproduces the fixed vector C proof when mining for difficulty 16', async () => {
    // Deterministic from nonce 0: the first satisfying nonce must be 91134.
    const nonce = await mineNonce(base(), 16, { maxAttempts: 1_000_000n });
    expect(nonce).toBe(BigInt(C.nonce));
  });

  it('throws when no nonce is found within maxAttempts', async () => {
    await expect(mineNonce(base(), 32, { maxAttempts: 1n })).rejects.toThrow(ProtocolError);
  });

  it('honors startNonce', async () => {
    const nonce = await mineNonce(base(), 8, { startNonce: 1000n, maxAttempts: 4096n });
    expect(nonce).toBeGreaterThanOrEqual(1000n);
  });
});
