/* Alzinger Laser-Kalkulation – App-Logik (Konfigurator-Stil, mit CAD) */
'use strict';
pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

const PARAMS = {
  laser_satz:134.17,   // €/h Laser (TruLaser 5030)
  abkant_satz:85.00,   // €/h Abkanten
  prog_satz:60.00,     // €/h Programmierung/Büro
  marge:30,            // % Aufschlag auf VK
  min_pos:15,          // € Mindestposition
  prog_min:12,         // min Programmieren je Teilenummer (auf Menge umgelegt)
  ruest_laser_min:5,   // min Laser-Rüsten je Position (umgelegt)
  ruest_biege_min:8,   // min Biege-Rüsten je Position (umgelegt, nur bei Biegung)
  handling_s:15,       // s Handling je Teil beim Biegen
  t_biege_s:20,        // s je Biegung
  laser_overhead:1.4   // Faktor Maschinenzeit/Beam-on (nur DXF-Schätzung)
};
const MATERIAL = {'S235':1.30,'S355':1.50,'1.4301 V2A':4.90,'V4A':6.50,'AlMg3':4.20,'Hardox 500':2.40,'Hardox 600':2.80};
const DENSITY = {'1.4':7900,'V2A':7900,'V4A':7900,'S2':7850,'S3':7850,'Hardox':7850,'AlMg':2700,'Al':2700}; // kg/m³ je Präfix
function density(m){ for(const k in DENSITY){ if(m&&m.includes(k)) return DENSITY[k]; } return 7850; }

// Schnittgeschwindigkeit mm/min (Richtwerte Faserlaser 6 kW, TruLaser 5030) je Werkstoffgruppe/Dicke
// Richtwerte 6-kW-Faserlaser (mm/min), verankert am Plan: 2 mm Edelstahl ~19 m/min
const SPEED = {
  stahl:     {t:[1,2,3,4,5,6,8,10,12,15,20,25], v:[9500,7000,4800,4000,3300,2800,2000,1700,1400,1000,650,450]},
  edelstahl: {t:[1,2,3,4,5,6,8,10,12,15,20],    v:[38000,19000,9500,5500,3800,2700,1500,950,650,400,250]},
  alu:       {t:[1,2,3,4,5,6,8,10,12,15],       v:[32000,16000,9000,5000,3500,2500,1300,800,500,320]},
};
function speedGroup(m){ if(!m) return 'stahl'; if(/1\.4|V2A|V4A/i.test(m)) return 'edelstahl'; if(/^Al|AlMg/i.test(m)) return 'alu'; return 'stahl'; }
function speedFor(m,t){ const g=SPEED[speedGroup(m)],ts=g.t,vs=g.v; if(t<=ts[0])return vs[0]; if(t>=ts[ts.length-1])return vs[vs.length-1];
  for(let i=1;i<ts.length;i++){ if(t<=ts[i]){ const f=(t-ts[i-1])/(ts[i]-ts[i-1]); return vs[i-1]+f*(vs[i]-vs[i-1]); } } return vs[vs.length-1]; }
// Einstechzeit (s) nach Dicke
function pierceTime(t){ return t<=3?0.4 : t<=6?0.8 : t<=10?1.5 : 2.5; }

let PARTS=[], PDFDOC=null, PAGE=1, SCALE=1.2, PLANNAME='', WERKSTOFF='', DICKE=0, OCCT=null;
// Schachtelung
const SHEET_W=3000, SHEET_H=1500, MIN_GAP=5;
let RESTTAFEL_CHARGE=false, NEST_RESULT=null;
let PENDING_BENDS=[];   // Biegeprogramme (jupidu/html), die auf passende Teile warten

const $=s=>document.querySelector(s);
const numDe=s=>{s=String(s).trim().replace(/\./g,'').replace(',','.');const v=parseFloat(s);return isNaN(v)?0:v;};
const fmt=(x,d=2)=>Number(x).toLocaleString('de-DE',{minimumFractionDigits:d,maximumFractionDigits:d});
const eur=x=>fmt(x)+' €';

// Einstellungen (Materialpreise + Sätze) dauerhaft im Browser speichern
function saveSettings(){ try{
  localStorage.setItem('alz_material_v2',JSON.stringify(MATERIAL));
  localStorage.setItem('alz_params_v2',JSON.stringify(PARAMS));
  localStorage.setItem('alz_rest', RESTTAFEL_CHARGE?'1':'0');
  localStorage.setItem('alz_nestmode', NEST_MODE);
}catch(e){} }
function setNestMode(mode){ if(!NEST_ANGLE_SETS[mode]) mode='fast'; NEST_MODE=mode; NEST_ANGLES=NEST_ANGLE_SETS[mode]; }
function loadSettings(){ try{
  const m=JSON.parse(localStorage.getItem('alz_material_v2')||'null');
  if(m&&typeof m==='object'&&Object.keys(m).length){ for(const k in MATERIAL) delete MATERIAL[k]; Object.assign(MATERIAL,m); }
  const p=JSON.parse(localStorage.getItem('alz_params_v2')||'null');
  if(p&&typeof p==='object') Object.assign(PARAMS,p);
  RESTTAFEL_CHARGE = localStorage.getItem('alz_rest')==='1';
  setNestMode(localStorage.getItem('alz_nestmode')||'fast');
}catch(e){} }
function resetSettings(){ try{ localStorage.removeItem('alz_material_v2'); localStorage.removeItem('alz_params_v2'); }catch(e){} location.reload(); }

function matPrice(name){
  if(name in MATERIAL) return {p:MATERIAL[name],known:true};
  for(const m in MATERIAL){ if(name&&(name.startsWith(m)||m.startsWith(name))) return {p:MATERIAL[m],known:true}; }
  return {p:0,known:false};
}
function calc(p){
  const {p:price,known}=matPrice(p.material); p._known=known;
  const menge=Math.max(1,parseInt(p.menge)||1);
  const bends=Math.max(0,parseInt(p.biegungen)||0);
  // Stückkosten (variabel) – Material aus Schachtelung, falls vorhanden
  const matk=(p._matkUnit!=null)?p._matkUnit:p.gewicht*price;
  const laserk=p.laser_min*PARAMS.laser_satz/60;            // Laserzeit (min) × €/h
  const biege_s=bends>0 ? (PARAMS.handling_s + bends*PARAMS.t_biege_s) : 0;
  const biegek=biege_s*PARAMS.abkant_satz/3600;             // Biegezeit (s) × €/h
  const varUnit=matk+laserk+biegek;
  // Fixkosten je Position (auf Menge umgelegt)
  const progFix=PARAMS.prog_min*PARAMS.prog_satz/60;        // Programmieren
  const ruestFix=PARAMS.ruest_laser_min*PARAMS.laser_satz/60
               + (bends>0?PARAMS.ruest_biege_min*PARAMS.abkant_satz/60:0); // Rüsten Laser(+Biegen)
  const fixPos=progFix+ruestFix;
  const progk=progFix/menge, ruestk=ruestFix/menge;
  const selbstk=varUnit+progk+ruestk;
  const m=PARAMS.marge/100;
  const vk=m<1?selbstk/(1-m):selbstk;
  const position=Math.max(vk*menge,PARAMS.min_pos);
  return {matk,progk,ruestk,laserk,biegek,biege_s,varUnit,fixPos,selbstk,vk,position,menge,known};
}
// VK je Stück bei Stückzahl Q (Fixkosten ÷ Q) – für Staffelpreise
function unitVkAt(p,Q){ const c=calc(p); const sk=c.varUnit + c.fixPos/Math.max(1,Q); const m=PARAMS.marge/100; return m<1?sk/(1-m):sk; }
const grandTotal=()=>PARTS.reduce((a,p)=>a+calc(p).position,0);
const totalStk=()=>PARTS.reduce((a,p)=>a+Math.max(1,parseInt(p.menge)||1),0);

// Laserzeit-Schätzung (min) aus Schneidlänge + Einstichen (DXF & STEP)
function estimateLaserMin(p){
  const v=speedFor(p.material,p.dicke||1);
  const beam=(p.cutlen_mm||0)/Math.max(150,v);              // Beam-on (min)
  const pierce=(p.einstech||0)*pierceTime(p.dicke||1)/60;   // Einstechzeit
  const rapid=beam*0.10;                                    // Eilgang ~10%
  return +((beam+pierce+rapid)*PARAMS.laser_overhead).toFixed(2);
}
// CAD-Teile: Gewicht (und ggf. Laserzeit) aus Geometrie neu berechnen
function recomputeCad(p){
  const d=density(p.material);
  if(p.source==='dxf')      p.gewicht = +(p.area_m2 * (p.dicke/1000) * d).toFixed(3);
  else if(p.source==='step') p.gewicht = +(p.vol_m3 * d).toFixed(3);
  if(p._autoLaser) p.laser_min = estimateLaserMin(p);
}

// ---------- Schachtelung ----------
function parseAbm(s){ const m=String(s||'').match(/([\d.,]+)\s*x\s*([\d.,]+)/i); return m?{w:numDe(m[1]),h:numDe(m[2])}:null; }
function footprint(p){
  if(p.source==='dxf' && p.bbox) return {w:p.bbox.w, h:p.bbox.h};
  if(p.source==='pdf'){ const a=parseAbm(p.abm); if(a&&a.w&&a.h) return a; }
  if(p.source==='step' && p.bbox){
    const dm=p.bbox.dims; const L=dm[2]||1; // längste Kante
    const blank=(p.dicke>0)?(p.vol_m3*1e9)/p.dicke:L*(dm[1]||1); // Abwicklungsfläche mm²
    return {w:L, h:Math.max(dm[1]||1, blank/L)};
  }
  return null;
}
// --- echte Konturen für die Schachtel-Darstellung (normiert auf [0,1]) ---
function flattenArc(c,r,a0,a1,seg){ const pts=[]; let da=a1-a0; if(da<0)da+=2*Math.PI; const n=Math.max(seg,Math.ceil(da/(Math.PI/12)));
  for(let i=0;i<=n;i++){ const a=a0+da*i/n; pts.push({x:c.x+r*Math.cos(a),y:c.y+r*Math.sin(a)}); } return pts; }
function dxfContourNorm(draw,bbox){
  const {minX,maxY,w,h}=bbox; if(!(w>0)||!(h>0)) return {path:'',holes:[]};
  const NX=x=>(x-minX)/w, NY=y=>(maxY-y)/h; // y nach unten kippen, [0,1]
  let d=''; const loops=[];
  for(const e of draw){
    let pts=null, closed=false;
    if(e.t==='pl'){ pts=e.pts; closed=e.closed; }
    else if(e.t==='circle'){ pts=flattenArc(e.c,e.r,0,2*Math.PI,24); closed=true; }
    else if(e.t==='arc'){ pts=flattenArc(e.c,e.r,e.a0,e.a1,16); }
    if(!pts||!pts.length) continue;
    d+='M'+NX(pts[0].x).toFixed(4)+' '+NY(pts[0].y).toFixed(4)+' ';
    for(let i=1;i<pts.length;i++) d+='L'+NX(pts[i].x).toFixed(4)+' '+NY(pts[i].y).toFixed(4)+' ';
    if(closed){ d+='Z ';
      let a=1e9,b=1e9,cc=-1e9,dd=-1e9; pts.forEach(p=>{const X=NX(p.x),Y=NY(p.y); if(X<a)a=X;if(Y<b)b=Y;if(X>cc)cc=X;if(Y>dd)dd=Y;});
      loops.push({x:a,y:b,w:cc-a,h:dd-b,area:(cc-a)*(dd-b)});
    }
  }
  loops.sort((p,q)=>q.area-p.area);
  const holes=loops.slice(1).filter(l=>l.w>0.1&&l.h>0.1);
  return {path:d, holes};
}
function convexHull(pts){ if(pts.length<3) return pts.slice();
  pts=pts.slice().sort((a,b)=>a.x-b.x||a.y-b.y);
  const cr=(o,a,b)=>(a.x-o.x)*(b.y-o.y)-(a.y-o.y)*(b.x-o.x);
  const lo=[],hi=[];
  for(const p of pts){ while(lo.length>=2&&cr(lo[lo.length-2],lo[lo.length-1],p)<=0)lo.pop(); lo.push(p); }
  for(let i=pts.length-1;i>=0;i--){ const p=pts[i]; while(hi.length>=2&&cr(hi[hi.length-2],hi[hi.length-1],p)<=0)hi.pop(); hi.push(p); }
  lo.pop(); hi.pop(); return lo.concat(hi); }
