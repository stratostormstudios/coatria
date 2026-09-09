import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';

// Coatria's geometry-first office. Occupants come only from authenticated
// workspace snapshots; geometry and client movement never grant permissions.
let activeInstance = null;
const html = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

export function mount(host, options = {}) {
  activeInstance?.dispose();
  if (!host) return null;
  const state = options.state || {};
  const user = state.user || {};
  const roomRecords = Array.isArray(options.rooms) ? options.rooms : [];
  const assignedRooms = new Set();
  const reducedMotion = !!(options.reducedMotion ?? user.reducedMotion ?? window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const custom = !!options.customLayout;
  const dimension=(value,fallback)=>Number.isFinite(value)?THREE.MathUtils.clamp(value,8,40):fallback;
  const floor={width:dimension(options.floor?.width,20),depth:dimension(options.floor?.depth,16)};
  const halfWidth=floor.width/2,halfDepth=floor.depth/2,sceneScale=Math.max(floor.width/20,floor.depth/16);
  const nav={minX:-halfWidth+.45,maxX:halfWidth-.45,minZ:-halfDepth+.45,maxZ:halfDepth-.45};
  const step=.38,columns=Math.ceil((nav.maxX-nav.minX)/step)+1,rows=Math.ceil((nav.maxZ-nav.minZ)/step)+1;
  const stepX=(nav.maxX-nav.minX)/(columns-1),stepZ=(nav.maxZ-nav.minZ)/(rows-1),footprints=[];
  let disposed = false, quality = options.quality === 'low' ? 'low' : 'balanced';
  let dirty = true, walking = false, frame = 0, lastFrame = 0, lastMoveSent = 0, lastExpiryCheck = 0, selected = null, path = [], expanded = false, previousOverflow = '';
  let scene, camera, renderer, controls, sun, player, selectionRing, destinationRing;
  const geometries = new Map(), materials = new Map(), clickable = [], characters = [], labels = [], obstacles = [], listeners = [], officeAssets = [];
  const officeCatalog = new Map((options.officeCatalog || []).map(asset => [asset.id, asset]));
  let framingHeight = 3.8;
  const hostClass = host.className;
  host.classList.add('cs-scene');
  host.innerHTML = `<div class="cs-scene-stage" tabindex="0" role="application" aria-label="Interactive 3D office. Drag to orbit, scroll to zoom, click the floor to walk. Use the labeled people and room buttons or the office List view for keyboard navigation."></div>
    <div class="cs-scene-heading"><span class="cs-scene-live"><i></i> COATRIA OFFICE</span><div class="cs-scene-heading-right"><span class="cs-scene-floor">${html(options.companyName || (custom ? 'Your custom floor' : 'The studio'))} <b>01</b></span><button type="button" class="cs-scene-expand" data-scene="expand" aria-label="Expand office view" aria-pressed="false" title="Expand office"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg><span>Expand office</span></button></div></div>
    <div class="cs-scene-labels" aria-label="People and rooms"></div>
    <div class="cs-scene-context" hidden></div>
    <div class="cs-scene-bottom"><div class="cs-scene-help"><span class="cs-scene-mouse">↗</span><span><strong>Make yourself at home.</strong><small>Click to walk · Drag to orbit · Scroll to zoom</small></span></div>
    <div class="cs-scene-controls" aria-label="3D view controls"><button type="button" data-scene="zoom-out" aria-label="Zoom out" title="Zoom out">−</button><button type="button" data-scene="reset" aria-label="Reset camera" title="Reset camera"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/></svg></button><button type="button" data-scene="zoom-in" aria-label="Zoom in" title="Zoom in">+</button><span></span><button type="button" data-scene="quality" aria-label="Graphics quality: ${quality}. Switch quality." title="Switch graphics quality">${quality === 'low' ? 'Low' : 'Balanced'}</button></div></div>
    <div class="cs-scene-status" aria-live="polite">${custom && !options.layout?.length ? 'An empty floor, ready for your first room.' : 'Click a person, an AI coworker, or a desk to connect.'}</div>
    <div class="cs-scene-key"><span><i></i> HUMAN</span><span><i class="ai"></i> AI AGENT</span><span class="cs-scene-prototype">Presence refreshes every 5 seconds</span></div>`;
  const stage = host.querySelector('.cs-scene-stage'), labelHost = host.querySelector('.cs-scene-labels'), context = host.querySelector('.cs-scene-context'), status = host.querySelector('.cs-scene-status');
  const on = (el, event, fn, opts) => { el.addEventListener(event, fn, opts); listeners.push(() => el.removeEventListener(event, fn, opts)); };
  const say = message => { status.textContent = message; };
  try {
    renderer = new THREE.WebGLRenderer({antialias: true, alpha: true, powerPreference: 'low-power'});
  } catch (error) {
    stage.innerHTML = `<div class="cs-scene-fallback"><strong>Your browser couldn’t start the 3D view.</strong><p>The office List view above still gives you access to every room and workstation.</p><button type="button">Try again</button></div>`;
    stage.querySelector('button').onclick = () => mount(host, options);
    const fallback = {dispose() { listeners.forEach(fn => fn()); host.innerHTML = ''; host.className = hostClass; }, error: error.message};
    activeInstance = fallback;
    return fallback;
  }
  stage.append(renderer.domElement);
  renderer.domElement.setAttribute('aria-hidden', 'true');
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.07;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  scene = new THREE.Scene();
  scene.background = new THREE.Color('#e9ede7');
  camera = new THREE.OrthographicCamera(-15, 15, 13, -13, .1, 180*Math.max(1,sceneScale));
  camera.position.set(24*sceneScale,27*sceneScale,29*sceneScale);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, .2, 0);
  controls.enableDamping = true;
  controls.dampingFactor = .12;
  controls.enablePan = true;
  controls.minZoom = .7; controls.maxZoom = 2.7;
  controls.minPolarAngle = .35; controls.maxPolarAngle = Math.PI / 2.6;
  controls.mouseButtons = {LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN};
  controls.touches = {ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN};
  controls.addEventListener('change', () => { dirty = true; });
  scene.add(new THREE.HemisphereLight('#f8fcff', '#7a8770', 1.8));
  const fill = new THREE.DirectionalLight('#c7dfe8', 1.15); fill.position.set(-12, 7, 4); scene.add(fill);
  sun = new THREE.DirectionalLight('#fff1d6', 3.4);
  sun.position.set(-9*sceneScale,23*sceneScale,12*sceneScale); sun.castShadow = true;
  const shadowExtent=Math.hypot(floor.width,floor.depth)*.72+3;
  Object.assign(sun.shadow.camera, {left:-shadowExtent,right:shadowExtent,top:shadowExtent,bottom:-shadowExtent,near:.1,far:Math.max(40,70*sceneScale)});
  sun.shadow.bias = -.00025; sun.shadow.normalBias = .035; sun.shadow.radius = 3;
  scene.add(sun);
  const architecture = new THREE.Group(); scene.add(architecture);
  let staticParent=architecture;
  const dynamic = new THREE.Group(); scene.add(dynamic);
  // Async licensed models keep their source geometry/materials shared. They are
  // deliberately excluded from procedural architecture batching and disposal.
  const assetLayer = new THREE.Group(); assetLayer.name='office-asset-instances'; scene.add(assetLayer);
  const assetNotice = document.createElement('div'), assetMessage = document.createElement('span'), assetRetry = document.createElement('button');
  assetNotice.dataset.officeAssetStatus=''; assetNotice.setAttribute('role','status'); assetNotice.hidden=true;
  Object.assign(assetNotice.style,{position:'absolute',left:'16px',bottom:'160px',zIndex:'6',maxWidth:'min(340px, calc(100% - 32px))',padding:'10px 12px',border:'1px solid #b6c1ae',borderRadius:'10px',background:'#f8faf3',color:'#304337',fontSize:'13px',lineHeight:'1.5',boxShadow:'0 4px 18px #20342812'});
  assetRetry.type='button';assetRetry.textContent='Retry furniture';Object.assign(assetRetry.style,{display:'block',marginTop:'8px',padding:'7px 10px',border:'1px solid #405740',borderRadius:'6px',background:'#304a36',color:'#fff',font:'inherit',cursor:'pointer'});
  assetNotice.append(assetMessage,assetRetry);host.append(assetNotice);
  on(assetRetry,'click',event=>{event.stopPropagation();retryOfficeAssets();});
  function mat(color, extra = {}) {
    const key = `${color}/${JSON.stringify(extra)}`;
    if (!materials.has(key)) materials.set(key, new THREE.MeshStandardMaterial({color, roughness:.84, metalness:0, ...extra}));
    return materials.get(key);
  }
  const M = {floor:mat('#e0e2d3'), edge:mat('#b8c8b3'), cream:mat('#f3f0df'), white:mat('#faf9f0'), timber:mat('#ce9d64'), timberEdge:mat('#ac8053'), dark:mat('#33473e'), metal:mat('#55655d'), screen:mat('#263c3c'), screenLit:mat('#a8c9b7', {emissive:'#547568',emissiveIntensity:.2}), sage:mat('#9aaf94'), sageDark:mat('#678361'), powder:mat('#a8c2ca'), clay:mat('#bd8364'), soil:mat('#665748'), leaf:mat('#749068', {flatShading:true}), leafLight:mat('#a4b789',{flatShading:true}), glass:mat('#cae1d9',{transparent:true,opacity:.19,roughness:.22,depthWrite:false}), lime:mat('#c8ec81'), bot:mat('#d2ed9f'), charcoal:mat('#3d4943'), brass:mat('#bc9d60')};
  function geometry(type, args) {
    const key = type + ':' + args.join(',');
    if (!geometries.has(key)) geometries.set(key, new THREE[type](...args));
    return geometries.get(key);
  }
  function mesh(geo, material, x=0, y=0, z=0, parent=staticParent, shadows=true) {
    const obj = new THREE.Mesh(geo, material); obj.position.set(x,y,z); obj.castShadow = shadows; obj.receiveShadow = true; parent.add(obj); return obj;
  }
  const box = (w,h,d,m,x,y,z,parent=staticParent) => mesh(geometry('BoxGeometry',[w,h,d]),m,x,y,z,parent);
  const cyl = (top,bottom,h,sides,m,x,y,z,parent=staticParent) => mesh(geometry('CylinderGeometry',[top,bottom,h,sides]),m,x,y,z,parent);
  const ball = (r,m,x,y,z,parent=staticParent) => mesh(geometry('SphereGeometry',[r,8,6]),m,x,y,z,parent);
  function group(x=0,z=0,angle=0,parent=staticParent) { const g = new THREE.Group(); g.position.set(x,0,z); g.rotation.y=angle; parent.add(g); return g; }
  // Physical bounds are transformed with furniture; actor clearance is added in open().
  function block(x,z,w,d) { obstacles.push({minX:x-w/2,maxX:x+w/2,minZ:z-d/2,maxZ:z+d/2}); }
  function pick(x,z,w,h,d,data) {
    const hit = mesh(geometry('BoxGeometry',[w,h,d]), new THREE.MeshBasicMaterial({visible:false}),x,h/2,z,dynamic,false);
    hit.userData.entity = data; clickable.push(hit); return hit;
  }
  function textLabel(text, x, y, z, data, className='') {
    const el = document.createElement('button'); el.type='button'; el.className='cs-scene-label '+className; el.textContent=text;
    el.setAttribute('aria-label', data.type==='room' ? `View ${text}` : `Select ${text}`);
    el.onclick = event=>{event.stopPropagation(); select(data);};
    labelHost.append(el); labels.push({el,position:new THREE.Vector3(x,y,z),data});
  }
  function updateAssetNotice() {
    if(disposed)return;
    const failed=officeAssets.filter(entry=>entry.status==='failed').length,pending=officeAssets.filter(entry=>entry.status==='loading').length;
    assetNotice.hidden=!failed&&!pending;assetRetry.hidden=!failed;assetRetry.style.display=failed?'block':'none';
    assetMessage.textContent=failed?`${failed} furniture ${failed===1?'item couldn’t':'items couldn’t'} load. Basic shapes are shown.${pending?' Other furniture is still loading.':''}`:`Loading furniture… ${officeAssets.length-pending} of ${officeAssets.length}`;
  }
  function setAssetBounds(entry,box3) {
    const bounds={minX:box3.min.x,maxX:box3.max.x,minZ:box3.min.z,maxZ:box3.max.z};
    entry.footprint.meshBounds={...bounds};entry.footprint.furnitureBounds={...bounds};
    if(entry.obstacle)Object.assign(entry.obstacle,bounds);
    entry.data.bounds={...bounds};
  }
  async function loadOfficeAsset(entry) {
    if(disposed||entry.status==='loading')return;
    const revision=++entry.revision;entry.status='loading';updateAssetNotice();
    let lease;
    try {
      if(!entry.metadata||typeof options.loadOfficeAsset!=='function')throw new Error('Furniture is unavailable.');
      lease=await options.loadOfficeAsset(entry.assetId);
      if(disposed||entry.revision!==revision){lease.release();return;}
      const model=lease.scene,sourceBounds=new THREE.Box3().setFromObject(model),size=sourceBounds.getSize(new THREE.Vector3()),center=sourceBounds.getCenter(new THREE.Vector3());
      if(![size.x,size.y,size.z].every(value=>Number.isFinite(value)&&value>=0)||size.x<.000001||size.z<.000001)throw new Error('Furniture dimensions are invalid.');
      const uniform=Math.min(entry.localW/size.x,entry.localD/size.z),sx=entry.metadata.resize==='footprint'?entry.localW/size.x:uniform,sz=entry.metadata.resize==='footprint'?entry.localD/size.z:uniform,sy=entry.metadata.resize==='footprint'?1:uniform;
      const alignment=new THREE.Group();alignment.scale.set(sx,sy,sz);alignment.position.set(-center.x*sx,-sourceBounds.min.y*sy,-center.z*sz);alignment.add(model);entry.root.add(alignment);
      model.userData.coatriaOfficeAsset=entry.assetId;
      model.traverse(object=>{if(object.isMesh){object.castShadow=entry.metadata.collidable!==false;object.receiveShadow=true;}});
      entry.lease=lease;entry.model=model;entry.alignment=alignment;entry.placeholder.visible=false;entry.status='ready';
      entry.root.updateMatrixWorld(true);
      const bounds=new THREE.Box3().setFromObject(alignment);setAssetBounds(entry,bounds);
      const actual=bounds.getSize(new THREE.Vector3());entry.height=actual.y;entry.scale={x:sx,y:sy,z:sz};
      entry.hit.scale.set(size.x*sx,Math.max(.06,actual.y),size.z*sz);entry.hit.position.y=Math.max(.06,actual.y)/2;
      if(bounds.max.y>framingHeight){framingHeight=bounds.max.y;resize();}
      dirty=true;
    } catch {
      lease?.release();
      if(disposed||entry.revision!==revision)return;
      entry.status='failed';
    }
    updateAssetNotice();
  }
  function retryOfficeAssets(){for(const entry of officeAssets)if(entry.status==='failed')void loadOfficeAsset(entry);}
  function addOfficeAsset(item,{x,z,width,depth,localW,localD,rotation}) {
    const metadata=officeCatalog.get(item.assetId),root=group(x,z,-rotation*Math.PI/180,assetLayer),id=String(item.id||`furniture-${officeAssets.length}`);
    root.name='office-asset:'+id;root.position.y=.08+(metadata?.collidable===false ? .002+officeAssets.length*.00002 : 0);
    const height=Math.max(.025,Math.min(metadata?.height||.4,1.2)),placeholder=box(localW,height,localD,M.sage,0,height/2,0,root);
    const bounds={minX:x-width/2,maxX:x+width/2,minZ:z-depth/2,maxZ:z+depth/2};
    const data={type:'furniture',id,assetId:item.assetId,name:item.name||item.label||metadata?.name||'Furniture',x,z,bounds:{...bounds},description:metadata?`${metadata.name}. ${metadata.collidable===false?'A walkable floor finish.':'Select “Walk nearby” to move beside this piece.'}`:'This piece is unavailable. Its saved footprint is shown.'};
    const hit=pick(0,0,1,1,1,data);root.add(hit);hit.position.y=height/2;hit.scale.set(localW,height,localD);
    // Floor finishes must not intercept every ordinary click-to-walk gesture.
    if(metadata?.collidable===false)clickable.splice(clickable.indexOf(hit),1);
    const obstacle=metadata?.collidable===false?null:{...bounds};if(obstacle)obstacles.push(obstacle);
    const footprint={id,assetId:item.assetId,kind:'asset',rotation,x,z,width,depth,forward:{x:-Math.sin(rotation*Math.PI/180),z:Math.cos(rotation*Math.PI/180)},bounds:{...bounds},meshBounds:{...bounds},furnitureBounds:{...bounds}};
    footprints.push(footprint);
    const entry={id,assetId:item.assetId,metadata,root,placeholder,hit,obstacle,footprint,data,localW,localD,status:'pending',revision:0,lease:null,model:null,height,scale:null};
    officeAssets.push(entry);void loadOfficeAsset(entry);
  }
  function plant(x,z,size=1) {
    cyl(.28*size,.23*size,.53*size,8,M.cream,x,.27*size,z);
    cyl(.245*size,.245*size,.025,8,M.soil,x,.53*size,z);
    cyl(.035,.045,1.15*size,5,M.timberEdge,x,1.02*size,z);
    for(let i=0;i<7;i++) { const a=i*2.399; const leaf=ball(.33*size,i%2?M.leaf:M.leafLight,x+Math.cos(a)*.3*size,(.94+(i%3)*.19)*size,z+Math.sin(a)*.3*size); leaf.scale.set(.7,1.27,.8); leaf.rotation.z=Math.sin(a)*.55; }
    block(x,z,.65*size,.65*size);
  }
  function chair(x,z,angle=0,color=M.sage) {
    const g=group(x,z,angle);
    box(.67,.13,.65,color,0,.69,0,g);
    box(.67,.7,.12,color,0,1.04,-.27,g);
    cyl(.045,.045,.44,6,M.dark,0,.41,0,g);
    for(let i=0;i<4;i++) {const a=i*Math.PI/2;const leg=box(.07,.06,.6,M.dark,0,.19,0,g);leg.rotation.y=a;}
    return g;
  }
  function desk(x,z,angle=0,label='Workstation',mine=false,footprint=null) {
    const width=footprint?.w||2.6,depth=footprint?.d||1.25;
    const g=group(x,z,angle);
    box(2.6,.15,1.25,M.timber,0,1.12,0,g);
    box(2.62,.055,1.27,M.timberEdge,0,1.03,0,g);
    for(const a of [-1.1,1.1]) { box(.065,1.04,.07,M.cream,a,.52,-.46,g);box(.065,1.04,.07,M.cream,a,.52,.46,g); }
    box(.85,.54,.06,M.screen,0,1.57,-.24,g);box(.77,.44,.014,M.screenLit,0,1.58,-.203,g);
    box(.04,.19,.045,M.metal,0,1.27,-.24,g);box(.36,.027,.2,M.metal,0,1.22,-.2,g);
    box(.56,.025,.19,M.cream,0,1.22,.27,g);box(.13,.023,.16,M.metal,.47,1.22,.23,g);
    box(.33,.045,.43,mine?M.sage:M.powder,-.84,1.225,.18,g);
    cyl(.085,.075,.17,8,M.white,.95,1.29,.19,g);
    g.scale.set(width/2.6,1,depth/1.25);
    const chairOffset=depth/2+.48,chairX=x+Math.sin(angle)*chairOffset,chairZ=z+Math.cos(angle)*chairOffset;chair(chairX,chairZ,angle);
    block(x,z,Math.abs(Math.cos(angle))*width+Math.abs(Math.sin(angle))*depth,Math.abs(Math.sin(angle))*width+Math.abs(Math.cos(angle))*depth);
    block(chairX,chairZ,.75,.75);
    const data={type:'desk',name:label,mine,x,z,approach:{x:x+Math.sin(angle)*(chairOffset+.65),z:z+Math.cos(angle)*(chairOffset+.65)},description:mine?'Your assigned workstation. A place to focus and share a selected screen when you choose.':'A shared workstation for your team. Audio and screen sharing remain off until you choose.'};
    pick(x,z,width+.1,1.9,depth+.1,data);
    if(mine)textLabel('Your desk',x,2.2,z,data,'is-desk');
  }
  function sofa(x,z,angle=0) {
    const g=group(x,z,angle);
    box(3,.38,1.08,M.sageDark,0,.45,0,g);box(2.72,.19,.83,M.sage,0,.75,.11,g);
    box(3,.75,.24,M.sage,0,.98,-.44,g);
    for(const s of [-1,1]){box(.23,.51,1.05,M.sage,s*1.39,.78,0,g);box(.12,.22,.12,M.timberEdge,s*1.23,.18,.32,g);}
    box(.69,.5,.2,M.cream,-.66,1.03,-.2,g).rotation.z=.12;
    box(.65,.5,.2,M.clay,.61,1.03,-.2,g).rotation.z=-.14;
    block(x,z,Math.abs(Math.cos(angle))*3+Math.abs(Math.sin(angle))*1.1,Math.abs(Math.sin(angle))*3+Math.abs(Math.cos(angle))*1.1);
  }
  function glassWall(x,z,w,angle=0,height=2.75) {
    const g=group(x,z,angle);
    box(w,height,.045,M.glass,0,height/2,0,g);
    for(const a of [-w/2,w/2])box(.055,height,.065,M.dark,a,height/2,0,g);
    box(w,.045,.065,M.dark,0,height,0,g);
    box(w,.06,.065,M.dark,0,.055,0,g);
    if(w>3)box(.045,height,.065,M.dark,0,height/2,0,g);
    block(x,z,Math.abs(Math.cos(angle))*w+.08,Math.abs(Math.sin(angle))*w+.08);
  }
  function roomZone(name,x,z,w,d,color=M.powder,kind='meeting',explicitId) {
    box(w,.035,d,color,x,.045,z);
    const room=roomRecords.find(r=>r.id===explicitId) || roomRecords.find(r=>r.name===name&&!assignedRooms.has(r.id)) || roomRecords.find(r=>r.kind===kind&&!assignedRooms.has(r.id));
    if(!room)return null;
    assignedRooms.add(room.id);
    const data={type:'room',id:room.id,name:room.name,x,z,description:room.kind==='focus'?'A quiet room for uninterrupted work. Set your availability before entering.':'Open this company room to read its discussion and choose whether to join audio.'};
    textLabel(room.name,x,.12,z-d/2+.65,data,'is-room');
    return data;
  }
  // A bounded cutaway floor. Window bays divide the actual wall length.
  box(floor.width+.2,.42,floor.depth+.2,M.edge,0,-.28,0);
  box(floor.width,.1,floor.depth,M.floor,0,-.045,0);
  const groundSize=Math.max(220,Math.max(floor.width,floor.depth)*8);
  box(groundSize,.12,groundSize,mat('#e9ede7'),0,-.62,0);
  box(floor.width,.07,.12,M.cream,0,.015,halfDepth);
  box(.12,.07,floor.depth,M.cream,halfWidth,.015,0);
  box(floor.width+.12,.16,.2,M.white,0,.1,-halfDepth);
  box(.2,.16,floor.depth,M.white,-halfWidth,.1,0);
  const floorPick = mesh(geometry('PlaneGeometry',[floor.width,floor.depth]),new THREE.MeshBasicMaterial({visible:false}),0,.065,0,dynamic,false);
  floorPick.rotation.x=-Math.PI/2;
  function exterior() {
    box(floor.width,.64,.23,M.cream,0,.33,-halfDepth);
    box(.23,.64,floor.depth,M.cream,-halfWidth,.33,0);
    const across=Math.ceil(floor.width/2),along=Math.ceil(floor.depth/2),bayW=floor.width/across,bayD=floor.depth/along;
    for(let i=0;i<=across;i++){
      const x=-halfWidth+i*bayW;box(.11,3.5,.18,M.cream,x,1.78,-halfDepth);
      if(i<across){box(bayW-.14,2.67,.038,M.glass,x+bayW/2,2.02,-halfDepth);box(bayW,.075,.12,M.cream,x+bayW/2,3.42,-halfDepth);}
    }
    box(floor.width+.12,.18,.32,M.white,0,3.68,-halfDepth);
    for(let i=0;i<=along;i++){
      const z=-halfDepth+i*bayD;box(.18,3.5,.11,M.cream,-halfWidth,1.78,z);
      if(i<along){box(.038,2.67,bayD-.14,M.glass,-halfWidth,2.02,z+bayD/2);box(.12,.075,bayD,M.cream,-halfWidth,3.42,z+bayD/2);}
    }
    box(.32,.18,floor.depth+.12,M.white,-halfWidth,3.68,0);
  }
  exterior();
  const legacyStart={geometry:architecture.children.length,picks:clickable.length,labels:labels.length,obstacles:obstacles.length};
  if(!custom) {
    // Room boundaries and furnishings leave a continuous central circulation spine.
    roomZone('Meeting room',-6.5,-4.5,6.8,6.6,M.powder);
    glassWall(-3.12,-4.5,6.7,Math.PI/2);
    glassWall(-8.48,-1.15,2.75);glassWall(-4.18,-1.15,2.15);
    const table=group(-6.5,-4.6);box(3.7,.18,1.62,M.timber,0,1.15,0,table);
    for(const x of [-1.2,1.2])box(.09,1.04,1.2,M.dark,x,.55,0,table);
    block(-6.5,-4.6,3.7,1.62);
    for(const x of [-7.7,-6.5,-5.3]) {chair(x,-6.04,0,M.cream);chair(x,-3.16,Math.PI,M.cream);block(x,-6.04,.75,.75);block(x,-3.16,.75,.75);}
    box(1.05,.055,.7,M.dark,-6.5,1.28,-4.6);box(.8,.035,.44,M.cream,-7.7,1.27,-4.7);
    box(.05,1.5,2.3,M.dark,-9.78,2.07,-4.9);box(.02,1.33,2.1,M.screenLit,-9.745,2.07,-4.9);
    plant(-8.92,-6.91,1.15);

    roomZone('Focus nook',-.65,-5.45,4.3,4.8,M.sage,'focus');
    glassWall(1.5,-5.5,4.65,Math.PI/2);glassWall(-1.75,-3.05,2.05);
    desk(-.4,-5.55,0,'Focus workstation');
    plant(.9,-7.1,.85);

    roomZone('Project room',5.73,-4.42,7.8,6.95,M.floor);
    // Timber slats add a subtle physical material, not a baked background image.
    for(let i=0;i<19;i++)box(.017,.01,6.9,M.cream,2.02+i*.4,.07,-4.42);
    desk(4.13,-5.4,0,'Project workstation 01');desk(7.3,-5.4,0,'Project workstation 02');
    box(5.7,.5,.18,M.sage,5.73,.38,-3.4);
    plant(8.9,-6.6,1.25);
    box(2.9,.73,.48,M.cream,5.5,.45,-7.55);
    box(2.96,.08,.52,M.timber,5.5,.85,-7.55);block(5.5,-7.55,3,.55);

    // Open studio workstations.
    box(7.4,.032,5.6,M.sage,5.35,.047,4.28);
    desk(3.45,3.1,0,'Shared workstation');desk(6.85,3.1,0,'Shared workstation');
    desk(3.45,6.05,Math.PI,'D05 · Shared');desk(6.85,6.05,Math.PI,'D06 · Shared');
    plant(9,1.85,1.05);plant(8.97,6.76,.9);
    box(6.9,.62,.14,M.cream,5.15,.43,4.52);
    block(5.15,4.52,6.9,.14);

    // A lived-in lounge and kitchen, with open passages on both sides.
    roomZone('The lounge',-5.8,4.35,6.4,4.65,mat('#d9d0bb'),'lounge');
    box(6.4,.025,4.65,mat('#d9d0bb'),-5.66,.038,4.67);
    for(let i=0;i<6;i++)box(6.3,.003,.035,M.cream,-5.66,.055,2.9+i*.65);
    sofa(-6.5,3.13,0);sofa(-8.11,5.25,Math.PI/2);
    cyl(.93,.88,.12,16,M.timber,-5.56,.66,5.12);cyl(.42,.55,.56,8,M.cream,-5.56,.32,5.12);block(-5.56,5.12,1.9,1.9);
    box(.42,.04,.58,M.clay,-5.72,.75,5.05);cyl(.09,.075,.18,8,M.white,-5.12,.8,5.09);
    cyl(.49,.47,.58,12,M.clay,-3.51,.34,6.16);block(-3.51,6.16,1,1);
    plant(-9,1.57,1.25);plant(-8.75,7.03,.94);plant(-2.54,2.38,.8);
    box(.78,.98,3.4,M.sage,-9.35,.49,.75);box(.86,.11,3.5,M.timber,-9.3,1.04,.75);block(-9.35,.75,.9,3.5);
    box(.44,.5,.53,M.dark,-9.23,1.33,.1);box(.32,.04,.27,M.metal,-9.1,1.1,.1);
    for(const z of [-.43,1.8])cyl(.11,.09,.2,8,M.white,-9.18,1.17,z);
    // A welcome bench and leafy planter close the floor without blocking the camera.
    box(3.3,.11,.52,M.timber,-.45,.63,7.18);for(const x of [-1.7,.8])box(.08,.6,.41,M.cream,x,.29,7.18);block(-.45,7.18,3.3,.52);
    plant(-2.48,7.05,.73);
  } else {
    const clamp=(value,min,max)=>Math.min(max,Math.max(min,Number(value)||0));
    const transformBounds=(bounds,matrix)=>{
      const result=new THREE.Box3();for(const x of [bounds.minX,bounds.maxX])for(const z of [bounds.minZ,bounds.maxZ])result.expandByPoint(new THREE.Vector3(x,0,z).applyMatrix4(matrix));
      return {minX:result.min.x,maxX:result.max.x,minZ:result.min.z,maxZ:result.max.z};
    };
    const transformData=(data,matrix)=>{const point=new THREE.Vector3(data.x,0,data.z).applyMatrix4(matrix);data.x=point.x;data.z=point.z;if(data.approach){const approach=new THREE.Vector3(data.approach.x,0,data.approach.z).applyMatrix4(matrix);data.approach={x:approach.x,z:approach.z};}};
    for(const item of options.layout || []) {
      const kind=item.kind||item.type,minimum=kind==='asset'?.001:1;
      const left=clamp(item.x,0,100-minimum),top=clamp(item.y,0,100-minimum),width=clamp(item.w,minimum,100-left)*floor.width/100,depth=clamp(item.h,minimum,100-top)*floor.depth/100;
      const x=-halfWidth+left*floor.width/100+width/2,z=-halfDepth+top*floor.depth/100+depth/2;
      const rotation=[0,90,180,270].includes(item.rotation)?item.rotation:0,quarter=rotation===90||rotation===270,localW=quarter?depth:width,localD=quarter?width:depth;
      if(kind==='asset'){addOfficeAsset(item,{x,z,width,depth,localW,localD,rotation});continue;}
      const root=group(0,0,0,architecture),labelStart=labels.length,obstacleStart=obstacles.length,pickStart=clickable.length;
      root.name='floor-object:'+String(item.id||footprints.length);staticParent=root;
      if(!['desk','plant'].includes(kind))roomZone(item.name||item.label||'Room',0,0,localW,localD,kind==='focus'?M.sage:kind==='lounge'?mat('#d9d0bb'):M.powder,kind,item.roomId);
      const content=new THREE.Group();root.add(content);staticParent=content;
      if(kind==='plant')plant(0,0,Math.min(1.6,Math.min(localW,localD)*.8));
      else if(kind==='desk')desk(0,0,0,item.name||item.label||'Workstation',false,{w:Math.max(.3,localW*.9),d:Math.max(.35,localD-1.2)});
      else if(kind==='lounge'){
        sofa(0,-Math.min(.3,localD*.12),0);
        if(localW>4){cyl(.58,.54,.12,12,M.timber,localW*.32,.64,.1);cyl(.19,.3,.56,8,M.cream,localW*.32,.3,.1);block(localW*.32,.1,1.15,1.15);}
      }else{
        glassWall(0,-localD/2,localW,0,Math.min(2.75,Math.max(.5,Math.min(localW,localD)*1.1)));
        glassWall(-localW/2,0,localD,Math.PI/2,Math.min(2.75,Math.max(.5,Math.min(localW,localD)*1.1)));
        if(kind==='focus'&&localW>1.4&&localD>1.6)desk(0,-.2,0,'Focus workstation',false,{w:Math.min(2.6,localW-.4),d:Math.min(1.25,localD*.36)});
        else if(localW>1.4&&localD>1.6){
          const tableW=Math.min(2.6,localW*.62),tableD=Math.min(1.05,localD*.35);
          box(tableW,.16,tableD,M.timber,0,1.1,0);box(.5,1,.5,M.cream,0,.52,0);block(0,0,tableW,tableD);
          for(const side of [-1,1]){chair(side*tableW*.3,tableD/2+.48,Math.PI,M.cream);block(side*tableW*.3,tableD/2+.48,.75,.75);if(localD>4){chair(side*tableW*.3,-tableD/2-.48,0,M.cream);block(side*tableW*.3,-tableD/2-.48,.75,.75);}}
          box(.52,.03,.38,M.dark,0,1.21,0);if(localW>4&&localD>4)plant(localW/2-.65,-localD/2+.65,.85);
        }
      }
      // Fit every visible part, including chairs and sofa arms, inside the saved
      // footprint. The floor patch stays full size; only its contents shrink.
      const bounds=new THREE.Box3().setFromObject(content),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3()),inset=Math.min(.07,Math.min(localW,localD)*.06);
      const sx=Math.min(1,(localW-inset*2)/Math.max(size.x,.001)),sz=Math.min(1,(localD-inset*2)/Math.max(size.z,.001));
      content.scale.set(sx,Math.min(1,Math.sqrt(sx*sz)),sz);content.position.set(-center.x*sx,0,-center.z*sz);
      root.position.set(x,0,z);root.rotation.y=-rotation*Math.PI/180;root.updateMatrixWorld(true);
      for(let i=obstacleStart;i<obstacles.length;i++)obstacles[i]=transformBounds(obstacles[i],content.matrixWorld);
      for(let i=pickStart;i<clickable.length;i++){const hit=clickable[i];hit.applyMatrix4(content.matrixWorld);transformData(hit.userData.entity,content.matrixWorld);}
      for(let i=labelStart;i<labels.length;i++){labels[i].position.applyMatrix4(root.matrixWorld);transformData(labels[i].data,root.matrixWorld);labels[i].position.x=THREE.MathUtils.clamp(labels[i].position.x,x-width/2,x+width/2);labels[i].position.z=THREE.MathUtils.clamp(labels[i].position.z,z-depth/2,z+depth/2);}
      const actual=new THREE.Box3().setFromObject(root),furniture=new THREE.Box3().setFromObject(content);
      const plain=b=>({minX:b.min.x,maxX:b.max.x,minZ:b.min.z,maxZ:b.max.z});
      const forward=new THREE.Vector3(0,0,1).transformDirection(root.matrixWorld);
      footprints.push({id:String(item.id||footprints.length),kind,rotation,x,z,width,depth,forward:{x:forward.x,z:forward.z},bounds:{minX:x-width/2,maxX:x+width/2,minZ:z-depth/2,maxZ:z+depth/2},meshBounds:plain(actual),furnitureBounds:plain(furniture)});
      staticParent=architecture;
    }
  }
  if(!custom&&(floor.width!==20||floor.depth!==16)){
    // The legacy built-in studio remains usable for direct renderer consumers.
    const scale=new THREE.Matrix4().makeScale(floor.width/20,1,floor.depth/16),data=new Set();
    architecture.children.slice(legacyStart.geometry).forEach(object=>object.applyMatrix4(scale));
    clickable.slice(legacyStart.picks).forEach(object=>{object.applyMatrix4(scale);data.add(object.userData.entity);});
    labels.slice(legacyStart.labels).forEach(label=>{label.position.applyMatrix4(scale);data.add(label.data);});
    for(const entity of data){entity.x*=floor.width/20;entity.z*=floor.depth/16;if(entity.approach){entity.approach.x*=floor.width/20;entity.approach.z*=floor.depth/16;}}
    for(const obstacle of obstacles.slice(legacyStart.obstacles)){obstacle.minX*=floor.width/20;obstacle.maxX*=floor.width/20;obstacle.minZ*=floor.depth/16;obstacle.maxZ*=floor.depth/16;}
  }
  // Newly created rooms remain reachable even before a room is placed by the editor.
  roomRecords.filter(room=>!assignedRooms.has(room.id)).forEach((room,index)=>{
    const across=Math.max(1,Math.floor((floor.width-1.6)/2.7)),spacing=(floor.width-1.6)/across;
    const x=-halfWidth+.8+spacing*((index%across)+.5),z=Math.max(-halfDepth+.6,halfDepth-.8-Math.floor(index/across)*.9);
    const data={type:'room',id:room.id,name:room.name,x,z,description:'Open this company room. Its discussion and media permissions are checked by the server.'};
    textLabel(room.name,x,.2,z,data,'is-room');
  });
  // Batch immutable geometry by material. This keeps a furnished room inexpensive
  // while pick proxies and articulated people remain independently interactive.
  function batchStatic() {
    architecture.updateMatrixWorld(true);
    const batches=new Map();
    architecture.traverse(obj=>{
      if(!obj.isMesh)return;
      const key=obj.material.uuid;
      if(!batches.has(key))batches.set(key,{material:obj.material,positions:[],normals:[]});
      const batch=batches.get(key),g=(obj.geometry.index?obj.geometry.toNonIndexed():obj.geometry.clone());
      g.applyMatrix4(obj.matrixWorld);batch.positions.push(g.getAttribute('position').array.slice());batch.normals.push(g.getAttribute('normal').array.slice());g.dispose();
    });
    architecture.clear();
    const combine=list=>{const output=new Float32Array(list.reduce((total,a)=>total+a.length,0));let offset=0;for(const a of list){output.set(a,offset);offset+=a.length;}return output;};
    for(const batch of batches.values()) {
      const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(combine(batch.positions),3));g.setAttribute('normal',new THREE.BufferAttribute(combine(batch.normals),3));g.computeBoundingSphere();
      const obj=new THREE.Mesh(g,batch.material);obj.castShadow=true;obj.receiveShadow=true;if(batch.material.transparent)obj.renderOrder=2;architecture.add(obj);
    }
  }
  batchStatic();

  function human(name,id,x,z,look={},you=false) {
    if(custom){const spot=nearestOpen(x,z);x=spot.x;z=spot.z;}
    const g=group(x,z,look.angle||0,dynamic), body=new THREE.Group();g.add(body);
    const skin=mat(look.skin||'#ce9e76',{flatShading:true}),hair=mat(look.hair||'#3b352e',{flatShading:true}),shirt=mat(look.shirt||'#d1af7e'),pants=mat(look.pants||'#59675d');
    const torso=cyl(.25,.3,.67,7,shirt,0,1.18,0,body);torso.scale.z=.69;
    cyl(.09,.11,.17,7,skin,0,1.62,0,body);
    const head=ball(.24,skin,0,1.91,0,body);head.scale.set(.9,1.11,.9);
    const cap=ball(.248,hair,0,2.025,-.025,body);cap.scale.set(.92,.7,.95);
    if(look.longHair){box(.41,.39,.15,hair,0,1.87,-.15,body);ball(.16,hair,.03,2.24,-.04,body);}
    for(const side of [-1,1]) {ball(.036,skin,side*.22,1.91,0,body);ball(.018,M.dark,side*.081,1.94,.203,body);}
    box(.056,.028,.019,M.clay,0,1.82,.221,body);
    const arms=[],legs=[];
    for(const side of [-1,1]) {
      const arm=new THREE.Group();arm.position.set(side*.29,1.43,0);body.add(arm);arm.rotation.z=side*.12;
      cyl(.085,.074,.31,6,shirt,0,-.13,0,arm);cyl(.067,.065,.29,6,skin,0,-.43,0,arm);ball(.073,skin,0,-.58,0,arm);arms.push(arm);
      const leg=new THREE.Group();leg.position.set(side*.125,.87,0);body.add(leg);
      cyl(.12,.083,.67,6,pants,0,-.32,0,leg);box(.19,.13,.32,M.cream,0,-.71,.075,leg);legs.push(leg);
    }
    const data={type:'person',name,id,you,x,z,description:you?'This is you. Click any open floor to walk there. Your presence is visible, while audio and screen sharing stay under your control.':`${look.role||'Team member'} · ${look.status||'Available'}. View their profile or open a room to collaborate.`};
    g.userData.entity=data;
    const hit=pick(x,z,.78,2.4,.7,data);
    const entry={id,name,g,body,arms,legs,hit,data,you,phase:0,speed:0,motionSpeed:0,walkBlend:0,assetRevision:0};characters.push(entry);
    if(you){player=entry; textLabel('You',x,2.52,z,data,'is-you');entry.label=labels.at(-1);}
    else {textLabel(name,x,2.52,z,data,'is-person');entry.label=labels.at(-1);}
    requestCharacter(entry,look.avatarId);
    return entry;
  }
  function robot(name,id,x,z,angle=0) {
    if(custom){const spot=nearestOpen(x,z);x=spot.x;z=spot.z;}
    const g=group(x,z,angle,dynamic),body=new THREE.Group();g.add(body);
    box(.61,.68,.4,M.bot,0,.98,0,body);box(.54,.42,.42,M.cream,0,1.62,0,body);
    box(.42,.18,.025,M.dark,0,1.64,.219,body);
    for(const side of [-1,1]){box(.052,.051,.014,M.lime,side*.107,1.64,.239,body);box(.15,.42,.19,M.bot,side*.41,1.03,0,body);box(.17,.15,.23,M.dark,side*.19,.39,0,body);box(.16,.3,.16,M.cream,side*.19,.62,0,body);}
    box(.12,.08,.03,M.white,0,.99,.219,body);cyl(.022,.022,.24,6,M.dark,0,1.94,0,body);ball(.052,M.lime,0,2.085,0,body);
    const ring=mesh(geometry('TorusGeometry',[.37,.027,6,28]),M.lime,0,.13,0,g);ring.rotation.x=Math.PI/2;
    const data={type:'agent',name,id,x,z,description:'AI coworker · Company-scoped permissions, visible task history, and an accountable human sponsor. It never joins a call or shares a screen automatically.'};
    const hit=pick(x,z,.92,2.2,.8,data),entry={id,name,g,body,hit,data,robot:true};characters.push(entry);
    textLabel(`${name} · AI`,x,2.38,z,data,'is-ai');entry.label=labels.at(-1);return entry;
  }
  // Keep the controllable person in the circulation spine, away from furniture.
  const savedPosition=state.spatialPosition;
  const start = savedPosition&&Number.isFinite(savedPosition.x)&&Number.isFinite(savedPosition.z)?nearestOpen(savedPosition.x,savedPosition.z):custom ? nearestOpen(0,halfDepth-1.1) : nearestOpen(.15,Math.min(2.2,halfDepth-1.1));
  human(user.name || 'You',String(user.id),start.x,start.z,{skin:'#d7a781',hair:'#5b4034',shirt:avatarColor(user.avatarColor),pants:'#526558',angle:-.45,avatarId:user.avatarId},true);
  selectionRing=mesh(geometry('RingGeometry',[.48,.55,40]),new THREE.MeshBasicMaterial({color:'#f9fff1',side:THREE.DoubleSide,transparent:true,opacity:.95}),0,.084,0,dynamic,false);selectionRing.rotation.x=-Math.PI/2;selectionRing.visible=false;
  destinationRing=mesh(geometry('RingGeometry',[.29,.33,28]),new THREE.MeshBasicMaterial({color:'#627856',side:THREE.DoubleSide,transparent:true,opacity:.8}),0,.085,0,dynamic,false);destinationRing.rotation.x=-Math.PI/2;destinationRing.visible=false;
  const playerHalo=mesh(geometry('RingGeometry',[.38,.44,36]),new THREE.MeshBasicMaterial({color:'#ffffff',side:THREE.DoubleSide,transparent:true,opacity:.9}),0,.082,0,player.g,false);playerHalo.rotation.x=-Math.PI/2;

  function avatarColor(value) {
    const palette={forest:'#55745c',sage:'#9aaf94',clay:'#bd8364',blue:'#8ea7b2',amber:'#d5ae7c',lavender:'#a99fbd',coral:'#c98573'};
    return palette[value] || (/^#[\da-f]{6}$/i.test(value||'')?value:'#d5ae7c');
  }
  function fresh(value,now,ttl=45000) {
    const time=Date.parse(value||'');return Number.isFinite(time)&&time<=now+5000&&now-time<=ttl;
  }
  function removeCharacter(c) {
    if(c.you)return;
    if(selected===c.data){selected=null;context.hidden=true;selectionRing.visible=false;}
    c.removed=true;c.assetRevision++;releaseCharacterModel(c);c.g.removeFromParent();c.hit.removeFromParent();c.hit.material.dispose();
    clickable.splice(clickable.indexOf(c.hit),1);
    if(c.label){c.label.el.onclick=null;c.label.el.remove();labels.splice(labels.indexOf(c.label),1);}
    characters.splice(characters.indexOf(c),1);dirty=true;
  }
  function updateSnapshot(snapshot={}) {
    if(disposed)return;
    if(snapshot.user?.id===user.id){player.name=String(snapshot.user.name||'You');player.data.name=player.name;requestCharacter(player,snapshot.user.avatarId);}
    const now=Date.now(),wanted=new Set([`person:${user.id}`]);
    const members=new Map((snapshot.members||[]).map(member=>[String(member.userId||member.id),member]));
    const byUser=new Map();
    for(const record of snapshot.presence||[]){
      const id=String(record.userId||'');
      if(!id||id===String(user.id)||!members.has(id)||!fresh(record.updatedAt,now)||record.status==='offline'||!Number.isFinite(record.x)||!Number.isFinite(record.z))continue;
      if(!byUser.has(id)||Date.parse(record.updatedAt)>Date.parse(byUser.get(id).updatedAt))byUser.set(id,record);
    }
    for(const [id,record] of byUser){
      const member=members.get(id),name=String(member.name||record.name||'Team member'),point=nearestOpen(record.x,record.z);
      wanted.add(`person:${id}`);
      let c=characters.find(character=>!character.robot&&character.id===id);
      if(!c)c=human(name,id,point.x,point.z,{shirt:avatarColor(member.avatarColor),role:member.roleTitle,status:record.status,avatarId:member.avatarId});
      requestCharacter(c,member.avatarId);
      c.expiresAt=Date.parse(record.updatedAt)+45000;c.name=name;c.data.name=name;c.label.el.textContent=name;
      c.label.el.setAttribute('aria-label',`Select ${name}`);
      c.data.description=`${member.roleTitle||'Team member'} · ${record.status||'available'}. View their profile or open a room to collaborate.`;
      const distance=Math.hypot(point.x-c.g.position.x,point.z-c.g.position.z);
      if(c.lastPresenceAt!==record.updatedAt){
        c.lastPresenceAt=record.updatedAt;
        if(reducedMotion||distance>8){c.g.position.set(point.x,0,point.z);c.path=[];c.speed=0;c.motionSpeed=0;}
        else if(distance>.025)c.path=findPath({x:c.g.position.x,z:c.g.position.z},point)||[];
        else {c.path=[];c.speed=0;c.motionSpeed=0;}
      }
      updateCharacter(c);
    }
    (snapshot.agents||[]).forEach((agent,index)=>{
      const id=String(agent.id||'');
      if(!id||agent.status!=='active'||!fresh(agent.lastSeenAt,now,60000))return;
      wanted.add(`agent:${id}`);
      let c=characters.find(character=>character.robot&&character.id===id);
      if(!c){const point=nearestOpen(-1.5+(index%4)*1.25,1.2+Math.floor(index/4)*1.25);c=robot(String(agent.name||'AI agent'),id,point.x,point.z,-.4);}
      c.expiresAt=Date.parse(agent.lastSeenAt)+60000;c.name=String(agent.name||'AI agent');c.data.name=c.name;c.label.el.textContent=`${c.name} · AI`;
      c.label.el.setAttribute('aria-label',`Select ${c.name}, AI agent`);
      c.data.description=`AI agent · ${String(agent.harness||'Connected harness')}. A recent API heartbeat was received. Company-scoped access remains under its sponsor's control.`;
    });
    for(const c of [...characters])if(!c.you&&!wanted.has(`${c.robot?'agent':'person'}:${c.id}`))removeCharacter(c);
    dirty=true;
  }

  function select(data) {
    selected=data;
    const person=characters.find(c=>c.data===data),p=person?.g.position || data;
    selectionRing.position.set(p.x,.084,p.z);selectionRing.visible=true;
    const type=data.type==='agent'?'AI COWORKER':data.type==='person'?(data.you?'YOUR CHARACTER':'TEAM MEMBER'):data.type==='desk'?'WORKSTATION':data.type==='furniture'?'FURNITURE':'SHARED SPACE';
    const actionLabel=data.type==='agent'?'Open agent profile':data.type==='person'?(data.you?'View my profile':'View teammate'):data.type==='desk'?'Walk here':data.type==='furniture'?'Walk nearby':'Open room';
    context.innerHTML=`<button type="button" class="cs-scene-close" aria-label="Close selection">×</button><span class="cs-scene-context-type ${data.type==='agent'?'ai':''}">${type}</span><strong>${html(data.name)}</strong><p>${html(data.description)}</p><button type="button" class="cs-scene-primary">${actionLabel} <span>↗</span></button>`;
    context.hidden=false;
    context.querySelector('.cs-scene-close').onclick=()=>{context.hidden=true;selectionRing.visible=false;selected=null;dirty=true;};
    context.querySelector('.cs-scene-primary').onclick=()=>{
      if(expanded)toggleExpanded(false);
      if(data.type==='room')options.onOpenRoom?.(data.id);
      else if(data.type==='desk')routeTo(data.approach?.x??data.x,data.approach?.z??data.z+1.4);
      else if(data.type==='furniture'){
        const bounds=data.bounds,position=player.g.position,candidates=[{x:data.x,z:bounds.maxZ+.45},{x:data.x,z:bounds.minZ-.45},{x:bounds.maxX+.45,z:data.z},{x:bounds.minX-.45,z:data.z}];
        candidates.sort((a,b)=>Math.hypot(a.x-position.x,a.z-position.z)-Math.hypot(b.x-position.x,b.z-position.z));
        if(!candidates.some(point=>open(point.x,point.z)&&routeTo(point.x,point.z)))say('There is no clear aisle beside this piece. Choose another open spot.');
      }
      else if(data.type==='agent')options.onOpenAgent?.(data.id,data.name);
      else options.onOpenPerson?.(data.id);
    };
    say(`${data.name} selected. ${data.type==='agent'?'Identified as an AI coworker.':''}`);dirty=true;
  }
  // Navigation uses a small occupancy grid; diagonal steps cannot cut corners.
  function open(x,z) {return Number.isFinite(x)&&Number.isFinite(z)&&x>=nav.minX&&x<=nav.maxX&&z>=nav.minZ&&z<=nav.maxZ&&!obstacles.some(b=>x>b.minX-.3&&x<b.maxX+.3&&z>b.minZ-.3&&z<b.maxZ+.3);}
  function gridPoint(i,j){return{x:Math.min(nav.maxX,nav.minX+i*stepX),z:Math.min(nav.maxZ,nav.minZ+j*stepZ)};}
  function nearestOpen(x,z) {
    x=THREE.MathUtils.clamp(Number.isFinite(x)?x:0,nav.minX,nav.maxX);z=THREE.MathUtils.clamp(Number.isFinite(z)?z:0,nav.minZ,nav.maxZ);
    if(open(x,z))return{x,z};
    for(let r=step;r<Math.hypot(floor.width,floor.depth);r+=step)for(let angle=0;angle<Math.PI*2;angle+=Math.PI/8){const q={x:x+Math.cos(angle)*r,z:z+Math.sin(angle)*r};if(open(q.x,q.z))return q;}
    // A fully obstructed floor still gets an in-bounds spawn; routing is denied.
    return{x:THREE.MathUtils.clamp(0,nav.minX,nav.maxX),z:nav.maxZ};
  }
  function findPath(from,target) {
    if(!open(from.x,from.z)||!open(target.x,target.z))return null;
    const clear=(a,b)=>{
      if(!open(a.x,a.z)||!open(b.x,b.z))return false;
      // Exact segment/slab intersection catches even a short corner crossing;
      // sampling alone can miss narrow furniture or a nearly tangent segment.
      return !obstacles.some(obstacle=>{let near=0,far=1;for(const [axis,min,max] of [['x',obstacle.minX-.3+1e-7,obstacle.maxX+.3-1e-7],['z',obstacle.minZ-.3+1e-7,obstacle.maxZ+.3-1e-7]]){const origin=a[axis],delta=b[axis]-origin;if(Math.abs(delta)<1e-10){if(origin<=min||origin>=max)return false;}else{const first=(min-origin)/delta,last=(max-origin)/delta;near=Math.max(near,Math.min(first,last));far=Math.min(far,Math.max(first,last));if(near>far)return false;}}return near<=far;});
    };
    if(clear(from,target))return Math.hypot(target.x-from.x,target.z-from.z)>.001?[target]:[];
    const clamp=(a,min,max)=>Math.min(max,Math.max(min,a));
    const index=(x,z)=>{const i=clamp(Math.round((x-nav.minX)/stepX),0,columns-1),j=clamp(Math.round((z-nav.minZ)/stepZ),0,rows-1);for(let radius=0;radius<=3;radius++){let best=null,distance=Infinity;for(let a=Math.max(0,i-radius);a<=Math.min(columns-1,i+radius);a++)for(let b=Math.max(0,j-radius);b<=Math.min(rows-1,j+radius);b++){const point=gridPoint(a,b),next=Math.hypot(point.x-x,point.z-z);if(next<distance&&clear({x,z},point)){best=[a,b];distance=next;}}if(best)return best;}return null;};
    const start=index(from.x,from.z),end=index(target.x,target.z),key=(i,j)=>j*columns+i;if(!start||!end)return null;
    const queue=[start],seen=new Map([[key(...start),null]]);let found=null;
    for(let cursor=0;cursor<queue.length;cursor++) {
      const [i,j]=queue[cursor];if(i===end[0]&&j===end[1]){found=[i,j];break;}
      for(const [di,dj] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
        const ni=i+di,nj=j+dj,k=key(ni,nj);if(ni<0||nj<0||ni>=columns||nj>=rows||seen.has(k))continue;
        const q=gridPoint(ni,nj);if(!open(q.x,q.z)||!clear(gridPoint(i,j),q))continue;
        if(di&&dj){const a=gridPoint(i+di,j),b=gridPoint(i,j+dj);if(!open(a.x,a.z)||!open(b.x,b.z))continue;}
        seen.set(k,[i,j]);queue.push([ni,nj]);
      }
    }
    if(!found)return null;
    const points=[];let cursor=found;while(cursor){points.unshift(gridPoint(...cursor));cursor=seen.get(key(...cursor));}
    if(open(target.x,target.z))points.push(target);
    // Remove the grid's tiny alternating turns while retaining collision checks.
    const smoothed=[];let anchor=from,indexInPath=0;
    while(indexInPath<points.length){let next=indexInPath;if(!clear(anchor,points[next]))return null;while(next+1<points.length&&clear(anchor,points[next+1]))next++;smoothed.push(points[next]);anchor=points[next];indexInPath=next+1;}
    return smoothed;
  }
  function routeTo(targetX,targetZ) {
    const target=nearestOpen(targetX,targetZ);
    const points=findPath({x:player.g.position.x,z:player.g.position.z},target);
    if(!points){say('That spot is enclosed. Choose an open aisle or enter through the room doorway.');return false;}
    path=points;walking=path.length>0;destinationRing.position.set(target.x,.085,target.z);destinationRing.visible=walking;
    if(reducedMotion && walking){player.g.position.set(target.x,0,target.z);path=[];walking=false;destinationRing.visible=false;updateCharacter(player);options.onMove?.({x:target.x,z:target.z});say('You moved to the selected spot. Reduced motion is on.');}
    else if(walking)say('Walking to your spot…');
    dirty=true;return true;
  }
  const raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2();let pointerStart=null;
  on(renderer.domElement,'pointerdown',event=>{pointerStart={x:event.clientX,y:event.clientY,time:performance.now(),button:event.button};});
  on(renderer.domElement,'pointerup',event=>{
    if(!pointerStart||pointerStart.button!==0||Math.hypot(event.clientX-pointerStart.x,event.clientY-pointerStart.y)>6||performance.now()-pointerStart.time>750)return;
    const rect=renderer.domElement.getBoundingClientRect();pointer.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);raycaster.setFromCamera(pointer,camera);
    const hit=raycaster.intersectObjects(clickable,false)[0];if(hit){select(hit.object.userData.entity);return;}
    const ground=raycaster.intersectObject(floorPick)[0];if(ground)routeTo(ground.point.x,ground.point.z);
  });
  on(stage,'keydown',event=>{
    const deltas={ArrowUp:[0,-1],ArrowDown:[0,1],ArrowLeft:[-1,0],ArrowRight:[1,0]};
    if(deltas[event.key]){event.preventDefault();const [dx,dz]=deltas[event.key];routeTo(player.g.position.x+dx,player.g.position.z+dz);}
    if(event.key==='Escape'){context.hidden=true;selectionRing.visible=false;selected=null;path=[];walking=false;destinationRing.visible=false;dirty=true;}
    if(event.key==='+'||event.key==='=')zoom(1.18);if(event.key==='-')zoom(1/1.18);if(event.key.toLowerCase()==='r')reset();
  });
  on(host,'click',event=>{
    const button=event.target.closest('[data-scene]');if(!button)return;event.stopPropagation();
    if(button.dataset.scene==='zoom-in')zoom(1.2);if(button.dataset.scene==='zoom-out')zoom(1/1.2);
    if(button.dataset.scene==='reset')reset();if(button.dataset.scene==='quality')setQuality(quality==='balanced'?'low':'balanced');
    if(button.dataset.scene==='expand')toggleExpanded();
  });
  on(document,'keydown',event=>{
    if(event.key==='Escape'&&expanded){event.preventDefault();toggleExpanded(false);}
    if(event.key==='Tab'&&expanded){
      const items=[...host.querySelectorAll('button,[tabindex="0"]')].filter(el=>!el.disabled&&getComputedStyle(el).visibility!=='hidden'&&el.getClientRects().length);
      const first=items[0],last=items.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    }
  });
  function toggleExpanded(value=!expanded){
    if(value===expanded)return;expanded=value;host.classList.toggle('is-expanded',expanded);
    if(expanded){host.setAttribute('role','dialog');host.setAttribute('aria-modal','true');host.setAttribute('aria-label','Expanded 3D office');}else{host.removeAttribute('role');host.removeAttribute('aria-modal');host.removeAttribute('aria-label');}
    if(expanded){previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';}
    else document.body.style.overflow=previousOverflow;
    const button=host.querySelector('[data-scene="expand"]');button.setAttribute('aria-pressed',String(expanded));button.setAttribute('aria-label',expanded?'Close expanded office view':'Expand office view');button.title=expanded?'Close expanded view · Escape':'Expand office';button.querySelector('span').textContent=expanded?'Close view':'Expand office';
    resize();button.focus({preventScroll:true});say(expanded?'Expanded office. Press Escape or Close view to return.':'Office view restored.');dirty=true;
  }
  function zoom(factor){camera.zoom=THREE.MathUtils.clamp(camera.zoom*factor,controls.minZoom,controls.maxZoom);camera.updateProjectionMatrix();dirty=true;}
  function reset(){camera.position.set(24*sceneScale,27*sceneScale,29*sceneScale);controls.target.set(0,.2,0);camera.zoom=1;camera.updateProjectionMatrix();controls.update();dirty=true;say('Camera reset. Click the floor to walk.');}
  function setQuality(value) {
    quality=value==='low'?'low':'balanced';renderer.setPixelRatio(quality==='low'?1:Math.min(window.devicePixelRatio||1,1.6));
    renderer.shadowMap.enabled=quality!=='low';sun.shadow.mapSize.set(1024,1024);
    if(sun.shadow.map){sun.shadow.map.dispose();sun.shadow.map=null;}
    const button=host.querySelector('[data-scene="quality"]');button.textContent=quality==='low'?'Low':'Balanced';button.setAttribute('aria-label',`Graphics quality: ${quality}. Switch quality.`);
    options.onQualityChange?.(quality);dirty=true;return quality;
  }
  function resize(){if(disposed)return;const width=stage.clientWidth,height=stage.clientHeight;if(!width||!height)return;renderer.setSize(width,height,false);const aspect=width/height;const right=new THREE.Vector3(29,0,-24).normalize(),up=new THREE.Vector3().crossVectors(new THREE.Vector3(24,27,29).normalize(),right).normalize();const halfX=(floor.width*Math.abs(right.x)+floor.depth*Math.abs(right.z))/2+.6;const halfY=(floor.width*Math.abs(up.x)+floor.depth*Math.abs(up.z))/2+framingHeight*Math.abs(up.y)+.4;const halfH=Math.max(halfY*1.18,halfX/aspect*1.18);camera.left=-halfH*aspect;camera.right=halfH*aspect;camera.top=halfH;camera.bottom=-halfH;camera.updateProjectionMatrix();dirty=true;}
  const resizeObserver=new ResizeObserver(resize);resizeObserver.observe(stage);
  // Tear down if navigation removes the host, including failed routes/re-renders.
  const mutationObserver=new MutationObserver(()=>{if(!host.isConnected)dispose();});mutationObserver.observe(document.body,{childList:true,subtree:true});
  on(document,'visibilitychange',()=>{dirty=true;});
  function updateCharacter(c){c.hit.position.set(c.g.position.x,1.2,c.g.position.z);if(c.label)c.label.position.set(c.g.position.x,c.robot?2.38:2.52,c.g.position.z);if(selected===c.data)selectionRing.position.set(c.g.position.x,.084,c.g.position.z);}
  function requestCharacter(c,avatarId){
    if(!options.loadCharacter||c.robot||c.removed||disposed)return;
    const key=typeof avatarId==='string'?avatarId:'';
    if(c.requestedAvatar===key&&(c.assetPending||c.rigAvatarKey===key||Date.now()-(c.assetFailedAt||0)<30000))return;
    c.requestedAvatar=key;c.assetPending=true;
    const revision=++c.assetRevision;
    Promise.resolve().then(()=>options.loadCharacter({id:c.id,avatarId})).then(lease=>{
      if(disposed||c.removed||revision!==c.assetRevision){lease.release();return;}
      if(setCharacterModel(c.id,lease.scene,lease.animations,lease.metadata,lease.release))c.rigAvatarKey=key;
      else {lease.release();c.assetFailedAt=Date.now();}
    }).catch(()=>{if(revision===c.assetRevision)c.assetFailedAt=Date.now();}).finally(()=>{if(revision===c.assetRevision)c.assetPending=false;});
  }
  function releaseCharacterModel(c){
    c.mixer?.stopAllAction();
    if(c.mixer&&c.rigRoot)c.mixer.uncacheRoot(c.rigRoot);
    c.model?.removeFromParent();
    if(c.releaseModel)c.releaseModel();
    c.model=null;c.rigRoot=null;c.mixer=null;c.idleAction=null;c.walkAction=null;c.releaseModel=null;c.avatarId=null;c.walkBlend=0;
    c.body.visible=true;
  }
  function advanceCharacter(c,waypoints,dt){
    if(!waypoints?.length){c.speed=0;c.motionSpeed=0;return false;}
    let remaining=0,previous={x:c.g.position.x,z:c.g.position.z};
    for(const point of waypoints){remaining+=Math.hypot(point.x-previous.x,point.z-previous.z);previous=point;}
    const acceleration=4,deceleration=5,cruise=THREE.MathUtils.clamp(c.referenceSpeed||2.2,.8,3);
    const desired=Math.min(cruise,Math.sqrt(2*deceleration*remaining));
    const oldSpeed=c.speed||0;
    c.speed=oldSpeed<desired?Math.min(desired,oldSpeed+acceleration*dt):Math.max(desired,oldSpeed-deceleration*dt);
    let budget=(oldSpeed+c.speed)*.5*dt,travelled=0;
    const facing=waypoints.find(point=>Math.hypot(point.x-c.g.position.x,point.z-c.g.position.z)>.02);
    if(facing){const targetAngle=Math.atan2(facing.x-c.g.position.x,facing.z-c.g.position.z),delta=Math.atan2(Math.sin(targetAngle-c.g.rotation.y),Math.cos(targetAngle-c.g.rotation.y));c.g.rotation.y+=THREE.MathUtils.clamp(delta,-dt*5.5,dt*5.5);}
    while(waypoints.length&&budget>0){
      const target=waypoints[0],dx=target.x-c.g.position.x,dz=target.z-c.g.position.z,distance=Math.hypot(dx,dz);
      if(distance<=budget+.002){c.g.position.x=target.x;c.g.position.z=target.z;travelled+=distance;budget=Math.max(0,budget-distance);waypoints.shift();}
      else {c.g.position.x+=dx/distance*budget;c.g.position.z+=dz/distance*budget;travelled+=budget;budget=0;}
    }
    c.motionSpeed=travelled/dt;
    if(!waypoints.length)c.speed=0;
    if(travelled){updateCharacter(c);dirty=true;}
    return travelled>.0001;
  }
  function updateLocomotion(c,dt){
    const speed=reducedMotion?0:c.motionSpeed||0;
    if(c.mixer){
      const target=THREE.MathUtils.smoothstep(speed,.035,(c.referenceSpeed||2.2)*.35);
      c.walkBlend=THREE.MathUtils.damp(c.walkBlend,target,12,dt);
      if(Math.abs(c.walkBlend-target)<.001)c.walkBlend=target;
      c.idleAction.setEffectiveWeight(1-c.walkBlend);
      c.walkAction.setEffectiveWeight(c.walkBlend);
      // Playback follows the distance actually travelled. The imported in-place
      // clips retain their authored hip sway; no skeletal axes are overwritten.
      c.walkAction.setEffectiveTimeScale(Math.max(.1,speed/(c.referenceSpeed||2.2)));
      c.walkAction.paused=speed<.015&&c.walkBlend===0;
      c.currentMotion=c.walkBlend>.01?'walk':'idle';
      if(!reducedMotion){c.mixer.update(dt);dirty=true;}
    }else if(c.body.visible){
      const moving=speed>.02;
      if(moving){c.phase+=dt*8*speed/2.2;c.legs[0].rotation.x=Math.sin(c.phase)*.42;c.legs[1].rotation.x=-Math.sin(c.phase)*.42;c.arms[0].rotation.x=-Math.sin(c.phase)*.3;c.arms[1].rotation.x=Math.sin(c.phase)*.3;c.body.position.y=Math.abs(Math.sin(c.phase))*.025;dirty=true;}
      else if(c.wasMoving){c.legs.forEach(l=>l.rotation.x=0);c.arms.forEach(l=>l.rotation.x=0);c.body.position.y=0;dirty=true;}
      c.wasMoving=moving;
    }
  }
  function updateLabels(){const width=stage.clientWidth,height=stage.clientHeight;for(const item of labels){const q=item.position.clone().project(camera);const x=(q.x*.5+.5)*width,y=(-q.y*.5+.5)*height;item.el.style.transform=`translate(-50%, -100%) translate(${x}px, ${y}px)`;item.el.style.visibility=q.z>1||x<15||x>width-15||y<20||y>height-90?'hidden':'visible';}}
  function animate(now) {
    if(disposed)return;frame=requestAnimationFrame(animate);if(document.hidden){lastFrame=now;return;}
    const dt=Math.min((now-lastFrame)/1000,.05);if(now-lastFrame<1000/(quality==='low'?30:60)-1)return;lastFrame=now;
    controls.update();
    if(now-lastExpiryCheck>1000){lastExpiryCheck=now;for(const c of [...characters])if(!c.you&&c.expiresAt<=Date.now())removeCharacter(c);}
    if(walking&&path.length){
      advanceCharacter(player,path,dt);
      if(now-lastMoveSent>=1000){lastMoveSent=now;options.onMove?.({x:player.g.position.x,z:player.g.position.z});}
      if(!path.length){walking=false;destinationRing.visible=false;options.onMove?.({x:player.g.position.x,z:player.g.position.z});say('You’ve arrived. Select a teammate or a space to connect.');}
    }else {player.speed=0;player.motionSpeed=0;}
    for(const c of characters)if(!c.you&&!c.robot){
      advanceCharacter(c,c.path,dt);
    }
    for(const c of characters)if(!c.robot)updateLocomotion(c,dt);
    if(dirty){renderer.render(scene,camera);updateLabels();dirty=false;}
  }
  function setCharacterModel(name, model, animations=[],metadata={},release) {
    const c=characters.find(item=>item.data.id===name||name==='you'&&item.you);if(!c||!model)return false;
    const idle=animations.find(clip=>clip.name===(metadata.idleClip||'Idle')),walk=animations.find(clip=>clip.name===(metadata.walkClip||'Walk'));
    if(!idle||!walk||idle===walk||idle.duration<=0||walk.duration<=0)return false;
    const bounds=new THREE.Box3().setFromObject(model),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());
    if(!Number.isFinite(size.y)||size.y<.01)return false;
    releaseCharacterModel(c);
    const wrapper=new THREE.Group(),alignment=new THREE.Group(),scale=2.2/size.y;
    alignment.scale.setScalar(scale);alignment.position.set(-center.x*scale,-bounds.min.y*scale,-center.z*scale);alignment.add(model);wrapper.add(alignment);wrapper.rotation.y=Number.isFinite(metadata.forwardRotation)?metadata.forwardRotation:0;
    wrapper.userData.coatriaAvatar=metadata.id||'custom';c.g.add(wrapper);c.model=wrapper;c.rigRoot=model;c.releaseModel=release||(()=>{const geos=new Set(),mats=new Set(),textures=new Set(),skeletons=new Set();model.traverse(obj=>{if(obj.geometry)geos.add(obj.geometry);if(obj.skeleton)skeletons.add(obj.skeleton);if(obj.material)(Array.isArray(obj.material)?obj.material:[obj.material]).forEach(m=>mats.add(m));});geos.forEach(g=>g.dispose());mats.forEach(m=>{Object.values(m).forEach(v=>{if(v?.isTexture)textures.add(v);});m.dispose();});textures.forEach(t=>t.dispose());skeletons.forEach(s=>s.dispose());});c.avatarId=metadata.id||'custom';c.body.visible=false;
    model.traverse(obj=>{if(obj.isMesh){obj.castShadow=true;obj.receiveShadow=true;}});
    c.referenceSpeed=(Number.isFinite(metadata.walkSpeed)&&metadata.walkSpeed>0?metadata.walkSpeed:1.5)*scale;
    c.mixer=new THREE.AnimationMixer(model);c.idleAction=c.mixer.clipAction(idle).setEffectiveWeight(1).play();c.walkAction=c.mixer.clipAction(walk).setEffectiveWeight(0).play();
    const phase=[...String(c.id)].reduce((sum,value)=>sum+value.charCodeAt(0),0)%997/997;
    c.idleAction.time=idle.duration*phase;c.walkAction.time=walk.duration*phase;c.walkAction.paused=true;c.currentMotion='idle';c.mixer.update(0);
    dirty=true;return true;
  }
  function dispose() {
    if(disposed)return;disposed=true;if(expanded)document.body.style.overflow=previousOverflow;cancelAnimationFrame(frame);resizeObserver.disconnect();mutationObserver.disconnect();listeners.forEach(fn=>fn());controls.dispose();
    for(const c of characters){c.removed=true;c.assetRevision++;releaseCharacterModel(c);}
    for(const entry of officeAssets){entry.revision++;entry.lease?.release();entry.lease=null;entry.model=null;}
    const geos=new Set(),mats=new Set();scene.traverse(obj=>{if(obj.geometry)geos.add(obj.geometry);if(obj.material)(Array.isArray(obj.material)?obj.material:[obj.material]).forEach(m=>mats.add(m));});
    const textures=new Set();geometries.forEach(g=>geos.add(g));materials.forEach(m=>mats.add(m));geos.forEach(g=>g.dispose());mats.forEach(m=>{Object.values(m).forEach(v=>{if(v?.isTexture)textures.add(v);});m.dispose();});textures.forEach(t=>t.dispose());renderer.dispose();renderer.forceContextLoss();host.innerHTML='';host.className=hostClass;
    if(activeInstance===api)activeInstance=null;
  }
  setQuality(quality);resize();controls.update();updateSnapshot(options);frame=requestAnimationFrame(animate);
  const api={dispose,reset,setQuality,toggleExpanded,walkTo:routeTo,updateSnapshot,retryOfficeAssets,selectEntity(id){const c=characters.find(c=>c.data.id===id);const item=c?.data||labels.find(l=>l.data.id===id)?.data||officeAssets.find(entry=>entry.id===id)?.data;if(item)select(item);return!!item;},setCharacterModel,
    get diagnostics(){return{renderer:'Three.js / WebGL',quality,customLayout:custom,floor:{...floor},floorBounds:{minX:-halfWidth,maxX:halfWidth,minZ:-halfDepth,maxZ:halfDepth},navigation:{...nav,columns,rows,stepX,stepZ},officeAssets:officeAssets.map(entry=>({id:entry.id,assetId:entry.assetId,status:entry.status,modelLoaded:!!entry.model,collidable:entry.metadata?.collidable!==false,resize:entry.metadata?.resize||null,height:entry.height,scale:entry.scale?{...entry.scale}:null,bounds:{...entry.footprint.meshBounds}})),objects:footprints.map(item=>({...item,forward:{...item.forward},bounds:{...item.bounds},meshBounds:{...item.meshBounds},furnitureBounds:{...item.furnitureBounds}})),obstacles:obstacles.map(bounds=>({...bounds})),plannedPath:path.map(point=>({...point})),characters:characters.length,occupants:characters.map(c=>({id:c.id,type:c.data.type,name:c.name,x:c.g.position.x,z:c.g.position.z,rotation:c.g.rotation.y,avatarId:c.avatarId||null,modelLoaded:!!c.model,speed:c.motionSpeed||0,walkWeight:c.walkBlend||0,walkPlaybackRate:c.walkAction?.getEffectiveTimeScale()||0,referenceSpeed:c.referenceSpeed||null,pathLength:c.you?path.length:c.path?.length||0})),drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,walking,position:{x:player.g.position.x,z:player.g.position.z},pathLength:path.length,disposed,proceduralCharacters:characters.filter(c=>!c.model).length,loadedCharacterModels:characters.filter(c=>c.model).length};},
    scene,camera,renderer};
  activeInstance=api;
  return api;
}

export function dispose(){activeInstance?.dispose();}
window.CoatriaScene={mount,dispose,get instance(){return activeInstance;}};
