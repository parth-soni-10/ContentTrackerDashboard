/* ---------------------------------------------------------------------------
 * The Pages Function this site is served by.
 *
 * Pages is this site's only host. `functions/[[path]].js` is the catch-all
 * route, so every request to the site arrives here, and the router it imports -
 * `_router.js` - does the work: it answers the `/.netlify/functions/*` paths the
 * page has always called, wiring this request's bindings and headers into the
 * shape those functions expect, and hands everything else to `env.ASSETS`.
 *
 * Why two files rather than one: Pages compiles every file in this directory as
 * a route, and only the entry needs to be one. `_router.js` carries the
 * underscore prefix Pages treats as private - a module, never a path of its own
 * - so the routing table is exactly the one catch-all below, and there is no
 * per-endpoint file to keep in step with `app.js`.
 *
 * This is what replaced the Workers deployment: those functions used to be
 * bundled into a Worker script and staged as the deployment's `_worker.js`.
 * Pages compiles them itself now, which is where the site was already being
 * served from, minus the bundle step and the second config.
 * ------------------------------------------------------------------------ */
import router from './_router.js';

export const onRequest = (context) => router.fetch(context.request, context.env, context);
