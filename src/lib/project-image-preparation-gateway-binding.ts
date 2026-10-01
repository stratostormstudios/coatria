/** A verified generic gateway is insufficient: its immutable reviewed
 * configuration must explicitly admit the preparation byte protocol. */
import type {PoolClient} from 'pg';
import {verifiedProjectGateway} from './project-gateway-bindings';
import {parseTrustedServiceGatewayConfiguration,trustedServiceHash} from './trusted-service-config';

export async function verifiedImagePreparationGateway(db:PoolClient,companyId:string,projectId:string){
 const gateway=await verifiedProjectGateway(db,companyId,projectId);if(!gateway)return null;
 const row=(await db.query(`SELECT p.preset,p.created_by,b.verified_by FROM project_gateway_bindings b
  JOIN trusted_service_provisions p ON p.company_id=b.company_id AND p.id=b.provision_id
  WHERE b.company_id=$1 AND b.project_id=$2 AND b.id=$3 AND p.id=$4`,[companyId,projectId,gateway.bindingId,gateway.provisionId])).rows[0];
 if(!row)return null;
 // Keep both distinct gateway sponsors current through the caller's commit.
 // The generic gateway resolver's legacy role checks do not fence timestamp-only revocation.
 const sponsors=[...new Set<string>([row.created_by,row.verified_by])].sort();
 const members=await db.query(`SELECT user_id FROM memberships WHERE company_id=$1 AND user_id=ANY($2::uuid[])
  AND role IN ('owner','admin') AND access_revoked_at IS NULL ORDER BY user_id FOR SHARE`,[companyId,sponsors]);
 if(members.rows.length!==sponsors.length)return null;
 // A binding, stop intent or deadline may change while a membership lock waits.
 const current=await verifiedProjectGateway(db,companyId,projectId);
 if(!current||Object.entries(gateway).some(([key,value])=>current[key as keyof typeof current]!==value))return null;
 try{
  const configuration=parseTrustedServiceGatewayConfiguration(row?.preset?.configuration);
  if(!configuration.imagePreparation||configuration.companyId!==companyId||!configuration.projectIds.includes(projectId)||trustedServiceHash(configuration)!==gateway.configurationHash)return null;
  return gateway;
 }catch{return null;}
}
