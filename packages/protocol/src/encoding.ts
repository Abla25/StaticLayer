import {
  CHALLENGE_ID_BYTES,
  MAX_ARTICLE_PATH_BYTES,
  MAX_BODY_BYTES,
  MAX_COMMENT_ID_BYTES,
  MAX_HOST_CONTEXT_BYTES,
  MAX_NICKNAME_BYTES,
  MAX_OPTION_BYTES,
  MAX_POLL_ID_BYTES,
  MAX_POLL_OPTIONS,
  NONCE_BYTES,
  PROTOCOL_VERSION,
  UINT64_MAX,
} from './constants.ts';
import { ProtocolError } from './errors.ts';
import { utf8DecodeStrict, utf8EncodeStrict } from './utf8.ts';

/**
 * A logical PoW payload. This is the object the client assembles (nickname,
 * body, nonce) on top of a server-issued challenge (host context, article
 * path, challenge id).
 *
 * `nonce` is a `bigint` (uint64). It is serialized as JSON either as a number
 * (when it fits in a safe integer) or as a decimal string otherwise — see
 * `serializeNonce` / `parseNonce`.
 */
export interface CanonicalPayload {
  version: number;
  hostContext: string;
  articlePath: string;
  nickname: string;
  body: string;
  challengeId: Uint8Array; // exactly CHALLENGE_ID_BYTES
  nonce: bigint; // 0 <= nonce <= UINT64_MAX
}

/**
 * PoW payload for POLL VOTES (a separate canonical schema from comments).
 * Uses a distinct encoding so polls do not touch the comment wire format:
 * version + host_context + article_path + poll_id + option + challenge_id + nonce.
 */
export interface PollCanonicalPayload {
  version: number;
  hostContext: string;
  articlePath: string;
  pollId: string;
  option: string;
  challengeId: Uint8Array; // exactly CHALLENGE_ID_BYTES
  nonce: bigint; // 0 <= nonce <= UINT64_MAX
}

/**
 * PoW payload for MULTI-SELECT POLL VOTES. Options MUST be sorted (canonical
 * order) before encoding so the byte sequence is deterministic — enforced by
 * the client (widget/worker), the server, and fixed test vectors.
 */
export interface PollMultiCanonicalPayload {
  version: number;
  hostContext: string;
  articlePath: string;
  pollId: string;
  /** Sorted list of selected options (1..MAX_POLL_OPTIONS). */
  options: string[];
  challengeId: Uint8Array; // exactly CHALLENGE_ID_BYTES
  nonce: bigint; // 0 <= nonce <= UINT64_MAX
}

/**
 * Canonical binary encoding, schema v1.
 *
 * ALL integers are BIG-ENDIAN. Field order is fixed and length-prefixed, so
 * the encoding is self-describing and unambiguous:
 *
 *   offset  size  field
 *   0       1     version            uint8
 *   1       2     host_context_len   uint16 BE   (max 255)
 *   3       n     host_context       UTF-8
 *   ...     2     article_path_len   uint16 BE   (max 255)
 *   ...     n     article_path       UTF-8
 *   ...     2     nickname_len       uint16 BE   (max 50)
 *   ...     n     nickname           UTF-8
 *   ...     4     body_len           uint32 BE   (max 3000)
 *   ...     n     body               UTF-8
 *   ...     32    challenge_id       raw bytes
 *   ...     8     nonce              uint64 BE
 *
 * The Worker and the client Web Worker MUST produce exactly this byte
 * sequence for the same logical payload (enforced by fixed test vectors).
 */
