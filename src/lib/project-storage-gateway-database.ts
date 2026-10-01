/** Read-only configuration-selected gateway preflight. No HTTP startup, pool
 * creation or runtime selection occurs when this module is imported. */
import {assertProjectStorageGatewayDatabase} from './project-storage-preflight';
import {assertImagePreparationGatewayDatabase} from './project-image-preparation-gateway-database.mjs';
import {parseTrustedServiceGatewayConfiguration} from './trusted-service-config';

type Database={query(sql:string,values?:unknown[]):Promise<{rows:Record<string,unknown>[]}>};
export function assertStorageGatewayStartupDatabase(db:Database,configuration?:unknown){
 const config=configuration===undefined?undefined:parseTrustedServiceGatewayConfiguration(configuration);
 return config?.imagePreparation?assertImagePreparationGatewayDatabase(db):assertProjectStorageGatewayDatabase(db);
}
