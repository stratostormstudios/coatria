import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {buildStudioBootstrap} from './build-studio-bootstrap.mjs';

const run=promisify(execFile),paths=['public/downloads/agent-worker.mjs','public/downloads/provider-adapter.mjs','scripts/hosting/run-studio-host.mjs'];
/** Read-only builder. It verifies every runtime file against the selected Git
 * commit before producing a server preset; it cannot provision or install it.
 */
export async function buildCpuPreset({root,commit,configuration}){
 if(!/^[a-f0-9]{40}$/.test(commit))throw Error('A full reviewed Git commit is required.');
 const keys=['id','modelId','endpointId','maxHourlyMicrousd','maxSteps','maxOutputTokens','maxTotalTokens','timeoutSeconds','companies'];
 if(!configuration||typeof configuration!=='object'||Object.keys(configuration).some(key=>!keys.includes(key))||keys.some(key=>!(key in configuration)))throw Error('Use only the documented nonsecret CPU preset configuration fields.');
 for(const path of paths){const checked=(await readFile(resolve(root,path),'utf8')).replaceAll('\r\n','\n'),source=(await run('git',['show',commit+':'+path],{cwd:root,encoding:'utf8',maxBuffer:2097152})).stdout;if(checked!==source.replaceAll('\r\n','\n'))throw Error('Runtime source differs from the reviewed Git commit: '+path);}
 const bootstrap=await buildStudioBootstrap({root,commit});
 return{...configuration,releaseCommit:commit,bootstrapArgs:bootstrap.args,bootstrapHash:createHash('sha256').update(bootstrap.args).digest('hex')};
}
async function main(){const[commit,configPath,outputPath]=process.argv.slice(2);if(!commit||!configPath||!outputPath||process.argv.length!==5)throw Error('Usage: node scripts/hosting/build-cpu-preset.mjs <full-commit> <configuration.json> <new-output.json>');const configuration=JSON.parse(await readFile(resolve(configPath),'utf8')),preset=await buildCpuPreset({root:process.cwd(),commit,configuration});await writeFile(resolve(outputPath),JSON.stringify(preset,null,2)+'\n',{flag:'wx',mode:0o600});process.stdout.write('Reviewed CPU preset written. Nothing was installed or provisioned.\n');}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{process.stderr.write('CPU preset build failed. Verify the reviewed commit, documented configuration fields, source hashes and new output path.\n');process.exitCode=1;});
