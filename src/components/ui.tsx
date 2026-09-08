'use client';
import {Children,cloneElement,isValidElement,useEffect,useId,useRef,useState, type ReactNode, type ReactElement, type FormEvent} from 'react';
import {ArrowRight, Check, Copy, LoaderCircle, X, type LucideIcon} from 'lucide-react';
import {initials} from '@/lib/client';

export function Brand({small=false}:{small?:boolean}) { return <span className={'brand '+(small?'brand-small':'')}><span className="brand-symbol" aria-hidden="true"><i/><i/><i/></span>{!small && 'coatria'}<span className="sr-only">{small?'Coatria':''}</span></span>; }
export function Avatar({name,color,size='normal'}:{name:string;color?:string;size?:string}) { return <span className={'avatar '+size} style={color && /^#[0-9a-f]{6}$/i.test(color)?{background:color}:undefined}>{initials(name)}</span>; }
export function Badge({children,tone=''}:{children:ReactNode;tone?:string}) { return <span className={'badge '+tone}>{children}</span>; }
export function PageHead({eyebrow,title,description,action}:{eyebrow:string;title:string;description?:string;action?:ReactNode}) { return <div className="page-head"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1>{description&&<p>{description}</p>}</div>{action&&<div className="head-action">{action}</div>}</div>; }
export function Empty({icon:Icon,title,description,action}:{icon:LucideIcon;title:string;description:string;action?:ReactNode}) { return <div className="empty"><span className="empty-icon"><Icon size={24}/></span><h3>{title}</h3><p>{description}</p>{action}</div>; }
export function Loading({label='Loading your workspace'}:{label?:string}) { return <div className="loading" role="status"><LoaderCircle className="spin" size={23}/><span>{label}…</span></div>; }
export function Field({label,children,hint}:{label:string;children:ReactNode;hint?:string}) {
 const id=useId();let controlId=id;
 function associate(nodes:ReactNode):ReactNode{return Children.map(nodes,node=>{if(!isValidElement(node))return node;const child=node as ReactElement<Record<string,unknown>>;
  if(typeof child.type==='string'&&['input','select','textarea'].includes(child.type)){controlId=typeof child.props.id==='string'?child.props.id:id;return cloneElement(child,{id:controlId,'aria-describedby':[child.props['aria-describedby'],hint?id+'-hint':null].filter(Boolean).join(' ')||undefined});}
  return child.props.children?cloneElement(child,{},associate(child.props.children as ReactNode)):child;
 });}
 const content=associate(children);
 return <div className="field"><label htmlFor={controlId}>{label}</label>{content}{hint&&<small id={id+'-hint'}>{hint}</small>}</div>;
}
export function Form({onSubmit,children,submit='Save changes',pendingLabel='Saving…',className='',disabled=false,submitDisabled=false}:{onSubmit:(form:HTMLFormElement)=>Promise<void>;children:ReactNode;submit?:string;pendingLabel?:string;className?:string;disabled?:boolean;submitDisabled?:boolean}) {
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),submitting=useRef(false),errorRef=useRef<HTMLParagraphElement>(null);
 useEffect(()=>{if(error)errorRef.current?.focus();},[error]);
 async function handle(e:FormEvent<HTMLFormElement>){e.preventDefault();if(submitting.current||disabled||submitDisabled)return;const form=e.currentTarget;submitting.current=true;setError('');setBusy(true);try{await onSubmit(form);}catch(err){setError(err instanceof Error?err.message:'Something went wrong. Please try again.');}finally{submitting.current=false;setBusy(false);}}
 return <form onSubmit={handle} className={'form '+className} aria-busy={busy}><fieldset disabled={busy||disabled}>{children}</fieldset>{error&&<p ref={errorRef} tabIndex={-1} role="alert" className="error-message">{error}</p>}<button className="button primary" disabled={busy||disabled||submitDisabled} type="submit">{busy?<LoaderCircle size={16} className="spin"/>:<ArrowRight size={16}/>} {busy?pendingLabel:submit}</button></form>;
}
let openModalCount=0,previousBodyOverflow='';
export function Modal({title,description,onClose,children,wide=false}:{title:string;description?:string;onClose:()=>void;children:ReactNode;wide?:boolean}) {
 const ref=useRef<HTMLDialogElement>(null),id=useId();
 useEffect(()=>{const d=ref.current,active=document.activeElement as HTMLElement|null;d?.showModal();d?.querySelector<HTMLElement>('input:not([type=hidden]):not(:disabled),textarea:not(:disabled),select:not(:disabled)')?.focus();if(openModalCount++===0){previousBodyOverflow=document.body.style.overflow;document.body.style.overflow='hidden';}return()=>{d?.close();if(--openModalCount===0)document.body.style.overflow=previousBodyOverflow;if(active?.isConnected)active.focus();};},[]);
 return <dialog ref={ref} className={'modal '+(wide?'wide':'')} aria-labelledby={id+'-title'} aria-describedby={description?id+'-description':undefined} onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target===e.currentTarget){const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)onClose();}}}><header><div><h2 id={id+'-title'}>{title}</h2>{description&&<p id={id+'-description'}>{description}</p>}</div><button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20}/></button></header><div className="modal-body">{children}</div></dialog>;
}
export function CopyButton({text,label='Copy'}:{text:string;label?:string}) {
 const [copied,setCopied]=useState(false),[error,setError]=useState(false),timer=useRef<ReturnType<typeof setTimeout>|null>(null);
 useEffect(()=>()=>{if(timer.current)clearTimeout(timer.current);},[]);
 return <><button type="button" className="button secondary small" onClick={async()=>{setError(false);try{await navigator.clipboard.writeText(text);setCopied(true);if(timer.current)clearTimeout(timer.current);timer.current=setTimeout(()=>setCopied(false),2500);}catch{setError(true);}}}>{copied?<Check size={15}/>:<Copy size={15}/>} {copied?'Copied':label}</button><span className="sr-only" role="status">{copied?'Copied to clipboard':''}</span>{error&&<small role="alert">Select and copy the text manually.</small>}</>;
}
export function Secret({token,title='Save your connection token',children}:{token:string;title?:string;children?:ReactNode}) {return <div className="secret-box"><Badge tone="warning">Shown only once</Badge><h3>{title}</h3><p>Keep this token in your local environment or secret manager. It gives access to this company integration.</p><textarea readOnly aria-label="Connection token" value={token} rows={3}/><CopyButton text={token} label="Copy token"/>{children}</div>;}
