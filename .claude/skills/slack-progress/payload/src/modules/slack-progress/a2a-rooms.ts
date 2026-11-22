import { envValue } from '../../env.js';

/** Channel ids listed in SLACK_A2A_ROOMS. Bot-to-bot hand-offs there depend on mentions, so no plans or streams. */
export function a2aRooms(): Set<string> {
  const raw = envValue('SLACK_A2A_ROOMS') ?? '';
  return new Set(
    raw
      .split(',')
      .map((s) => {
        const t = s.trim();
        return t.startsWith('slack:') ? t.slice('slack:'.length) : t;
      })
      .filter(Boolean),
  );
}
