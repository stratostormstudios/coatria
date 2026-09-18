import {StudioClientPortal} from '@/components/StudioClientDeliveries';
export const metadata={title:'Private delivery · Coatria',robots:{index:false,follow:false},referrer:'no-referrer' as const};
export default async function ClientDeliveryPage({params}:{params:Promise<{shareId:string}>}){const {shareId}=await params;return <StudioClientPortal shareId={shareId}/>;}