// dominante Flächennormale (größte Fläche) – für Dicke & Kontur
function dominantNormal(meshes){
  const cl=[];
  for(const m of meshes){ const pos=m.pos, idx=m.idx; if(!idx) continue; const g=i=>[pos[i*3],pos[i*3+1],pos[i*3+2]];
    for(let t=0;t<idx.length;t+=3){ const a=g(idx[t]),b=g(idx[t+1]),c=g(idx[t+2]);
      let nx=(b[1]-a[1])*(c[2]-a[2])-(b[2]-a[2])*(c[1]-a[1]),ny=(b[2]-a[2])*(c[0]-a[0])-(b[0]-a[0])*(c[2]-a[2]),nz=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
      const L=Math.hypot(nx,ny,nz); if(L<1e-9)continue; const ar=0.5*L; let sx=nx/L,sy=ny/L,sz=nz/L;
      if(sz<-1e-6||(Math.abs(sz)<=1e-6&&(sy<-1e-6||(Math.abs(sy)<=1e-6&&sx<0)))){sx=-sx;sy=-sy;sz=-sz;}
      let f=false; for(const c2 of cl){ if(c2.ax*sx+c2.ay*sy+c2.az*sz>0.985){c2.area+=ar;f=true;break;} } if(!f)cl.push({ax:sx,ay:sy,az:sz,area:ar});
    } }
  if(!cl.length) return {x:0,y:0,z:1}; cl.sort((a,b)=>b.area-a.area); return {x:cl[0].ax,y:cl[0].ay,z:cl[0].az};
}
// Blechdicke = Abstand zwischen Ober- und Unterseite der Hauptfläche (robust auch bei gebogenen Teilen,
// da nur Flächen ~+n und ~-n zählen, nicht abstehende Schenkel)
function sheetThickness(meshes,n){
  let topS=0,topW=0,botS=0,botW=0;
  for(const m of meshes){ const pos=m.pos, idx=m.idx; if(!idx) continue; const g=i=>[pos[i*3],pos[i*3+1],pos[i*3+2]];
    for(let t=0;t<idx.length;t+=3){ const a=g(idx[t]),b=g(idx[t+1]),c=g(idx[t+2]);
      let nx=(b[1]-a[1])*(c[2]-a[2])-(b[2]-a[2])*(c[1]-a[1]),ny=(b[2]-a[2])*(c[0]-a[0])-(b[0]-a[0])*(c[2]-a[2]),nz=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
      const L=Math.hypot(nx,ny,nz); if(L<1e-9)continue; const ar=0.5*L; const d=(nx*n.x+ny*n.y+nz*n.z)/L;
      const proj=((a[0]+b[0]+c[0])/3)*n.x+((a[1]+b[1]+c[1])/3)*n.y+((a[2]+b[2]+c[2])/3)*n.z;
      if(d>0.985){ topS+=proj*ar; topW+=ar; } else if(d<-0.985){ botS+=proj*ar; botW+=ar; }
    } }
  if(topW>0&&botW>0) return Math.abs(topS/topW - botS/botW);
  // Fallback: Gesamtausdehnung entlang n
  let mn=1e18,mx=-1e18; for(const m of meshes){ const pos=m.pos; for(let i=0;i<pos.length;i+=3){ const d=pos[i]*n.x+pos[i+1]*n.y+pos[i+2]*n.z; if(d<mn)mn=d; if(d>mx)mx=d; } } return mx-mn;
}
function planeBasis(n){
  const ax=Math.abs(n.x),ay=Math.abs(n.y),az=Math.abs(n.z);
  let t=(ax<=ay&&ax<=az)?{x:1,y:0,z:0}:(ay<=az?{x:0,y:1,z:0}:{x:0,y:0,z:1});
  const d=t.x*n.x+t.y*n.y+t.z*n.z; let ux=t.x-d*n.x,uy=t.y-d*n.y,uz=t.z-d*n.z; const ul=Math.hypot(ux,uy,uz)||1; ux/=ul;uy/=ul;uz/=ul;
  return {u:{x:ux,y:uy,z:uz}, v:{x:n.y*uz-n.z*uy, y:n.z*ux-n.x*uz, z:n.x*uy-n.y*ux}};
}
// echte 2D-Kontur: Randkanten der Top-Fläche (Normale ~ +n) projizieren und zu Schleifen verketten
function stepOutline(meshes,n){
  const {u,v}=planeBasis(n); const edge=new Map(), P=new Map(); let mi=0;
  for(const m of meshes){ const pos=m.pos, idx=m.idx; if(!idx){mi++;continue;} const g=i=>[pos[i*3],pos[i*3+1],pos[i*3+2]];
    for(let t=0;t<idx.length;t+=3){ const ia=idx[t],ib=idx[t+1],ic=idx[t+2]; const a=g(ia),b=g(ib),c=g(ic);
      let nx=(b[1]-a[1])*(c[2]-a[2])-(b[2]-a[2])*(c[1]-a[1]),ny=(b[2]-a[2])*(c[0]-a[0])-(b[0]-a[0])*(c[2]-a[2]),nz=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
      const L=Math.hypot(nx,ny,nz); if(L<1e-9)continue; if((nx*n.x+ny*n.y+nz*n.z)/L<0.985) continue;
      const ks=k=>mi+':'+k; [[ia,a],[ib,b],[ic,c]].forEach(([vi,p])=>{ const kk=ks(vi); if(!P.has(kk)) P.set(kk,{x:p[0]*u.x+p[1]*u.y+p[2]*u.z, y:p[0]*v.x+p[1]*v.y+p[2]*v.z}); });
      [[ia,ib],[ib,ic],[ic,ia]].forEach(([p,q])=>{ const k1=ks(p),k2=ks(q); const ek=k1<k2?k1+'|'+k2:k2+'|'+k1; edge.set(ek,(edge.get(ek)||0)+1); });
    } mi++;
  }
  const adj=new Map();
  for(const [ek,cnt] of edge){ if(cnt!==1) continue; const i=ek.indexOf('|'); const k1=ek.slice(0,i),k2=ek.slice(i+1);
    if(!adj.has(k1))adj.set(k1,[]); if(!adj.has(k2))adj.set(k2,[]); adj.get(k1).push(k2); adj.get(k2).push(k1); }
  const seen=new Set(), loops=[];
  for(const start of adj.keys()){ if(seen.has(start)) continue; const loop=[]; let cur=start,prev=null,guard=0;
    while(cur!==null && cur!==undefined && !seen.has(cur) && guard++<200000){ seen.add(cur); loop.push(P.get(cur)); const nb=adj.get(cur)||[]; let nx=nb.find(x=>x!==prev&&!seen.has(x)); prev=cur; cur=(nx===undefined)?null:nx; }
    if(loop.length>=3) loops.push(loop);
  }
  if(!loops.length) return null;
  let mnx=1e18,mny=1e18,mxx=-1e18,mxy=-1e18; loops.forEach(lp=>lp.forEach(p=>{if(p.x<mnx)mnx=p.x;if(p.y<mny)mny=p.y;if(p.x>mxx)mxx=p.x;if(p.y>mxy)mxy=p.y;}));
  const w=mxx-mnx||1,h=mxy-mny||1; let d=''; const boxes=[];
  loops.forEach(lp=>{ let a=1e9,b=1e9,cc=-1e9,dd=-1e9;
    lp.forEach((p,i)=>{ const X=(p.x-mnx)/w, Y=(mxy-p.y)/h; d+=(i?'L':'M')+X.toFixed(4)+' '+Y.toFixed(4)+' '; if(X<a)a=X;if(Y<b)b=Y;if(X>cc)cc=X;if(Y>dd)dd=Y; });
    d+='Z '; boxes.push({x:a,y:b,w:cc-a,h:dd-b,area:(cc-a)*(dd-b)}); });
  boxes.sort((p,q)=>q.area-p.area);
  const holes=boxes.slice(1).filter(l=>l.w>0.1&&l.h>0.1);
  return {path:d, holes};
}
function stepContourNorm(meshes,n){
  try{ const o=stepOutline(meshes,n); if(o && o.path && o.path.length>20) return o; }catch(e){ console.warn('outline',e); }
  const {u,v}=planeBasis(n); let total=0; meshes.forEach(m=>total+=m.pos.length/3);
  const step=Math.max(1,Math.floor(total/4000)); const pts=[]; let c=0;
  for(const m of meshes){ const pos=m.pos; for(let i=0;i<pos.length;i+=3){ if(c++%step) continue; pts.push({x:pos[i]*u.x+pos[i+1]*u.y+pos[i+2]*u.z, y:pos[i]*v.x+pos[i+1]*v.y+pos[i+2]*v.z}); } }
  if(pts.length<3) return {path:'',holes:[]};
  const hull=convexHull(pts); let mnx=1e18,mny=1e18,mxx=-1e18,mxy=-1e18;
  hull.forEach(p=>{if(p.x<mnx)mnx=p.x;if(p.y<mny)mny=p.y;if(p.x>mxx)mxx=p.x;if(p.y>mxy)mxy=p.y;});
  const w=mxx-mnx||1,h=mxy-mny||1; let d=''; hull.forEach((p,i)=>{ d+=(i?'L':'M')+((p.x-mnx)/w).toFixed(4)+' '+((mxy-p.y)/h).toFixed(4)+' '; });
  return {path:d+'Z', holes:[]};
}
// Randschleifen (Außenrand + Löcher) einer 2D-Dreiecksmenge über Kanten, die nur 1× vorkommen
function loops2D(tris){
  const Q=0.08, kk=p=>Math.round(p.x/Q)+'_'+Math.round(p.y/Q);
  const ids=new Map(), pts=[];
  const idOf=p=>{const k=kk(p); let id=ids.get(k); if(id==null){id=pts.length;ids.set(k,id);pts.push({x:p.x,y:p.y});} return id;};
  const edge=new Map();
  for(const t of tris){ const i0=idOf(t.a),i1=idOf(t.b),i2=idOf(t.c);
    [[i0,i1],[i1,i2],[i2,i0]].forEach(([a,b])=>{ if(a===b)return; const k=a<b?a+'|'+b:b+'|'+a; edge.set(k,(edge.get(k)||0)+1); }); }
  const adj=new Map(), push=(a,b)=>{ if(!adj.has(a))adj.set(a,[]); adj.get(a).push(b); };
  for(const [k,c] of edge){ if(c!==1)continue; const i=k.indexOf('|'); const a=+k.slice(0,i),b=+k.slice(i+1); push(a,b); push(b,a); }
  const seen=new Set(), loops=[];
  for(const s of adj.keys()){ if(seen.has(s))continue; const lp=[]; let cur=s,prev=-1,gu=0;
    while(cur!=null&&!seen.has(cur)&&gu++<200000){ seen.add(cur); lp.push(pts[cur]); const nb=adj.get(cur)||[]; let nx=nb.find(x=>x!==prev&&!seen.has(x)); if(nx==null)nx=nb.find(x=>x!==prev); prev=cur; cur=(nx==null?null:nx); }
    if(lp.length>=3) loops.push(lp); }
  return loops;
}
// Größte zusammenhängende FLACHE Fläche (eine Ebene) mit Außenrand + Löchern – sauberer Zuschnitt-Look
// für Biegeteile (statt der überlagerten 3D-Projektion). Nur Darstellung.
function dominantFaceFlat(meshes,n){
 try{
  const {u,v}=planeBasis(n); const dot=(P,Q)=>P[0]*Q.x+P[1]*Q.y+P[2]*Q.z;
  const tris=[];
  for(const m of meshes){ const pos=m.pos,idx=m.idx; if(!idx)continue; const g=i=>[pos[i*3],pos[i*3+1],pos[i*3+2]];
    for(let t=0;t<idx.length;t+=3){ const A=g(idx[t]),B=g(idx[t+1]),C=g(idx[t+2]);
      let nx=(B[1]-A[1])*(C[2]-A[2])-(B[2]-A[2])*(C[1]-A[1]);
      let ny=(B[2]-A[2])*(C[0]-A[0])-(B[0]-A[0])*(C[2]-A[2]);
      let nz=(B[0]-A[0])*(C[1]-A[1])-(B[1]-A[1])*(C[0]-A[0]);
      const L=Math.hypot(nx,ny,nz); if(L<1e-9)continue;
      if((nx*n.x+ny*n.y+nz*n.z)/L<0.985) continue;          // nur Flächen ~ +n
      const cen=[(A[0]+B[0]+C[0])/3,(A[1]+B[1]+C[1])/3,(A[2]+B[2]+C[2])/3];
      const p2=P=>({x:dot(P,u),y:dot(P,v)});
      tris.push({off:dot(cen,n), area:0.5*L, a:p2(A),b:p2(B),c:p2(C)});
    } }
  if(tris.length<2) return null;
  tris.sort((a,b)=>a.off-b.off);                             // nach Ebenen-Offset gruppieren
  let groups=[],cur=null;
  for(const t of tris){ if(cur&&Math.abs(t.off-cur.last)<2){cur.tris.push(t);cur.area+=t.area;cur.last=t.off;} else {cur={tris:[t],area:t.area,last:t.off};groups.push(cur);} }
  groups.sort((a,b)=>b.area-a.area);                         // größte einzelne Fläche
  const loops=loops2D(groups[0].tris); if(!loops.length) return null;
  let mnx=1e18,mny=1e18,mxx=-1e18,mxy=-1e18;
  loops.forEach(lp=>lp.forEach(p=>{if(p.x<mnx)mnx=p.x;if(p.y<mny)mny=p.y;if(p.x>mxx)mxx=p.x;if(p.y>mxy)mxy=p.y;}));
  const w=mxx-mnx||1,h=mxy-mny||1;
  loops.sort((a,b)=>shoelace(b)-shoelace(a));                // Außenrand zuerst
  let d=''; loops.forEach(lp=>{ lp.forEach((p,i)=>{ d+=(i?'L':'M')+((p.x-mnx)/w).toFixed(4)+' '+((mxy-p.y)/h).toFixed(4)+' '; }); d+='Z '; });
  return {path:d, w, h, loops:loops.length};
 }catch(e){ console.warn('flatface',e); return null; }
}
// Abwicklung eines um EINE Achse gebogenen/gerollten Teils (Profil, Rinne, Zylinderschale):
// Außenhaut über den Querschnitt-Bogen aufrollen → (Länge, Bogenlänge) mit allen Ausschnitten.
// Validierung gegen die echte Blechfläche; gibt null, wenn das Modell nicht passt.
function unrollCylindrical(meshes, dicke, blankArea){
 try{
  let mn=[1e18,1e18,1e18],mx=[-1e18,-1e18,-1e18];
  for(const m of meshes){const p=m.pos;for(let i=0;i<p.length;i+=3)for(let k=0;k<3;k++){const v=p[i+k];if(v<mn[k])mn[k]=v;if(v>mx[k])mx[k]=v;}}
  const ext=[mx[0]-mn[0],mx[1]-mn[1],mx[2]-mn[2]];
  const AL=ext[0]>=ext[1]&&ext[0]>=ext[2]?0:(ext[1]>=ext[2]?1:2);     // Längsachse
  const A=[0,1,2].filter(k=>k!==AL);                                   // Querschnitt-Achsen
  let su=0,sv=0,cnt=0;
  for(const m of meshes){const p=m.pos;for(let i=0;i<p.length;i+=3){su+=p[i+A[0]];sv+=p[i+A[1]];cnt++;}}
  const Cu=su/cnt, Cv=sv/cnt;                                          // Querschnitt-Schwerpunkt
  const g=(p,i)=>[p[i*3],p[i*3+1],p[i*3+2]];
  const tris=[]; let rsum=0,rn=0;
  for(const m of meshes){const pos=m.pos,idx=m.idx;if(!idx)continue;
    for(let t=0;t<idx.length;t+=3){const a=g(pos,idx[t]),b=g(pos,idx[t+1]),c=g(pos,idx[t+2]);
      let nx=(b[1]-a[1])*(c[2]-a[2])-(b[2]-a[2])*(c[1]-a[1]),ny=(b[2]-a[2])*(c[0]-a[0])-(b[0]-a[0])*(c[2]-a[2]),nz=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
      const L=Math.hypot(nx,ny,nz);if(L<1e-9)continue; const nn=[nx,ny,nz];
      const mu=(a[A[0]]+b[A[0]]+c[A[0]])/3-Cu, mv=(a[A[1]]+b[A[1]]+c[A[1]])/3-Cv, rl=Math.hypot(mu,mv)||1;
      const dotR=(nn[A[0]]*mu+nn[A[1]]*mv)/(L*rl);
      if(dotR<0.3) continue;                                           // nur klar nach außen zeigende Außenhaut
      rsum+=rl; rn++; tris.push([a,b,c]);
    }}
  if(tris.length<10) return null;
  const R=rsum/rn;
  const ang=P=>Math.atan2(P[A[1]]-Cv, P[A[0]]-Cu);
  const allTh=[]; for(const tr of tris)for(const P of tr)allTh.push(ang(P));
  allTh.sort((x,y)=>x-y);
  let gap=-1,gapAt=allTh[0]; for(let i=1;i<allTh.length;i++){const d=allTh[i]-allTh[i-1];if(d>gap){gap=d;gapAt=allTh[i];}}
  const wrapGap=(allTh[0]+2*Math.PI)-allTh[allTh.length-1]; if(wrapGap>gap){gap=wrapGap;gapAt=allTh[0];}
  const th0=gapAt; const norm=th=>{let d=th-th0; while(d<0)d+=2*Math.PI; while(d>=2*Math.PI)d-=2*Math.PI; return d;};
  const map=P=>({x:P[AL], y:norm(ang(P))*R});
  const loops=loops2D(tris.map(tr=>({a:map(tr[0]),b:map(tr[1]),c:map(tr[2])}))); if(!loops.length) return null;
  let mnx=1e18,mny=1e18,mxx=-1e18,mxy=-1e18;
  loops.forEach(lp=>lp.forEach(p=>{if(p.x<mnx)mnx=p.x;if(p.y<mny)mny=p.y;if(p.x>mxx)mxx=p.x;if(p.y>mxy)mxy=p.y;}));
  const w=mxx-mnx||1,h=mxy-mny||1;
  if(blankArea>0){ const ratio=(w*h)/blankArea; if(ratio<0.6||ratio>1.8) return null; }   // muss zur Blechfläche passen
  loops.sort((a,b)=>shoelace(b)-shoelace(a));
  let d=''; loops.forEach(lp=>{lp.forEach((p,i)=>{d+=(i?'L':'M')+((p.x-mnx)/w).toFixed(4)+' '+((mxy-p.y)/h).toFixed(4)+' ';});d+='Z ';});
  return {path:d, w, h, R:Math.round(R), loops:loops.length, devW:Math.round(h)};
 }catch(e){ console.warn('unroll',e); return null; }
}
// Skyline-Packer (bottom-left) – füllt freie Flächen dicht, große Teile zuerst, kleine in die Lücken
function packSheets(items, sheetW, sheetH){
  const list=items.slice().sort((a,b)=> (b.w*b.h)-(a.w*a.h) || b.h-a.h);
  const sheets=[];
  const newSheet=()=>{ const s={rects:[], sky:[{x:0,y:0,w:sheetW}]}; sheets.push(s); return s; };
  function findPos(s,w,h){ const sl=s.sky; let best=null;
    for(let i=0;i<sl.length;i++){ const x=sl[i].x; if(x+w>sheetW+0.01) continue;
      let y=0, wsum=0, j=i;
      while(j<sl.length && wsum<w-0.01){ if(sl[j].y>y)y=sl[j].y; wsum+=sl[j].w; j++; }
      if(wsum<w-0.01) continue; if(y+h>sheetH+0.01) continue;
      if(!best || y<best.y-0.01 || (Math.abs(y-best.y)<=0.01 && x<best.x)) best={x,y};
    }
    return best;
  }
  function placeSky(s,x,y,w,h){ const ny=y+h, nx2=x+w; const res=[];
    for(const seg of s.sky){ const a=seg.x,b=seg.x+seg.w;
      if(b<=x+0.001||a>=nx2-0.001){ res.push(seg); continue; }
      if(a<x) res.push({x:a,y:seg.y,w:x-a});
      if(b>nx2) res.push({x:nx2,y:seg.y,w:b-nx2});
    }
    res.push({x,y:ny,w}); res.sort((p,q)=>p.x-q.x);
    const mg=[]; for(const seg of res){ const l=mg[mg.length-1]; if(l&&Math.abs(l.y-seg.y)<0.01&&Math.abs(l.x+l.w-seg.x)<0.01) l.w+=seg.w; else mg.push({x:seg.x,y:seg.y,w:seg.w}); }
    s.sky=mg;
  }
  const place=(s,it,x,y,w,h,rot)=>{ const si=sheets.indexOf(s); s.rects.push({x,y,w,h,rot,label:it.label,pi:it.pi,it}); if(it){it._sheet=si;it._x=x;it._y=y;} placeSky(s,x,y,w,h); };
  const tryFit=(sh,it)=>{ let w=it.w,h=it.h; let pos=findPos(sh,w,h); if(pos) return {pos,w,h,rot:false};
    const p2=findPos(sh,h,w); if(p2) return {pos:p2,w:h,h:w,rot:true}; return null; };
  newSheet();
  for(const it of list){
    let done=false;
    for(const sh of sheets){ const f=tryFit(sh,it); if(f){ place(sh,it,f.pos.x,f.pos.y,f.w,f.h,f.rot); done=true; break; } } // erst Lücken bestehender Tafeln füllen
    if(!done){ const ns=newSheet(); const f=tryFit(ns,it)||{pos:{x:0,y:0},w:it.w,h:it.h,rot:false}; place(ns,it,f.pos.x,f.pos.y,f.w,f.h,f.rot); }
  }
  for(const sh of sheets){
    sh.usedX=sh.rects.length?Math.max(...sh.rects.map(r=>r.x+r.w)):0;
    sh.usedY=sh.rects.length?Math.max(...sh.rects.map(r=>r.y+r.h)):0;
    sh.usedArea=sh.rects.reduce((a,r)=>a+r.w*r.h,0);
  }
  return sheets;
}
// ---------- Echte Konturschachtelung (Raster/Heightmap mit Drehung) ----------
const NEST_CELL=4;                    // mm je Rasterzelle (Genauigkeit vs. Tempo)
const NEST_ANGLE_SETS={fast:[0,90], med:[0,45,90], fine:[0,10,20,30,40,50,60,70,80,90]};
let NEST_MODE='fast';                 // Schachtel-Modus (per Einstellung änderbar)
let NEST_ANGLES=NEST_ANGLE_SETS[NEST_MODE];   // Drehwinkel (Grad) – mehr Winkel helfen v. a. asymmetrischen Teilen, sind aber langsamer
let _nestCanvas=null;
function nestCanvas(){ if(!_nestCanvas) _nestCanvas=document.createElement('canvas'); return _nestCanvas; }
// Min-Ecke + Groesse des Bounding-Rechtecks einer w×h-Box, gedreht um ihren Mittelpunkt (lineare Einheit egal: mm oder px)
function rotBoxMin(w,h,deg){ const a=deg*Math.PI/180,ca=Math.cos(a),sa=Math.sin(a),cx=w/2,cy=h/2;
  let mnx=1e18,mny=1e18,mxx=-1e18,mxy=-1e18;
  [[0,0],[w,0],[w,h],[0,h]].forEach(([x,y])=>{ const dx=x-cx,dy=y-cy,rx=cx+dx*ca-dy*sa,ry=cy+dx*sa+dy*ca;
    if(rx<mnx)mnx=rx;if(ry<mny)mny=ry;if(rx>mxx)mxx=rx;if(ry>mxy)mxy=ry; });
  return {mnx,mny,W:mxx-mnx,H:mxy-mny}; }
