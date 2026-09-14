import { describe, expect, it } from 'vitest';
import { hasCrypto, open, seal } from './crypto';

/* ------------------------------------------------------------------ *
 * What these pin.
 *
 * The round trip is the easy half and the least interesting. What
 * matters is everything that must FAIL: a link opened with the wrong
 * key, a blob a store altered, a URL a chat client truncated. AES-GCM
 * authenticates as well as encrypts, and the whole reason for choosing
 * it over CBC is that those cases come back as null rather than as
 * plausible garbage that the decoder downstream then has to catch.
 * ------------------------------------------------------------------ */

const bytes = (...n: number[]): Uint8Array<ArrayBuffer> => new Uint8Array(n);

/** IV (12) + at least one block + GCM tag (16). */
const MIN_BLOB = 12 + 16;

describe('seal and open', () => {
  it('is available in this environment', () => {
    expect(hasCrypto()).toBe(true);
  });

  it('round trips the bytes exactly', async () => {
    const plain = bytes(0, 1, 2, 250, 255, 128, 64);
    const { blob, key } = await seal(plain);
    expect(await open(blob, key)).toEqual(plain);
  });

  it('round trips an empty payload', async () => {
    // A design cannot be empty, but the encoder's framing byte is the
    // only thing guaranteeing that, and this layer should not depend on
    // a guarantee made two modules away.
    const { blob, key } = await seal(bytes());
    expect(await open(blob, key)).toEqual(bytes());
  });

  it('round trips a payload larger than one AES block', async () => {
    const plain = new Uint8Array(5000);
    for (let i = 0; i < plain.length; i++) plain[i] = i % 256;
    const { blob, key } = await seal(plain);
    expect(await open(blob, key)).toEqual(plain);
  });

  it('produces a 128 bit key', async () => {
    const { key } = await seal(bytes(1));
    expect(key.length).toBe(16);
  });

  it('prepends a 12 byte IV, so the blob outgrows the plaintext', async () => {
    const plain = bytes(1, 2, 3);
    const { blob } = await seal(plain);
    expect(blob.length).toBeGreaterThanOrEqual(MIN_BLOB);
  });

  it('never reuses a key between designs', async () => {
    const a = await seal(bytes(1));
    const b = await seal(bytes(1));
    expect(a.key).not.toEqual(b.key);
  });

  it('never reuses an IV, which is what makes one key per design safe', async () => {
    const a = await seal(bytes(1));
    const b = await seal(bytes(1));
    expect(a.blob.subarray(0, 12)).not.toEqual(b.blob.subarray(0, 12));
  });

  it('encrypts the same bytes to different blobs each time', async () => {
    const a = await seal(bytes(7, 7, 7));
    const b = await seal(bytes(7, 7, 7));
    expect(a.blob).not.toEqual(b.blob);
  });
});

describe('open refuses what it should', () => {
  it('refuses a key from another design', async () => {
    const { blob } = await seal(bytes(1, 2, 3));
    const { key: other } = await seal(bytes(9, 9, 9));
    expect(await open(blob, other)).toBeNull();
  });

  it('refuses a blob whose ciphertext was altered', async () => {
    const { blob, key } = await seal(bytes(1, 2, 3, 4, 5));
    const tampered = new Uint8Array(blob);
    tampered[tampered.length - 1] ^= 0x01;
    expect(await open(tampered, key)).toBeNull();
  });

  it('refuses a blob whose IV was altered', async () => {
    const { blob, key } = await seal(bytes(1, 2, 3, 4, 5));
    const tampered = new Uint8Array(blob);
    tampered[0] ^= 0x01;
    expect(await open(tampered, key)).toBeNull();
  });

  it('refuses a truncated blob rather than throwing', async () => {
    const { blob, key } = await seal(bytes(1, 2, 3, 4, 5));
    for (const cut of [0, 1, 11, 12, 13, blob.length - 1]) {
      expect(await open(blob.subarray(0, cut), key)).toBeNull();
    }
  });

  it('refuses a blob with bytes appended', async () => {
    const { blob, key } = await seal(bytes(1, 2, 3));
    const longer = new Uint8Array(blob.length + 4);
    longer.set(blob);
    expect(await open(longer, key)).toBeNull();
  });

  it('refuses a key of the wrong length rather than throwing', async () => {
    const { blob } = await seal(bytes(1, 2, 3));
    for (const n of [0, 1, 8, 15, 17, 32]) {
      expect(await open(blob, new Uint8Array(n))).toBeNull();
    }
  });

  it('refuses random bytes that were never a blob', async () => {
    const { key } = await seal(bytes(1));
    const junk = new Uint8Array(64);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 37) % 256;
    expect(await open(junk, key)).toBeNull();
  });
});
