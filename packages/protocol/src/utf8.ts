import { ProtocolError } from './errors.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Returns true when `s` contains an unpaired UTF-16 surrogate.
 *
 * JavaScript strings are UTF-16. `TextEncoder` silently replaces unpaired
 * surrogates with U+FFFD, which would silently corrupt the canonical byte
 * sequence (and let two different inputs collapse into the same encoding).
 * The protocol must FAIL CLOSED on such input instead.
 */
export function hasUnpairedSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: must be followed by a low surrogate.
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++; // consume the pair
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // Lone low surrogate.
      return true;
    }
  }
  return false;
}

/** Encode a string to UTF-8, rejecting invalid encodings (unpaired surrogates). */
export function utf8EncodeStrict(s: string): Uint8Array {
  if (hasUnpairedSurrogate(s)) {
    throw new ProtocolError('Invalid UTF-8: input contains an unpaired surrogate');
  }
  return encoder.encode(s);
}

/** Strictly decode bytes as UTF-8, rejecting malformed sequences. */
export function utf8DecodeStrict(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new ProtocolError('Invalid UTF-8: byte sequence is not valid UTF-8');
  }
}
