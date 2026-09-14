/* ------------------------------------------------------------------ *
 * The share-link store.
 *
 * Two routes over one KV namespace: put a blob in, get it back by id.
 * That is the whole service, and it is deliberately the whole service.
 *
 * WHAT THIS CANNOT DO, BY CONSTRUCTION. Every blob arrives encrypted
 * with a key that only ever existed in the sender's browser and travels
 * in the URL fragment, which browsers do not transmit. So this Worker
 * cannot read a design, cannot search for one, and cannot hand one to
 * anybody who was not given the link. Losing the whole store would leak
 * nothing. That property is why there is no account system here and no
 * need for one.
 *
 * It also means the store cannot tell a design from a file someone
 * uploaded to use this as free hosting, because it cannot see either.
 * The defences are therefore all shape rather than content: a size cap,
 * a rate limit per address, and ids the caller does not choose.
 * ------------------------------------------------------------------ */

export interface Env {
  LINKS: KVNamespace;
  /** The runtime's own limiter. Atomic, and it costs no KV writes. */
  WRITE_LIMIT: RateLimit;
  /** Origins allowed to call this. Comma separated. */
  ALLOWED_ORIGINS?: string;
}

interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Ceiling on one stored blob.
 *
 * A design that reaches this is already far past anything the editor
 * produces: the largest bundled example is about 1KB encrypted. The cap
 * exists so a single caller cannot park megabytes here, not to constrain
 * real designs, so it sits well above them and still well under KV's own
 * 25MiB value limit.
 */
const MAX_BLOB_BYTES = 256 * 1024;

/** A 12 byte IV plus a 16 byte GCM tag, which every sealed blob carries. */
const MIN_BLOB_BYTES = 28;

/* The write limit itself lives in wrangler.toml, because the runtime
 * enforces it rather than this file. A counter kept in KV would not work:
 * KV is eventually consistent, so concurrent requests all read the same
 * count and the limit is bypassed by sending requests in parallel, and
 * every attempt would spend one of the day's KV writes to record it. */

/**
 * Length of a generated id, in bytes before encoding.
 *
 * Ten bytes is 80 bits, which is not guessable: an attacker enumerating
 * ids to find designs they were not given would need on the order of
 * 2^40 requests before a single collision became likely, against a
 * Worker that rate limits. The id is not a secret (it travels in the
 * query string) but it should not be discoverable either.
 */
const ID_BYTES = 10;

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function newId(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(ID_BYTES)));
}

/**
 * An id that came from a URL. Anything outside the alphabet, or of the
 * wrong length, was never one of ours, so it is refused before it
 * reaches KV rather than being looked up and missed.
 */
function isId(s: string): boolean {
  return /^[A-Za-z0-9_-]{13,14}$/.test(s);
}

function allowList(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * Whether this origin may WRITE.
 *
 * Separate from the CORS headers on purpose. Those only stop a browser
 * from reading a response; they do not stop the request, so a POST from
 * a script with no Origin header at all is unaffected by them and the
 * blob still lands. Reads are deliberately not gated this way: a link is
 * meant to open wherever someone pasted it, including from a page that
 * embeds it, and the blob is useless without the key anyway.
 */
function mayWrite(env: Env, origin: string | null): boolean {
  const allowed = allowList(env);
  // Nothing configured is a self-hosted deployment that has not been told
  // who may call it, and locking it out of its own store would be worse
  // than leaving it open.
  if (allowed.length === 0) return true;
  return origin !== null && allowed.includes(origin);
}

function corsHeaders(env: Env, origin: string | null): Record<string, string> {
  const allowed = allowList(env);
  const allow =
    allowed.length === 0 ? '*' : origin && allowed.includes(origin) ? origin : '';
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  };
}

function json(
  body: unknown,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'content-type': 'application/json' },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('origin');
    const cors = corsHeaders(env, origin);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // POST /v1 -> { id }
    if (request.method === 'POST' && url.pathname === '/v1') {
      if (!mayWrite(env, origin)) return json({ error: 'not allowed' }, 403, cors);

      const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
      const { success } = await env.WRITE_LIMIT.limit({ key: ip });
      if (!success) return json({ error: 'rate limited' }, 429, cors);

      const body = await request.arrayBuffer();
      // Below the floor nothing sealed can be this small: a 12 byte IV
      // and a 16 byte GCM tag are present even for an empty payload. It
      // does not prove the body is one of ours, because the Worker cannot
      // read it, but it costs nothing and rejects the obvious junk.
      if (body.byteLength < MIN_BLOB_BYTES)
        return json({ error: 'too small' }, 400, cors);
      if (body.byteLength > MAX_BLOB_BYTES) {
        return json({ error: 'too large' }, 413, cors);
      }

      const id = newId();
      await env.LINKS.put(id, body);
      return json({ id }, 200, cors);
    }

    // GET /v1/:id -> the blob
    if (request.method === 'GET' && url.pathname.startsWith('/v1/')) {
      const id = url.pathname.slice('/v1/'.length);
      if (!isId(id)) return json({ error: 'not found' }, 404, cors);

      const blob = await env.LINKS.get(id, 'arrayBuffer');
      if (blob === null) return json({ error: 'not found' }, 404, cors);

      return new Response(blob, {
        status: 200,
        headers: {
          ...cors,
          'content-type': 'application/octet-stream',
          // A stored blob never changes: the id names this exact
          // ciphertext and a new design gets a new id. So it can be
          // cached hard, which is what keeps the free tier's read
          // budget clear of links that get opened repeatedly.
          'cache-control': 'public, max-age=31536000, immutable',
        },
      });
    }

    return json({ error: 'not found' }, 404, cors);
  },
};
