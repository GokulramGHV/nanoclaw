/**
 * Plain, safe descriptions of tool calls for the progress plan.
 * Tool input is never included, except Bash's own description,
 * cut to one line of at most 80 characters.
 */
const FIXED: Record<string, string> = {
  Read: 'Reading files',
  Edit: 'Editing files',
  Write: 'Editing files',
  Grep: 'Searching files',
  Glob: 'Searching files',
  WebSearch: 'Searching the web',
  WebFetch: 'Reading a web page',
  Task: 'Working with a helper agent',
  Skill: 'Using a skill',
};

export function describeTool(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash') {
    const d = typeof input.description === 'string' ? (input.description.split('\n')[0] ?? '').trim() : '';
    return d ? d.slice(0, 80) : 'Running a command';
  }
  if (Object.hasOwn(FIXED, name)) return FIXED[name]!;
  const m = /^mcp__([^_].*?)__/.exec(name);
  if (m) return `Using ${m[1]}`;
  return 'Working';
}
