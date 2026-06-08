/* Alzinger Laser-Kalkulation – App-Logik (Konfigurator-Stil, mit CAD) */
'use strict';
pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

const PARAMS = { laser_satz:134.17, abkant_satz:85.00, marge:30, min_pos:15, ruest_pos:75, sek_biegung:30, pierce_s:0.5 };
const MATERIAL = {'1.4301':4.90,'1.4571':6.50,'1.4404':5.80,'S235':1.30,'S355':1.50,'S355MC':1.55,'S235MC':1.35,'DC01':1.40,'AlMg3':4.20,'RAEX':2.20,'Cu':10.00};
const DENSITY = {'1.4':7900,'S2':7850,'S3':7850,'DC':7850,'RAEX':7850,'AlMg':2700,'Al':2700,'Cu':8900}; // kg/m³ je Präfix
function density(m){ for(const k in DENSITY){ if(m&&m.startsWith(k)) return DENSITY[k]; } return 7850; }

// Schnittgeschwindigkeit mm/min (Richtwerte Faserlaser 6 kW, TruLaser 5030) je Werkstoffgruppe/Dicke
const SPEED = {
  stahl:     {t:[1,2,3,4,5,6,8,10,12,15,20,25], v:[8000,5000,3500,2800,2300,2000,1500,1200,950,700,450,300]},
  edelstahl: {t:[1,2,3,4,5,6,8,10,12,15,20],    v:[9000,5500,3200,2200,1600,1200,700,450,300,200,130]},
  alu:       {t:[1,2,3,4,5,6,8,10,12,15],       v:[9000,6000,4000,3000,2200,1700,1000,700,500,350]},
};
function speedGroup(m){ if(!m) return 'stahl'; if(m.startsWith('1.4')) return 'edelstahl'; if(m.startsWith('Al')) return 'alu'; return 'stahl'; }
function speedFor(m,t){ const g=SPEED[speedGroup(m)],ts=g.t,vs=g.v; if(t<=ts[0])return vs[0]; if(t>=ts[ts.length-1])return vs[vs.length-1];
  for(let i=1;i<ts.length;i++){ if(t<=ts[i]){ const f=(t-ts[i-1])/(ts[i]-ts[i-1]); return vs[i-1]+f*(vs[i]-vs[i-1]); } } return vs[vs.length-1]; }

let PARTS=[], PDFDOC=null, PAGE=1, SCALE=1.2, PLANNAME='', WERKSTOFF='', DICKE=0, OCCT=null;

const $=s=>document.querySelector(s);
const numDe=s=>{s=String(s).trim().replace(/\./g,'').replace(',','.');const v=parseFloat(s);return isNaN(v)?0:v;};
const fmt=(x,d=2)=>Number(x).toLocaleString('de-DE',{minimumFractionDigits:d,maximumFractionDigits:d});
const eur=x=>fmt(x)+' €';

function matPrice(name){
  if(name in MATERIAL) return {p:MATERIAL[name],known:true};
  for(const m in MATERIAL){ if(name&&(name.startsWith(m)||m.startsWith(name))) return {p:MATERIAL[m],known:true}; }
  return {p:0,known:false};
}
function calc(p){
  const {p:price,known}=matPrice(p.material); p._known=known;
  const matk=p.gewicht*price;
  const laserk=p.laser_min*PARAMS.laser_satz/60;
  const biegek=(p.biegungen||0)*(PARAMS.sek_biegung/3600)*PARAMS.abkant_satz;
  const menge=Math.max(1,parseInt(p.menge)||1);
  const ruestk=PARAMS.ruest_pos/menge;
  const selbstk=matk+laserk+biegek+ruestk;
  const vk=PARAMS.marge<100?selbstk/(1-PARAMS.marge/100):selbstk;
  const position=Math.max(vk*menge,PARAMS.min_pos);
  return {matk,laserk,biegek,ruestk,selbstk,vk,position,menge,known};
}
const grandTotal=()=>PARTS.reduce((a,p)=>a+calc(p).position,0);
const totalStk=()=>PARTS.reduce((a,p)=>a+Math.max(1,parseInt(p.menge)||1),0);

// CAD-Teile: Gewicht (und ggf. Laserzeit) aus Geometrie neu berechnen
function recomputeCad(p){
  const d=density(p.material);
  if(p.source==='dxf'){
    p.gewicht = +(p.area_m2 * (p.dicke/1000) * d).toFixed(3);
    if(p._autoLaser){
      const v=speedFor(p.material,p.dicke||1);
      p.laser_min = +((p.cutlen_mm/Math.max(150,v)) + (p.einstech||0)*PARAMS.pierce_s/60).toFixed(2);
    }
  }else if(p.source==='step'){
    p.gewicht = +(p.vol_m3 * d).toFixed(3);
  }
}

