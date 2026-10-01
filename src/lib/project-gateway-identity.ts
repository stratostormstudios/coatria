/** Domain-separated authenticated identity protocol; never returns key material. */
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {fail} from './security';
import {canonicalServiceValue} from './trusted-service-config';

export const gatewayIdentitySchema=z.object({version:z.literal(1),companyId:z.uuid(),projectIds:z.array(z.uuid()).min(1).max(100),provisionId:z.uuid(),configurationHash:z.string().regex(/^[a-f0-9]{64}$/),sourceCommit:z.string().regex(/^[a-f0-9]{40}$/),expiresAt:z.iso.datetime()}).strict();
export type GatewayIdentity=z.infer<typeof gatewayIdentitySchema>;
const challengeSchema=z.object({identity:gatewayIdentitySchema,nonce:z.string().regex(/^[a-f0-9]{64}$/),issuedAt:z.number().int(),expiresAt:z.number().int(),keyId:z.string().regex(/^[\w-]{1,40}$/),mac:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
type Challenge=z.infer<typeof challengeSchema>;
function ring(){try{const value=JSON.parse(process.env.COATRIA_HOSTING_KEYRING||''),keys=new Map<string,Buffer>();if(!/^[\w-]{1,40}$/.test(value.activeKeyId)||!value.keys||Object.keys(value.keys).length>5)throw Error();for(const[k,v]of Object.entries(value.keys)){if(typeof v!=='string'||!/^[\w-]{1,40}$/.test(k))throw Error();const key=Buffer.from(v,'base64');if(key.length!==32||key.toString('base64')!==v)throw Error();keys.set(k,key);}if(!keys.has(value.activeKeyId))throw Error();return {id:value.activeKeyId as string,keys};}catch{fail(503,'Gateway identity keys are unavailable.','GATEWAY_IDENTITY_UNAVAILABLE');}}
const unsigned=(challenge:Challenge)=>({identity:challenge.identity,nonce:challenge.nonce,issuedAt:challenge.issuedAt,expiresAt:challenge.expiresAt,keyId:challenge.keyId});
function mac(domain:'challenge'|'response',payload:unknown,key:Buffer){return createHmac('sha256',key).update('coatria:gateway-identity:v1:'+domain+'\n'+canonicalServiceValue(payload)).digest('hex');}
const equal=(a:string,b:string)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function createGatewayChallenge(identity:GatewayIdentity,now=Date.now()):Challenge{identity=gatewayIdentitySchema.parse(identity);const keys=ring(),payload={identity,nonce:randomBytes(32).toString('hex'),issuedAt:now,expiresAt:Math.min(now+30000,Date.parse(identity.expiresAt)),keyId:keys.id};return {...payload,mac:mac('challenge',payload,keys.keys.get(keys.id)!)};}
export function answerGatewayChallenge(value:unknown,identity:GatewayIdentity,now=Date.now()){
 const parsed=challengeSchema.safeParse(value);if(!parsed.success)fail(403,'Invalid gateway identity challenge.','GATEWAY_IDENTITY_INVALID');const challenge=parsed.data,key=ring().keys.get(challenge.keyId);
 if(!key||challenge.issuedAt>now+1000||challenge.expiresAt<=now||challenge.expiresAt-challenge.issuedAt>30000||Date.parse(identity.expiresAt)<=now||canonicalServiceValue(challenge.identity)!==canonicalServiceValue(identity)||!equal(challenge.mac,mac('challenge',unsigned(challenge),key)))fail(403,'Gateway identity did not match the reviewed service.','GATEWAY_IDENTITY_INVALID');
 return {challenge,mac:mac('response',challenge,key)};
}
export function verifyGatewayAnswer(value:unknown,challenge:Challenge,now=Date.now()){
 const parsed=z.object({challenge:challengeSchema,mac:z.string().regex(/^[a-f0-9]{64}$/)}).strict().safeParse(value),key=ring().keys.get(challenge.keyId);
 if(!parsed.success||!key||challenge.expiresAt<=now||canonicalServiceValue(parsed.data.challenge)!==canonicalServiceValue(challenge)||!equal(parsed.data.mac,mac('response',challenge,key)))fail(502,'A signed live gateway identity was not confirmed.','GATEWAY_IDENTITY_UNCONFIRMED');
 return true;
}
export async function boundedGatewayJson(body:ReadableStream<Uint8Array>|null){if(!body)fail(400,'Gateway identity body is required.');const reader=body.getReader(),chunks:Uint8Array[]=[];let bytes=0;try{for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>16384)fail(413,'Gateway identity body exceeded its bound.');chunks.push(chunk.value);}return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}}
