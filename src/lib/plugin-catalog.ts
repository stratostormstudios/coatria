import {AGENT_CAPABILITIES,type AgentCapability} from './agent-policy';

export const PLUGIN_CATALOG_VERSION='2026-09-17.2';
export type AgentCharacter={roleTitle:string;persona:string;workStyle:'collaborative'|'independent'|'methodical'};
export type PluginRuntimeConfig={providerId:string;modelId:string;maxSteps:number;maxOutputTokens:number;maxTotalTokens:number;timeoutSeconds:number};
export type PluginModel={id:string;label:string;tier:'flagship'|'balanced'|'economy'|'custom';toolSupport:'documented'|'unverified'};
export type PluginCatalogEntry={
 id:string;version:string;name:string;description:string;summary:string;publisher:'Coatria';vendor:string;
 category:'coding'|'assistant'|'inference';harness:'codex'|'claude-code'|'custom';
 runtime:'codex-cli'|'claude-code-cli'|'responses'|'anthropic-messages'|'chat-completions';
 providers:{id:string;models:PluginModel[];allowCustomModel:boolean}[];capabilities:AgentCapability[];
 docsUrl:string;setupFiles:string[];credentialEnv:string;limitations:string[];verifiedAt:string;
};
const model=(id:string,label:string,tier:PluginModel['tier']):PluginModel=>({id,label,tier,toolSupport:'documented'});
const openaiModels=[model('gpt-6-astra','Astra','flagship'),model('gpt-5.6-terra','Terra','balanced'),model('gpt-5.6-luna','Luna','economy')];
const claudeModels=[model('claude-sonnet-5','Claude Sonnet 5','balanced'),model('claude-opus-5','Claude Opus 5','flagship'),model('claude-haiku-4-5-20251001','Claude Haiku 4.5','economy')];
// Available grants are offered for explicit administrator selection. Adding a
// supported tool never changes any installation's persisted capabilities.
const common={version:'1.0.0',publisher:'Coatria' as const,capabilities:[...AGENT_CAPABILITIES],verifiedAt:'2026-09-16'};
const providerFiles=['/downloads/agent-worker.mjs','/downloads/provider-adapter.mjs','/downloads/PROVIDER_BRIDGES.md'];
/** Curated, version-pinned bridge manifests. Installation never downloads or executes remote code. */
export const PLUGIN_CATALOG:PluginCatalogEntry[]=[
 {...common,id:'codex',name:'Codex',vendor:'OpenAI',category:'coding',harness:'codex',runtime:'codex-cli',
  summary:'A coding teammate with a persistent company role.',description:'Connect an operator-hosted Codex CLI worker to Coatria tasks, conversations and permissioned workspace tools.',
  providers:[{id:'openai',models:[model('gpt-5.6-sol','Sol','balanced'),...openaiModels],allowCustomModel:false}],
  docsUrl:'https://developers.openai.com/codex/cli/',credentialEnv:'CODEX_API_KEY',
  setupFiles:['/downloads/agent-worker.mjs','/downloads/codex-adapter.mjs','/downloads/agent-mcp.mjs','/downloads/AGENT_RUNTIME.md'],
  limitations:['Requires your own running worker and an authenticated Codex CLI.','CLI usage is controlled by your Codex account; API token and step budgets do not apply to this bridge.','Repository execution requires an explicitly provisioned isolated worker.']},
 {...common,id:'claude-code',name:'Claude Code',vendor:'Anthropic',category:'coding',harness:'claude-code',runtime:'claude-code-cli',
  summary:'Claude Code, connected to your team’s work.',description:'Connect a restricted, operator-hosted Claude Code worker using Coatria MCP tools and a durable company identity.',
  providers:[{id:'anthropic',models:claudeModels,allowCustomModel:false}],
  docsUrl:'https://code.claude.com/docs/en/cli-reference',credentialEnv:'ANTHROPIC_API_KEY',
  setupFiles:['/downloads/agent-worker.mjs','/downloads/claude-code-adapter.mjs','/downloads/provider-adapter.mjs','/downloads/agent-mcp.mjs','/downloads/PROVIDER_BRIDGES.md'],
  limitations:['Requires Claude Code CLI on a running worker. Choose native CLI login or your Anthropic API key.','Native login stays inside the unmodified Claude Code CLI on your worker; browser sign-in alone does not connect Coatria.','CLI token accounting differs from the direct API bridge; set provider spending limits.']},
 {...common,id:'openai',name:'Astra & OpenAI',vendor:'OpenAI',category:'assistant',harness:'custom',runtime:'responses',
  summary:'Choose Astra, Terra or Luna for your company.',description:'Use the Responses API for a bounded tool-calling assistant with your selected model, role and permissions.',
  providers:[{id:'openai',models:openaiModels,allowCustomModel:false}],
  docsUrl:'https://developers.openai.com/api/docs/guides/function-calling',credentialEnv:'OPENAI_API_KEY',setupFiles:providerFiles,
  limitations:['Provider usage is billed to your OpenAI account.','Requires a running worker; installing a manifest does not connect or verify a model.']},
 {...common,id:'anthropic',name:'Claude',vendor:'Anthropic',category:'assistant',harness:'custom',runtime:'anthropic-messages',
  summary:'Claude as a focused workplace assistant.',description:'Use the Anthropic Messages API with bounded tool use, company responsibilities and explicit capabilities.',
  providers:[{id:'anthropic',models:claudeModels,allowCustomModel:false}],
  docsUrl:'https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview',credentialEnv:'ANTHROPIC_API_KEY',setupFiles:providerFiles,
  limitations:['Provider usage is billed to your Anthropic account.','Requires a running worker and a model enabled for your account.']},
 {...common,id:'xai',name:'Grok',vendor:'xAI',category:'assistant',harness:'custom',runtime:'responses',
  summary:'A Grok-powered bot with a role in your team.',description:'Connect xAI Grok through the Responses API using the same scoped Coatria tools and durable task pipeline.',
  providers:[{id:'xai',models:[model('grok-4.6','Grok 4.6','flagship')],allowCustomModel:false}],
  docsUrl:'https://docs.x.ai/developers/tools/function-calling',credentialEnv:'XAI_API_KEY',setupFiles:providerFiles,
  limitations:['Requires an xAI API account, key and running worker.','Live provider access must be checked with your credentials.']},
 {...common,id:'fireworks',name:'Qwen on Fireworks',vendor:'Fireworks AI',category:'inference',harness:'custom',runtime:'chat-completions',
  summary:'Hosted Qwen 3.8 with documented tool calling.',description:'Run Qwen3.8 Max on Fireworks serverless inference with bounded Coatria tool use and a persistent company role.',
  providers:[{id:'fireworks',models:[model('accounts/fireworks/models/qwen3p8-max','Qwen3.8 Max','flagship')],allowCustomModel:false}],
  docsUrl:'https://fireworks.ai/models/fireworks/qwen3p8-max',credentialEnv:'FIREWORKS_API_KEY',setupFiles:providerFiles,
  limitations:['Qwen3.8 Max is the capability-focused Qwen option, not the cheapest model.','Serverless availability and provider billing depend on your Fireworks account.']},
 {...common,id:'together',name:'Qwen on Together',vendor:'Together AI',category:'inference',harness:'custom',runtime:'chat-completions',
  summary:'An economical Qwen model with tool support.',description:'Use Qwen3.5 9B on Together for lower-cost, bounded workplace tasks with documented function calling.',
  providers:[{id:'together',models:[model('Qwen/Qwen3.5-9B','Qwen3.5 9B','economy')],allowCustomModel:false}],
  docsUrl:'https://docs.together.ai/docs/serverless/models',credentialEnv:'TOGETHER_API_KEY',setupFiles:providerFiles,
  limitations:['Smaller models need closer review on complex or high-impact tasks.','Qwen3.8 variants without confirmed tool support are not offered in this curated bridge.']},
 {...common,id:'runpod',name:'Your Runpod inference',vendor:'Runpod',category:'inference',harness:'custom',runtime:'chat-completions',
  summary:'Qwen 3.8 on your own inference endpoint.',description:'Connect a Runpod worker running Qwen3.8 27B FP8, with tracked inference jobs and scoped Coatria tools.',
  providers:[{id:'runpod',models:[model('Qwen/Qwen3.8-27B-FP8','Qwen3.8 27B FP8','balanced')],allowCustomModel:true}],
  docsUrl:'https://docs.runpod.io/serverless/vllm/openai-compatibility',credentialEnv:'RUNPOD_API_KEY',setupFiles:[...providerFiles,'/downloads/runpod-qwen38.example.json'],verifiedAt:'2026-09-17',
  limitations:['Requires an operator-provisioned endpoint and COATRIA_RUNPOD_ENDPOINT_ID on the worker.','The Qwen preset has an isolated live canary; other custom models require their own tests.','Cold starts consume time and GPU credit. A supervised Coatria worker must remain online.','The company interface cannot configure arbitrary network destinations.']},
];