// ---------- Datei-Routing ----------
async function handleFiles(list){
  const files=[...list]; if(!files.length) return;
  for(const f of files){
    const ext=(f.name.split('.').pop()||'').toLowerCase();
    try{
      if(ext==='pdf') await loadPlan(await f.arrayBuffer(), f.name);
      else if(ext==='dxf') await loadDxf(await f.text(), f.name);
      else if(ext==='stp'||ext==='step') await loadStep(await f.arrayBuffer(), f.name);
      else toast('Nicht unterstützt: '+f.name);
    }catch(e){ console.error(e); toast('Fehler bei '+f.name+': '+e.message); }
  }
  showWork(); renderPositions(); recalc();
}
function showWork(){ $('#dropArea').classList.add('hidden'); $('#posArea').classList.remove('hidden'); $('#sec-pos').scrollIntoView(); }

// ---------- TruTops-PDF ----------
async function extractText(doc){ let f=''; for(let n=1;n<=doc.numPages;n++){const pg=await doc.getPage(n);const tc=await pg.getTextContent();f+=tc.items.map(i=>i.str).join('\n')+'\n';} return f; }
async function loadPlan(buf,name){
  PDFDOC=await pdfjsLib.getDocument({data:buf}).promise;
  const full=await extractText(PDFDOC);
  const {parts,werkstoff,dicke}=LaserParser.parsePlanText(full);
  if(!parts.length){ toast('Keine Einzelteil-Informationen im PDF gefunden.'); return; }
  parts.forEach(p=>{p.source='pdf';p.quelle=name;});
  PARTS.push(...parts); PLANNAME=name; WERKSTOFF=werkstoff; DICKE=dicke;
  $('#planMeta').textContent=`${name.replace(/\.pdf$/i,'')} · ${werkstoff||'?'} · ${fmt(dicke,2)} mm`;
  $('#pdfbox').classList.remove('hidden'); PAGE=1; renderPage(1);
}

// ---------- DXF ----------
function dist(a,b){return Math.hypot(a.x-b.x,a.y-b.y);}
function polyLen(v,closed){let L=0;for(let i=1;i<v.length;i++)L+=dist(v[i-1],v[i]);if(closed&&v.length>2)L+=dist(v[v.length-1],v[0]);return L;}
function shoelace(v){let A=0;for(let i=0;i<v.length;i++){const j=(i+1)%v.length;A+=v[i].x*v[j].y-v[j].x*v[i].y;}return Math.abs(A/2);}
function parseDxfGeom(text){
  const d=new DxfParser().parseSync(text);
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity,cutlen=0;
  const loops=[]; const draw=[]; // draw: {type,...} für SVG
  const ext=(x,y)=>{if(x<minX)minX=x;if(y<minY)minY=y;if(x>maxX)maxX=x;if(y>maxY)maxY=y;};
  for(const e of (d.entities||[])){
    if(e.type==='LINE'&&e.vertices&&e.vertices.length>=2){
      const v=e.vertices; cutlen+=polyLen(v,false); v.forEach(p=>ext(p.x,p.y));
      draw.push({t:'pl',pts:v,closed:false});
    }else if((e.type==='LWPOLYLINE'||e.type==='POLYLINE')&&e.vertices){
      const v=e.vertices.map(p=>({x:p.x,y:p.y})); const cl=!!(e.shape||e.closed);
      cutlen+=polyLen(v,cl); v.forEach(p=>ext(p.x,p.y));
      draw.push({t:'pl',pts:v,closed:cl});
      if(cl&&v.length>=3) loops.push({area:shoelace(v),v});
    }else if(e.type==='CIRCLE'&&e.center){
      const r=e.radius; cutlen+=2*Math.PI*r; ext(e.center.x-r,e.center.y-r);ext(e.center.x+r,e.center.y+r);
      draw.push({t:'circle',c:e.center,r}); loops.push({area:Math.PI*r*r,v:null,r});
    }else if(e.type==='ARC'&&e.center){
      const r=e.radius; let a0=e.startAngle,a1=e.endAngle;
      // dxf-parser liefert Bogen-Winkel in Radiant
      let da=a1-a0; if(da<0)da+=2*Math.PI; cutlen+=r*da;
      ext(e.center.x-r,e.center.y-r);ext(e.center.x+r,e.center.y+r);
      draw.push({t:'arc',c:e.center,r,a0,a1});
    }else if(e.type==='SPLINE'&&(e.fitPoints||e.controlPoints)){
      const v=(e.fitPoints&&e.fitPoints.length?e.fitPoints:e.controlPoints).map(p=>({x:p.x,y:p.y}));
      cutlen+=polyLen(v,false); v.forEach(p=>ext(p.x,p.y)); draw.push({t:'pl',pts:v,closed:false});
    }
  }
  if(!isFinite(minX)) return null;
  const w=maxX-minX,h=maxY-minY;
  loops.sort((a,b)=>b.area-a.area);
  let area_mm2 = loops.length ? loops[0].area - loops.slice(1).reduce((a,l)=>a+l.area,0) : w*h;
  if(area_mm2<0) area_mm2 = loops.length?loops[0].area:w*h;
  const pierces = Math.max(1, loops.length || draw.filter(e=>e.closed||e.t==='circle').length);
  return {bbox:{w,h,minX,minY,maxX,maxY}, cutlen_mm:cutlen, area_m2:area_mm2/1e6, pierces, draw};
}
async function loadDxf(text,name){
  const g=parseDxfGeom(text);
  if(!g){ toast('DXF konnte nicht gelesen werden: '+name); return; }
  const p={ teilenr:name.replace(/\.dxf$/i,''), source:'dxf', quelle:name, material:'1.4301',
    dicke:2, menge:1, biegungen:0, gewicht:0, einstech:g.pierces, auftrag:'',
    area_m2:g.area_m2, cutlen_mm:g.cutlen_mm, bbox:g.bbox, dxf:g.draw, laser_min:0, _autoLaser:true };
  recomputeCad(p); PARTS.push(p);
  toast(`DXF übernommen: ${p.teilenr} · ${fmt(g.bbox.w,0)}×${fmt(g.bbox.h,0)} mm`);
}

