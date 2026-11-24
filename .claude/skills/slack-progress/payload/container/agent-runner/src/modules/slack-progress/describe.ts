/**
 * Plain, safe descriptions of tool calls for the progress plan.
 * Tool input is never included, except Bash's own description,
 * cut to one line of at most 80 characters, and the Skill tool's skill name
 * when it is a plain name.
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

/**
 * The agent's own built-in MCP server. Its name is internal, so its tools get
 * their own labels and the server name is never shown.
 */
const BUILT_IN_SERVER = 'nanoclaw';

const BUILT_IN: Record<string, string> = {
  send_message: 'Writing a message',
  edit_message: 'Editing a message',
  send_file: 'Sending a file',
  add_reaction: 'Reacting',
  send_card: 'Posting a card',
  post_card: 'Posting a card',
  ask: 'Asking a question',
  ask_user_question: 'Asking a question',
  create_agent: 'Setting up an agent',
  install_packages: 'Installing packages',
  add_mcp_server: 'Adding a tool',
};

/** A skill name as the Skill tool takes it ("pdf", "plugin:skill-name"). Anything else is not shown. */
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export function describeTool(name: string, input: Record<string, unknown>): string {
  if (name === 'Skill') {
    const skill = typeof input.skill === 'string' ? input.skill.trim() : '';
    return SKILL_NAME.test(skill) ? `Using skill ${skill}` : FIXED.Skill!;
  }
  if (name === 'Bash') {
    const d = typeof input.description === 'string' ? (input.description.split('\n')[0] ?? '').trim() : '';
    return d ? d.slice(0, 80) : 'Running a command';
  }
  if (Object.hasOwn(FIXED, name)) return FIXED[name]!;
  const m = /^mcp__([^_].*?)__(.*)$/.exec(name);
  if (m) {
    if (m[1] === BUILT_IN_SERVER) return Object.hasOwn(BUILT_IN, m[2]!) ? BUILT_IN[m[2]!]! : 'Working';
    return `Using ${m[1]}`;
  }
  return 'Working';
}
