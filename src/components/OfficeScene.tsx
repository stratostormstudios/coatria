"use client";

import { useEffect, useRef, useState } from "react";

type Entity = Record<string, any>;
type Position = { x: number; z: number };
type SceneInstance = {
  dispose: () => void;
  updateSnapshot: (snapshot: Entity) => void;
  setCharacterModel: (id: string, model: unknown, animations: unknown[]) => boolean;
  diagnostics: { position: Position };
  error?: string;
};
type SceneRuntime = {
  mount: (host: HTMLElement, options: Entity) => SceneInstance;
  loadCharacter: () => Promise<{ scene: unknown; animations: unknown[] }>;
  disposeCharacter: (model: unknown) => void;
};

declare global {
  interface Window { CoatriaOfficeRuntime?: SceneRuntime }
}

export type OfficeSceneProps = {
  user: { id: string; name: string; avatarColor?: string };
  company: { id: string; name: string; template: string };
  members: Entity[];
  agents: Entity[];
  presence: Entity[];
  rooms: Entity[];
  layout: Entity[];
  onMove: (position: Position) => void;
  onOpenRoom: (roomId: string) => void;
  onOpenAgent: (agentId: string) => void;
  onOpenPerson: (userId: string) => void;
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

  const geometryKey = JSON.stringify({ company: props.company.id, name: props.company.name, template: props.company.template, user: props.user.id, layout: props.layout, rooms: props.rooms.map(room => ({ id: room.id, name: room.name, kind: room.kind })) });

  useEffect(() => {
    let cancelled = false;
    let mounted: SceneInstance | null = null;
    setState("loading");
    const savedQuality = (() => { try { return localStorage.getItem("coatria-graphics"); } catch { return null; } })();
    loadRuntime().then(runtime => {
      if (cancelled || !host.current) return;
      const latest = current.current;
      const ownPresence = latest.presence.find(person => person.userId === latest.user.id);
      mounted = runtime.mount(host.current, {
        state: { user: latest.user, spatialPosition: ownPresence ? { x: ownPresence.x, z: ownPresence.z } : undefined },
        companyName: latest.company.name,
        // Stored editor coordinates are authoritative for both studio and blank.
        customLayout: true,
        layout: latest.layout.map(item => ({ ...item, kind: item.type, name: item.label })),
        rooms: latest.rooms,
        members: latest.members,
        agents: latest.agents,
        presence: latest.presence,
        quality: savedQuality === "low" ? "low" : "balanced",
        onMove: (position: Position) => current.current.onMove(position),
        onOpenRoom: (id: string) => current.current.onOpenRoom(id),
        onOpenAgent: (id: string) => current.current.onOpenAgent(id),
        onOpenPerson: (id: string) => current.current.onOpenPerson(id),
        onQualityChange: (quality: string) => { try { localStorage.setItem("coatria-graphics", quality); } catch { /* A browser preference is optional. */ } }
      });
      if (!mounted || mounted.error) { mounted?.dispose(); mounted = null; setState("unavailable"); return; }
      instance.current = mounted;
      setState("ready");
      current.current.onMove(mounted.diagnostics.position);
      const target = mounted;
      runtime.loadCharacter().then(asset => {
        if (cancelled || instance.current !== target) { runtime.disposeCharacter(asset.scene); return; }
        if (!target.setCharacterModel(latest.user.id, asset.scene, asset.animations)) runtime.disposeCharacter(asset.scene);
      }).catch(() => { /* The procedural local avatar remains fully functional. */ });
    }).catch(() => { if (!cancelled) setState("unavailable"); });
    return () => { cancelled = true; mounted?.dispose(); if (instance.current === mounted) instance.current = null; };
  }, [geometryKey, retry]);

  useEffect(() => {
    instance.current?.updateSnapshot({ user: props.user, members: props.members, agents: props.agents, presence: props.presence });
  }, [props.user, props.members, props.agents, props.presence]);

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