export function encodeCanonicalPayload(p: CanonicalPayload): Uint8Array {
  if (p.version !== PROTOCOL_VERSION) {
    throw new ProtocolError(`Unsupported protocol version: ${p.version}`);
  }

  const host = utf8EncodeStrict(p.hostContext);
  const path = utf8EncodeStrict(p.articlePath);
  const nick = utf8EncodeStrict(p.nickname);
  const body = utf8EncodeStrict(p.body);

  assertByteLen('hostContext', host.length, MAX_HOST_CONTEXT_BYTES);
  assertByteLen('articlePath', path.length, MAX_ARTICLE_PATH_BYTES);
  assertByteLen('nickname', nick.length, MAX_NICKNAME_BYTES);
  assertByteLen('body', body.length, MAX_BODY_BYTES);

  if (p.challengeId.length !== CHALLENGE_ID_BYTES) {
    throw new ProtocolError(
      `challengeId must be exactly ${CHALLENGE_ID_BYTES} bytes, got ${p.challengeId.length}`,
    );
  }
  if (p.nonce < 0n || p.nonce > UINT64_MAX) {
    throw new ProtocolError('nonce out of uint64 range');
  }

  const total =
    1 +
    2 + host.length +
    2 + path.length +
    2 + nick.length +
    4 + body.length +
    CHALLENGE_ID_BYTES +
    NONCE_BYTES;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let o = 0;

  view.setUint8(o, p.version);
  o += 1;

  view.setUint16(o, host.length, false);
  o += 2;
  out.set(host, o);
  o += host.length;

  view.setUint16(o, path.length, false);
  o += 2;
  out.set(path, o);
  o += path.length;

  view.setUint16(o, nick.length, false);
  o += 2;
  out.set(nick, o);
  o += nick.length;

  view.setUint32(o, body.length, false);
  o += 4;
  out.set(body, o);
  o += body.length;

  out.set(p.challengeId, o);
  o += CHALLENGE_ID_BYTES;

  view.setBigUint64(o, p.nonce, false);
  o += NONCE_BYTES;

  if (o !== total) {
    // Defensive: internal invariant. If this ever fires, the encoding above
    // and the byte accounting diverged — never ship such a state.
    throw new ProtocolError(`internal encoding error: wrote ${o} of ${total} bytes`);
  }

  return out;
}

/**
 * Canonical binary encoding of a POLL VOTE payload (schema "poll").
 *
 *   offset  size  field
 *   0       1     version          uint8
 *   1       2     host_context_len uint16 BE   (max 255)
 *   3       n     host_context     UTF-8
 *   ...     2     article_path_len uint16 BE   (max 255)
 *   ...     n     article_path     UTF-8
 *   ...     2     poll_id_len      uint16 BE   (max 64)
 *   ...     n     poll_id          UTF-8
 *   ...     2     option_len       uint16 BE   (max 100)
 *   ...     n     option           UTF-8
 *   ...     32    challenge_id     raw bytes
 *   ...     8     nonce            uint64 BE
 */
export function encodeCanonicalPollPayload(p: PollCanonicalPayload): Uint8Array {
  if (p.version !== PROTOCOL_VERSION) {
    throw new ProtocolError(`Unsupported protocol version: ${p.version}`);
  }

  const host = utf8EncodeStrict(p.hostContext);
  const path = utf8EncodeStrict(p.articlePath);
  const pollId = utf8EncodeStrict(p.pollId);
  const option = utf8EncodeStrict(p.option);

  assertByteLen('hostContext', host.length, MAX_HOST_CONTEXT_BYTES);
  assertByteLen('articlePath', path.length, MAX_ARTICLE_PATH_BYTES);
  assertByteLen('pollId', pollId.length, MAX_POLL_ID_BYTES);
  assertByteLen('option', option.length, MAX_OPTION_BYTES);

  if (p.challengeId.length !== CHALLENGE_ID_BYTES) {
    throw new ProtocolError(
      `challengeId must be exactly ${CHALLENGE_ID_BYTES} bytes, got ${p.challengeId.length}`,
    );
  }
  if (p.nonce < 0n || p.nonce > UINT64_MAX) {
    throw new ProtocolError('nonce out of uint64 range');
  }

  const total =
    1 +
    2 + host.length +
    2 + path.length +
    2 + pollId.length +
    2 + option.length +
    CHALLENGE_ID_BYTES +
    NONCE_BYTES;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let o = 0;

  view.setUint8(o, p.version);
  o += 1;

  view.setUint16(o, host.length, false);
  o += 2;
  out.set(host, o);
  o += host.length;

  view.setUint16(o, path.length, false);
  o += 2;
  out.set(path, o);
  o += path.length;

  view.setUint16(o, pollId.length, false);
  o += 2;
  out.set(pollId, o);
  o += pollId.length;

  view.setUint16(o, option.length, false);
  o += 2;
  out.set(option, o);
  o += option.length;

  out.set(p.challengeId, o);
  o += CHALLENGE_ID_BYTES;

  view.setBigUint64(o, p.nonce, false);
  o += NONCE_BYTES;

  if (o !== total) {
    throw new ProtocolError(`internal poll encoding error: wrote ${o} of ${total} bytes`);
  }

  return out;
}

