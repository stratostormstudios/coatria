import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {OFFICE_CATALOG} from '../src/lib/office-catalog';
import {MAX_OFFICE_LIBRARY_BYTES,officeAssetPath,validOfficeModel,validOfficePreview} from '../src/lib/office-assets';

export async function checkOfficeAssets(){
  if(!OFFICE_CATALOG.length)throw new Error('The release office object catalog is empty.');
  if(new Set(OFFICE_CATALOG.map(asset=>asset.id)).size!==OFFICE_CATALOG.length)throw new Error('Office catalog IDs must be unique.');
  let total=0;
  for(const asset of OFFICE_CATALOG){
    if(!asset.name||!asset.category||![asset.width,asset.depth,asset.height].every(value=>Number.isFinite(value)&&value>0)||!['uniform','footprint'].includes(asset.resize))throw new Error(`Invalid office catalog metadata: ${asset.id}`);
    const model=await readFile(officeAssetPath(asset.id));
    if(!validOfficeModel(model))throw new Error(`Invalid or externally linked office model: ${asset.id}`);
    total+=model.length;
    for(const kind of ['preview','plan'] as const){
      const image=await readFile(officeAssetPath(asset.id,kind));
      if(!validOfficePreview(image))throw new Error(`Invalid office ${kind} image: ${asset.id}`);
      total+=image.length;
    }
  }
  if(total>MAX_OFFICE_LIBRARY_BYTES)throw new Error('The private office asset bundle exceeds its 128 MiB deployment budget. Optimize the models before deploying.');
  return {count:OFFICE_CATALOG.length,bytes:total};
}

async function main(){
  if(process.env.VERCEL||process.env.COATRIA_REQUIRE_OFFICE_ASSETS==='1'){
    const result=await checkOfficeAssets();console.log(`Verified ${result.count} private, self-contained office objects (${(result.bytes/1024/1024).toFixed(1)}MiB).`);
  }else console.log('Source-only build: licensed office assets are checked when deploying to Vercel.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void main().catch(error=>{console.error(error instanceof Error?error.message:'Office bundle validation failed.');process.exitCode=1;});
