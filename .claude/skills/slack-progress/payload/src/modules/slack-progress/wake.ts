import { registerWakeContext, type ContextBlock, type WakeContextInput } from '../../wake-context.js';
import { a2aRooms } from './a2a-rooms.js';
import { isEnabled } from './settings.js';

/** What the agent is told on each engaged message while progress display is on. Kept fixed so it adds little noise. */
const DISPLAY_TEXT =
  "People in this chat see your task list and your current step live, in a plan message and a status line. Do not report step progress in chat: no lines like 'Steps 1 and 2 are done', 'All four steps are done', or 'Now I will...'. Do not send any message until the work is done, unless you must ask a question you cannot continue without or the work has failed. Do not explain retries, corrections or changes of approach: just make them. Your final reply is the result itself, with no recap of which steps finished and no account of how you got there.";

function channelOf(platformId: string): string {
  const id = platformId.startsWith('slack:') ? platformId.slice('slack:'.length) : platformId;
  return id.split(':')[0];
}

/** Tell the agent its progress is already shown, so it stops narrating it. Never throws. */
export async function progressDisplayContext(input: WakeContextInput): Promise<ContextBlock[]> {
  try {
    if (input.mg.channel_type !== 'slack') return [];
    if (a2aRooms().has(channelOf(input.mg.platform_id))) return [];
    if (!(await isEnabled(input.agentGroup.id))) return [];
    return [
      {
        key: 'display',
        tag: 'progress-display',
        about: 'How your progress is shown in this chat',
        lines: [
          {
            sender: 'system',
            time: input.trigger.timestamp || new Date().toISOString(),
            text: DISPLAY_TEXT,
          },
        ],
      },
    ];
    // eslint-disable-next-line no-catch-all/no-catch-all -- context only: the message goes through either way
  } catch {
    return [];
  }
}

registerWakeContext('slack-progress', progressDisplayContext);
