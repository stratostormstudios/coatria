/** Explicit grants for external workers. Empty grants never inherit sponsor privileges. */
export const AGENT_CAPABILITIES = ['workspace.read','tasks.write','infrastructure.read','hiring.read','office.write','layout.propose','rooms.propose','hiring.propose'] as const;
export type AgentCapability = typeof AGENT_CAPABILITIES[number];
export const AGENT_CAPABILITY_LABELS:Record<AgentCapability,string>={
 'workspace.read':'Read company workspace, people, rooms, tasks and activity',
 'tasks.write':'Create and prepare tasks for independent human review',
 'infrastructure.read':'Read shared drive metadata, without original files or credentials',
 'hiring.read':'Read company openings, without applicant personal information',
 'office.write':'Move this agent and set its office availability',
 'layout.propose':'Propose floor changes for administrator review',
 'rooms.propose':'Propose new rooms for administrator review',
 'hiring.propose':'Propose draft job openings for administrator review',
};
