import type {Metadata} from 'next';
import './globals.css';
export const metadata:Metadata={title:'Coatria — a place to work, together',description:'Your people, agents and ideas. One shared workplace. Build a virtual office, collaborate on real work, and take your skills with you.'};
export default function RootLayout({children}:{children:React.ReactNode}) {return <html lang="en"><body><a className="skip-link" href="#main">Skip to content</a>{children}</body></html>;}