// Belegungsmaske (Spaltenprofile lo/hi je Spalte) aus echter Kontur, gedreht, inkl. Teileabstand
function maskFromContour(contourNorm,wmm,hmm,deg,cell,gapMM){
  const r=rotBoxMin(wmm,hmm,deg);
  const cols=Math.max(1,Math.ceil(r.W/cell)), rows=Math.max(1,Math.ceil(r.H/cell));
  const cv=nestCanvas(); cv.width=cols; cv.height=rows;
  const ctx=cv.getContext('2d',{willReadFrequently:true});
  ctx.clearRect(0,0,cols,rows); ctx.fillStyle='#000';
  ctx.save();
  ctx.translate(-r.mnx/cell,-r.mny/cell);          // gedrehtes Bounding-Min -> 0
  ctx.translate((wmm/2)/cell,(hmm/2)/cell); ctx.rotate(deg*Math.PI/180); ctx.translate(-(wmm/2)/cell,-(hmm/2)/cell);
  ctx.scale(wmm/cell,hmm/cell);                     // [0,1]-Pfad -> Zellen
  const d=(contourNorm&&contourNorm.length>8)?contourNorm:'M0 0L1 0L1 1L0 1Z';
  try{ ctx.fill(new Path2D(d),'evenodd'); }catch(e){ ctx.fillRect(0,0,1,1); }
  ctx.restore();
  const img=ctx.getImageData(0,0,cols,rows).data;
  const bits=new Uint8Array(cols*rows);
  for(let i=0,j=3;i<cols*rows;i++,j+=4) if(img[j]>40) bits[i]=1;
  const g=Math.max(0,Math.round(gapMM/cell)); let mask=bits;
  if(g>0){ const dd=new Uint8Array(cols*rows);
    for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){ if(!bits[y*cols+x])continue;
      for(let dy=-g;dy<=g;dy++){ const ny=y+dy; if(ny<0||ny>=rows)continue; const xr=g-Math.abs(dy);
        for(let dx=-xr;dx<=xr;dx++){ const nx=x+dx; if(nx<0||nx>=cols)continue; dd[ny*cols+nx]=1; } } }
    mask=dd; }
  const lo=new Int32Array(cols).fill(-1), hi=new Int32Array(cols).fill(-1);
  for(let x=0;x<cols;x++){ for(let y=0;y<rows;y++) if(mask[y*cols+x]){lo[x]=y;break;}
    for(let y=rows-1;y>=0;y--) if(mask[y*cols+x]){hi[x]=y;break;} }
  return {cols,rows,lo,hi};
}
// Punkt (px,py) im unrotierten Footprint -> Sheet-Koordinate (beruecksichtigt Drehung des Teils)
function footPointToSheet(it,px,py){ const deg=it._rot||0;
  if(!deg) return {x:it._x+px, y:it._y+py};
  const a=deg*Math.PI/180,ca=Math.cos(a),sa=Math.sin(a),cx=it.fpw/2,cy=it.fph/2;
  const rx=cx+(px-cx)*ca-(py-cy)*sa, ry=cy+(px-cx)*sa+(py-cy)*ca;
  const rb=rotBoxMin(it.fpw,it.fph,deg);
  return {x:it._x+(rx-rb.mnx), y:it._y+(ry-rb.mny)}; }
