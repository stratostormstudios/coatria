import {NextRequest,NextResponse} from 'next/server';
import {currentUser} from './lib/auth';
import {transaction} from './lib/db';
import {verifiedGatewayOriginsForUser} from './lib/project-gateway-bindings';

export async function proxy(request:NextRequest) {
  const nonce=Buffer.from(crypto.randomUUID()).toString('base64');
  const development=process.env.NODE_ENV==='development';
  let storageOrigins:string[]=[];
  if(process.env.DATABASE_URL&&request.cookies.has('coatria_session')){
    try{const user=await currentUser(request);if(user)storageOrigins=await transaction(db=>verifiedGatewayOriginsForUser(db,user.id));}
    catch{/* Fail closed for transfer origins while leaving the app accessible. */}
  }
  const policy=[
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development?" 'unsafe-eval'":''}`,
    "script-src-attr 'none'",
    // React and the office renderer use inline geometry/color styles.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    `connect-src 'self' blob:${development?' ws: wss:':''}${storageOrigins.length?' '+storageOrigins.join(' '):''}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(!development?['upgrade-insecure-requests']:[])
  ].join('; ');
  const headers=new Headers(request.headers);
  headers.set('x-nonce',nonce);
  headers.set('Content-Security-Policy',policy);
  const response=NextResponse.next({request:{headers}});
  response.headers.set('Content-Security-Policy',policy);
  response.headers.set('Cache-Control','private, no-store');
  return response;
}

export const config={matcher:['/((?!api|_next/static|_next/image|spatial|assets|downloads|icon.svg|favicon.svg).*)']};
