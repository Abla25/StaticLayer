#!/usr/bin/env python3
"""
StaticLayer protocol v1 — independent test-vector generator.

INTENT: this script derives the expected byte sequences from the SPEC ONLY
(struct, hashlib, hmac, base64 — stdlib), completely independent from the
TypeScript implementation. The outputs are hardcoded into
packages/protocol/test/test-vectors.ts and asserted by Vitest. If the TS
implementation ever diverges from this canonical encoding, the tests fail.

Canonical payload v1 (all integers BIG-ENDIAN):
  version u8 | host_context_len u16 | host_context | article_path_len u16 |
  article_path | nickname_len u16 | nickname | body_len u32 | body |
  challenge_id (32) | nonce u64

Canonical challenge (signed):
  version u8 | host_context_len u16 | host_context | article_path_len u16 |
  article_path | challenge_id (32) | expires_at u64 | difficulty u8
"""
import base64
import hashlib
import hmac
import struct
import sys

# ---------------------------------------------------------------- fixtures
VERSION = 1
HOST_CONTEXT = "example.com"
ARTICLE_PATH = "/blog/hello-world"
NICKNAME = "Alice"
BODY = "Hello, world! This is a test comment."
CHALLENGE_ID = bytes(range(32))            # 00 01 .. 1f
NONCE = 0x0102030405060708                 # 72623859790382856
POW_SECRET = b"staticlayer-test-pow-secret"
EXPIRES_AT = 1710000000
DIFFICULTY = 16


def enc_payload(nickname, body, nonce):
    hc = HOST_CONTEXT.encode("utf-8")
    ap = ARTICLE_PATH.encode("utf-8")
    nk = nickname.encode("utf-8")
    bd = body.encode("utf-8")
    out = struct.pack(">B", VERSION)
    out += struct.pack(">H", len(hc)) + hc
    out += struct.pack(">H", len(ap)) + ap
    out += struct.pack(">H", len(nk)) + nk
    out += struct.pack(">I", len(bd)) + bd
    out += CHALLENGE_ID
    out += struct.pack(">Q", nonce)
    return out


def enc_challenge():
    hc = HOST_CONTEXT.encode("utf-8")
    ap = ARTICLE_PATH.encode("utf-8")
    out = struct.pack(">B", VERSION)
    out += struct.pack(">H", len(hc)) + hc
    out += struct.pack(">H", len(ap)) + ap
    out += CHALLENGE_ID
    out += struct.pack(">Q", EXPIRES_AT)
    out += struct.pack(">B", DIFFICULTY)
    return out


def leading_zero_bits(digest):
    bits = 0
    for byte in digest:
        if byte == 0:
            bits += 8
            continue
        b = byte
        while (b & 0x80) == 0:
            bits += 1
            b = (b << 1) & 0xFF
        break
    return bits


# ---------------------------------------------------------------- vector A: nominal
payload = enc_payload(NICKNAME, BODY, NONCE)
sig = hmac.new(POW_SECRET, enc_challenge(), hashlib.sha256).digest()

print("=== VECTOR A: nominal ===")
print("payload_len =", len(payload))
print("canonical_payload_hex =", payload.hex())
print("payload_sha256_hex =", hashlib.sha256(payload).hexdigest())
print("canonical_challenge_hex =", enc_challenge().hex())
print("challenge_signature_hex =", sig.hex())
print("challenge_signature_b64url =", base64.urlsafe_b64encode(sig).rstrip(b"=").decode())
print("challenge_id_b64url =", base64.urlsafe_b64encode(CHALLENGE_ID).rstrip(b"=").decode())

# ---------------------------------------------------------------- vector B: boundaries
MAX_HC = "h" * 255
MAX_AP = "/" * 255
MAX_NK = "a" * 50
MAX_BD = "b" * 3000
payload_b = enc_payload(MAX_NK, MAX_BD, 0)
# recompute with max host/path by hand (enc_payload uses fixed host/path):
hc = MAX_HC.encode("utf-8")
ap = MAX_AP.encode("utf-8")
nk = MAX_NK.encode("utf-8")
bd = MAX_BD.encode("utf-8")
payload_b = struct.pack(">B", VERSION)
payload_b += struct.pack(">H", len(hc)) + hc
payload_b += struct.pack(">H", len(ap)) + ap
payload_b += struct.pack(">H", len(nk)) + nk
payload_b += struct.pack(">I", len(bd)) + bd
payload_b += CHALLENGE_ID
payload_b += struct.pack(">Q", 0)
print("=== VECTOR B: boundary lengths (hc=255, ap=255, nick=50, body=3000) ===")
print("payload_len =", len(payload_b))
print("canonical_payload_hex =", payload_b.hex())
print("payload_sha256_hex =", hashlib.sha256(payload_b).hexdigest())

# ---------------------------------------------------------------- vector C: PoW mining
print("=== VECTOR C: PoW (difficulty 16) ===")
nonce = 0
found = None
while nonce <= 2_000_000:
    p = enc_payload(NICKNAME, BODY, nonce)
    h = hashlib.sha256(p).digest()
    if leading_zero_bits(h) >= 16:
        found = (nonce, h.hex(), leading_zero_bits(h))
        break
    nonce += 1
if found is None:
    print("FAIL: no nonce found")
    sys.exit(1)
print("pow_nonce =", found[0])
print("pow_nonce_sha256_hex =", found[1])
print("pow_nonce_leading_zero_bits =", found[2])
print("OK")
