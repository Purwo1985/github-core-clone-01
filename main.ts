// Entry point: starts the app server, hands its port to the trial
// environment, then idles until the environment reports the trial is
// finished. This file only runs the handshake; every API route lives
// in app.ts, which is where the actual server behaviour is defined.
//
// The handshake, step by step:
//   - MAKEFUN_ENV_URL points at the environment (for example
//     http://store:8080 inside a trial container). With no value there
//     is nobody to talk to, so the process stops immediately.
//   - The server binds port 0, letting the kernel choose a free one.
//     Port 8080 is never used here: that one belongs to the env.
//   - POST /register tells the env the chosen port, so it knows where
//     to send trial traffic. A 409 only means some other entry got
//     there first; this process simply carries on waiting.
//   - GET /done is polled until the body reads {"done": true}.
//   - The server is closed and the process leaves with code 0.

import { createApp } from './app.ts';

const trialOrigin = readTrialOrigin();

function readTrialOrigin(): string {
  const raw = process.env.MAKEFUN_ENV_URL ?? '';
  const cleaned = raw.replace(/\/+$/, '');
  if (cleaned.length === 0) {
    process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
    process.exit(1);
  }
  return cleaned;
}

const timings = {
  /** Longest a single register or done request may run before giving up. */
  requestBudgetMs: 30_000,
  /** Pause before the first retry after a failed attempt. */
  firstRetryMs: 250,
  /** Retry pauses grow but never past this. */
  longestRetryMs: 2_000,
};

const pause = (ms: number): Promise<void> =>
  new Promise<void>((wake) => setTimeout(wake, ms));

/** Yields an ever-longer pause: doubles each time, capped at the longest. */
function makeBackoff(): () => Promise<void> {
  let nextMs = timings.firstRetryMs;
  return async () => {
    await pause(nextMs);
    nextMs = Math.min(timings.longestRetryMs, nextMs * 2);
  };
}

/**
 * Keeps POSTing the bound port to /register. A 200 accepts it and a 409
 * means an earlier registration already stands, so both finish the job.
 * A 400 or 405 is a contract problem and aborts the process, while a
 * network failure or any other status just waits and tries again — the
 * environment may still be coming up.
 */
async function announcePort(port: number): Promise<void> {
  const backOff = makeBackoff();
  for (;;) {
    let reply: Response | null = null;
    try {
      reply = await fetch(`${trialOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(timings.requestBudgetMs),
      });
    } catch {
      await backOff();
      continue;
    }
    if (reply.status === 200 || reply.status === 409) return;
    if (reply.status === 400 || reply.status === 405) {
      throw new Error(`register failed with HTTP ${reply.status}: ${await reply.text()}`);
    }
    await backOff();
  }
}

/** Polls GET /done and only returns once the body says {"done": true}. */
async function waitUntilDone(): Promise<void> {
  const backOff = makeBackoff();
  for (;;) {
    try {
      const reply = await fetch(`${trialOrigin}/done`, {
        signal: AbortSignal.timeout(timings.requestBudgetMs),
      });
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // No answer yet, or the request timed out: not done, so poll again.
    }
    await backOff();
  }
}

/** Bind, announce the port, wait for the trial to end, then shut down. */
async function runEntry(): Promise<void> {
  const appServer = createApp();
  const listening = new Promise<void>((resolveListen, rejectListen) => {
    appServer.once('error', rejectListen);
    appServer.listen(0, () => resolveListen());
  });
  await listening;
  const bound = appServer.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('could not determine the ephemeral TCP port the server bound');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitUntilDone();
  appServer.close();
  process.stdout.write('[entry] done\n');
}

runEntry()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
