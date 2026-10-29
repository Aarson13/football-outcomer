/* functions/api/[[path]].js — Cloudflare Pages Function: every /api/* request is answered by
 * handleApi() in worker/api.js. `[[path]]` is the optional catch-all, so the router inside the
 * worker (health, spaces, doc) is the only routing that exists.
 *
 * `env.DB` is the D1 binding declared in wrangler.jsonc; the deployment applies it.
 */
import { handleApi } from '../../worker/api.js';

export async function onRequest({ request, env }) {
  try {
    return await handleApi(request, env);
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'server', message: 'The sync service hit an unexpected error.' }),
      {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      },
    );
  }
}
