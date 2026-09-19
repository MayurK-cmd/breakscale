import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ShareStoreError,
  fetchStored,
  hasStoredLink,
  setEndpointForTests,
  storeTopology,
} from './store';
import { PRESETS } from '../sim/presets';
import type { Topology } from '../sim/types';

/* ------------------------------------------------------------------ *
 * What these pin.
 *
 * The store is the one part of sharing that can fail for reasons
 * nothing in this repo controls: a network that is down, a rate limit, a
 * response that is not what the contract says. Every one of those
 * reaches a reader who has just pressed a button, so the rule is that
 * none of them throws past the caller and none of them ends in a blank
 * canvas.
 *
 * `fetch` is stubbed rather than pointed at a running Worker. A test
 * that needs a server running is a test that fails on someone else's
 * machine, and the thing worth pinning here is how this module behaves
 * given each answer, not that the Worker produces them.
 * ------------------------------------------------------------------ */

const BASE = 'https://breakscale.tech/';
const SIMPLE: Topology = PRESETS[0]!.topology;

/** Real bytes of a real design, so decode is exercised rather than faked. */
async function sealedBlobFor(
  topology: Topology,
): Promise<{ blob: Uint8Array; key: string }> {
  const { encodeBytes } = await import('../share');
  const { seal } = await import('./crypto');
  const { blob, key } = await seal(await encodeBytes(topology));
  const b64 = btoa(String.fromCharCode(...key))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return { blob, key: b64 };
}

// A store, named here rather than read from the environment: these
// tests must behave the same on a contributor's machine, where no
// endpoint is configured, as on one where it is.
beforeEach(() => {
  setEndpointForTests('https://store.test');
});

afterEach(() => {
  setEndpointForTests(null);
  vi.unstubAllGlobals();
});

describe('with no store configured', () => {
  it('refuses to build a link rather than pretending to', async () => {
    setEndpointForTests('');
    await expect(storeTopology(SIMPLE, BASE)).rejects.toBeInstanceOf(ShareStoreError);
  });

  it('reports a stored link it has no way to open', async () => {
    setEndpointForTests('');
    const res = await fetchStored('?s=abcdefghijklmn', '#k=7FT3tbd51aRuTZRXPhrLug');
    expect(res.status).toBe('invalid');
  });
});

describe('hasStoredLink', () => {
  it('wants both halves, because either alone is a different kind of link', () => {
    expect(hasStoredLink('?s=abc', '#k=xyz')).toBe(true);
    expect(hasStoredLink('?s=abc', '')).toBe(false);
    expect(hasStoredLink('', '#k=xyz')).toBe(false);
    expect(hasStoredLink('', '')).toBe(false);
  });

  it('leaves a fragment link alone', () => {
    // A d3 link has no id in the query, so the two paths can never both
    // claim the same URL.
    expect(hasStoredLink('', '#d3.AU2OPU7DQBSE')).toBe(false);
  });

  it('tolerates a missing leading hash', () => {
    expect(hasStoredLink('?s=abc', 'k=xyz')).toBe(true);
  });
});