// Bottom-Left "Tetris-Drop" ueber Heightmap, First-Fit ueber alle Tafeln, mit Drehung
function packTrueShapeGroup(items, gap){
  const cell=NEST_CELL, angles=NEST_ANGLES;
  const SC=Math.ceil(SHEET_W/cell), SR=Math.ceil(SHEET_H/cell);
  const maskCache=new Map();
  const maskFor=(it,deg)=>{ const key=it.pi+'@'+deg; let m=maskCache.get(key);
    if(!m){ m=maskFromContour(it.contourNorm,it.fpw,it.fph,deg,cell,gap); maskCache.set(key,m); } return m; };
  const sheets=[]; const newSheet=()=>{ const s={rects:[],colTop:new Int32Array(SC).fill(0)}; sheets.push(s); return s; };
  // Tiefste Fallposition (Bottom-Left); Höhe = rows (konstant je Maske) → kein zweiter Loop nötig
  function drop(s,m,minTop){ const {cols,rows,lo}=m; if(cols>SC||minTop+rows>SR) return null;
    const ct=s.colTop, maxBase=SR-rows; let bx=-1, bb=1e9;
    for(let x=0;x+cols<=SC;x++){ let baseY=0;
      for(let c=0;c<cols;c++){ const l=lo[c]; if(l<0)continue; const need=ct[x+c]-l; if(need>baseY)baseY=need; }
      if(baseY>maxBase) continue;
      if(baseY<bb){ bb=baseY; bx=x; if(baseY===0) break; } }   // 0 ist optimal → Früh-Abbruch (links zuerst)
    return bx<0 ? null : {x:bx, baseY:bb, top:bb+rows-1}; }
  const minTopOf=s=>{ const ct=s.colTop; let mn=SR; for(let i=0;i<SC;i++){ const v=ct[i]; if(v<mn){ mn=v; if(mn===0)return 0; } } return mn; };
  const list=items.slice().sort((a,b)=>b.area-a.area);   // grosse zuerst, kleine fuellen Luecken
  newSheet();
  for(const it of list){ let chosen=null; const angs=it.walzAngles||angles;   // Walzrichtung schränkt Winkel ein
    for(const s of sheets){ const mt=minTopOf(s);
      for(const deg of angs){ const m=maskFor(it,deg); const d=drop(s,m,mt);
        if(d&&(!chosen||d.baseY<chosen.baseY||(d.baseY===chosen.baseY&&d.top<chosen.top))) chosen={s,m,deg,x:d.x,baseY:d.baseY,top:d.top}; }
      if(chosen) break; }   // First-Fit: erste Tafel, die das Teil aufnimmt
    if(!chosen){ const s=newSheet(); for(const deg of angs){ const m=maskFor(it,deg); const d=drop(s,m,0);
        if(d&&(!chosen||d.baseY<chosen.baseY)) chosen={s,m,deg,x:d.x,baseY:d.baseY,top:d.top}; }
      if(!chosen) continue; }   // Teil größer als Tafel
    const {s,m,deg,x,baseY}=chosen;
    for(let c=0;c<m.cols;c++) if(m.hi[c]>=0) s.colTop[x+c]=baseY+m.hi[c]+1;
    const xmm=x*cell, ymm=baseY*cell; const si=sheets.indexOf(s);
    s.rects.push({pi:it.pi,label:it.label,x:xmm,y:ymm,w:it.fpw,h:it.fph,rot:deg,it});
    it._sheet=si; it._x=xmm; it._y=ymm; it._rot=deg;
  }
  for(const s of sheets){ let mx=0,lastCol=0;
    for(let i=0;i<SC;i++){ if(s.colTop[i]>mx)mx=s.colTop[i]; if(s.colTop[i]>0)lastCol=i; }
    s.usedY=mx*cell; s.usedX=(lastCol+1)*cell;
    s.usedArea=s.rects.reduce((a,r)=>a+(r.it.faceArea||r.w*r.h),0);
  }
  return sheets;
}
// Schachtelung berechnen: gruppiert nach Werkstoff+Dicke (nur CAD-Teile)
function computeNesting(){
  PARTS.forEach(p=>{ p._matkUnit=null; });
  const groups={};
  PARTS.forEach((p,i)=>{
    if(p.source!=='dxf' && p.source!=='step') return;       // PDF: Plan ist bereits geschachtelt
    const fp=footprint(p); if(!fp||!(fp.w>0)||!(fp.h>0)) return;
    const key=p.material+' · '+fmt(p.dicke,2)+' mm';
    (groups[key]=groups[key]||{material:p.material,dicke:p.dicke,parts:[],items:[]});
    groups[key].parts.push(p);
    const gap=Math.max(1, Math.round(p.dicke));
    const menge=Math.max(1,parseInt(p.menge)||1);
    const holesMM=(p.holes||[]).map(h=>({x:h.x*fp.w, y:h.y*fp.h, w:h.w*fp.w, h:h.h*fp.h})); // Löcher in mm (rel. Footprint-Ecke)
    // echte Metallfläche (für Ausnutzung): DXF = Konturfläche, STEP = Volumen/Dicke (Abwicklung)
    const faceArea = p.source==='dxf' ? (p.area_m2||0)*1e6
                   : (p.source==='step' && p.dicke>0 ? (p.vol_m3*1e9)/p.dicke : fp.w*fp.h);
    // Walzrichtung schränkt die erlaubte Drehung ein: längs = 0°, quer = 90°, beliebig = freie Winkel
    const walzAngles = p.walz==='laengs' ? [0] : p.walz==='quer' ? [90] : null;
    // Biegeteil? (STEP, deutlich aus der Ebene heraus) → flache Abwicklung als Rechteck schachteln,
    // nicht die gebogene 3D-Kontur. Flache Teile (DXF/ungebogenes STEP) behalten ihre echte Kontur.
    const bent = p.source==='step' && p.bbox.dims && p.bbox.dims[0] > p.dicke*2.5;
    p._nestRect = bent;
    const nestContour = bent ? '' : p.contourNorm;
    for(let k=0;k<menge;k++) groups[key].items.push({pi:i, label:(i+1)+'', fpw:fp.w, fph:fp.h, w:fp.w+gap, h:fp.h+gap, area:fp.w*fp.h, holes:holesMM, contourNorm:nestContour, faceArea:faceArea>0?faceArea:fp.w*fp.h, walzAngles});
  });
  const out=[];
  for(const key in groups){
    const g=groups[key]; const gap=Math.max(1, Math.round(g.dicke));
    // --- Loch-Schachtelung: kleine Teile in Löcher größerer legen ---
    const insts=g.items.slice().sort((a,b)=>b.area-a.area);
    const availHoles=[]; const packList=[]; const nestedItems=[];
    for(const inst of insts){ inst._host=null; inst._holeOff=null;
      let placed=false;
      for(const hole of availHoles){ if(hole.used) continue;
        if(inst.w<=hole.w && inst.h<=hole.h){ hole.used=true; inst._host=hole.owner;
          inst._holeOff={dx:hole.x+(hole.w-inst.fpw)/2, dy:hole.y+(hole.h-inst.fph)/2}; placed=true; break; } }
      if(placed){ nestedItems.push(inst); }
      else { packList.push(inst);
        (inst.holes||[]).forEach(h=>{ if(h.w>=30&&h.h>=30) availHoles.push({owner:inst,x:h.x,y:h.y,w:h.w,h:h.h,used:false}); }); }
    }
    const sheets=packTrueShapeGroup(packList, gap);   // echte Konturschachtelung mit Drehung
    // genestete Teile aufs Blech ihres Hosts setzen (Loch-Offset inkl. Host-Drehung)
    for(const inst of nestedItems){ const host=inst._host; if(host && host._sheet!=null && sheets[host._sheet]){ const sh=sheets[host._sheet];
      const pos=footPointToSheet(host, inst._holeOff.dx, inst._holeOff.dy);
      (sh.nested=sh.nested||[]).push({pi:inst.pi, label:inst.label, x:pos.x, y:pos.y, w:inst.fpw, h:inst.fph, rot:0}); } }
    const nSheets=sheets.length;
    const last=sheets[nSheets-1];
    // Resttafel: Trennschnitt in die Richtung, die den größeren (nicht verrechneten) Rest lässt
    let lastFrac=1; last._cut=null;
    if(!RESTTAFEL_CHARGE){
      const ax=(last.usedX||0)*SHEET_H, ay=SHEET_W*(last.usedY||0);
      if(ax<=ay){ lastFrac=ax/(SHEET_W*SHEET_H); if(last.usedX<SHEET_W) last._cut={dir:'x',at:last.usedX}; }
      else      { lastFrac=ay/(SHEET_W*SHEET_H); if(last.usedY<SHEET_H) last._cut={dir:'y',at:last.usedY}; }
      lastFrac=Math.min(1,lastFrac);
    }
    const chargedSheets=(nSheets-1)+lastFrac;
    const dens=density(g.material), pr=matPrice(g.material).p;
    const sheetWeight=(SHEET_W*SHEET_H/1e6)*(g.dicke/1000)*dens;   // kg/Tafel
    const groupMatCost=chargedSheets*sheetWeight*pr;
    const totW=g.parts.reduce((a,p)=>a+p.gewicht*Math.max(1,parseInt(p.menge)||1),0);
    g.parts.forEach(p=>{ p._matkUnit = totW>0 ? groupMatCost*p.gewicht/totW : 0; });
    const usedArea=sheets.reduce((a,s)=>a+s.usedArea,0);
    const util= nSheets>0 ? Math.min(1, usedArea/(nSheets*SHEET_W*SHEET_H)) : 0;
    out.push({key, material:g.material, dicke:g.dicke, gap, sheets, nSheets, chargedSheets, sheetWeight, groupMatCost, util, parts:g.parts.length, items:g.items.length, nested:nestedItems.length});
  }
  NEST_RESULT=out;
  return out;
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
      else if(ext==='jupidu'){ const b=await parseBendJupidu(await f.arrayBuffer(), f.name); if(b) PENDING_BENDS.push(b); }
      else if(ext==='html'||ext==='htm'){ const b=parseBendHtml(await f.text(), f.name); if(b) PENDING_BENDS.push(b); }
      else toast('Nicht unterstützt: '+f.name);
    }catch(e){ console.error(e); toast('Fehler bei '+f.name+': '+e.message); }
  }
  applyPendingBends();
  showWork(); renderPositions(); recalc();
}
// --- Biegeprogramme (TruTops JUPIDU / HTML-Biegeplan) ---
function parseBendHtml(htmlText,name){
  const txt=htmlText.replace(/<[^>]+>/g,' ').replace(/&[a-zA-Z#0-9]+;/g,' ').replace(/\s+/g,' ');
  const bieg=[...txt.matchAll(/Biegung\s+(\d+)/g)].map(m=>+m[1]);
  const bends=bieg.length?Math.max(...bieg):0;
  const mat=(txt.match(/Material\s+([A-Za-z0-9.\-]+)/)||[])[1]||'';
  const dicke=numDe((txt.match(/Dicke\s+([\d.,]+)/)||[])[1]||'0');
  const dn=(txt.match(/([0-9]{5,8}_\d+)/)||[])[1] || name.replace(/\.(html?|jupidu)$/i,'').replace(/[._]?Bend\d+$/i,'');
  return {teilenr:dn, material:mat, dicke, bends, src:name};
}
async function parseBendJupidu(buf,name){
  try{ const zip=await JSZip.loadAsync(buf); const f=zip.file('BendingProgram/mainbendingprogram.json'); if(!f) return null;
    const j=JSON.parse(await f.async('string')); const bp=j.BendingProgram||{};
    const dn=(bp.DrawingNumber||bp.Name||name).replace(/[._]?Bend\d+$/i,'').replace(/[._]+$/,'');
    return {teilenr:dn, material:j.RawMaterialDinName||'', dicke:+j.SheetThickness||0, bends:(bp.BendingSteps||[]).length, src:name};
  }catch(e){ console.warn('jupidu',e); return null; }
}
function applyPendingBends(){
  const norm=s=>String(s||'').replace(/[._\s]+$/,'').replace(/\s+/g,'').toLowerCase();
  for(let k=PENDING_BENDS.length-1;k>=0;k--){ const b=PENDING_BENDS[k];
    const bn=norm(b.teilenr); if(!bn){ continue; }
    const part=PARTS.find(p=>{const pn=norm(p.teilenr); return pn&&(pn===bn||pn.startsWith(bn)||bn.startsWith(pn));});
    if(part){
      if(b.bends!=null){ part.biegungen=b.bends; part._autoBends=false; part._bendSrc=true; }
      if(b.material) part.material=normMaterial(b.material);
      if(b.dicke>0) part.dicke=b.dicke;
      if(part.source==='dxf'||part.source==='step') recomputeCad(part);
      toast(`Biegeprogramm ${part.teilenr}: ${b.bends} Biegung(en) · ${normMaterial(b.material||part.material)} · ${fmt(b.dicke||part.dicke,1)} mm`);
      PENDING_BENDS.splice(k,1);
    }
  }
}
function showWork(){ $('#dropArea').classList.add('hidden'); $('#posArea').classList.remove('hidden'); $('#sec-pos').scrollIntoView(); }
function clearList(){
  if(!PARTS.length) return;
  if(!confirm('Alle Positionen entfernen und neu starten?')) return;
  PARTS=[]; PDFDOC=null; PLANNAME=''; WERKSTOFF=''; DICKE=0;
  $('#posArea').classList.add('hidden'); $('#dropArea').classList.remove('hidden');
  $('#pdfbox')?.classList.add('hidden'); $('#planMeta').textContent='';
  renderPositions(); recalc(); $('#sec-pos').scrollIntoView();
  toast('Liste geleert.');
}
function deletePart(i){
  if(i<0||i>=PARTS.length) return;
  const p=PARTS[i]; PARTS.splice(i,1);
  // war es das letzte Teil eines geladenen PDF-Plans? PDF-Vorschau ausblenden, wenn keine PDF-Teile mehr da sind
  if(!PARTS.some(x=>x.source==='pdf')){ PDFDOC=null; $('#pdfbox')?.classList.add('hidden'); }
  if(!PARTS.length){ $('#posArea').classList.add('hidden'); $('#dropArea').classList.remove('hidden'); $('#planMeta').textContent=''; }
  renderPositions(); recalc();
  toast(`Position ${p.teilenr||''} gelöscht.`);
}

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
  const p={ teilenr:name.replace(/\.dxf$/i,''), source:'dxf', quelle:name, material:'1.4301 V2A',
    dicke:2, menge:1, biegungen:0, gewicht:0, einstech:g.pierces, auftrag:'',
    area_m2:g.area_m2, cutlen_mm:g.cutlen_mm, bbox:g.bbox, dxf:g.draw, laser_min:0, _autoLaser:true };
  const _dc=dxfContourNorm(g.draw,g.bbox); p.contourNorm=_dc.path; p.holes=_dc.holes;
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
function meshArea(pos,idx){ let A=0; const g=i=>[pos[i*3],pos[i*3+1],pos[i*3+2]];
  for(let t=0;t<idx.length;t+=3){ const a=g(idx[t]),b=g(idx[t+1]),c=g(idx[t+2]);
    const ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2], vx=c[0]-a[0],vy=c[1]-a[1],vz=c[2]-a[2];
    const cx=uy*vz-uz*vy,cy=uz*vx-ux*vz,cz=ux*vy-uy*vx; A+=0.5*Math.hypot(cx,cy,cz); }
  return A; }
// Blechdicke aus Volumen/Oberfläche (dünnwandig) -> auf Standarddicke runden
function snapThickness(t){ const std=[0.5,0.75,1,1.25,1.5,2,2.5,3,4,5,6,8,10,12,15,20,25];
  if(!(t>0)||t>26) return +(+t||2).toFixed(1);
  let best=std[0],bd=1e9; for(const s of std){const d=Math.abs(s-t); if(d<bd){bd=d;best=s;}} return best; }
// Biegungen aus STEP-Geometrie schätzen: Anzahl flacher Schenkel-Ausrichtungen − 1
function detectBends(meshes, dicke){
  const TOL=Math.cos(15*Math.PI/180); const clusters=[]; let total=0;
  for(const m of meshes){ const pos=m.pos, idx=m.idx; if(!idx) continue;
    const g=i=>[pos[i*3],pos[i*3+1],pos[i*3+2]];
    for(let t=0;t<idx.length;t+=3){
      const a=g(idx[t]),b=g(idx[t+1]),c=g(idx[t+2]);
      let nx=(b[1]-a[1])*(c[2]-a[2])-(b[2]-a[2])*(c[1]-a[1]);
      let ny=(b[2]-a[2])*(c[0]-a[0])-(b[0]-a[0])*(c[2]-a[2]);
      let nz=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
      const len=Math.hypot(nx,ny,nz); if(len<1e-9) continue;
      const area=0.5*len; total+=area; nx/=len;ny/=len;nz/=len;
      // n und -n als gleiche Achse behandeln (Ober-/Unterseite eines Schenkels)
      if(nz<-1e-6||(Math.abs(nz)<=1e-6&&(ny<-1e-6||(Math.abs(ny)<=1e-6&&nx<0)))){nx=-nx;ny=-ny;nz=-nz;}
      let f=false;
      for(const cl of clusters){ if(cl.ax*nx+cl.ay*ny+cl.az*nz>TOL){
        const w=cl.area+area; cl.ax=(cl.ax*cl.area+nx*area)/w; cl.ay=(cl.ay*cl.area+ny*area)/w; cl.az=(cl.az*cl.area+nz*area)/w;
        const ll=Math.hypot(cl.ax,cl.ay,cl.az)||1; cl.ax/=ll;cl.ay/=ll;cl.az/=ll; cl.area=w; cl.V.push(a,b,c); f=true; break; } }
      if(!f) clusters.push({ax:nx,ay:ny,az:nz,area,V:[a,b,c]});
    }
  }
  if(!clusters.length||total<=0) return 0;
  const maxA=Math.max(...clusters.map(c=>c.area)); const th=Math.max(1, dicke||1);
  // echtes Blech (Schenkel) = nennenswerte Fläche UND beidseitig ausgedehnt (kein dünnes Kantenband/Biegeradius)
  const isFlange=c=>{ if(c.area<=0.015*maxA) return false;
    const n={x:c.ax,y:c.ay,z:c.az}, {u,v}=planeBasis(n);
    let mnu=1e18,mxu=-1e18,mnv=1e18,mxv=-1e18;
    for(const P of c.V){ const U=P[0]*u.x+P[1]*u.y+P[2]*u.z, W=P[0]*v.x+P[1]*v.y+P[2]*v.z;
      if(U<mnu)mnu=U;if(U>mxu)mxu=U;if(W<mnv)mnv=W;if(W>mxv)mxv=W; }
    return Math.min(mxu-mnu, mxv-mnv) > th*3;
  };
  const flanges=clusters.filter(isFlange).length;
  return Math.max(0, flanges-1);
}
// Werkstoff aus STEP-Text lesen (falls vorhanden) und auf bekannte Bezeichnung normieren
function detectMaterialFromStep(text){
  if(!text) return '';
  let m=text.match(/MATERIAL[A-Z_]*\(\s*'([^']+)'/i);
  if(m) return m[1].trim();
  // STEP-Strings korrekt tokenisieren (leere ''/escapte '' beachten), Koordinaten ignorieren
  const labels=text.match(/'(?:''|[^'])*'/g)||[];
  const pats=[/1\.4\d{3}/, /1\.0\d{3}/, /S235\w*/i, /S355\w*/i, /DC0\d/i, /X\d+CrNi[\w-]*/i, /AlMg\d/i, /EN ?AW[- ]?\d+/i, /St(37|52)\b/i];
  for(const lab of labels){ const s=lab.slice(1,-1).trim();
    if(!s || s.length>60 || /[()#=]/.test(s)) continue;  // keine Geometrie-/Verweis-Strings
    for(const p of pats){ const mm=s.match(p); if(mm) return mm[0]; } }
  return '';
}
function normMaterial(raw){
  const s=(raw||'').toUpperCase();
  if(/1\.4404|1\.4571|X2CRNIMO|X6CRNIMOTI|V4A/.test(s)) return 'V4A';
  if(/1\.4301|X5CRNI18|V2A|1\.4\d{3}/.test(s)) return '1.4301 V2A';
  if(/HARDOX ?600/.test(s)) return 'Hardox 600';
  if(/HARDOX/.test(s)) return 'Hardox 500';
  if(/S355|1\.0577|ST52/.test(s)) return 'S355';
  if(/S235|1\.0038|ST37/.test(s)) return 'S235';
  if(/ALMG|EN ?AW|ALUMIN/.test(s)) return 'AlMg3';
  return raw.trim();
}
async function loadStep(buf,name){
  showLoad('STEP wird eingelesen … (große Baugruppen können dauern)');
  await new Promise(r=>setTimeout(r,30));
  try{
    const stepText=new TextDecoder('latin1').decode(new Uint8Array(buf));
    const matRaw=detectMaterialFromStep(stepText);
    const material=matRaw?normMaterial(matRaw):'1.4301 V2A';
    const occt=await ensureOcct();
    const r=occt.ReadStepFile(new Uint8Array(buf),null);
    if(!r||!r.success||!r.meshes||!r.meshes.length){ toast('STEP ohne darstellbare Volumenkörper: '+name); return; }
    let minX=Infinity,minY=Infinity,minZ=Infinity,maxX=-Infinity,maxY=-Infinity,maxZ=-Infinity,vol=0,area=0;
    const meshes=r.meshes.map(m=>{
      const pos=m.attributes.position.array, idx=m.index?m.index.array:null;
      for(let i=0;i<pos.length;i+=3){const x=pos[i],y=pos[i+1],z=pos[i+2];
        if(x<minX)minX=x;if(y<minY)minY=y;if(z<minZ)minZ=z;if(x>maxX)maxX=x;if(y>maxY)maxY=y;if(z>maxZ)maxZ=z;}
      if(idx){ vol+=meshVolume(pos,idx); area+=meshArea(pos,idx); }
      return {pos:Float32Array.from(pos), idx:idx?Uint32Array.from(idx):null, color:m.color};
    });
    const dims=[maxX-minX,maxY-minY,maxZ-minZ].sort((a,b)=>a-b);
    // Blechdicke aus Projektion auf die Hauptflächen-Normale (robust auch bei stark konturierten Teilen)
    const nrm=dominantNormal(meshes);
    let thRaw=sheetThickness(meshes,nrm);
    if(!(thRaw>0) || thRaw>dims[2]*1.05) thRaw=Math.min(area>0?2*vol/area:dims[0], dims[0]); // Fallback
    const dicke = snapThickness(thRaw);
    const bends=detectBends(meshes, dicke);
    // Schneidlänge aus Geometrie: Rand (Umfang × Dicke) = Oberfläche − 2·Blechfläche
    const blank = dicke>0 ? vol/dicke : 0;            // mm² Blechfläche (≈ V/t)
    let cutlen = dicke>0 ? (area - 2*blank)/dicke : 0; // mm Umfang inkl. Löcher
    if(!(cutlen>0)) cutlen=0;
    const p={ teilenr:name.replace(/\.(stp|step)$/i,''), source:'step', quelle:name, material,
      dicke, menge:1, biegungen:bends, _autoBends:true, gewicht:0, einstech:1, auftrag:'',
      cutlen_mm:cutlen, vol_m3:vol/1e9, area_m2:area/1e6, bbox:{minX,minY,minZ,maxX,maxY,maxZ,dims},
      step:meshes, laser_min:0, _autoLaser:true };
    const _sc=stepContourNorm(meshes,nrm); p.contourNorm=_sc.path; p.holes=_sc.holes;
    // Abwicklung für die Tafel-Darstellung: erst Zylinder-/Roll-Abwicklung (volle Kontur + alle Ausschnitte,
    // gegen die Blechfläche geprüft), sonst größte flache Fläche. Nur Darstellung; Preis bleibt das Rechteck.
    const _blankA = dicke>0 ? (vol/dicke) : 0;
    const _fl = unrollCylindrical(meshes, dicke, _blankA) || dominantFaceFlat(meshes, nrm);
    if(_fl && _fl.w>0 && _fl.h>0){ p._flatNorm=_fl.path; p._flatW=_fl.w; p._flatH=_fl.h; }
    recomputeCad(p); PARTS.push(p);
    toast(`STEP: ${p.teilenr} · ${fmt(dims[0],1)} mm · ${matRaw?('Werkstoff '+p.material):'kein Werkstoff in Datei → '+p.material}· ${bends} Biegung(en)`);
  } finally { hideLoad(); }
}

// ---------- Vorschau-Kacheln ----------
function dxfPathD(draw){
  let d='';
  for(const e of draw){
    if(e.t==='pl'){ e.pts.forEach((pt,k)=>{ d+=(k?'L':'M')+pt.x+' '+(-pt.y)+' '; }); if(e.closed)d+='Z '; }
    else if(e.t==='circle'){ const r=e.r,c=e.c; d+=`M ${c.x-r} ${-c.y} a ${r} ${r} 0 1 0 ${2*r} 0 a ${r} ${r} 0 1 0 ${-2*r} 0 `; }
    else if(e.t==='arc'){ const r=e.r,c=e.c; const x0=c.x+r*Math.cos(e.a0),y0=c.y+r*Math.sin(e.a0),x1=c.x+r*Math.cos(e.a1),y1=c.y+r*Math.sin(e.a1); let da=e.a1-e.a0;if(da<0)da+=2*Math.PI;const lg=da>Math.PI?1:0; d+=`M ${x0} ${-y0} A ${r} ${r} 0 ${lg} 0 ${x1} ${-y1} `; }
  }
  return d;
}
function dxfThumbSvg(p){
  const {minX,minY,w,h}=p.bbox; const pad=Math.max(w,h)*0.08||2; const sw=Math.max(w,h)/26||1;
  return `<svg viewBox="${minX-pad} ${-(minY+h)-pad} ${w+2*pad} ${h+2*pad}" preserveAspectRatio="xMidYMid meet"><path d="${dxfPathD(p.dxf)}" fill="none" stroke="#c00000" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
function makeStepThumb(p){
  if(p._thumb!==undefined) return p._thumb;
  try{
    const S=92;
    const r=new THREE.WebGLRenderer({antialias:true,alpha:true,preserveDrawingBuffer:true});
    r.setPixelRatio(2); r.setSize(S,S);
    const sc=new THREE.Scene();
    sc.add(new THREE.AmbientLight(0xffffff,0.6));
    sc.add(new THREE.HemisphereLight(0xffffff,0x6b7079,0.9));
    const l1=new THREE.DirectionalLight(0xffffff,0.85); l1.position.set(1,1.3,1.1); sc.add(l1);
    const l2=new THREE.DirectionalLight(0xffffff,0.45); l2.position.set(-1,-0.4,-1); sc.add(l2);
    const g=new THREE.Group();
    p.step.forEach(m=>{ const geo=new THREE.BufferGeometry(); geo.setAttribute('position',new THREE.BufferAttribute(m.pos,3)); if(m.idx)geo.setIndex(new THREE.BufferAttribute(m.idx,1)); geo.computeVertexNormals();
      const hc=m.color&&(m.color[0]+m.color[1]+m.color[2])>0.12; const col=hc?new THREE.Color(m.color[0],m.color[1],m.color[2]):new THREE.Color(0xb4bac1);
      g.add(new THREE.Mesh(geo,new THREE.MeshStandardMaterial({color:col,metalness:0.18,roughness:0.62,side:THREE.DoubleSide}))); });
    const box=new THREE.Box3().setFromObject(g),ctr=box.getCenter(new THREE.Vector3()),sz=box.getSize(new THREE.Vector3()); g.position.sub(ctr); sc.add(g);
    const cam=new THREE.PerspectiveCamera(45,1,0.01,1e7); const rad=Math.max(sz.x,sz.y,sz.z,1)*0.5; const d=rad/Math.sin((45*Math.PI/180)/2)*1.15; cam.near=d/100;cam.far=d*100;cam.updateProjectionMatrix(); cam.position.set(d*0.55,d*0.5,d*0.8); cam.lookAt(0,0,0);
    r.render(sc,cam); const url=r.domElement.toDataURL('image/png'); r.dispose();
    g.traverse(o=>{if(o.geometry)o.geometry.dispose();if(o.material)o.material.dispose();});
    p._thumb=url; return url;
  }catch(e){ console.error('thumb',e); p._thumb=null; return null; }
}
function phIcon(){ return `<svg class="ph" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>`; }
function thumbHtml(p){
  if(p.source==='dxf') return dxfThumbSvg(p);
  if(p.source==='step'){ const u=makeStepThumb(p); return u?`<img src="${u}" alt="">`:phIcon(); }
  return phIcon();
}

// ---------- Positionen ----------
function renderPositions(){
  computeNesting();
  const el=$('#poslist'); el.innerHTML='';
  PARTS.forEach((p,i)=>{
    const c=calc(p);
    const matOpts=Object.keys(MATERIAL).sort().map(m=>`<option ${m===p.material?'selected':''}>${m}</option>`).join('')+(p.material in MATERIAL?'':`<option selected>${p.material}</option>`);
    const badge=`<span class="srcbadge ${p.source}">${p.source}</span>`;
    const sub = p.source==='step' ? `${fmt(p.gewicht,2)} kg · ${fmt(p.cutlen_mm||0,0)} mm · ${fmt(p.laser_min,2)} min · 3D`
      : p.source==='dxf' ? `${fmt(p.gewicht,2)} kg · ${fmt(p.cutlen_mm,0)} mm · ${fmt(p.laser_min,2)} min`
      : `${fmt(p.gewicht,2)} kg · ${fmt(p.laser_min,2)} min${p.auftrag?' · '+p.auftrag:''}`;
    const viewBtn = (p.source==='step'||p.source==='dxf') ? `<button class="vbtn" data-view="${i}">👁 Ansehen</button>` : '';
    const w=p.walz||'egal';
    const walzSel = (p.source==='step'||p.source==='dxf') ? `<select class="walzsel" data-i="${i}" data-k="walz" title="Lage zur Walzrichtung beim Schachteln">
        <option value="egal"${w==='egal'?' selected':''}>↻ Lage beliebig</option>
        <option value="laengs"${w==='laengs'?' selected':''}>↕ Walzrichtung</option>
        <option value="quer"${w==='quer'?' selected':''}>↔ Gegen Walzrichtung</option></select>` : '';
    const delBtn = `<button class="delbtn" data-del="${i}" title="Diese Position löschen">✕</button>`;
    const row=document.createElement('div');
    row.className='posrow'+(!c.known&&p.gewicht>0?' warn':'');
    row.innerHTML=`
      <div class="pidx">${i+1}</div>
      <div class="nm"><div class="thumb">${thumbHtml(p)}</div><div class="nmtext"><b>${p.teilenr||'—'}${badge}</b><small>${sub}</small><div class="rowtools">${viewBtn}${walzSel}${delBtn}</div></div></div>
      <div class="mini mat"><label>Material</label><select data-i="${i}" data-k="material">${matOpts}</select></div>
      <div class="mini d"><label>Dicke mm</label><input data-i="${i}" data-k="dicke" value="${fmt(p.dicke,2)}"></div>
      <div class="mini m"><label>Menge</label><input data-i="${i}" data-k="menge" value="${c.menge}"></div>
      <div class="mini b"><label>Biegungen${p.source==='step'&&p._autoBends?' •':''}</label><input data-i="${i}" data-k="biegungen" value="${p.biegungen||0}" title="${p.source==='step'&&p._autoBends?'aus 3D automatisch erkannt – bitte prüfen':''}"></div>
      <div class="price kg" title="Verkaufspreis je kg (VK/St ÷ Gewicht)">${p.gewicht>0?eur(c.vk/p.gewicht):'–'}</div>
      <div class="price ep" title="Einzelpreis netto / Stück">${eur(c.vk)}</div>
      <div class="price" title="Gesamtpreis netto (${c.menge}× ${eur(c.vk)})">${eur(c.position)} ▾</div>`;
    row.title='Klicken für Kostenaufschlüsselung';
    el.appendChild(row);
    const det=document.createElement('div'); det.className='costsplit'+(p._open?' open':'');
    det.innerHTML=`<div class="cs-row">
      <div class="cs-item"><span class="k">Material</span><span class="v">${eur(c.matk)}</span></div>
      <div class="cs-item"><span class="k">Programmieren</span><span class="v">${eur(c.progk)}</span></div>
      <div class="cs-item"><span class="k">Rüsten</span><span class="v">${eur(c.ruestk)}</span></div>
      <div class="cs-item"><span class="k">Lasern</span><span class="v">${eur(c.laserk)}</span></div>
      <div class="cs-item"><span class="k">Biegen</span><span class="v">${eur(c.biegek)}</span></div>
      <div class="cs-sep"></div>
      <div class="cs-item dim"><span class="k">Selbstkosten/St</span><span class="v">${eur(c.selbstk)}</span></div>
      <div class="cs-item dim"><span class="k">VK/St +${fmt(PARAMS.marge,0)}%</span><span class="v">${eur(c.vk)}</span></div>
      <div class="cs-item tot"><span class="k">Gesamt ${c.menge}×</span><span class="v">${eur(c.position)}</span></div>
    </div><div class="cs-hint">Werte je Stück · Programmieren &amp; Rüsten auf Menge ${c.menge} verteilt${c.position>c.vk*c.menge+0.005?' · Mindestposition '+eur(PARAMS.min_pos):''}</div>
    <div class="cs-staffel"><div class="lbl">Staffelpreise (VK netto je Stück)</div><div class="qs">${
      [...new Set([1,5,10,25,50,c.menge])].sort((a,b)=>a-b).map(q=>{const u=unitVkAt(p,q);return `<div class="cs-q${q===c.menge?' cur':''}"><span class="qn">${q} Stück</span><span class="qp">${eur(u)}</span><span class="qg">= ${eur(u*q)}</span></div>`;}).join('')
    }</div></div>`;
    if(p._open) row.classList.add('open');
    el.appendChild(det);
    row.addEventListener('click',e=>{ if(e.target.closest('input,select,button')) return; p._open=!p._open; det.classList.toggle('open',p._open); row.classList.toggle('open',p._open); });
  });
  el.querySelectorAll('select[data-k],input[data-k]').forEach(inp=>{
    inp.onchange=e=>{
      const i=+e.target.dataset.i,k=e.target.dataset.k,v=e.target.value,p=PARTS[i];
      if(k==='menge') p[k]=Math.max(1,parseInt(v)||1);
      else if(k==='biegungen'){ p[k]=Math.max(0,parseInt(v)||0); p._autoBends=false; }
      else if(k==='dicke') p[k]=numDe(v);
      else p[k]=v;
      if(p.source==='dxf'||p.source==='step') recomputeCad(p);
      renderPositions(); recalc();
    };
  });
  el.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>openViewer(+b.dataset.view));
  el.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>deletePart(+b.dataset.del));
  $('#posCount').textContent=`${PARTS.length} Positionen`;
  if(!PDFDOC) $('#pdfbox')?.classList.add('hidden');
  renderNesting();
}
function recalc(){ $('#bPos').textContent=PARTS.length; $('#bStk').textContent=totalStk(); $('#bTotal').textContent=eur(grandTotal()); }

// Schachtelung visualisieren (Blechtafeln mit Teilen)
const NEST_COLORS=['#c00000','#1f6feb','#15803d','#a28231','#7c3aed','#0d9488','#b45309','#be185d'];
function buildSheetSvg(g,sh,si,W){
  const H=W*SHEET_H/SHEET_W, sx=W/SHEET_W, sy=H/SHEET_H;
  const cut=(si===g.nSheets-1 && sh._cut)?sh._cut:null;
  const fs=Math.max(7, W/42);   // Schriftgröße skaliert mit Tafelgröße
  let rects='';
  // x,y = Min-Ecke des GEDREHTEN Bounding (mm); wm,hm = unrotiertes Footprint (mm); deg = Drehwinkel
  const draw=(pi,x,y,wm,hm,deg,op,sw)=>{ const col=NEST_COLORS[pi%NEST_COLORS.length], pp=PARTS[pi];
    const Wp=wm*sx,Hp=hm*sy, cx=Wp/2, cy=Hp/2, rb=rotBoxMin(Wp,Hp,deg);
    const tx=x*sx-rb.mnx, ty=y*sy-rb.mny;
    // Biegeteile (_nestRect): saubere flache Hauptfläche (Außenrand + Ausschnitte), unverzerrt mittig im Slot.
    // Flache Teile: echte Kontur inkl. Löcher (füllt den Slot). Sonst: Rechteck.
    if(pp&&pp._nestRect&&pp._flatNorm&&pp._flatW>0&&pp._flatH>0){
      const fW=pp._flatW*sx, fH=pp._flatH*sy, fit=Math.min(Wp/fW,Hp/fH)||1;
      const dW=fW*fit, dH=fH*fit, oxp=(Wp-dW)/2, oyp=(Hp-dH)/2;
      rects+=`<path d="${pp._flatNorm}" transform="translate(${tx.toFixed(1)},${ty.toFixed(1)}) rotate(${deg} ${cx.toFixed(1)} ${cy.toFixed(1)}) translate(${oxp.toFixed(1)},${oyp.toFixed(1)}) scale(${dW.toFixed(2)},${dH.toFixed(2)})" fill="${col}" fill-opacity="${op}" fill-rule="evenodd" stroke="${col}" stroke-width="${sw}" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
    }
    else if(pp&&!pp._nestRect&&pp.contourNorm&&pp.contourNorm.length>8)
      rects+=`<path d="${pp.contourNorm}" transform="translate(${tx.toFixed(1)},${ty.toFixed(1)}) rotate(${deg} ${cx.toFixed(1)} ${cy.toFixed(1)}) scale(${Wp.toFixed(2)},${Hp.toFixed(2)})" fill="${col}" fill-opacity="${op}" fill-rule="evenodd" stroke="${col}" stroke-width="${sw}" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
    else rects+=`<rect x="${(x*sx).toFixed(1)}" y="${(y*sy).toFixed(1)}" width="${Math.max(1,rb.W-0.6).toFixed(1)}" height="${Math.max(1,rb.H-0.6).toFixed(1)}" fill="${col}" fill-opacity="${op}" stroke="${col}" stroke-width="0.7"/>`;
    if(rb.W>fs*1.6&&rb.H>fs*1.3) rects+=`<text x="${(x*sx+rb.W/2).toFixed(1)}" y="${(y*sy+rb.H/2+fs/3).toFixed(1)}" font-size="${fs.toFixed(1)}" text-anchor="middle" fill="${col}" font-family="monospace">${PARTS[pi]?(PARTS[pi]._lbl||''):''}</text>`;
  };
  sh.rects.forEach(r=>{ PARTS[r.pi]._lbl=r.label; draw(r.pi, r.x, r.y, r.w, r.h, r.rot||0, 0.20, 0.9); });
  (sh.nested||[]).forEach(nz=>{ PARTS[nz.pi]._lbl=nz.label; draw(nz.pi, nz.x, nz.y, nz.w, nz.h, nz.rot||0, 0.38, 1.1); });
  let restLabel=''; const lf=Math.max(7,W/55);
  if(cut){ if(cut.dir==='x'){ const cx=cut.at*sx; restLabel=`<line x1="${cx.toFixed(1)}" y1="0" x2="${cx.toFixed(1)}" y2="${H}" stroke="#16181a" stroke-width="1" stroke-dasharray="4 3"/><text x="${(cx+(W-cx)/2).toFixed(1)}" y="${(H/2).toFixed(1)}" font-size="${lf.toFixed(1)}" text-anchor="middle" fill="#9a9aa0" font-family="monospace">Rest</text>`; }
    else { const cy=cut.at*sy; restLabel=`<line x1="0" y1="${cy.toFixed(1)}" x2="${W}" y2="${cy.toFixed(1)}" stroke="#16181a" stroke-width="1" stroke-dasharray="4 3"/><text x="${(W/2).toFixed(1)}" y="${(cy+(H-cy)/2).toFixed(1)}" font-size="${lf.toFixed(1)}" text-anchor="middle" fill="#9a9aa0" font-family="monospace">Rest</text>`; } }
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H.toFixed(0)}"><rect x="0" y="0" width="${W}" height="${H.toFixed(1)}" fill="#fff" stroke="#c9c4ba" stroke-width="1"/>${rects}${restLabel}</svg>`;
}
function renderNesting(){
  const area=$('#nestArea'), box=$('#nestBox'); if(!area||!box) return;
  const groups=NEST_RESULT||[];
  if(!groups.length){ area.style.display='none'; box.innerHTML=''; return; }
  area.style.display='block'; $('#restCharge').checked=RESTTAFEL_CHARGE;
  let html='';
  groups.forEach((g,gi)=>{
    html+=`<div class="nestgroup"><div class="ngh">${g.material} · ${fmt(g.dicke,2)} mm`+
      `<span class="ngmeta">${g.items} Teile · ${g.nSheets} Tafel(n) · Ausnutzung ${fmt(g.util*100,0)} % · Abstand ${g.gap} mm${g.nested?' · '+g.nested+' in Löchern geschachtelt':''} · ${eur(g.groupMatCost)} Material</span></div><div class="ngsheets">`;
    g.sheets.forEach((sh,si)=>{ const cut=(si===g.nSheets-1&&sh._cut)?sh._cut:null;
      html+=`<div class="nsheet" data-g="${gi}" data-s="${si}" title="Zum Vergrößern klicken">${buildSheetSvg(g,sh,si,300)}`+
        `<div class="nscap">Tafel ${si+1} · ${fmt(Math.min(100,sh.usedArea/(SHEET_W*SHEET_H)*100),0)} %${cut?' · Trennschnitt':''} · 🔍 vergrößern</div></div>`;
    });
    html+=`</div></div>`;
  });
  box.innerHTML=html;
  box.querySelectorAll('.nsheet').forEach(el=>{ el.style.cursor='zoom-in'; el.onclick=()=>openSheetModal(+el.dataset.g,+el.dataset.s); });
}
function openSheetModal(gi,si){
  const g=(NEST_RESULT||[])[gi]; if(!g) return; const sh=g.sheets[si]; if(!sh) return;
  const W=Math.min(Math.max(600,window.innerWidth-60), 1280);
  const teile=sh.rects.length+(sh.nested?sh.nested.length:0);
  const m=document.createElement('div'); m.className='viewer'; m.id='sheetModal';
  m.innerHTML=`<div class="viewer-card" style="width:auto;max-width:97vw;height:auto;max-height:95vh">
    <div class="viewer-h"><h3>Tafel ${si+1} · ${g.material} · ${fmt(g.dicke,2)} mm</h3>
      <span class="meta">3000 × 1500 mm · ${teile} Teile · Belegung ${fmt(Math.min(100,sh.usedArea/(SHEET_W*SHEET_H)*100),0)} %</span>
      <button class="x">✕</button></div>
    <div class="viewer-body" style="background:#eceef0;padding:16px;overflow:auto;display:block">${buildSheetSvg(g,sh,si,W)}</div></div>`;
  document.body.appendChild(m);
  m.querySelector('.x').onclick=()=>m.remove(); m.onclick=e=>{ if(e.target===m) m.remove(); };
}

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
  const controls=new THREE.TrackballControls(cam,renderer.domElement);
  controls.rotateSpeed=3.4; controls.zoomSpeed=1.3; controls.panSpeed=0.8;
  controls.staticMoving=false; controls.dynamicDampingFactor=0.12;
  controls.target.set(0,0,0); controls.handleResize(); controls.update();
  let wire=false;
  const setCam=(x,y,z)=>{cam.up.set(0,1,0);cam.position.set(x,y,z);controls.target.set(0,0,0);controls.update();};
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
  const onResize=()=>{const r=body.getBoundingClientRect();const w=Math.max(40,r.width),h=Math.max(40,r.height);cam.aspect=w/h;cam.updateProjectionMatrix();renderer.setSize(w,h);controls.handleResize();};
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
  const map={
    p_laser:['laser_satz',2], p_abk:['abkant_satz',2], p_prog_satz:['prog_satz',2],
    p_marge:['marge',0], p_min:['min_pos',2],
    p_progmin:['prog_min',0], p_rl:['ruest_laser_min',0], p_rb:['ruest_biege_min',0],
    p_hand:['handling_s',0], p_tb:['t_biege_s',0], p_ovh:['laser_overhead',2]
  };
  for(const id in map){ const [key,dec]=map[id]; const el=$('#'+id); if(!el) continue;
    el.value=fmt(PARAMS[key],dec);
    el.onchange=()=>{ PARAMS[key]=numDe(el.value); PARTS.forEach(p=>{if(p.source==='dxf'||p.source==='step')recomputeCad(p);}); renderPositions(); recalc(); saveSettings(); }; }
  // Schachtel-Modus (Drehwinkel) – Umschalter
  const nm=$('#p_nestmode');
  if(nm){ nm.value=NEST_MODE;
    nm.onchange=()=>{ setNestMode(nm.value); if(PARTS.length){ showLoad('Schachtelung wird neu berechnet …'); setTimeout(()=>{ renderPositions(); recalc(); hideLoad(); },30); } saveSettings(); }; }
}