// ---------- STEP ----------
async function ensureOcct(){ if(!OCCT) OCCT=await occtimportjs({locateFile:f=>'lib/'+f}); return OCCT; }
function showLoad(t){ let o=$('#loadov'); if(!o){o=document.createElement('div');o.id='loadov';o.className='loadov';document.body.appendChild(o);} o.innerHTML=`<span class="spin"></span>${t}`; }
function hideLoad(){ const o=$('#loadov'); if(o)o.remove(); }
function meshVolume(pos,idx){ let V=0; const get=i=>[pos[i*3],pos[i*3+1],pos[i*3+2]];
  for(let t=0;t<idx.length;t+=3){ const a=get(idx[t]),b=get(idx[t+1]),c=get(idx[t+2]);
    V += (a[0]*(b[1]*c[2]-c[1]*b[2]) - a[1]*(b[0]*c[2]-c[0]*b[2]) + a[2]*(b[0]*c[1]-c[0]*b[1]))/6; }
  return Math.abs(V); }
async function loadStep(buf,name){
  showLoad('STEP wird eingelesen … (große Baugruppen können dauern)');
  await new Promise(r=>setTimeout(r,30));
  try{
    const occt=await ensureOcct();
    const r=occt.ReadStepFile(new Uint8Array(buf),null);
    if(!r||!r.success||!r.meshes||!r.meshes.length){ toast('STEP ohne darstellbare Volumenkörper: '+name); return; }
    let minX=Infinity,minY=Infinity,minZ=Infinity,maxX=-Infinity,maxY=-Infinity,maxZ=-Infinity,vol=0;
    const meshes=r.meshes.map(m=>{
      const pos=m.attributes.position.array, idx=m.index?m.index.array:null;
      for(let i=0;i<pos.length;i+=3){const x=pos[i],y=pos[i+1],z=pos[i+2];
        if(x<minX)minX=x;if(y<minY)minY=y;if(z<minZ)minZ=z;if(x>maxX)maxX=x;if(y>maxY)maxY=y;if(z>maxZ)maxZ=z;}
      if(idx) vol+=meshVolume(pos,idx);
      return {pos:Float32Array.from(pos), idx:idx?Uint32Array.from(idx):null, color:m.color};
    });
    const dims=[maxX-minX,maxY-minY,maxZ-minZ].sort((a,b)=>a-b);
    const p={ teilenr:name.replace(/\.(stp|step)$/i,''), source:'step', quelle:name, material:'1.4301',
      dicke:+dims[0].toFixed(2)||2, menge:1, biegungen:0, gewicht:0, einstech:0, auftrag:'',
      vol_m3:vol/1e9, bbox:{minX,minY,minZ,maxX,maxY,maxZ,dims}, step:meshes, laser_min:0, _autoLaser:false };
    recomputeCad(p); PARTS.push(p);
    toast(`STEP übernommen: ${p.teilenr} · ${meshes.length} Körper · ${fmt(dims[2],0)}×${fmt(dims[1],0)}×${fmt(dims[0],1)} mm`);
  } finally { hideLoad(); }
}

