/**
 * Proves the API-wide rate limit is what the environment says it is.
 *
 *   npx tsx scripts/check-rate-limit.ts
 *
 * Boots the real app on an ephemeral port and drives one IP past the ceiling. It exists
 * because the limiter's configuration was wrong for a long time without anything noticing:
 * the API-wide guard was set to 100 requests per FIFTEEN minutes, which is stricter than
 * every endpoint-specific limiter sitting behind it, and the only symptom was telecallers
 * being signed out during ordinary work.
 *
 * The e2e suite cannot check this — it raises the ceiling for itself so that the limiter
 * cannot turn an unrelated assertion into a 429 — so the check lives here, on its own, and
 * reads the defaults rather than overriding them.
 *
 * No database is touched. Every request goes to an unauthenticated route and is expected
 * to be refused on its merits; the only thing under test is WHICH refusal comes back.
 */
import dotenv from 'dotenv';

dotenv.config();

process.env.NODE_ENV = 'development';
process.env.LOG_LEVEL = 'error';
process.env.JWT_SECRET ??= 'rate-limit-check-secret-that-is-long-enough-to-pass';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}`);
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
  }
}

async function main(): Promise<void> {
  const { config } = await import('../src/config/env');
  const { createApp } = await import('../src/app');

  const max = config.rateLimit.max;
  const windowSeconds = Math.round(config.rateLimit.globalWindowMs / 1000);

  console.log(`\nAPI-wide limit: ${max} requests / ${windowSeconds}s per IP\n`);

  const app = createApp();
  const listener = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });

  const address = listener.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  // A route that needs no database and no credentials. What it returns does not matter;
  // only whether the limiter answered first.
  const url = `http://127.0.0.1:${port}/api/mobile/auth/me`;

  try {
    check(
      'the configured limit is the one the request asked for',
      max === 120 && windowSeconds === 60,
      { max, windowSeconds },
    );

    const first = await fetch(url);
    check(
      'the advertised policy matches the configuration',
      first.headers.get('ratelimit-policy') === `${max};w=${windowSeconds}`,
      first.headers.get('ratelimit-policy'),
    );
    check('a request well inside the ceiling is not rate limited', first.status !== 429, first.status);

    /*
     * Up to the ceiling exactly. One request has already been spent, so this takes the
     * count to `max` — the last request that must still be allowed through.
     */
    let lastBelow = 0;
    for (let i = 1; i < max; i += 1) {
      lastBelow = (await fetch(url)).status;
    }

    check(`request number ${max} is still allowed`, lastBelow !== 429, lastBelow);

    const overLimit = await fetch(url);
    check(`request number ${max + 1} is refused with 429`, overLimit.status === 429, overLimit.status);
    check(
      'and the refusal says when to come back',
      Number(overLimit.headers.get('retry-after')) > 0 &&
        Number(overLimit.headers.get('retry-after')) <= windowSeconds,
      overLimit.headers.get('retry-after'),
    );

    /*
     * The anti-guessing limiters must NOT have inherited the short window. This is the
     * regression the split exists to prevent: five signups per minute instead of five per
     * fifteen would be sixty times as many attempts an hour.
     */
    check(
      'the anti-guessing window is still measured in minutes, not seconds',
      config.rateLimit.windowMs >= 15 * 60 * 1000,
      { windowMs: config.rateLimit.windowMs },
    );
    check(
      'and it is independent of the API-wide window',
      config.rateLimit.windowMs !== config.rateLimit.globalWindowMs,
      { anti: config.rateLimit.windowMs, global: config.rateLimit.globalWindowMs },
    );
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

void main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
