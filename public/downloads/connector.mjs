#!/usr/bin/env node
// Outbound-only metadata connector. No file contents or absolute paths are transmitted.
import { readdir, realpath, lstat, stat } from 'node:fs/promises';
import { resolve, relative, sep, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const privateNames=new Set(['.git','.ssh','.aws','.azure','node_modules','.next','.env','.DS_Store']);
export function connectorOrigin(value){
  const endpoint=new URL(value);
  const local=['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname);
  if(endpoint.protocol!=='https:'&&!(local&&endpoint.protocol==='http:'))throw new Error('The connector requires HTTPS except for local development.');
  if(endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/')throw new Error('Use a plain Coatria origin URL without credentials, a path, or parameters.');
  return endpoint;
}

/** @param {string} approvedRoot @param {{maxFiles?:number,maxDepth?:number,shouldStop?:()=>boolean}} options */
export async function scanMetadata(approvedRoot,{maxFiles=1000,maxDepth=12,shouldStop=()=>false}={}){
  const root=await realpath(resolve(approvedRoot));
  if(!(await stat(root)).isDirectory())throw new Error('The approved root must be a directory.');
  const files=[];
  const within=actual=>{const path=relative(root,actual);return !isAbsolute(path)&&path!=='..'&&!path.startsWith('..'+sep);};
  async function walk(directory,depth){
    if(shouldStop())throw new Error('Connector stopped.');
    if(depth>maxDepth)throw new Error('Folder exceeds the index depth limit. Choose a shallower approved subfolder.');
    // Resolve again at each boundary. Do not traverse links added during a scan.
    const actualDirectory=await realpath(directory);
    if(!within(actualDirectory)||(await lstat(directory)).isSymbolicLink()||actualDirectory!==directory)return;
    const entries=await readdir(directory,{withFileTypes:true});
    for(const entry of entries){
      if(shouldStop())throw new Error('Connector stopped.');
      if(entry.isSymbolicLink()||entry.name.startsWith('.')||privateNames.has(entry.name))continue;
      const candidate=resolve(directory,entry.name);
      const metadata=await lstat(candidate);
      if(metadata.isSymbolicLink())continue;
      const actual=await realpath(candidate);
      if(!within(actual)||actual!==candidate)continue;
      if(metadata.isDirectory())await walk(actual,depth+1);
      else if(metadata.isFile()){
        if(files.length>=maxFiles)throw new Error(`Folder exceeds the ${maxFiles.toLocaleString('en-US')}-file index limit. Choose a smaller approved subfolder.`);
        const path=relative(root,actual).split(sep).join('/');
        if(path.length>1000)throw new Error('A relative file path exceeds the index limit. Choose a smaller approved subfolder.');
        files.push({path,size:metadata.size,modifiedAt:metadata.mtime.toISOString()});
      }
    }
  }
  await walk(root,0);return files;
}

export async function main(args=process.argv.slice(2)){
  const {values}=parseArgs({args,options:{root:{type:'string'},url:{type:'string',default:process.env.COATRIA_URL||'https://coatria.com'},once:{type:'boolean',default:false},help:{type:'boolean',default:false}}});
  if(values.help||!values.root){console.log('Usage: COATRIA_CONNECTOR_TOKEN=<one-time token> node scripts/connector.mjs --root <approved folder> [--url https://coatria.com] [--once]\nIndexes relative file names, sizes and modification dates. Does not read file contents, follow symbolic links, or upload originals. Limit: 1,000 files.');return values.help?0:1;}
  const token=process.env.COATRIA_CONNECTOR_TOKEN;
  if(!token)throw new Error('Set COATRIA_CONNECTOR_TOKEN in the environment. Never pass it in the URL.');
  const endpoint=connectorOrigin(values.url);
  let root;
  try{root=await realpath(resolve(values.root));if(!(await stat(root)).isDirectory())throw new Error();}
  catch{throw new Error('The approved folder is unavailable or is not a directory.');}
  let stopped=false;
  const stop=()=>{stopped=true;};process.on('SIGINT',stop);process.on('SIGTERM',stop);
  async function send(path,body){
    const response=await fetch(new URL(path,endpoint),{method:body?'POST':'GET',redirect:'error',headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});
    if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.error||`Connector request failed (${response.status}).`);}
    return response.json();
  }
  try{
    await send('/api/connector/config');
    while(!stopped){
      let files;
      try{files=await scanMetadata(root,{shouldStop:()=>stopped});}catch(error){if(stopped)break;throw error;}
      if(stopped)break;
      // An incomplete or interrupted index is never sent as a healthy snapshot.
      await send('/api/connector/heartbeat',{files,status:'online'});
      console.log(`Connected. Indexed ${files.length} files at ${new Date().toISOString()}. Originals remain on your server.`);
      if(values.once)break;
      if(!stopped)await new Promise(resolve=>{const finish=()=>{clearTimeout(timer);process.off('SIGINT',finish);process.off('SIGTERM',finish);resolve();};const timer=setTimeout(finish,30000);process.once('SIGINT',finish);process.once('SIGTERM',finish);});
    }
    return 0;
  }finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  main().then(code=>{process.exitCode=code;}).catch(error=>{console.error(error instanceof Error?error.message:'Connector failed.');process.exitCode=1;});
}