// ---------- Positionen ----------
function renderPositions(){
  const el=$('#poslist'); el.innerHTML='';
  PARTS.forEach((p,i)=>{
    const c=calc(p);
    const matOpts=Object.keys(MATERIAL).sort().map(m=>`<option ${m===p.material?'selected':''}>${m}</option>`).join('')+(p.material in MATERIAL?'':`<option selected>${p.material}</option>`);
    const badge=`<span class="srcbadge ${p.source}">${p.source}</span>`;
    const sub = p.source==='step' ? `${fmt(p.gewicht,2)} kg · 3D-Körper`
      : p.source==='dxf' ? `${fmt(p.gewicht,2)} kg · ${fmt(p.cutlen_mm,0)} mm · ${fmt(p.laser_min,2)} min`
      : `${fmt(p.gewicht,2)} kg · ${fmt(p.laser_min,2)} min${p.auftrag?' · '+p.auftrag:''}`;
    const viewBtn = (p.source==='step'||p.source==='dxf') ? `<button class="vbtn" data-view="${i}">👁 Ansehen</button>` : '';
    const row=document.createElement('div');
    row.className='posrow'+(!c.known&&p.gewicht>0?' warn':'');
    row.innerHTML=`
      <div class="pidx">${i+1}</div>
      <div class="nm"><b>${p.teilenr||'—'}${badge}</b><small>${sub}</small>${viewBtn}</div>
      <div class="mini"><label>Material</label><select data-i="${i}" data-k="material">${matOpts}</select></div>
      <div class="mini d"><label>Dicke mm</label><input data-i="${i}" data-k="dicke" value="${fmt(p.dicke,2)}"></div>
      <div class="mini"><label>Menge</label><input data-i="${i}" data-k="menge" value="${c.menge}"></div>
      <div class="mini b"><label>Biegungen</label><input data-i="${i}" data-k="biegungen" value="${p.biegungen||0}"></div>
      <div class="price">${eur(c.position)}</div>`;
    el.appendChild(row);
  });
  el.querySelectorAll('select[data-k],input[data-k]').forEach(inp=>{
    inp.onchange=e=>{
      const i=+e.target.dataset.i,k=e.target.dataset.k,v=e.target.value,p=PARTS[i];
      if(k==='menge') p[k]=Math.max(1,parseInt(v)||1);
      else if(k==='biegungen') p[k]=Math.max(0,parseInt(v)||0);
      else if(k==='dicke') p[k]=numDe(v);
      else p[k]=v;
      if(p.source==='dxf'||p.source==='step') recomputeCad(p);
      renderPositions(); recalc();
    };
  });
  el.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>openViewer(+b.dataset.view));
  $('#posCount').textContent=`${PARTS.length} Positionen`;
  if(!PDFDOC) $('#pdfbox')?.classList.add('hidden');
}
function recalc(){ $('#bPos').textContent=PARTS.length; $('#bStk').textContent=totalStk(); $('#bTotal').textContent=eur(grandTotal()); }

// ---------- CAD-Viewer ----------
let _three=null;
function closeViewer(){ const v=$('#viewer'); if(v){ if(_three){cancelAnimationFrame(_three.raf); if(_three.onResize)window.removeEventListener('resize',_three.onResize); _three.renderer.dispose(); _three=null;} v.remove(); } }
function openViewer(i){
  const p=PARTS[i]; if(!p) return;
  const v=document.createElement('div'); v.id='viewer'; v.className='viewer';
  v.innerHTML=`<div class="viewer-card">
    <div class="viewer-h"><h3>${p.teilenr}</h3><span class="meta">${p.source.toUpperCase()} · ${p.quelle}</span><button class="x">✕</button></div>
    <div class="viewer-body" id="vbody"></div></div>`;
  document.body.appendChild(v);
  v.querySelector('.x').onclick=closeViewer;
  v.onclick=e=>{ if(e.target===v) closeViewer(); };
  const body=v.querySelector('#vbody');
  const info=document.createElement('div'); info.className='viewer-info';
  if(p.source==='dxf'){
    info.innerHTML=`Abmessung<br><b>${fmt(p.bbox.w,1)} × ${fmt(p.bbox.h,1)} mm</b><br>Schneidlänge<br><b>${fmt(p.cutlen_mm,0)} mm</b><br>Fläche<br><b>${fmt(p.area_m2,4)} m²</b><br>Gewicht<br><b>${fmt(p.gewicht,2)} kg</b>`;
    renderDxfView(body,p);
  }else{
    const dm=p.bbox.dims;
    info.innerHTML=`Abmessung<br><b>${fmt(dm[2],1)} × ${fmt(dm[1],1)} × ${fmt(dm[0],1)} mm</b><br>Volumen<br><b>${fmt(p.vol_m3*1e6,1)} cm³</b><br>Gewicht<br><b>${fmt(p.gewicht,2)} kg</b>`;
    renderStepView(body,p);
  }
  body.appendChild(info);
  // Laserzeit/Biegungen direkt im Viewer setzen
  const cfg=document.createElement('div'); cfg.className='viewer-info'; cfg.style.top='auto'; cfg.style.bottom='14px'; cfg.style.right='14px';
  cfg.innerHTML=`Laserzeit min<br><input id="vLaser" value="${fmt(p.laser_min,2)}" style="width:90px;margin-bottom:8px;font-family:var(--mono);border:0;border-radius:5px;padding:4px 6px"><br>Biegungen<br><input id="vBieg" value="${p.biegungen||0}" style="width:90px;font-family:var(--mono);border:0;border-radius:5px;padding:4px 6px">`;
  body.appendChild(cfg);
  cfg.querySelector('#vLaser').onchange=e=>{p.laser_min=numDe(e.target.value);p._autoLaser=false;renderPositions();recalc();};
  cfg.querySelector('#vBieg').onchange=e=>{p.biegungen=Math.max(0,parseInt(e.target.value)||0);renderPositions();recalc();};
}

