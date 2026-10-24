import { createHmac } from 'node:crypto';

/**
 * RFC 6238 time-based one-time passwords — what an authenticator app shows, generated
 * from the base32 secret Angel issues when TOTP is enabled for SmartAPI.
 *
 * Twenty lines on node:crypto rather than a dependency: the algorithm is fixed by the
 * RFC, and the e2e section checks this against the RFC's own test vector.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const TOTP_STEP_SECONDS = 30;

/** Decodes an RFC 4648 base32 string. Spaces and padding are ignored; case is not significant. */
export function base32Decode(secret: string): Buffer {
  const cleaned = secret.replace(/[\s=]/g, '').toUpperCase();
  if (cleaned.length === 0) throw new Error('empty base32 secret');

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) throw new Error('invalid base32 character');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** The code for the 30-second step containing `atMs`. */
export function totpAt(secret: Buffer, atMs: number, digits = 6): string {
  const counter = Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** Seconds left before the code for `atMs` rolls over. */
export function totpSecondsLeft(atMs: number): number {
  return TOTP_STEP_SECONDS - ((atMs / 1000) % TOTP_STEP_SECONDS);
}
