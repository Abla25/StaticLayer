/**
 * Errors thrown by the protocol package.
 *
 * All validation failures in the protocol throw `ProtocolError` (fail closed).
 * The runtime layer maps these to HTTP 400/422 responses.
 */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}
