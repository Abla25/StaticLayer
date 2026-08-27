import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  encodeCanonicalChallenge,
  hexToBytes,
  signChallenge,
  verifyChallenge,
} from '../src/index.ts';
import { VECTORS } from './test-vectors.ts';

const A = VECTORS.A;

function challenge(overrides: Partial<Parameters<typeof encodeCanonicalChallenge>[0]> = {}) {
  return {
    version: VECTORS.version,
    hostContext: A.hostContext,
    articlePath: A.articlePath,
    challengeId: hexToBytes(A.challengeIdHex),
    expiresAt: BigInt(A.expiresAt),
    difficulty: A.difficulty,
    ...overrides,
  };
}

describe('encodeCanonicalChallenge — fixed vector A', () => {
  it('produces EXACTLY the independently computed challenge bytes', () => {
    expect(bytesToHex(encodeCanonicalChallenge(challenge()))).toBe(A.canonicalChallengeHex);
  });
});

describe('signChallenge / verifyChallenge', () => {
  it('signs the challenge to the fixed signature', async () => {
    const sig = await signChallenge(challenge(), VECTORS.powSecret);
    expect(bytesToHex(sig)).toBe(A.challengeSignatureHex);
    expect(typeof sig).toBe('object');
  });

  it('accepts a Uint8Array secret identically', async () => {
    const sigBytes = await signChallenge(challenge(), new TextEncoder().encode(VECTORS.powSecret));
    expect(bytesToHex(sigBytes)).toBe(A.challengeSignatureHex);
  });

  it('verifies the fixed signature', async () => {
    const ok = await verifyChallenge(
      challenge(),
      hexToBytes(A.challengeSignatureHex),
      VECTORS.powSecret,
    );
    expect(ok).toBe(true);
  });

  it('REJECTS a signature produced with a different secret', async () => {
    const forged = await signChallenge(challenge(), 'attacker-secret');
    expect(bytesToHex(forged)).not.toBe(A.challengeSignatureHex);
    const ok = await verifyChallenge(challenge(), forged, VECTORS.powSecret);
    expect(ok).toBe(false);
  });

  it('REJECTS any tampered challenge field (fail closed)', async () => {
    const validSig = hexToBytes(A.challengeSignatureHex);
    const tamperCases: Array<Partial<Parameters<typeof encodeCanonicalChallenge>[0]>> = [
      { hostContext: 'evil.example.com' },
      { articlePath: '/different-post' },
      { expiresAt: BigInt(A.expiresAt) + 3600n }, // client tries to extend expiry
      { difficulty: 0 }, // client tries to weaken difficulty
      { difficulty: 24 },
      { challengeId: hexToBytes('ff'.repeat(32)) },
      { version: 2 },
    ];
    for (const tamper of tamperCases) {
      await expect(verifyChallenge(challenge(tamper), validSig, VECTORS.powSecret)).resolves.toBe(
        false,
      );
    }
  });

  it('REJECTS a corrupted signature (single flipped byte)', async () => {
    const bad = hexToBytes(A.challengeSignatureHex);
    bad[bad.length - 1] ^= 0x01;
    await expect(verifyChallenge(challenge(), bad, VECTORS.powSecret)).resolves.toBe(false);
  });

  it('REJECTS a signature of the wrong length', async () => {
    await expect(
      verifyChallenge(challenge(), new Uint8Array(31), VECTORS.powSecret),
    ).resolves.toBe(false);
    await expect(
      verifyChallenge(challenge(), new Uint8Array(0), VECTORS.powSecret),
    ).resolves.toBe(false);
  });
});
