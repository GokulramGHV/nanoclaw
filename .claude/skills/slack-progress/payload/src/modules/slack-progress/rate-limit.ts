/**
 * Retry a Slack call that was answered with `ratelimited`. slackCall turns the
 * answer into an error and does not expose Retry-After, so this waits a short,
 * bounded time between tries. Any other error is thrown at once. If every try
 * is rate limited, the last error is thrown.
 */
export const rateLimit = { delaysMs: [2000, 4000, 8000] };

export function isRateLimited(err: unknown): boolean {
  return err instanceof Error && err.message.includes('ratelimited');
}

export async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const delay = rateLimit.delaysMs[attempt];
      if (!isRateLimited(err) || delay === undefined) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
