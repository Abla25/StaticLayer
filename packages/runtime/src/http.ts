import { utf8EncodeStrict } from '@staticlayer/protocol';

/** Small HTTP helpers. All JSON responses are cache-disabled. */

/**
 * Strict UTF-8 byte length check of a field value.
 * Returns false for invalid UTF-8 (unpaired surrogates) or over-limit values.
 */
export function validField(value: string, maxBytes: number): boolean {
  let len: number;
  try {
    len = utf8EncodeStrict(value).length;
  } catch {
    return false;
  }
  return len <= maxBytes;
}

export function json(
  data: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

export type BodyRead =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413 };

/**
 * Read and parse a JSON request body with a hard byte cap (fail closed).
 *
 * The cap is enforced on the raw UTF-8 BYTE length of the body (via
 * ArrayBuffer), so it cannot be bypassed with multi-byte characters.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<BodyRead> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    return { ok: false, status: 413 };
  }
  let buffer: ArrayBuffer;
  try {
    buffer = await request.arrayBuffer();
  } catch {
    return { ok: false, status: 400 };
  }
  if (buffer.byteLength > maxBytes) {
    return { ok: false, status: 413 };
  }
  if (buffer.byteLength === 0) {
    return { ok: false, status: 400 };
  }
  let text: string;
  try {
    text = new TextDecoder().decode(buffer);
  } catch {
    return { ok: false, status: 400 };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400 };
  }
}
