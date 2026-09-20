/** Operational gate, not a claim that any particular transfer is healthy. */
export function higgsfieldArchiveAvailability(){
 const enabled=process.env.COATRIA_HIGGSFIELD_ARCHIVE_ENABLED==='true';
 return {enabled,message:enabled?'Archive processing is enabled. Each request is checked again by the transfer worker.':'Archive processing is not enabled for this deployment. You can prepare destinations; approval becomes available after the transfer worker and storage are configured.'};
}
