import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {fail} from './security';

type Context={companyId:string;id:string;purpose:'oauth-pending'|'oauth-connection'};
type Envelope={keyId:string;nonce:string;tag:string;ciphertext:string};
function ring(){
 try{const value=JSON.parse(process.env.COATRIA_HOSTING_KEYRING||'');const keys=new Map<string,Buffer>();
  if(!/^[\w-]{1,40}$/.test(value.activeKeyId)||!value.keys||Object.keys(value.keys).length>5)throw Error();
  for(const[id,encoded]of Object.entries(value.keys)){if(typeof encoded!=='string'||!/^[\w-]{1,40}$/.test(id))throw Error();const key=Buffer.from(encoded,'base64');if(key.length!==32||key.toString('base64')!==encoded)throw Error();keys.set(id,key);}
  if(!keys.has(value.activeKeyId))throw Error();return {id:value.activeKeyId as string,keys};
 }catch{fail(503,'The server connection vault is unavailable.','HIGGSFIELD_VAULT_UNAVAILABLE');}
}
const aad=(c:Context)=>Buffer.from(JSON.stringify(['coatria:higgsfield:v1',c.companyId,c.id,c.purpose]));
export function sealHiggsfieldSecret(value:unknown,context:Context):Envelope{
 const text=JSON.stringify(value);if(Buffer.byteLength(text)>65536)fail(413,'Connection credentials exceed the vault limit.');
 const r=ring(),nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',r.keys.get(r.id)!,nonce);cipher.setAAD(aad(context));
 const ciphertext=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]).toString('base64');
 return {keyId:r.id,nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext};
}
export function openHiggsfieldSecret<T>(value:Envelope,context:Context):T{
 const key=ring().keys.get(value.keyId);if(!key)fail(503,'The connection vault key is unavailable.','HIGGSFIELD_VAULT_UNAVAILABLE');
 try{const nonce=Buffer.from(value.nonce,'base64'),tag=Buffer.from(value.tag,'base64');if(nonce.length!==12||tag.length!==16||value.ciphertext.length>90000)throw Error();const decipher=createDecipheriv('aes-256-gcm',key,nonce);decipher.setAAD(aad(context));decipher.setAuthTag(tag);return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext,'base64')),decipher.final()]).toString('utf8')) as T;}
 catch{fail(503,'The saved connection failed its integrity check. Reconnect Higgsfield.','HIGGSFIELD_VAULT_INTEGRITY');}
}
