/** Local test fixture only: signed synthetic token, persisted policy, no provider calls. */
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {query,transaction} from '../../src/lib/db';
import type {Membership} from '../../src/lib/auth';
import {hashToken} from '../../src/lib/security';
import {selectCompanyRuntimeConfiguration,companyRuntimeHash} from '../../src/lib/company-runtime-config';
import {saveArchiveExecutorCredential} from '../../src/lib/company-runtime-executor';
import {planTrustedService} from '../../src/lib/trusted-service-provisioning';
import {trustedServiceHash,type TrustedServicePreset} from '../../src/lib/company-runtime-preset';
import {VERCEL_MEDIA_IMAGE} from '../../src/lib/higgsfield-vercel-media-sandbox';

const pair=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...pair.publicKey.export({format:'jwk'}),kid:'synthetic-archive-fixture',use:'sig',alg:'RS256'};
export async function companyArchiveRuntimeFixture(companyId:string,userId:string,projectId:string,phase:'service'|'preflight'='service'){
 const now=Date.now(),expiresAt=new Date(now+600000).toISOString(),releaseCommit='a'.repeat(40),scope={companyId,projectIds:[projectId],sourceCommit:releaseCommit,expiresAt};
 const configuration={version:1,policy:{...scope,pilotId:randomUUID(),maxLaunches:6,binding:{teamId:'team_synthetic',projectId:'prj_synthetic',region:'iad1',image:VERCEL_MEDIA_IMAGE,closureSha256:'b'.repeat(64),limits:{maxInputBytes:128*1024**2,maxClosureBytes:256*1024**2,timeoutMs:120000,maxOutputBytes:1024**2,maxStderrBytes:65536}}},closure:{root:'/opt/coatria/closure',files:[{path:'bin/ffmpeg',bytes:4096,sha256:'b'.repeat(64)},{path:'bin/ffprobe',bytes:4096,sha256:'c'.repeat(64)}]},qualification:{receiptPath:'/opt/coatria/qualification.json',sha256:'d'.repeat(64)},scratchRoot:'/var/lib/coatria-scratch',outputHosts:['media.example.invalid'],operationDeadlineMs:600000,inspection:{timeoutMs:300000,sandboxTimeoutMs:90000}};
 const bootstrapArgs=`node --input-type=module -e "import('data:text/javascript;base64,${Buffer.from('throw Error("Synthetic bootstrap must never execute")').toString('base64')}').catch(()=>{console.error('COATRIA_TRUSTED_SERVICE_BOOTSTRAP_FAILED');process.exit(1)})"`;
 const preset:TrustedServicePreset={id:'synthetic-archive',service:'archive',companyId,projectIds:[projectId],releaseCommit,bootstrapArgs,bootstrapHash:hashToken(bootstrapArgs),dataCenterId:'US-NC-2',expiresAt,maxHourlyMicrousd:60000,lifetimeAllowanceMicrousd:500000,configuration,configurationHash:trustedServiceHash(configuration)};
 const member={companyId,userId,role:'owner',user:{id:userId}} as Membership;
 await query("INSERT INTO platform_operator_grants(user_id,expires_at) VALUES($1,clock_timestamp()+interval '1 hour') ON CONFLICT DO NOTHING",[userId]);
 const selected=await transaction(db=>selectCompanyRuntimeConfiguration(db,member,'archive',{clientId:randomUUID(),expectedRevision:0,phase,expiresAt,preset,configurationHash:companyRuntimeHash(preset)}));
 const payload=[{typ:'JWT',alg:'RS256',kid:jwk.kid},{iss:'https://oidc.vercel.com/synthetic',aud:'https://vercel.com/synthetic',sub:'owner:synthetic:project:coatria:environment:development',owner:'synthetic',owner_id:'team_synthetic',project:'coatria',project_id:'prj_synthetic',environment:'development',iat:Math.floor(now/1000)-1,exp:Math.floor(now/1000)+3600}].map(value=>Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
 const token=payload+'.'+sign('RSA-SHA256',Buffer.from(payload),pair.privateKey).toString('base64url');
 const credential=await transaction(db=>saveArchiveExecutorCredential(db,member,selected.configuration.configurationId,{clientId:randomUUID(),expectedCredentialId:null,token},{fetch:async()=>Response.json({keys:[jwk]})}));
 const planned=await transaction(db=>planTrustedService(db,member,{clientId:randomUUID(),service:'archive'}));
 await query("UPDATE trusted_service_provisions SET phase='running',provider_status='RUNNING',pod_id=$2,submitted_at=clock_timestamp(),last_reconciled_at=clock_timestamp(),expected_environment_hashes=$3 WHERE id=$1",[planned.provision.id,'synthetic-observation-'+planned.provision.id,JSON.stringify({COATRIA_VERCEL_MEDIA_TOKEN:hashToken(token)})]);
 return {member,preset,selection:selected.configuration,credential:credential.credential!,provision:planned.provision};
}