describe('storeTopology', () => {
  it('reports a store that cannot be reached, rather than throwing past the caller', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    await expect(storeTopology(SIMPLE, BASE)).rejects.toBeInstanceOf(ShareStoreError);
  });

  it('says how long to wait when the store rate limits', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 429 })));
    // The number matters more than the wording: a wait nobody has put a
    // figure on reads as indefinite.
    await expect(storeTopology(SIMPLE, BASE)).rejects.toThrow(/minute/i);
  });

  it('points an oversized design at the file export', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 413 })));
    await expect(storeTopology(SIMPLE, BASE)).rejects.toThrow(/file/i);
  });

  it('reports a refusal', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 413 })));
    await expect(storeTopology(SIMPLE, BASE)).rejects.toBeInstanceOf(ShareStoreError);
  });

  it('reports a body that is not the shape the contract promises', async () => {
    for (const body of ['{}', '{"id":42}', 'not json', '[]']) {
      vi.stubGlobal('fetch', () =>
        Promise.resolve(new Response(body, { status: 200 })),
      );
      await expect(storeTopology(SIMPLE, BASE)).rejects.toBeInstanceOf(ShareStoreError);
    }
  });

  it('sends the ciphertext alone, with nothing identifying the sender', async () => {
    let sent: RequestInit | undefined;
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      sent = init;
      return Promise.resolve(new Response('{"id":"abcdefghijklmn"}', { status: 200 }));
    });
    await storeTopology(SIMPLE, BASE);

    expect(sent?.method).toBe('POST');
    const body = sent?.body as Uint8Array;
    expect(body).toBeInstanceOf(Uint8Array);
    // Whatever else it is, it is not the readable design: the node kinds
    // that appear in the JSON must not survive into what gets uploaded.
    expect(new TextDecoder().decode(body)).not.toContain('client');
  });

  it('puts the id in the query and the key in the fragment', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('{"id":"abcdefghijklmn"}', { status: 200 })),
    );
    const url = await storeTopology(SIMPLE, BASE);
    const parsed = new URL(url);

    expect(parsed.searchParams.get('s')).toBe('abcdefghijklmn');
    expect(parsed.hash).toMatch(/^#k=[A-Za-z0-9\-_]{22}$/);
    // The key is the half a server must never see, so it must not have
    // leaked into the part a server does.
    expect(parsed.search).not.toContain(parsed.hash.slice(3));
  });

  it('replaces a fragment the base URL already carried', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('{"id":"abcdefghijklmn"}', { status: 200 })),
    );
    const url = await storeTopology(SIMPLE, `${BASE}#d3.SOMETHINGOLD`);
    expect(url).not.toContain('d3.');
  });
});

describe('fetchStored', () => {
  it('opens a design that went through the whole pipeline', async () => {
    const { blob, key } = await sealedBlobFor(SIMPLE);
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(blob as BodyInit, { status: 200 })),
    );

    const res = await fetchStored('?s=abcdefghijklmn', `#k=${key}`);
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.topology.nodes.length).toBe(SIMPLE.nodes.length);
    expect(res.topology.edges.length).toBe(SIMPLE.edges.length);
  });

  it('says absent when the URL is not a stored link', async () => {
    expect((await fetchStored('', '')).status).toBe('absent');
    expect((await fetchStored('?s=abc', '')).status).toBe('absent');
  });

  it('reports a key that is not a key rather than opening nothing', async () => {
    const { blob } = await sealedBlobFor(SIMPLE);
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(blob as BodyInit, { status: 200 })),
    );
    for (const k of ['', 'short', '!!!!not-base64!!!!', 'A'.repeat(22)]) {
      const res = await fetchStored('?s=abcdefghijklmn', `#k=${k}`);
      expect(res.status).toBe('invalid');
    }
  });

  it('reports a store that is down, and says which problem it was', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    const res = await fetchStored('?s=abcdefghijklmn', '#k=7FT3tbd51aRuTZRXPhrLug');
    expect(res.status).toBe('invalid');
    if (res.status !== 'invalid') return;
    expect(res.message).toMatch(/could not reach/i);
  });

  it('reports an id the store does not have', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 404 })));
    const res = await fetchStored('?s=abcdefghijklmn', '#k=7FT3tbd51aRuTZRXPhrLug');
    expect(res.status).toBe('invalid');
  });

  it('refuses an empty body and an oversized one', async () => {
    for (const body of [new Uint8Array(0), new Uint8Array(300 * 1024)]) {
      vi.stubGlobal('fetch', () =>
        Promise.resolve(new Response(body as BodyInit, { status: 200 })),
      );
      const res = await fetchStored('?s=abcdefghijklmn', '#k=7FT3tbd51aRuTZRXPhrLug');
      expect(res.status).toBe('invalid');
    }
  });

  it('refuses a blob the store altered', async () => {
    const { blob, key } = await sealedBlobFor(SIMPLE);
    const tampered = new Uint8Array(blob);
    tampered[tampered.length - 2] ^= 0x01;
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(tampered as BodyInit, { status: 200 })),
    );

    const res = await fetchStored('?s=abcdefghijklmn', `#k=${key}`);
    expect(res.status).toBe('invalid');
  });

  it('refuses a blob that decrypts but was never a design', async () => {
    const { seal } = await import('./crypto');
    const { blob, key } = await seal(new Uint8Array([9, 9, 9, 9]));
    const b64 = btoa(String.fromCharCode(...key))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(blob as BodyInit, { status: 200 })),
    );

    const res = await fetchStored('?s=abcdefghijklmn', `#k=${b64}`);
    expect(res.status).toBe('invalid');
  });
});