/** Canonical sort: byte-wise ascending, stable for equal strings. */
export function sortPollOptions(options: string[]): string[] {
  return [...options].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Canonical binary encoding of a MULTI-SELECT POLL VOTE payload (schema
 * "poll-multi"). Distinct from the single-option schema so existing polls are
 * never affected:
 *
 *   offset  size  field
 *   0       1     version          uint8
 *   1       2     host_context_len uint16 BE   (max 255)
 *   3       n     host_context     UTF-8
 *   ...     2     article_path_len uint16 BE   (max 255)
 *   ...     n     article_path     UTF-8
 *   ...     2     poll_id_len      uint16 BE   (max 64)
 *   ...     n     poll_id          UTF-8
 *   ...     1     option_count     uint8       (1..MAX_POLL_OPTIONS)
 *   ...     2     option_len       uint16 BE   (max 100)   × count
 *   ...     n     option           UTF-8                  × count
 *   ...     32    challenge_id     raw bytes
 *   ...     8     nonce            uint64 BE
 */

/**
 * PoW payload for a COMMENT ACTION: visitor flag ("report") or anonymous
 * like/upvote. Same fields as a comment but WITHOUT the body — the action byte
 * discriminates the two so a nonce mined for one is never valid for the other.
 */
export interface CommentActionCanonicalPayload {
  version: number;
  action: 'flag' | 'vote';
  hostContext: string;
  articlePath: string;
  commentId: string;
  challengeId: Uint8Array; // exactly CHALLENGE_ID_BYTES
  nonce: bigint; // 0 <= nonce <= UINT64_MAX
}

const ACTION_BYTE: Record<'flag' | 'vote', number> = { flag: 1, vote: 2 };

/**
 * Canonical binary encoding of a COMMENT ACTION payload (schema "comment-action"):
 *
 *   offset  size  field
 *   0       1     version          uint8
 *   1       1     action           uint8 (1=flag, 2=vote)
 *   2       2     host_context_len uint16 BE   (max 255)
 *   4       n     host_context     UTF-8
 *   ...     2     article_path_len uint16 BE   (max 255)
 *   ...     n     article_path     UTF-8
 *   ...     2     comment_id_len   uint16 BE   (max 64)
 *   ...     n     comment_id       UTF-8
 *   ...     32    challenge_id     raw bytes
 *   ...     8     nonce            uint64 BE
 */
export function encodeCanonicalCommentActionPayload(p: CommentActionCanonicalPayload): Uint8Array {
  if (p.version !== PROTOCOL_VERSION) {
    throw new ProtocolError(`Unsupported protocol version: ${p.version}`);
  }

  const host = utf8EncodeStrict(p.hostContext);
  const path = utf8EncodeStrict(p.articlePath);
  const commentId = utf8EncodeStrict(p.commentId);
  const actionByte = ACTION_BYTE[p.action];

  assertByteLen('hostContext', host.length, MAX_HOST_CONTEXT_BYTES);
  assertByteLen('articlePath', path.length, MAX_ARTICLE_PATH_BYTES);
  assertByteLen('commentId', commentId.length, MAX_COMMENT_ID_BYTES);

  if (p.challengeId.length !== CHALLENGE_ID_BYTES) {
    throw new ProtocolError(
      `challengeId must be exactly ${CHALLENGE_ID_BYTES} bytes, got ${p.challengeId.length}`,
    );
  }
  if (p.nonce < 0n || p.nonce > UINT64_MAX) {
    throw new ProtocolError('nonce out of uint64 range');
  }

  const total =
    1 +
    1 +
    2 + host.length +
    2 + path.length +
    2 + commentId.length +
    CHALLENGE_ID_BYTES +
    NONCE_BYTES;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let o = 0;

  view.setUint8(o, p.version);
  o += 1;

  view.setUint8(o, actionByte);
  o += 1;

  view.setUint16(o, host.length, false);
  o += 2;
  out.set(host, o);
  o += host.length;

  view.setUint16(o, path.length, false);
  o += 2;
  out.set(path, o);
  o += path.length;

  view.setUint16(o, commentId.length, false);
  o += 2;
  out.set(commentId, o);
  o += commentId.length;

  out.set(p.challengeId, o);
  o += CHALLENGE_ID_BYTES;

  view.setBigUint64(o, p.nonce, false);
  o += NONCE_BYTES;

  if (o !== total) {
    throw new ProtocolError(`internal comment-action encoding error: wrote ${o} of ${total} bytes`);
  }

  return out;
}

/**
 * Canonical binary encoding of a MULTI-SELECT POLL VOTE payload (schema
 * "poll-multi"). Distinct from the single-option schema so existing polls are
 * never affected:
 *
 *   offset  size  field
 *   0       1     version          uint8
 *   1       2     host_context_len uint16 BE   (max 255)
 *   3       n     host_context     UTF-8
 *   ...     2     article_path_len uint16 BE   (max 255)
 *   ...     n     article_path     UTF-8
 *   ...     2     poll_id_len      uint16 BE   (max 64)
 *   ...     n     poll_id          UTF-8
 *   ...     1     option_count     uint8       (1..MAX_POLL_OPTIONS)
 *   ...     2     option_len       uint16 BE   (max 100)   × count
 *   ...     n     option           UTF-8                  × count
 *   ...     32    challenge_id     raw bytes
 *   ...     8     nonce            uint64 BE
 */
export function encodeCanonicalPollPayloadMulti(p: PollMultiCanonicalPayload): Uint8Array {
  if (p.version !== PROTOCOL_VERSION) {
    throw new ProtocolError(`Unsupported protocol version: ${p.version}`);
  }

  const host = utf8EncodeStrict(p.hostContext);
  const path = utf8EncodeStrict(p.articlePath);
  const pollId = utf8EncodeStrict(p.pollId);
  if (!Array.isArray(p.options) || p.options.length < 1 || p.options.length > MAX_POLL_OPTIONS) {
    throw new ProtocolError(`options must be 1..${MAX_POLL_OPTIONS} strings`);
  }
  // Enforce canonical order: encoding is only deterministic if both sides sort.
  const sorted = sortPollOptions(p.options);
  const opts = sorted.map((o) => utf8EncodeStrict(o));

  assertByteLen('hostContext', host.length, MAX_HOST_CONTEXT_BYTES);
  assertByteLen('articlePath', path.length, MAX_ARTICLE_PATH_BYTES);
  assertByteLen('pollId', pollId.length, MAX_POLL_ID_BYTES);
  for (const o of opts) assertByteLen('option', o.length, MAX_OPTION_BYTES);

  if (p.challengeId.length !== CHALLENGE_ID_BYTES) {
    throw new ProtocolError(
      `challengeId must be exactly ${CHALLENGE_ID_BYTES} bytes, got ${p.challengeId.length}`,
    );
  }
  if (p.nonce < 0n || p.nonce > UINT64_MAX) {
    throw new ProtocolError('nonce out of uint64 range');
  }

  const total =
    1 +
    2 + host.length +
    2 + path.length +
    2 + pollId.length +
    1 +
    opts.reduce((n, o) => n + 2 + o.length, 0) +
    CHALLENGE_ID_BYTES +
    NONCE_BYTES;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let o = 0;

  view.setUint8(o, p.version);
  o += 1;

  view.setUint16(o, host.length, false);
  o += 2;
  out.set(host, o);
  o += host.length;

  view.setUint16(o, path.length, false);
  o += 2;
  out.set(path, o);
  o += path.length;

  view.setUint16(o, pollId.length, false);
  o += 2;
  out.set(pollId, o);
  o += pollId.length;

  view.setUint8(o, opts.length);
  o += 1;

  for (const opt of opts) {
    view.setUint16(o, opt.length, false);
    o += 2;
    out.set(opt, o);
    o += opt.length;
  }

  out.set(p.challengeId, o);
  o += CHALLENGE_ID_BYTES;

  view.setBigUint64(o, p.nonce, false);
  o += NONCE_BYTES;

  if (o !== total) {
    throw new ProtocolError(`internal poll-multi encoding error: wrote ${o} of ${total} bytes`);
  }

  return out;
}

/**
 * Strictly decode a canonical payload. Rejects unknown versions, trailing
 * bytes, oversized fields and invalid UTF-8 (fail closed).
 */
export function decodeCanonicalPayload(bytes: Uint8Array): CanonicalPayload {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;

  const version = view.getUint8(o);
  o += 1;
  if (version !== PROTOCOL_VERSION) {
    throw new ProtocolError(`Unsupported protocol version: ${version}`);
  }

  const readLen16 = (): number => {
    if (o + 2 > bytes.length) throw new ProtocolError('truncated payload');
    const len = view.getUint16(o, false);
    o += 2;
    return len;
  };
  const readLen32 = (): number => {
    if (o + 4 > bytes.length) throw new ProtocolError('truncated payload');
    const len = view.getUint32(o, false);
    o += 4;
    return len;
  };
  const readBytes = (len: number, label: string): Uint8Array => {
    if (o + len > bytes.length) throw new ProtocolError(`truncated ${label}`);
    const slice = bytes.slice(o, o + len);
    o += len;
    return slice;
  };

  const hostLen = readLen16();
  assertByteLen('hostContext', hostLen, MAX_HOST_CONTEXT_BYTES);
  const hostContext = utf8DecodeStrict(readBytes(hostLen, 'hostContext'));

  const pathLen = readLen16();
  assertByteLen('articlePath', pathLen, MAX_ARTICLE_PATH_BYTES);
  const articlePath = utf8DecodeStrict(readBytes(pathLen, 'articlePath'));

  const nickLen = readLen16();
  assertByteLen('nickname', nickLen, MAX_NICKNAME_BYTES);
  const nickname = utf8DecodeStrict(readBytes(nickLen, 'nickname'));

  const bodyLen = readLen32();
  assertByteLen('body', bodyLen, MAX_BODY_BYTES);
  const body = utf8DecodeStrict(readBytes(bodyLen, 'body'));

  const challengeId = readBytes(CHALLENGE_ID_BYTES, 'challengeId');

  if (o + NONCE_BYTES > bytes.length) throw new ProtocolError('truncated nonce');
  const nonce = view.getBigUint64(o, false);
  o += NONCE_BYTES;

  if (o !== bytes.length) {
    throw new ProtocolError(`trailing bytes after canonical payload (${bytes.length - o})`);
  }

  return { version, hostContext, articlePath, nickname, body, challengeId, nonce };
}

/** Serialize a uint64 nonce for JSON: number when safe, decimal string otherwise. */
export function serializeNonce(nonce: bigint): number | string {
  if (nonce < 0n || nonce > UINT64_MAX) {
    throw new ProtocolError('nonce out of uint64 range');
  }
  if (nonce <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(nonce);
  }
  return nonce.toString(10);
}

/** Parse a JSON nonce (number or decimal string) back into a uint64 bigint. */
export function parseNonce(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ProtocolError('nonce must be a non-negative safe integer');
    }
    return BigInt(value);
  }
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) {
      throw new ProtocolError('nonce string must be a non-negative decimal integer');
    }
    const n = BigInt(value);
    if (n > UINT64_MAX) throw new ProtocolError('nonce out of uint64 range');
    return n;
  }
  throw new ProtocolError('nonce must be a number or decimal string');
}

function assertByteLen(field: string, actual: number, max: number): void {
  if (actual > max) {
    throw new ProtocolError(`${field} exceeds ${max} UTF-8 bytes (got ${actual})`);
  }
}
