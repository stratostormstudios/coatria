import {parseReferenceEnrollmentRequest,referenceEnrollmentHash,referenceEnrollmentCanonical,referenceEnrollmentServiceIdentity,referenceEnrollmentProjectIdentity} from '../../scripts/hosting/reference-enrollment-contract.mjs';

/** A hash match authenticates an immutable registrar record inside this DB trust
 * boundary. It is not a remote-host attestation or a new qualification decision. */
export function verifiedReferenceServiceEnrollment(service:Record<string,any>,projects:Record<string,any>[],enrollment:Record<string,any>|undefined){
 if(!enrollment)throw Error('REFERENCE_SERVICE_ENROLLMENT_REQUIRED');
 const identity=parseReferenceEnrollmentRequest(enrollment.identity,{allowExpired:true});
 if(enrollment.service_id!==service.id||enrollment.company_id!==service.company_id||enrollment.request_id!==identity.requestId||enrollment.request_hash!==referenceEnrollmentHash(identity)||Object.entries(referenceEnrollmentServiceIdentity(identity)).some(([key,value])=>service[key]!==value)||new Date(service.expires_at).toISOString()!==identity.expiresAt||referenceEnrollmentCanonical(service.upload_hosts)!==referenceEnrollmentCanonical(identity.uploadHosts)||referenceEnrollmentCanonical(projects)!==referenceEnrollmentCanonical(referenceEnrollmentProjectIdentity(identity)))throw Error('REFERENCE_SERVICE_ENROLLMENT_REQUIRED');
 return identity;
}