function renderDxfView(body,p){
  const {minX,minY,w,h}=p.bbox; const pad=Math.max(w,h)*0.06||5; const sw=Math.max(w,h)/320;
  const ns='http://www.w3.org/2000/svg';
  const svg=document.createElementNS(ns,'svg');
  svg.setAttribute('viewBox',`${minX-pad} ${-(minY+h)-pad} ${w+2*pad} ${h+2*pad}`);
  const g=document.createElementNS(ns,'g'); g.setAttribute('id','rotG');
  const cx=minX+w/2, cy=-(minY+h/2);
  const path=document.createElementNS(ns,'path');
  let d='';
  for(const e of p.dxf){
    if(e.t==='pl'){ e.pts.forEach((pt,k)=>{ d+=(k?'L':'M')+pt.x+' '+(-pt.y)+' '; }); if(e.closed)d+='Z '; }
    else if(e.t==='circle'){ const r=e.r,c=e.c; d+=`M ${c.x-r} ${-c.y} a ${r} ${r} 0 1 0 ${2*r} 0 a ${r} ${r} 0 1 0 ${-2*r} 0 `; }
    else if(e.t==='arc'){ const r=e.r,c=e.c; const x0=c.x+r*Math.cos(e.a0),y0=c.y+r*Math.sin(e.a0),x1=c.x+r*Math.cos(e.a1),y1=c.y+r*Math.sin(e.a1); let da=e.a1-e.a0;if(da<0)da+=2*Math.PI;const large=da>Math.PI?1:0; d+=`M ${x0} ${-y0} A ${r} ${r} 0 ${large} 0 ${x1} ${-y1} `; }
  }
  path.setAttribute('d',d); path.setAttribute('fill','none'); path.setAttribute('stroke','#c00000'); path.setAttribute('stroke-width',sw); path.setAttribute('stroke-linejoin','round');
  g.appendChild(path); svg.appendChild(g); body.appendChild(svg);
  let rot=0; const apply=()=>g.setAttribute('transform',`rotate(${rot} ${cx} ${cy})`);
  addTools(body,[['↺ −90°',()=>{rot-=90;apply();}],['↻ +90°',()=>{rot+=90;apply();}],['Reset',()=>{rot=0;apply();}]]);
  body.insertAdjacentHTML('beforeend','<div class="viewer-hint">DXF · 2D-Kontur</div>');
}

