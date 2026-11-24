import { describe, expect, test } from 'bun:test';
import { describeTool } from './describe.js';

describe('describeTool', () => {
  test('Bash uses its description', () => {
    expect(describeTool('Bash', { description: 'Run the tests' })).toBe('Run the tests');
  });
  test('Bash without a description', () => {
    expect(describeTool('Bash', {})).toBe('Running a command');
  });
  test('multi-line description keeps line one', () => {
    expect(describeTool('Bash', { description: 'First line\nSecond line' })).toBe('First line');
  });
  test('long description is cut to 80 characters', () => {
    expect(describeTool('Bash', { description: 'x'.repeat(200) })).toBe('x'.repeat(80));
  });
  test('file tools', () => {
    expect(describeTool('Read', {})).toBe('Reading files');
    expect(describeTool('Edit', {})).toBe('Editing files');
    expect(describeTool('Write', {})).toBe('Editing files');
    expect(describeTool('Grep', {})).toBe('Searching files');
    expect(describeTool('Glob', {})).toBe('Searching files');
  });
  test('web tools', () => {
    expect(describeTool('WebSearch', {})).toBe('Searching the web');
    expect(describeTool('WebFetch', {})).toBe('Reading a web page');
  });
  test('agent tools', () => {
    expect(describeTool('Task', {})).toBe('Working with a helper agent');
    expect(describeTool('Skill', {})).toBe('Using a skill');
  });
  test('Skill names the skill when it is a plain name', () => {
    expect(describeTool('Skill', { skill: 'team-tickets' })).toBe('Using skill team-tickets');
    expect(describeTool('Skill', { skill: 'plugin:pdf', args: 'secret stuff' })).toBe('Using skill plugin:pdf');
  });
  test('Skill hides anything that is not a plain name', () => {
    expect(describeTool('Skill', { skill: 'a b' })).toBe('Using a skill');
    expect(describeTool('Skill', { skill: '<!channel>' })).toBe('Using a skill');
    expect(describeTool('Skill', { skill: 'x'.repeat(65) })).toBe('Using a skill');
    expect(describeTool('Skill', { skill: 42 })).toBe('Using a skill');
  });
  test('mcp and unknown tools', () => {
    expect(describeTool('mcp__github__get_repo', {})).toBe('Using github');
    expect(describeTool('Unknown', {})).toBe('Working');
  });
  test('built-in tools get their own labels, never the server name', () => {
    expect(describeTool('mcp__nanoclaw__ask', {})).toBe('Asking a question');
    expect(describeTool('mcp__nanoclaw__post_card', {})).toBe('Posting a card');
    expect(describeTool('mcp__nanoclaw__send_message', {})).toBe('Writing a message');
    expect(describeTool('mcp__nanoclaw__some_new_tool', {})).toBe('Working');
    expect(describeTool('mcp__nanoclaw__constructor', {})).toBe('Working');
  });
  test('never leaks the command', () => {
    expect(describeTool('Bash', { command: 'cat /secret/path' })).toBe('Running a command');
  });
});
