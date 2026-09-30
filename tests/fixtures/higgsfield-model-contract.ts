// Constraint fields observed through the connected company's models_list and
// generate_image UI on 2026-09-28. Descriptions, account data and pagination are
// omitted. This fixture is not evidence of provider generation or upload success.
// The same GPT Image 2 constraint fields were observed again through
// models_explore(action=list) on 2026-09-30; account data/prose stay omitted.
import type {HiggsfieldTool} from '../../src/lib/higgsfield-mcp';
export const observedImageModel={id:'gpt_image_2',output_type:'image',parameters:[{name:'resolution',required:'optional',type:'string',default:'1k',options:['1k','2k','4k']},{name:'quality',required:'optional',type:'string',default:'low',options:['low','medium','high']}],medias:[{name:'medias',type:'image',roles:['image']}],aspect_ratios:['1:1','4:3','3:4','16:9','21:9','9:16','3:2','2:3']};
// Pagination shape observed from the same read; cursor is a synthetic value.
export const observedImageModelPage={items:[observedImageModel],has_more:true,next_page_token:'fixture-next-page'};
export const observedImageTool:HiggsfieldTool={name:'generate_image',description:'Observed company tool; annotation text omitted',inputSchema:{type:'object',$schema:'https://json-schema.org/draft/2020-12/schema',required:['params'],properties:{params:{anyOf:[{type:'object',required:['model'],properties:{count:{type:'integer',default:1,maximum:4,minimum:1},model:{type:'string'},medias:{type:'array',items:{type:'object',required:['value','role'],properties:{role:{type:'string'},value:{type:'string'}}}},prompt:{type:'string'},get_cost:{type:'boolean'},use_unlim:{type:'boolean'},aspect_ratio:{type:'string'}},additionalProperties:{}},{type:'string'}]}}}};