function renderStepView(body,p){
  const rect=body.getBoundingClientRect();
  let W=Math.max(40,Math.round(rect.width)), H=Math.max(40,Math.round(rect.height));
  const renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});
  renderer.setPixelRatio(Math.min(2,window.devicePixelRatio||1)); renderer.setSize(W,H);
  renderer.domElement.style.touchAction='none';
  body.insertBefore(renderer.domElement,body.firstChild);
  const scene=new THREE.Scene();
  const cam=new THREE.PerspectiveCamera(45,W/H,0.01,1e7);
  // gleichmäßige Ausleuchtung (kein schwarzes Modell)
  scene.add(new THREE.AmbientLight(0xffffff,0.55));
  scene.add(new THREE.HemisphereLight(0xffffff,0x6b7079,0.9));
  const d1=new THREE.DirectionalLight(0xffffff,0.85); d1.position.set(1,1.4,1.2); scene.add(d1);
  const d2=new THREE.DirectionalLight(0xffffff,0.5);  d2.position.set(-1.2,-0.4,-1); scene.add(d2);
  const d3=new THREE.DirectionalLight(0xffffff,0.35); d3.position.set(0.2,-1,0.6); scene.add(d3);
  const grp=new THREE.Group();
  p.step.forEach(m=>{
    const geo=new THREE.BufferGeometry();
    geo.setAttribute('position',new THREE.BufferAttribute(m.pos,3));
    if(m.idx) geo.setIndex(new THREE.BufferAttribute(m.idx,1));
    geo.computeVertexNormals();
    // STEP-Farbe nur nutzen, wenn vorhanden und nicht (fast) schwarz – sonst Stahl-Grau
    const hasCol=m.color && (m.color[0]+m.color[1]+m.color[2])>0.12;
    const col=hasCol?new THREE.Color(m.color[0],m.color[1],m.color[2]):new THREE.Color(0xb4bac1);
    const mat=new THREE.MeshStandardMaterial({color:col,metalness:0.18,roughness:0.62,side:THREE.DoubleSide});
    grp.add(new THREE.Mesh(geo,mat));
  });
  const box=new THREE.Box3().setFromObject(grp); const ctr=box.getCenter(new THREE.Vector3()); const sz=box.getSize(new THREE.Vector3());
  grp.position.sub(ctr); scene.add(grp);
  const radius=Math.max(sz.x,sz.y,sz.z,1)*0.5;
  const fitDist=radius/Math.sin((cam.fov*Math.PI/180)/2)*1.25;
  const home=new THREE.Vector3(fitDist*0.6,fitDist*0.5,fitDist*0.8);
  cam.near=fitDist/100; cam.far=fitDist*100; cam.updateProjectionMatrix();
  cam.position.copy(home); cam.lookAt(0,0,0);
  const controls=new THREE.OrbitControls(cam,renderer.domElement);
  controls.enableDamping=true; controls.dampingFactor=0.09; controls.target.set(0,0,0);
  controls.rotateSpeed=0.9; controls.zoomSpeed=1.0; controls.update();
  let wire=false;
  const setCam=(x,y,z)=>{cam.position.set(x,y,z);controls.target.set(0,0,0);controls.update();};
  _three={renderer,raf:0,scene,cam};
  const loop=()=>{ _three.raf=requestAnimationFrame(loop); controls.update(); renderer.render(scene,cam); };
  addTools(body,[
    ['Reset',()=>setCam(home.x,home.y,home.z)],
    ['Drahtgitter',()=>{wire=!wire;grp.traverse(o=>{if(o.material)o.material.wireframe=wire;});}],
    ['Vorne',()=>setCam(0,0,fitDist)],
    ['Oben',()=>setCam(0,fitDist,0.001)],
    ['Seite',()=>setCam(fitDist,0,0)]]);
  body.insertAdjacentHTML('beforeend','<div class="viewer-hint">STEP · ziehen zum Drehen · Rad zum Zoomen · rechte Maustaste zum Verschieben</div>');
  loop();
  const onResize=()=>{const r=body.getBoundingClientRect();const w=Math.max(40,r.width),h=Math.max(40,r.height);cam.aspect=w/h;cam.updateProjectionMatrix();renderer.setSize(w,h);};
  _three.onResize=onResize; window.addEventListener('resize',onResize);
  // nach Layout-Settling einmal korrekt nachziehen
  requestAnimationFrame(onResize); setTimeout(onResize,120);
}
function addTools(body,btns){
  const t=document.createElement('div'); t.className='viewer-tools';
  btns.forEach(([lab,fn])=>{const b=document.createElement('button');b.textContent=lab;b.onclick=fn;t.appendChild(b);});
  body.appendChild(t);
}

// ---------- PDF rendern ----------
let rendering=false;
async function renderPage(n){
  if(!PDFDOC||rendering) return; rendering=true;
  try{ PAGE=Math.min(Math.max(1,n),PDFDOC.numPages);
    const page=await PDFDOC.getPage(PAGE); const vp=page.getViewport({scale:SCALE});
    const cv=$('#planCanvas'),ctx=cv.getContext('2d'); cv.width=vp.width; cv.height=vp.height;
    await page.render({canvasContext:ctx,viewport:vp}).promise;
    $('#pageInfo').textContent=`Seite ${PAGE} / ${PDFDOC.numPages}`;
  }catch(e){console.error(e);} finally{rendering=false;}
}

// ---------- Toast ----------
let tT; function toast(m){let t=$('#toast');if(!t){t=document.createElement('div');t.id='toast';t.className='toast';document.body.appendChild(t);}t.textContent=m;clearTimeout(tT);tT=setTimeout(()=>t.remove(),3400);}

// ---------- Parameter ----------
function bindParams(){
  const map={p_laser:'laser_satz',p_abk:'abkant_satz',p_marge:'marge',p_min:'min_pos',p_ruest:'ruest_pos',p_bieg:'sek_biegung'};
  for(const id in map){ const el=$('#'+id); el.value=fmt(PARAMS[map[id]],id==='p_marge'||id==='p_bieg'?0:2);
    el.onchange=()=>{ PARAMS[map[id]]=numDe(el.value); PARTS.forEach(p=>{if(p.source==='dxf'||p.source==='step')recomputeCad(p);}); renderPositions(); recalc(); }; }
}

