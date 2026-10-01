import test from 'node:test';
import assert from 'node:assert/strict';
import {imagePreparationTransformEvidence,runImagePreparationLinuxCanary} from './image-preparation-linux-canary.mts';

test('transform evidence requires actual native execution and cannot enroll a hosted worker',async()=>{
 const report=imagePreparationTransformEvidence();
 assert.equal(report.passed,false);assert.equal(report.actualLinuxTransform,false);
 assert.equal(report.productionQualified,false);assert.equal(report.installedServiceQualified,false);
 assert.equal(report.enrollmentExercised,false);assert.equal(report.remoteTransportExercised,false);assert.equal(report.providerCalls,0);
 let invoked=false;
 await assert.rejects(runImagePreparationLinuxCanary({sandbox:{run:async()=>{invoked=true;return ''; }},profileSha256:'a'.repeat(64),fixtureRoot:'/missing',cgroupRoot:'/missing',decoderEvents:[]},report));
 assert.equal(invoked,false);assert.equal(report.passed,false);assert.equal(report.actualLinuxTransform,false);
 assert.equal(report.qualificationExecutions,0);assert.equal(report.profileSha256,null);assert.deepEqual(report.cases,[]);
});
