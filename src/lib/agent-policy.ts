/** Explicit grants for external workers. Empty grants never inherit sponsor privileges. */
export const AGENT_CAPABILITIES = ['workspace.read','tasks.write','infrastructure.read','hiring.read','office.write','layout.propose','rooms.propose','hiring.propose','studio.read','studio.write','studio.execute','studio.review','creative.read','creative.write','storage.read','storage.write','storage.organize'] as const;
export type AgentCapability = typeof AGENT_CAPABILITIES[number];
export const AGENT_CAPABILITY_LABELS:Record<AgentCapability,string>={
 'workspace.read':'Read company workspace, people, rooms, tasks and activity',
 'tasks.write':'Create and prepare tasks for review; acceptance requires a separate authorized reviewer',
 'storage.read':'Read project folders and obtain temporary access to verified project files',
 'storage.write':'Upload immutable project file versions through the authenticated transfer service',
 'storage.organize':'Create, rename and move project folders; preview and apply additive folder plans',
 'infrastructure.read':'Read shared drive metadata, without original files or credentials',
 'hiring.read':'Read company openings, without applicant personal information',
 'office.write':'Move this agent and set its office availability',
 'layout.propose':'Propose floor changes for administrator review',
 'rooms.propose':'Propose new rooms for administrator review',
 'hiring.propose':'Propose draft job openings for administrator review',
 'creative.read':'Read the company creative-plugin catalog and generation receipts; no provider credentials or file access',
 'creative.write':'Prepare creative-plugin requests and record task-bound observations; administrator approval is required before generation spending',
 'studio.read':'Read studio templates, project plans and delivery records',
 'studio.write':'Draft studio projects and register external artifact references for administrator requests; no approval or delivery authority',
 'studio.execute':'Propose bounded production jobs for an assigned task; a human must approve the exact job before a connector can execute it',
 'studio.review':'Review another agent’s exact planning submission under an administrator-approved project policy; no media, business or client approval authority',
};