// ---------- Material-Dialog ----------
function openMaterial(){
  const rows=Object.entries(MATERIAL).sort().map(([m,p])=>`<tr><td><input class="mn" value="${m}"></td><td><input class="pr mp" value="${fmt(p,2)}"></td></tr>`).join('');
  const m=document.createElement('div'); m.className='modal';
  m.innerHTML=`<div class="modal-card"><div class="modal-h"><h3>Materialpreise · €/kg</h3><button>✕</button></div>
    <div class="modal-b"><table class="mtab"><thead><tr><th>Werkstoff</th><th>€/kg</th></tr></thead><tbody id="mb">${rows}</tbody></table>
    <button class="btn s" id="madd" style="margin-top:12px">＋ Material</button></div>
    <div class="modal-f"><button class="btn s" data-x>Abbrechen</button><button class="btn p" data-s>Speichern</button></div></div>`;
  document.body.appendChild(m);
  const close=()=>m.remove();
  m.querySelector('.modal-h button').onclick=close; m.querySelector('[data-x]').onclick=close; m.onclick=e=>{if(e.target===m)close();};
  m.querySelector('#madd').onclick=()=>{const tr=document.createElement('tr');tr.innerHTML=`<td><input class="mn"></td><td><input class="pr mp" value="0,00"></td>`;m.querySelector('#mb').appendChild(tr);};
  m.querySelector('[data-s]').onclick=()=>{
    const ns=[...m.querySelectorAll('.mn')],ps=[...m.querySelectorAll('.mp')],nm={};
    ns.forEach((n,i)=>{const k=n.value.trim();if(k)nm[k]=numDe(ps[i].value);});
    for(const k in MATERIAL)delete MATERIAL[k]; Object.assign(MATERIAL,nm);
    PARTS.forEach(p=>{if(p.source==='dxf'||p.source==='step')recomputeCad(p);}); renderPositions(); recalc(); close();
  };
}

// ---------- Angebot ----------
function openAngebot(){
  const g=id=>($('#'+id)?.value||'').trim();
  const total=grandTotal();
  const kundeAdr=[g('k_firma'),[g('k_anrede'),g('k_vor'),g('k_nach')].filter(Boolean).join(' '),g('k_str'),[g('k_plz'),g('k_ort')].filter(Boolean).join(' '),g('k_land')].filter(Boolean).join('<br>');
  const nr=g('d_nr')||(PLANNAME?PLANNAME.replace(/\.pdf$/i,''):'Angebot');
  const datum=g('d_datum')||new Date().toLocaleDateString('de-DE');
  const verk=[g('d_verk'),g('d_tel'),g('d_mail')].filter(Boolean).join(' · ');
  const opts=PARTS.map((p,i)=>{const c=calc(p);
    return `<div class="opt"><div class="on"><b>${i+1}. ${p.teilenr}</b><small>${p.material} · ${fmt(p.dicke,1)} mm · ${c.menge}× · ${eur(c.vk)}/St.</small></div><div class="op">${eur(c.position)}</div></div>`;}).join('');
  const metaSrc = PLANNAME?('Plan '+PLANNAME.replace(/\.pdf$/i,'')):(PARTS.length+' CAD-Teile');
  const w=document.createElement('div'); w.id='angebot';
  w.innerHTML=`
   <div class="angbar"><button class="back" id="angBack">‹ Zurück</button><button class="print" id="angPrint">Drucken / PDF</button></div>
   <div class="ang">
     <div class="head">
       <div style="display:flex;gap:13px;align-items:center">
         <img src="logo.png" width="50" height="50" style="border-radius:9px">
         <div class="co"><b>Alzinger Maschinenbau GmbH</b><small>Am Gewerbring 14 · 84069 Schierling${verk?'<br>Verkäufer: '+verk:''}</small></div>
       </div>
       <div class="meta">Angebot<br><b>${nr}</b><br>${datum}${g('d_ort')?' · '+g('d_ort'):''}</div>
     </div>
     ${kundeAdr?`<div style="margin-bottom:20px;font-size:13.5px">${kundeAdr}</div>`:''}
     <p class="lead">Sehr geehrte Damen und Herren,<br><br>wir bedanken uns herzlich für Ihr Interesse und unterbreiten Ihnen gerne – freibleibend – das nachfolgende Angebot über die nachstehenden Laser- &amp; Abkantteile.</p>
     <div class="basis"><div><div style="font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#cfae6e">Auftragsumfang</div><div class="t">${PARTS.length} Positionen · ${totalStk()} Teile</div><div style="font-family:var(--mono);font-size:11px;color:#bdbab2;margin-top:6px">${metaSrc}</div></div><div class="p">${eur(total)}</div></div>
     <div class="optgroup"><div class="ogh">Positionen</div>${opts}</div>
     <div class="sums"><div class="srow"><span>Zwischensumme netto</span><span style="font-family:var(--mono)">${eur(total)}</span></div><div class="srow tot"><span>Gesamtpreis netto</span><span class="v">${eur(total)}</span></div></div>
     <div class="terms">
       <div><h4>Gewährleistung</h4><p>1 Jahr ab Auslieferung, nicht auf Verschleißteile.</p></div>
       <div><h4>Lieferbedingungen</h4><p>FCA Schierling Germany (Incoterms 2010).</p></div>
       <div><h4>Zahlungsbedingungen</h4><p>30 % Anzahlung bei Auftragserteilung, Restbetrag bei Versandbereitschaft.</p></div>
       <div><h4>Lieferzeit</h4><p>Nach Vereinbarung.</p></div>
     </div>
     <div class="fine">Dieses Angebot ist freibleibend und unverbindlich, 30 Tage gültig. Alle Preise in Euro, netto zzgl. gesetzlicher Mehrwertsteuer. Es gelten die AGB der Alzinger Maschinenbau GmbH. Sätze: Laser ${fmt(PARAMS.laser_satz,2)} €/h · Abkanten ${fmt(PARAMS.abkant_satz,2)} €/h · Marge ${fmt(PARAMS.marge,0)} %.</div>
   </div>`;
  document.body.appendChild(w);
  $('#angBack').onclick=()=>w.remove(); $('#angPrint').onclick=()=>window.print();
}

