#!/usr/bin/env node
// Retirement notice only. Never forwards a credential or launches another program.
console.error('The work/report adapter is retired. Those endpoints now return HTTP 410. Download agent-worker.mjs and AGENT_RUNTIME.md, configure an approved local execute adapter, then run: node agent-worker.mjs --adapter ./my-agent.mjs');
if(!process.argv.includes('--help'))process.exitCode=1;
