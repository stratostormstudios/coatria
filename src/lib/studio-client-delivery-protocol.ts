import {z} from 'zod';

const uuid=z.string().uuid();
export const STUDIO_CLIENT_DELIVERY_MAX_DAYS=30;
export const STUDIO_CLIENT_DELIVERY_MAX_FILES=2400;
export const studioClientDeliveryCreateInput=z.object({
 clientId:uuid,revision:z.number().int().min(1),deliveryId:uuid,recipientUserId:uuid,
 identityConfirmation:z.literal('confirmed_out_of_band'),expiresAt:z.string().datetime({offset:false}),
}).strict();
export const studioClientDeliveryRevokeInput=z.object({clientId:uuid,revision:z.number().int().min(1)}).strict();
export const studioClientDeliveryAccessInput=z.object({clientId:uuid}).strict();
export const studioClientDeliveryResponseInput=z.object({clientId:uuid,revision:z.number().int().min(1),decision:z.enum(['acknowledged','changes_requested']),note:z.string().trim().min(1).max(4000)}).strict();
export const studioClientDeliveryListInput=z.object({after:uuid.optional(),limit:z.coerce.number().int().min(1).max(50).default(20)}).strict();
export type StudioClientDeliveryFile={fileId:string;artifactId:string;path:string;frame:number|null;sha256:string;bytes:number;contentType:string};
type StudioClientPackageBase={delivery:{id:string;name:string;preparedAt:string};project:{id:string;name:string;clientName:string;spec:Record<string,unknown>};sourceManifestSha256:string;reviewBasis:'independently_approved';artifacts:Array<{id:string;name:string;version:number;sha256:string}>};
export type StudioGeneratedClientDeliveryFile=StudioClientDeliveryFile&{frame:null;storageVersionId:string;mediaKind:'image'|'video'|'audio';transport:'project_storage'};
export type StudioLegacyClientPackage=StudioClientPackageBase&{schemaVersion:1;files:StudioClientDeliveryFile[]};
export type StudioGeneratedClientPackage=StudioClientPackageBase&{schemaVersion:2;files:StudioGeneratedClientDeliveryFile[]};
export type StudioClientPackage=StudioLegacyClientPackage|StudioGeneratedClientPackage;
export type StudioGeneratedClientAccess={transport:'project_storage';storageVersionId:string;gatewayOrigin:string;url:string;headers:{Authorization:string};expiresAt:string;bytes:number;name:string;sha256:string;contentType:string;status:'download_access_issued';bytesReceivedByClient:'not_observed'};
export type StudioClientDeliveryReceipt={id:string;kind:'portal_opened'|'download_access_issued'|'acknowledged'|'changes_requested'|'revoked';actorUserId:string;fileId:string|null;note:string|null;createdAt:string;packageSha256:string};
export type StudioClientDeliveryShare={id:string;projectId:string;deliveryId:string;recipientUserId:string;recipientName:string;identityBasis:'account_confirmed_out_of_band';emailVerifiedAtCreation:boolean;status:'active'|'revoked';revision:number;expiresAt:string;createdAt:string;createdBy:string;packageSha256:string;sourceManifestSha256:string;response:'awaiting_response'|'acknowledged'|'changes_requested';invitationPath:string;fileCount:number;receiptSummary:{portalOpened:number;downloadAccessIssued:number;clientAcknowledged:number;changesRequested:number};transferStatus:'not_observed';expired:boolean};
export type StudioClientDeliveryList={shares:StudioClientDeliveryShare[];page:{hasMore:boolean;nextAfter:string|null;limit:number}};
export type StudioClientDeliveryDetail={share:StudioClientDeliveryShare;package:StudioClientPackage;receipts:StudioClientDeliveryReceipt[];receiptPage:{hasMore:boolean;nextAfter:string|null;limit:number};canRespond:boolean;responseBlockedReason:string|null;identity:{userId:string;name:string;emailVerified:boolean}};
