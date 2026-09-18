import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {higgsfieldProjectPreset,HIGGSFIELD_PRODUCTION_STEPS,proceduralTurntablePreset,proceduralTurntableFit} from '../src/lib/studio-project-presets';
import {studioProjectInput} from '../src/lib/studio-protocol';
import {executionSubmitInput,EXECUTION_BUILTIN_PROFILES} from '../src/lib/studio-execution-protocol';

test('Higgsfield preset explicitly selects the creative workflow without authorizing a provider job',()=>{
 const preset=higgsfieldProjectPreset();const project=studioProjectInput.parse({clientId:randomUUID(),name:'AI concept',clientName:'Internal',brief:'Develop a concept from approved references and retain originals on connected storage.',aiPolicy:'unknown',...preset});
 assert.equal(project.productionPath,'higgsfield');assert.equal(project.spec.format,'mp4');assert.equal(project.spec.colorSpace,'Rec.709');assert.equal((project.shots[0].frameEnd-project.shots[0].frameStart+1)*project.spec.fpsDenominator/project.spec.fpsNumerator,5);assert.equal(project.shots[0].handles,0);assert.equal(project.aiPolicy,'unknown');
 assert.deepEqual(HIGGSFIELD_PRODUCTION_STEPS,['Brief','References','Generation','Review','Delivery']);
 for(const authority of ['gates','execution','provider','model','generationId','productionMode'])assert.equal(authority in project,false,authority);
 assert.equal(proceduralTurntableFit(project.spec,project.shots).supported,false);
 const separate=higgsfieldProjectPreset();preset.shots[0].handles=8;preset.spec.width=384;assert.equal(separate.shots[0].handles,0);assert.equal(separate.spec.width,1920);
});

test('explicit procedural preset fits actual project and controlled execution contracts without approving work',()=>{
 const preset=proceduralTurntablePreset(),fit=proceduralTurntableFit(preset.spec,preset.shots);assert.equal(fit.supported,true);assert.deepEqual(fit.reasons,[]);
 const project=studioProjectInput.parse({clientId:randomUUID(),name:'Controlled pilot',clientName:'Internal',brief:'Original procedural turntable only.',aiPolicy:'unknown',...preset});assert.equal(project.aiPolicy,'unknown');assert.equal(project.productionPath,'vfx');assert.deepEqual(project.shots[0].disciplines,['lighting']);assert.equal(project.shots[0].handles,0);
 const profile=EXECUTION_BUILTIN_PROFILES.find(p=>p.key===fit.profileKey)!;assert.deepEqual(profile.inputKinds,[]);assert.equal(fit.profileVersion,profile.version);
 assert(executionSubmitInput.safeParse({clientId:randomUUID(),projectId:randomUUID(),revision:1,workItemId:randomUUID(),connectorId:randomUUID(),profileKey:fit.profileKey,profileVersion:fit.profileVersion,inputIds:[],frameStart:preset.shots[0].frameStart,frameEnd:preset.shots[0].frameEnd,outputKind:'image_sequence'}).success);
 assert.equal('gates' in project,false);assert.equal('execution' in project,false);const separate=proceduralTurntablePreset();preset.shots[0].handles=1;assert.equal(separate.shots[0].handles,0);
});
test('general production defaults remain valid projects but do not imply built-in render support',()=>{
 const preset=proceduralTurntablePreset(),spec={...preset.spec,width:1920,height:1080},shots=[{...preset.shots[0],frameEnd:1100,handles:8,disciplines:['compositing']}];
 assert(studioProjectInput.safeParse({clientId:randomUUID(),name:'Manual production',clientName:'Client',brief:'Work by an artist or separate approved connector.',spec,shots}).success);const fit=proceduralTurntableFit(spec,shots);assert.equal(fit.supported,false);assert(fit.reasons.some(reason=>reason.includes('pixels')));assert(fit.reasons.some(reason=>reason.includes('24 frames')));assert(fit.reasons.some(reason=>reason.includes('discipline')));
});
test('pilot fit includes handles, aggregate pixels, rational fps and exact output/color/discipline support',()=>{
 const p=proceduralTurntablePreset();const check=(spec={},shot={})=>proceduralTurntableFit({...p.spec,...spec},[{...p.shots[0],...shot}]);
 assert.equal(check({fpsNumerator:24000,fpsDenominator:1001}).supported,true);
 assert.equal(check({}, {frameStart:1001,frameEnd:1024}).supported,true);
 assert.equal(check({}, {frameStart:1001,frameEnd:1024,handles:1}).supported,false);
 assert.equal(check({width:1024,height:1024},{frameEnd:1008}).supported,false);
 for(const spec of [{width:63},{width:1025},{height:0},{format:'mp4'},{colorSpace:'sRGB'},{fpsNumerator:61},{fpsDenominator:0},{fpsNumerator:1,fpsDenominator:2}])assert.equal(check(spec).supported,false,JSON.stringify(spec));
 for(const shot of [{disciplines:['lighting','compositing']},{frameEnd:1000},{handles:-1},{frameEnd:10_000_000,handles:1}])assert.equal(check({},shot).supported,false,JSON.stringify(shot));
 assert.equal(proceduralTurntableFit(p.spec,[...p.shots,...p.shots]).supported,false);assert.equal(proceduralTurntableFit(p.spec,[]).supported,false);
});

test('omitted production path remains legacy VFX for existing API clients',()=>{
 const preset=higgsfieldProjectPreset();const {productionPath,...legacyInput}=preset;assert.equal(productionPath,'higgsfield');const parsed=studioProjectInput.parse({clientId:randomUUID(),name:'Existing API request',clientName:'Client',brief:'Preserve existing API behavior.',...legacyInput});assert.equal(parsed.productionPath,'vfx');assert.equal(studioProjectInput.safeParse({...parsed,productionPath:'dcc-auto'}).success,false);
});
