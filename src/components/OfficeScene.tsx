"use client";

import { useEffect, useRef, useState } from "react";
import { selectAvatarForUser, type AvatarDefinition } from "@/lib/avatar-catalog";
import { DEFAULT_FLOOR, type FloorSize } from "@/lib/floor-plan";
import { OFFICE_CATALOG, type OfficeAssetDefinition } from "@/lib/office-catalog";

type Entity = Record<string, any>;
type Position = { x: number; z: number };
export type OfficeDiagnostics = {
  performance?:{state?:'active'|'idle'|'suspended'|'disposed';renderedSampleCount?:number;sampleCount:number;windowSeconds:number;fps:number;frameMs:{p50:number;p95:number};workMs:{p50:number;p95:number};animationMs:{p50:number;p95:number};renderMs:{p50:number;p95:number};labelsMs:{p50:number;p95:number};drawCalls:number;triangles:number};
  animation?:{visibleHumans:number;fullRateHumans:number;reducedRateHumans:number;culledHumans:number;mixerUpdatesLastFrame:number;fullRateBudget:number};
  resources?:{geometries:number;textures:number;programs:number;loadedCharacterModels:number;skinnedMeshes:number;bones:number;pickTargets:number};
  [key:string]:unknown;
};
type SceneInstance = {
  dispose: () => void;
  updateSnapshot: (snapshot: Entity) => void;
  diagnostics: OfficeDiagnostics & { position: Position };
  resetPerformance?: () => void;
  selectEntity?: (id:string) => boolean;
  error?: string;
};
type SceneRuntime = {
  mount: (host: HTMLElement, options: Entity) => SceneInstance;
  createCharacterLibrary: (options: { userId: string; selectAvatar: typeof selectAvatarForUser }) => CharacterLibrary;
  createOfficeAssetLibrary: (options: { userId: string; catalog: readonly OfficeAssetDefinition[] }) => OfficeAssetLibrary;
};
type OfficeAssetLibrary = {
  loadAsset: (assetId: string) => Promise<{scene: unknown; metadata: OfficeAssetDefinition; release: () => void}>;
  dispose: () => void;
};
type CharacterLibrary = {
  loadCharacter: (person: { id: string; avatarId?: string | null }) => Promise<{ scene: unknown; animations: unknown[]; metadata: AvatarDefinition; release: () => void }>;
  dispose: () => void;
};

declare global {
  interface Window { CoatriaOfficeRuntime?: SceneRuntime }
}

export type OfficeSceneProps = {
  user: { id: string; name: string; avatarColor?: string; avatarId?: string | null };
  company: { id: string; name: string; template: string };
  members: Entity[];
  agents: Entity[];
  presence: Entity[];
  rooms: Entity[];
  layout: Entity[];
  floor?: FloorSize;
  onMove: (position: Position) => void;
  onOpenRoom: (roomId: string) => void;
  onOpenAgent: (agentId: string) => void;
  onOpenPerson: (userId: string) => void;
  onDiagnostics?: (diagnostics:OfficeDiagnostics) => void;
  performanceResetKey?: number;
  selectionRequest?: {id:string;sequence:number};
};

let runtimePromise: Promise<SceneRuntime> | undefined;
function loadRuntime(): Promise<SceneRuntime> {
  if (window.CoatriaOfficeRuntime) return Promise.resolve(window.CoatriaOfficeRuntime);
  if (runtimePromise) return runtimePromise;
  runtimePromise = new Promise<SceneRuntime>((resolve, reject) => {
    if (!document.querySelector('link[data-coatria-spatial="styles"]')) {
      const link = document.createElement("link");
      link.rel = "stylesheet"; link.href = "/spatial/office-scene.css";
      link.dataset.coatriaSpatial = "styles"; document.head.append(link);
    }
    const script = document.createElement("script");
    script.type = "module"; script.src = "/spatial/bootstrap.js";
    script.onload = () => window.CoatriaOfficeRuntime ? resolve(window.CoatriaOfficeRuntime) : reject(new Error("Office renderer did not initialize."));
    script.onerror = () => { script.remove(); runtimePromise = undefined; reject(new Error("Office renderer could not be loaded.")); };
    document.head.append(script);
  });
  return runtimePromise;
}

