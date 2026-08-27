/**
 * Regression guard: the Cloudflare API client must call `fetch` with the
 * correct `this` when running inside workerd (Cloudflare Workers). Before the
 * fix, the client stored the bare global `fetch` and invoked it as a method,
 * which throws "Illegal invocation: function called with incorrect `this`
 * reference" — only in workerd, never in Node. This test runs the REAL client
 * inside Miniflare (workerd) and asserts it reaches the API without that error.
 */
import { CloudflareApiClient } from '@staticlayer/deployment-core/api';

export default {
  async fetch(): Promise<Response> {
    const client = new CloudflareApiClient({ accountId: 'acc-1', apiToken: 'tok-1' });
    try {
      const dbs = await client.listDatabases();
      return new Response(JSON.stringify({ ok: true, dbs }));
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: (err as Error).message }), { status: 500 });
    }
  },
};
