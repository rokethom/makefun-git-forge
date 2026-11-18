// The entry's lifecycle, as the trial's env settles it: bind an ephemeral port, tell the env which
// port that is, then wait until the env says the trial is over and exit 0. The suite scores the
// server app.ts builds; this file is only the handshake with the env, so it stays small.
//
//   1. MAKEFUN_ENV_URL names the env's origin. Without it there is nothing to talk to: exit 1.
//   2. createApp() builds the server; listen(0) lets the kernel pick a free port. Never 8080: the
//      env owns that one.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the address the request came
//      from plus N as the entry's base URL. A 409 means another entry registered first, which is
//      not this process's to fix, so it waits like any other answer.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env answers at once, so this
//      is a poll, not a held request; a failed or slow poll is retried with a short backoff.
//   5. Close the server and exit 0. The harness then stops the env, which writes the export the
//      scorer reads.

import { createApp } from './app.ts';

/** The env's origin, without a trailing slash; empty when the trial did not set one. */
const ENV_ORIGIN = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

/** How long one register or done request may take before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;

/** The first wait between retries, and the longest. */
const RETRY_FIRST_MS = 250;
const RETRY_CEILING_MS = 2_000;

/** Resolve after `ms` milliseconds. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The wait after `attempt` failed requests: exponential from RETRY_FIRST_MS, capped. */
function backoff(attempt: number): number {
  return Math.min(RETRY_CEILING_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/**
 * POST the bound port until the env takes it. 200 is the normal answer and 409 means a first
 * register already won; 400 and 405 are contract errors and end the program; anything else, a
 * network error included, is retried because the env may still be starting.
 */
async function announcePort(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const answer = await fetch(`${ENV_ORIGIN}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (answer.status === 200 || answer.status === 409) return;
      if (answer.status === 400 || answer.status === 405) {
        throw new Error(`register answered HTTP ${answer.status}: ${await answer.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await pause(backoff(attempt));
  }
}

/** Poll GET /done until it answers {"done":true}; never return before that. */
async function awaitTrialEnd(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const answer = await fetch(`${ENV_ORIGIN}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (answer.ok) {
        const body = (await answer.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await pause(backoff(attempt));
  }
}

/** Bind the port, register it, then wait for the env: the whole life of the process. */
async function run(): Promise<void> {
  if (ENV_ORIGIN === '') {
    process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
    process.exit(1);
  }
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await announcePort(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitTrialEnd();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