// ---------- Material-Dialog ----------
function openMaterial(){
  const rows=Object.entries(MATERIAL).sort().map(([m,p])=>`<tr><td><input class="mn" value="${m}"></td><td><input class="pr mp" value="${fmt(p,2)}"></td></tr>`).join('');
  const m=document.createElement('div'); m.className='modal';
  m.innerHTML=`<div class="modal-card"><div class="modal-h"><h3>Materialpreise · €/kg</h3><button>✕</button></div>
    <div class="modal-b"><table class="mtab"><thead><tr><th>Werkstoff</th><th>€/kg</th></tr></thead><tbody id="mb">${rows}</tbody></table>
    <button class="btn s" id="madd" style="margin-top:12px">＋ Material</button></div>
    <div class="modal-f"><button class="btn s" id="mreset" style="margin-right:auto">↺ Standard</button><button class="btn s" data-x>Abbrechen</button><button class="btn p" data-s>Speichern</button></div></div>`;
  document.body.appendChild(m);
  const close=()=>m.remove();
  m.querySelector('.modal-h button').onclick=close; m.querySelector('[data-x]').onclick=close; m.onclick=e=>{if(e.target===m)close();};
  m.querySelector('#madd').onclick=()=>{const tr=document.createElement('tr');tr.innerHTML=`<td><input class="mn"></td><td><input class="pr mp" value="0,00"></td>`;m.querySelector('#mb').appendChild(tr);};
  m.querySelector('#mreset').onclick=()=>{ if(confirm('Materialpreise und Sätze auf Standard zurücksetzen?')) resetSettings(); };
  m.querySelector('[data-s]').onclick=()=>{
    const ns=[...m.querySelectorAll('.mn')],ps=[...m.querySelectorAll('.mp')],nm={};
    ns.forEach((n,i)=>{const k=n.value.trim();if(k)nm[k]=numDe(ps[i].value);});
    for(const k in MATERIAL)delete MATERIAL[k]; Object.assign(MATERIAL,nm); saveSettings();
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
         <img src="logo.png" style="height:48px;width:auto" alt="Alzinger Maschinenbau">
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
  const head=['Pos','Teile-Nr','Quelle','Material','Dicke_mm','Menge','kg/St','Laser_min','Biegungen','Material_EUR','Programmieren_EUR','Ruesten_EUR','Lasern_EUR','Biegen_EUR','Selbstk_EUR','VK_EUR','Position_EUR'];
  const L=[head.join(';')];
  PARTS.forEach((p,i)=>{const c=calc(p);L.push([i+1,p.teilenr,p.source,p.material,fmt(p.dicke,2),c.menge,fmt(p.gewicht,3),fmt(p.laser_min,3),p.biegungen||0,fmt(c.matk),fmt(c.progk),fmt(c.ruestk),fmt(c.laserk),fmt(c.biegek),fmt(c.selbstk),fmt(c.vk),fmt(c.position)].join(';'));});
  const foot=new Array(head.length).fill(''); foot[15]='Gesamt'; foot[16]=fmt(grandTotal()); L.push(foot.join(';'));
  const blob=new Blob(['﻿'+L.join('\r\n')],{type:'text/csv;charset=utf-8'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=((PLANNAME||'Laser-Kalkulation').replace(/\.pdf$/i,''))+'.csv';a.click();
  toast('CSV exportiert.');
}

// ---------- Wiring ----------
$('#d_datum').value=new Date().toLocaleDateString('de-DE');
$('#drop').onclick=()=>$('#fileInput').click();
$('#reload').onclick=()=>$('#fileInput').click();
$('#addFile').onclick=()=>$('#fileInput').click();
$('#clearList').onclick=clearList;
$('#restCharge').onchange=e=>{ RESTTAFEL_CHARGE=e.target.checked; renderPositions(); recalc(); saveSettings(); };
$('#fileInput').onchange=e=>{handleFiles(e.target.files);e.target.value='';};
// Drag & Drop seitenweit – funktioniert auch wenn schon Teile geladen sind
let _dragDepth=0;
const _hasFiles=e=>!!(e.dataTransfer && Array.from(e.dataTransfer.types||[]).includes('Files'));
window.addEventListener('dragenter',e=>{ if(!_hasFiles(e))return; e.preventDefault(); _dragDepth++; $('#dropGlobal').classList.add('show'); });
window.addEventListener('dragover',e=>{ if(_hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave',e=>{ if(!_hasFiles(e))return; _dragDepth=Math.max(0,_dragDepth-1); if(!_dragDepth) $('#dropGlobal').classList.remove('show'); });
window.addEventListener('drop',e=>{ if(!_hasFiles(e))return; e.preventDefault(); _dragDepth=0; $('#dropGlobal').classList.remove('show'); if(e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });
$('#pgPrev').onclick=()=>renderPage(PAGE-1);
$('#pgNext').onclick=()=>renderPage(PAGE+1);
$('#zIn').onclick=()=>{SCALE=Math.min(3,SCALE+0.2);renderPage(PAGE);};
$('#zOut').onclick=()=>{SCALE=Math.max(0.5,SCALE-0.2);renderPage(PAGE);};
$('#btnMaterial').onclick=openMaterial;
// Einstellungs-Drawer (Hamburger-Menü)
const _drawer=$('#settingsDrawer'),_drawerOv=$('#drawerOv');
function toggleDrawer(open){ _drawer.classList.toggle('open',open); _drawerOv.classList.toggle('open',open); }
$('#burger').onclick=()=>toggleDrawer(!_drawer.classList.contains('open'));
$('#drawerClose').onclick=()=>toggleDrawer(false);
$('#drawerOv').onclick=()=>toggleDrawer(false);
$('#btnCsv').onclick=exportCsv;
$('#btnAngebot').onclick=()=>{ if(!PARTS.length){toast('Erst Dateien laden.');return;} openAngebot(); };
document.addEventListener('keydown',e=>{ if(e.key==='Escape'){ closeViewer(); $('#angebot')?.remove(); $('#sheetModal')?.remove(); toggleDrawer(false); } });
loadSettings();
bindParams();
window.__loadUrl=async url=>{const b=await(await fetch(url)).arrayBuffer();await loadPlan(b,url.split('/').pop());showWork();renderPositions();recalc();};
window.__loadDxfUrl=async url=>{const t=await(await fetch(url)).text();await loadDxf(t,url.split('/').pop());showWork();renderPositions();recalc();};
window.__loadStepUrl=async url=>{const b=await(await fetch(url)).arrayBuffer();await loadStep(b,url.split('/').pop());showWork();renderPositions();recalc();};
