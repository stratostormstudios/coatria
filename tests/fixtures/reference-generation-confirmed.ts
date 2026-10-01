/** Offline confirmed-reference fixture. Inspection/transfer results are synthetic
 * metadata; only the real control-plane consent/phase services are exercised. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {transaction} from '../../src/lib/db';
import * as references from '../../src/lib/higgsfield-references';
import {referenceGenerationFixture} from './reference-generation';

export async function confirmedReferenceGenerationFixture(options:Parameters<typeof referenceGenerationFixture>[0]={}){
 const f=await referenceGenerationFixture(options);assert(f.reference);assert(f.handoff);
 await f.finishProducer();await f.adopt();
 const inspectionLease=await f.claim();assert(inspectionLease);
 const inspected=(await transaction(db=>references.recordHiggsfieldReferenceInspection(db,inspectionLease,{profileSha256:'b'.repeat(64),descriptor:{kind:'image',format:'png',contentType:'image/png',width:96,height:64,bytes:f.output.bytes,sha256:f.output.sha256,verification:'full_decode',inspectionVersion:1,codec:'png',color:{space:null,primaries:null,transfer:null,range:null}}},f.inspectionOptions))).reference;
 await transaction(db=>references.approveHiggsfieldReference(db,{companyId:f.company,userId:f.admin},inspected.id,{clientId:randomUUID(),revision:inspected.revision,requestHash:inspected.requestHash,inspectionHash:inspected.inspection!.inspectionHash,expiresInMinutes:30,referenceSharingConsent:true,preparedProxyConsent:true,rightsConsent:true,allBytesConsent:true},f.inspectionOptions));
 const transfer=await f.claim();assert(transfer);const mediaId=randomUUID();let confirmedReference=inspected;
 for(const result of [{phase:'allocate' as const,allocation:{mediaId,uploadUrl:'https://fixture.invalid/upload',expiresAt:new Date(Date.now()+600000).toISOString()}},{phase:'put' as const,httpStatus:200 as const,bytes:f.output.bytes,sha256:f.output.sha256},{phase:'confirm' as const,mediaId,confirmed:true as const}]){
  const action=await transaction(db=>references.beginHiggsfieldReferencePhase(db,transfer,result.phase,f.inspectionOptions));
  confirmedReference=(await transaction(db=>references.completeHiggsfieldReferencePhase(db,transfer,action.actionId,result,f.inspectionOptions))).reference;
 }
 assert.equal(confirmedReference.status,'confirmed');
 return {...f,confirmedReference,mediaId};
}
