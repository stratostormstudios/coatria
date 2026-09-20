import {z} from 'zod';
import {studioGeneratedSpecInput,studioGeneratedWorkUnitInput,studioGeneratedObservedMediaInput,studioGeneratedFileFactsInput} from './studio-generated-protocol';
import {studioGeneratedSourceInput,studioGeneratedManifestInput} from './studio-generated-artifacts';

type Schema=Record<string,any>;
const uuid={type:'string',format:'uuid'},sha={type:'string',pattern:'^[a-f0-9]{64}$'},text={type:'string'},date={type:'string',format:'date-time'},revision={type:'integer',minimum:1};
const nullable=(schema:Schema)=>({anyOf:[schema,{type:'null'}]});
const ref=(name:string)=>({$ref:'#/components/schemas/'+name});
const object=(properties:Schema,required=Object.keys(properties)):Schema=>({type:'object',properties,required,additionalProperties:false});
const schema=(input:z.ZodType)=>z.toJSONSchema(input,{io:'input',unrepresentable:'any'}) as Schema;
export const studioContractVersionParameter={name:'contractVersion',in:'query',required:false,schema:{type:'integer',const:2},description:'Explicitly opt into generated image/video/audio contracts. Without this selector, lists include legacy projects only and exact generated project reads return STUDIO_CONTRACT_UNSUPPORTED. With 2, legacy DTOs remain unchanged and generated projects carry contractVersion:2.'};

/** Add separate generated components without widening or rewriting legacy frame
 * components. Shared endpoints choose an explicit response union. */
export function studioGeneratedOpenApiSchemas(legacy:Record<string,Schema>):Record<string,Schema>{
 const project=object({...legacy.StudioProject.properties,contractVersion:{const:2},productionPath:{const:'higgsfield'},spec:ref('StudioGeneratedSpec')},[...legacy.StudioProject.required,'contractVersion']);
 const work=schema(studioGeneratedWorkUnitInput);
 const shot={oneOf:work.oneOf??work.anyOf};
 shot.oneOf=shot.oneOf.map((branch:Schema)=>object({...branch.properties,id:uuid},[...branch.required,'id']));
 const source=schema(studioGeneratedSourceInput);
 const provenance=object({archiveId:uuid,archiveApprovedBy:uuid,requestId:uuid,jobId:uuid,outputId:uuid,storageVersionId:uuid,registeredBy:uuid,registeredAgentId:nullable(uuid),registeredRunId:nullable(uuid)});
 const file=schema(studioGeneratedFileFactsInput),media=schema(studioGeneratedObservedMediaInput);
 const limitations={type:'array',items:{enum:['COLOR_METADATA_NOT_REQUIRED','VIDEO_DURATION_ROUNDED_TO_MS','EMBEDDED_AUDIO_TIMING_UNVERIFIED']}};
 const artifact=object({contractVersion:{const:2},kind:{const:'verified_generated_media'},mediaKind:{enum:['image','video','audio']},id:uuid,workItemId:uuid,name:text,version:revision,url:{type:'string',format:'uri-reference',pattern:'^/api/companies/[^/]+/studio/projects/[^/]+/generated-artifacts/[^/]+/manifest$',description:'Authenticated, company-scoped canonical manifest. No provider locator or file access credential.'},sha256:{...sha,description:'SHA-256 of exact UTF-8 manifest response bytes. File bytes use file.sha256.'},notes:text,reviewStatus:{enum:['pending','approved','changes_requested']},createdAt:date,producedBy:uuid,producedAgentId:nullable(uuid),media:ref('StudioGeneratedObservedMedia'),file:ref('StudioGeneratedFileFacts'),source:ref('StudioGeneratedSource'),provenance,specSha256:sha,manifestSha256:sha,limitations});
 const manifest=schema(studioGeneratedManifestInput);
 const technicalMatch=object({matches:{type:'boolean'},issues:{type:'array',items:object({code:{type:'string',enum:['SPEC_INVALID','WORK_UNIT_INVALID','WORK_KIND_MISMATCH','OBSERVATION_INVALID','UNSUPPORTED_CODEC','MEDIA_KIND_MISMATCH','FORMAT_MISMATCH','CODEC_MISMATCH','DIMENSIONS_MISMATCH','COLOR_METADATA_UNKNOWN','COLOR_METADATA_MISMATCH','CADENCE_UNPROVEN','VARIABLE_FRAME_RATE','FRAME_RATE_MISMATCH','FRAME_TIMING_MISMATCH','DURATION_MISMATCH','DURATION_PRECISION_UNPROVEN','AUDIO_UNEXPECTED','AUDIO_REQUIRED','SAMPLE_RATE_MISMATCH','CHANNELS_MISMATCH','FILE_FACTS_INVALID','FILE_BYTES_MISMATCH','FILE_HASH_MISMATCH','FILE_CONTENT_TYPE_MISMATCH']},path:text})},limitations});
 const evidence={specSha256:sha,manifestSha256:sha,attestationVersion:{const:1},technicalMatch:ref('StudioGeneratedTechnicalMatch')};
 const review=object({...legacy.StudioReview.properties,contractVersion:{const:2},...evidence});
 const packageReview=object({...legacy.StudioReview.properties,...evidence,decision:{const:'approved'},technicalQc:{const:true}});
 const packageManifest=object({schemaVersion:{const:2},kind:{const:'generated_media_package'},project:object({id:uuid,name:text,clientName:text,spec:ref('StudioGeneratedSpec'),revision}),generatedAt:date,preparedBy:uuid,transportStatus:{const:'not_transferred'},artifacts:{type:'array',minItems:1,maxItems:100,items:ref('StudioGeneratedArtifact')},reviewReceipts:{type:'array',minItems:1,maxItems:100,items:ref('StudioGeneratedPackageReview')},note:text});
 const delivery=object({...legacy.StudioDelivery.properties,manifest:ref('StudioGeneratedPackageManifest')});
 return {
  StudioGeneratedSpec:schema(studioGeneratedSpecInput),StudioGeneratedShot:shot,StudioGeneratedSource:source,StudioGeneratedFileFacts:file,StudioGeneratedObservedMedia:media,StudioGeneratedArtifact:artifact,StudioGeneratedArtifactManifest:manifest,
  StudioGeneratedProject:project,
  StudioGeneratedTechnicalMatch:technicalMatch,StudioGeneratedReview:review,StudioReadableReview:{oneOf:[ref('StudioReview'),ref('StudioGeneratedReview')]},StudioGeneratedPackageReview:packageReview,StudioGeneratedPackageManifest:packageManifest,StudioGeneratedDelivery:delivery,StudioReadableDelivery:{anyOf:[ref('StudioDelivery'),ref('StudioGeneratedDelivery')]},
  StudioReadableProject:{oneOf:[ref('StudioProject'),ref('StudioGeneratedProject')]},
  StudioGeneratedProjectDetail:object({...legacy.StudioProjectDetail.properties,project:ref('StudioGeneratedProject'),shots:{type:'array',maxItems:100,items:ref('StudioGeneratedShot')},artifacts:{type:'array',maxItems:1000,items:ref('StudioGeneratedArtifact')},reviews:{type:'array',maxItems:1000,items:ref('StudioGeneratedReview')},deliveries:{type:'array',maxItems:100,items:ref('StudioGeneratedDelivery')}}),
  StudioReadableProjectDetail:{oneOf:[ref('StudioProjectDetail'),ref('StudioGeneratedProjectDetail')]},
  StudioReadableSnapshot:object({...legacy.StudioSnapshot.properties,projects:{type:'array',maxItems:100,items:ref('StudioReadableProject')}}),
 };
}
