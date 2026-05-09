import { describe, expect, it } from 'vitest';
import {
  buildRemoteTeamTextProtocolPrompt,
  parseRemoteTeamTextActions,
} from '@process/team/prompts/remoteTextProtocol';

describe('remote team text protocol', () => {
  it('parses a single action block', () => {
    const actions = parseRemoteTeamTextActions(`
Before.
\`\`\`aionui_team
{"tool":"team_members","args":{}}
\`\`\`
After.
`);

    expect(actions).toEqual([{ tool: 'team_members', args: {} }]);
  });

  it('parses multiple actions from an array block', () => {
    const actions = parseRemoteTeamTextActions(`
\`\`\`aionui_team
[
  {"tool":"team_task_create","args":{"subject":"Inspect"}},
  {"tool":"team_send_message","args":{"to":"check","message":"Go"}}
]
\`\`\`
`);

    expect(actions).toEqual([
      { tool: 'team_task_create', args: { subject: 'Inspect' } },
      { tool: 'team_send_message', args: { to: 'check', message: 'Go' } },
    ]);
  });

  it('reports invalid JSON action blocks instead of dropping them', () => {
    const actions = parseRemoteTeamTextActions(`
\`\`\`aionui_team
{"tool":"team_members","args":}
\`\`\`
`);

    expect(actions).toEqual([
      {
        tool: 'invalid',
        args: {
          error: 'Invalid JSON in aionui_team block',
          raw: '{"tool":"team_members","args":}',
        },
      },
    ]);
  });

  it('documents remote_agent_id for remote teammate spawning', () => {
    expect(buildRemoteTeamTextProtocolPrompt()).toContain('remote_agent_id');
  });
});
