/**
 * StaticLayer PoW Web Worker.
 *
 * Receives either:
 *   { challenge, nickname, body }                → comment / reaction PoW
 *   { challenge, pollId, option }                → poll vote PoW
 * mines a nonce over the canonical payload (identical byte sequence as the
 * server — fixed test vectors in @staticlayer/protocol), self-verifies, and
 * posts back { type: 'nonce' }. The protocol is bundled here; it uses only Web
 * Crypto (available in Web Workers) and has zero runtime dependencies.
 */
import {
  base64UrlToBytes,
  encodeCanonicalPollPayload,
  mineNonce,
  minePollNonce,
  PROTOCOL_VERSION,
  serializeNonce,
  verifyPow,
  verifyPowFields,
} from '@staticlayer/protocol';

self.onmessage = async function (event) {
  var msg = event.data || {};
  var challenge = msg.challenge;

  try {
    if (!challenge || typeof challenge.challengeId !== 'string') {
      throw new Error('malformed solve request');
    }
    var nonce;
    if (typeof msg.pollId === 'string' && typeof msg.option === 'string') {
      // Poll vote: use the dedicated poll payload schema.
      var pbase = {
        version: PROTOCOL_VERSION,
        hostContext: challenge.hostContext,
        articlePath: challenge.articlePath,
        pollId: msg.pollId,
        option: msg.option,
        challengeId: base64UrlToBytes(challenge.challengeId)
      };
      nonce = await minePollNonce(pbase, challenge.difficulty);
      if (!(await verifyPow(encodeCanonicalPollPayload({ ...pbase, nonce: nonce }), challenge.difficulty))) {
        throw new Error('internal: mined nonce failed verification');
      }
    } else {
      // Comment / reaction PoW.
      var nickname = msg.nickname;
      var body = msg.body;
      if (typeof nickname !== 'string' || typeof body !== 'string') {
        throw new Error('malformed solve request');
      }
      var base = {
        version: PROTOCOL_VERSION,
        hostContext: challenge.hostContext,
        articlePath: challenge.articlePath,
        nickname: nickname,
        body: body,
        challengeId: base64UrlToBytes(challenge.challengeId)
      };
      nonce = await mineNonce(base, challenge.difficulty);
      // Self-verify before reporting (defense in depth).
      if (!(await verifyPowFields({ ...base, nonce: nonce }, challenge.difficulty))) {
        throw new Error('internal: mined nonce failed verification');
      }
    }
    self.postMessage({ type: 'nonce', nonce: serializeNonce(nonce) });
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