export default function OfficeScene(props: OfficeSceneProps) {
  const host = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  const instance = useRef<SceneInstance | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [retry, setRetry] = useState(0);
  current.current = props;

  const geometryKey = JSON.stringify({ company: props.company.id, name: props.company.name, template: props.company.template, user: props.user.id, layout: props.layout, floor: props.floor ?? DEFAULT_FLOOR, rooms: props.rooms.map(room => ({ id: room.id, name: room.name, kind: room.kind })) });

  useEffect(() => {
    let cancelled = false;
    let mounted: SceneInstance | null = null;
    let library: CharacterLibrary | null = null;
    let furnitureLibrary: OfficeAssetLibrary | null = null;
    setState("loading");
    const savedQuality = (() => { try { return localStorage.getItem("coatria-graphics"); } catch { return null; } })();
    loadRuntime().then(runtime => {
      if (cancelled || !host.current) return;
      const latest = current.current;
      const ownPresence = latest.presence.find(person => person.userId === latest.user.id);
      library = runtime.createCharacterLibrary?.({ userId: latest.user.id, selectAvatar: selectAvatarForUser }) || null;
      furnitureLibrary = runtime.createOfficeAssetLibrary({ userId: latest.user.id, catalog: OFFICE_CATALOG });
      mounted = runtime.mount(host.current, {
        state: { user: latest.user, spatialPosition: ownPresence ? { x: ownPresence.x, z: ownPresence.z } : undefined },
        companyName: latest.company.name,
        // Stored editor coordinates are authoritative for both studio and blank.
        customLayout: true,
        layout: latest.layout.map(item => ({ ...item, kind: item.type, name: item.label })),
        floor: latest.floor,
        rooms: latest.rooms,
        members: latest.members,
        agents: latest.agents,
        presence: latest.presence,
        loadCharacter: library?.loadCharacter,
        officeCatalog: OFFICE_CATALOG,
        loadOfficeAsset: furnitureLibrary.loadAsset,
        quality: savedQuality === "low" ? "low" : "balanced",
        onMove: (position: Position) => current.current.onMove(position),
        onOpenRoom: (id: string) => current.current.onOpenRoom(id),
        onOpenAgent: (id: string) => current.current.onOpenAgent(id),
        onOpenPerson: (id: string) => current.current.onOpenPerson(id),
        onQualityChange: (quality: string) => { try { localStorage.setItem("coatria-graphics", quality); } catch { /* A browser preference is optional. */ } }
      });
      if (!mounted || mounted.error) { mounted?.dispose(); mounted = null; library?.dispose(); library = null; furnitureLibrary?.dispose(); furnitureLibrary = null; setState("unavailable"); return; }
      instance.current = mounted;
      setState("ready");
      current.current.onMove(mounted.diagnostics.position);
    }).catch(() => { mounted?.dispose(); library?.dispose(); furnitureLibrary?.dispose(); if (!cancelled) setState("unavailable"); });
    return () => { cancelled = true; mounted?.dispose(); library?.dispose(); furnitureLibrary?.dispose(); if (instance.current === mounted) instance.current = null; };
  }, [geometryKey, retry]);

  useEffect(() => {
    instance.current?.updateSnapshot({ user: props.user, members: props.members, agents: props.agents, presence: props.presence });
  }, [props.user, props.members, props.agents, props.presence]);

  useEffect(()=>{instance.current?.resetPerformance?.();},[props.performanceResetKey,state]);
  useEffect(()=>{if(props.selectionRequest)instance.current?.selectEntity?.(props.selectionRequest.id);},[props.selectionRequest,state]);
  useEffect(()=>{if(!props.onDiagnostics||state!=='ready')return;const sample=()=>{if(instance.current)current.current.onDiagnostics?.(instance.current.diagnostics);};sample();const timer=setInterval(sample,1000);return()=>clearInterval(timer);},[Boolean(props.onDiagnostics),state]);

  return <section className="coatria-office-scene" aria-label="Shared company office">
    <div ref={host} style={{ minHeight: state === "unavailable" ? undefined : 560 }} />
    {state === "loading" && <p role="status" className="coatria-scene-loading">Opening your office…</p>}
    {state === "unavailable" && <div className="coatria-scene-unavailable">
      <h3>The 3D view is unavailable here.</h3>
      <p>Every room is still available below. You can keep working without the 3D view.</p>
      <button type="button" onClick={() => setRetry(value => value + 1)}>Try the 3D view again</button>
    </div>}
    <details className="coatria-scene-room-list" open={state === "unavailable"}>
      <summary>Office rooms · accessible list</summary>
      <div className="coatria-scene-room-buttons">
        {props.rooms.length ? props.rooms.map(room => <button type="button" key={room.id} onClick={() => props.onOpenRoom(room.id)}>{room.name}</button>) : <p>This floor has no rooms yet. A company administrator can add the first room.</p>}
      </div>
    </details>
  </section>;
}
