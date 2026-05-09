export type RemoteTeamTextAction = {
  tool: string;
  args: Record<string, unknown>;
};

const ACTION_BLOCK_RE = /```aionui_team\s*([\s\S]*?)```/g;

function normalizeAction(value: unknown): RemoteTeamTextAction | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as { tool?: unknown; args?: unknown };
  if (typeof item.tool !== 'string' || !item.tool.trim()) return null;
  const args = item.args && typeof item.args === 'object' && !Array.isArray(item.args) ? item.args : {};
  return { tool: item.tool.trim(), args: args as Record<string, unknown> };
}

export function parseRemoteTeamTextActions(text: string): RemoteTeamTextAction[] {
  const actions: RemoteTeamTextAction[] = [];
  for (const match of text.matchAll(ACTION_BLOCK_RE)) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const values = Array.isArray(parsed) ? parsed : [parsed];
      for (const value of values) {
        const action = normalizeAction(value);
        if (action) actions.push(action);
      }
    } catch {
      actions.push({
        tool: 'invalid',
        args: { error: 'Invalid JSON in aionui_team block', raw },
      });
    }
  }
  return actions;
}

export function buildRemoteTeamTextProtocolPrompt(): string {
  return `\n\n## Remote Team Action Protocol
You are running as a remote agent, so the native team_* MCP tools may not appear in your tool list.
When you need to use a team tool, emit an \`aionui_team\` fenced JSON block instead. AionUi will execute it and send you the result in a follow-up message.

Format:
\`\`\`aionui_team
{"tool":"team_members","args":{}}
\`\`\`

You may emit multiple actions as a JSON array:
\`\`\`aionui_team
[
  {"tool":"team_task_create","args":{"subject":"Inspect project","owner":"check"}},
  {"tool":"team_send_message","args":{"to":"check","message":"Inspect the project and report risks."}}
]
\`\`\`

Supported tools:
- team_members: args {}
- team_task_list: args {}
- team_task_create: args { "subject": string, "description"?: string, "owner"?: string }
- team_task_update: args { "task_id": string, "status"?: "pending" | "in_progress" | "completed" | "deleted", "owner"?: string }
- team_send_message: args { "to": string, "message": string, "summary"?: string }
- team_spawn_agent: args { "name": string, "agent_type"?: string, "model"?: string, "custom_agent_id"?: string, "remote_agent_id"?: string }
- team_list_models: args { "agent_type"?: string }

For remote teammates, call team_spawn_agent with agent_type "remote" and the exact remote_agent_id shown in Available Agent Types for Spawning.
Do not pretend an action succeeded. After emitting an action block, wait for AionUi to return the result.`;
}