// ---------- CSV ----------
function exportCsv(){
  if(!PARTS.length){toast('Keine Positionen.');return;}
  const head=['Pos','Teile-Nr','Quelle','Material','Dicke_mm','Menge','kg/St','Laser_min','Biegungen','Material_EUR','Laser_EUR','Abkant_EUR','Ruest_EUR','Selbstk_EUR','VK_EUR','Position_EUR'];
  const L=[head.join(';')];
  PARTS.forEach((p,i)=>{const c=calc(p);L.push([i+1,p.teilenr,p.source,p.material,fmt(p.dicke,2),c.menge,fmt(p.gewicht,3),fmt(p.laser_min,3),p.biegungen||0,fmt(c.matk),fmt(c.laserk),fmt(c.biegek),fmt(c.ruestk),fmt(c.selbstk),fmt(c.vk),fmt(c.position)].join(';'));});
  L.push(['','','','','','','','','','','','','','','Gesamt',fmt(grandTotal())].join(';'));
  const blob=new Blob(['﻿'+L.join('\r\n')],{type:'text/csv;charset=utf-8'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=((PLANNAME||'Laser-Kalkulation').replace(/\.pdf$/i,''))+'.csv';a.click();
  toast('CSV exportiert.');
}

// ---------- Wiring ----------
$('#d_datum').value=new Date().toLocaleDateString('de-DE');
$('#drop').onclick=()=>$('#fileInput').click();
$('#reload').onclick=()=>$('#fileInput').click();
$('#addFile').onclick=()=>$('#fileInput').click();
$('#fileInput').onchange=e=>{handleFiles(e.target.files);e.target.value='';};
['dragover','dragenter'].forEach(ev=>$('#drop').addEventListener(ev,e=>{e.preventDefault();$('#drop').classList.add('over');}));
['dragleave','drop'].forEach(ev=>$('#drop').addEventListener(ev,e=>{e.preventDefault();$('#drop').classList.remove('over');}));
$('#drop').addEventListener('drop',e=>{ if(e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });
$('#pgPrev').onclick=()=>renderPage(PAGE-1);
$('#pgNext').onclick=()=>renderPage(PAGE+1);
$('#zIn').onclick=()=>{SCALE=Math.min(3,SCALE+0.2);renderPage(PAGE);};
$('#zOut').onclick=()=>{SCALE=Math.max(0.5,SCALE-0.2);renderPage(PAGE);};
$('#btnMaterial').onclick=openMaterial;
$('#btnCsv').onclick=exportCsv;
$('#btnAngebot').onclick=()=>{ if(!PARTS.length){toast('Erst Dateien laden.');return;} openAngebot(); };
document.addEventListener('keydown',e=>{ if(e.key==='Escape'){ closeViewer(); $('#angebot')?.remove(); } });
bindParams();
window.__loadUrl=async url=>{const b=await(await fetch(url)).arrayBuffer();await loadPlan(b,url.split('/').pop());showWork();renderPositions();recalc();};
window.__loadDxfUrl=async url=>{const t=await(await fetch(url)).text();await loadDxf(t,url.split('/').pop());showWork();renderPositions();recalc();};
window.__loadStepUrl=async url=>{const b=await(await fetch(url)).arrayBuffer();await loadStep(b,url.split('/').pop());showWork();renderPositions();recalc();};
