/** The chat route a task was created from, so a run can reply in the same thread. */
export interface TaskOriginRoute {
  channelType: string;
  platformId: string;
  threadId: string | null;
}

export interface TaskContent {
  prompt: string;
  script: string | null;
  originSessionId: string | null;
  originRoute: TaskOriginRoute | null;
}

function parseOriginRoute(value: unknown): TaskOriginRoute | null {
  if (typeof value !== 'object' || value === null) return null;
  const route = value as Record<string, unknown>;
  if (typeof route.channelType !== 'string' || typeof route.platformId !== 'string') return null;
  if (route.threadId !== null && route.threadId !== undefined && typeof route.threadId !== 'string') return null;
  return { channelType: route.channelType, platformId: route.platformId, threadId: route.threadId ?? null };
}

/** Decode the storage-neutral task content envelope. */
export function parseTaskContent(raw: string): TaskContent {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      prompt: typeof parsed.prompt === 'string' ? parsed.prompt : '',
      script: typeof parsed.script === 'string' ? parsed.script : null,
      originSessionId: typeof parsed.originSessionId === 'string' ? parsed.originSessionId : null,
      originRoute: parseOriginRoute(parsed.originRoute),
    };
    // eslint-disable-next-line no-catch-all/no-catch-all -- LEGACY-COMPAT(v1-tasks): plain-string content predating the JSON envelope
  } catch {
    return { prompt: raw, script: null, originSessionId: null, originRoute: null };
  }
}
