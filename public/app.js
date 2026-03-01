'use strict';
const API      = '/api/v1';
const COMPASS  = ['N','NE','E','SE','S','SW','W','NW'];
const SUBWAY_TAGS    = new Set(['1','2','3','4']);
const STREETCAR_TAGS = new Set(['301','304','306','501','503','504','505','506','508','509','510','511','512','514']);
const LINE_COLORS    = { '1':'#FFCD00', '2':'#00A650', '3':'#0070C0', '4':'#800080' };

function rType(tag)  { return SUBWAY_TAGS.has(tag)?'subway':STREETCAR_TAGS.has(tag)?'streetcar':'bus'; }
function rCls(t)     { return t==='subway'?'s':t==='streetcar'?'t':'b'; }
function rEmoji(t)   { return t==='subway'?'🚇':t==='streetcar'?'🚋':'🚌'; }
function rLabel(t)   { return t==='subway'?'Subway':t==='streetcar'?'Streetcar':'Bus'; }

const TTC_INFO = {
  subway:`<div class="sec" style="margin-top:4px">Service info</div><div class="info-grid">
<div class="icard"><div class="icard-ic">🕐</div><div class="icard-lbl">Hours</div><div class="icard-val">~6:00 AM – 1:30 AM<br>Owl buses replace overnight</div></div>
<div class="icard"><div class="icard-ic">💳</div><div class="icard-lbl">Fare (2025)</div><div class="icard-val">PRESTO: $3.30<br>Cash: $3.35 · Monthly: $156</div></div>
<div class="icard"><div class="icard-ic">♿</div><div class="icard-lbl">Accessibility</div><div class="icard-val">All stations elevator-equipped<br>Tactile strips + audio PA</div></div>
<div class="icard"><div class="icard-ic">🔁</div><div class="icard-lbl">Transfers</div><div class="icard-val">Free within 2h same direction<br>Tap PRESTO on/off required</div></div>
</div>`,
  streetcar:`<div class="sec" style="margin-top:4px">Service info</div><div class="info-grid">
<div class="icard"><div class="icard-ic">🕐</div><div class="icard-lbl">Hours</div><div class="icard-val">Most routes: 24h service<br>Check ttc.ca for specifics</div></div>
<div class="icard"><div class="icard-ic">💳</div><div class="icard-lbl">Fare (2025)</div><div class="icard-val">PRESTO: $3.30<br>Cash: $3.35 · Day Pass: $14.50</div></div>
<div class="icard"><div class="icard-ic">♿</div><div class="icard-lbl">Accessibility</div><div class="icard-val">Low-floor Bombardier Flexity<br>All-door boarding, ramp avail.</div></div>
<div class="icard"><div class="icard-ic">🚦</div><div class="icard-lbl">Signal priority</div><div class="icard-val">TSP active on most downtown<br>streetcar corridors</div></div>
</div>`,
  bus:`<div class="sec" style="margin-top:4px">Service info</div><div class="info-grid">
<div class="icard"><div class="icard-ic">🕐</div><div class="icard-lbl">Hours</div><div class="icard-val">Varies by route<br>Owl routes run overnight</div></div>
<div class="icard"><div class="icard-ic">💳</div><div class="icard-lbl">Fare (2025)</div><div class="icard-val">PRESTO: $3.30<br>Cash: $3.35 · 10-ride: $32.00</div></div>
<div class="icard"><div class="icard-ic">♿</div><div class="icard-lbl">Accessibility</div><div class="icard-val">Low-floor Nova / New Flyer<br>Kneeling + front-door ramp</div></div>
<div class="icard"><div class="icard-ic">🔁</div><div class="icard-lbl">Transfers</div><div class="icard-val">Free within 2h same direction<br>Tap PRESTO at every boarding</div></div>
</div>`,
};

// ── STATE ──────────────────────────────────────────────────────────────────
let map, tileLayer;
let vMarkers     = {};
let trailLayers  = {};
let bunchMarkers = [];
let shapeLayer   = null;
let stopMarkers  = [];
let userMarker   = null;

let allRoutes    = [];
let allVehicles  = {};
let allAlerts    = [];
let allBunching  = [];
let detailCache  = {};

let savedRoutes  = new Set(JSON.parse(localStorage.getItem('trackto-saved-routes')||'[]'));
let savedStops   = JSON.parse(localStorage.getItem('trackto-saved-stops')||'[]');
let layerOn      = { bus:true, streetcar:true, subway:true };
let showBunch    = false;
let currentView  = 'routes';
let currentTab   = 'all';
let selRoute     = null;
let selStop      = null;
let selVehicle   = null;
let trackedId    = null;
let isDark       = localStorage.getItem('trackto-theme')==='dark';
let lastTs       = 0;
let polling      = false;

// ── THEME ──────────────────────────────────────────────────────────────────
function applyTheme() {
  document.documentElement.setAttribute('data-theme', isDark?'dark':'light');
  document.getElementById('theme-btn').textContent = isDark?'☀️':'🌙';
  if (tileLayer) tileLayer.setUrl(isDark
    ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png');
}
function toggleTheme() { isDark=!isDark; localStorage.setItem('trackto-theme',isDark?'dark':'light'); applyTheme(); }

// ── BOOT ──────────────────────────────────────────────────────────────────
function boot() {
  map = L.map('map',{zoomControl:false}).setView([43.6532,-79.3832],12);
  tileLayer = L.tileLayer('',{subdomains:'abcd',maxZoom:20,
    attribution:'© <a href="https://openstreetmap.org/copyright">OSM</a> © <a href="https://carto.com/">CARTO</a>'
  }).addTo(map);
  L.control.zoom({position:'bottomright'}).addTo(map);
  applyTheme();
  fetchRoutes();
  fetchAlerts();
  startPoll();
  setInterval(fetchAlerts, 90000);
  setInterval(fetchBunching, 5000);
  setInterval(()=>{ if(selStop) loadArrivals(selStop); }, 20000);
  setInterval(refreshFavStops, 30000);
  buildAPIExplorer();
}

// ── POLL ──────────────────────────────────────────────────────────────────
function startPoll() { pollOnce(); setInterval(()=>{ if(!polling) pollOnce(); },1000); }

async function pollOnce() {
  polling=true;
  try {
    const url = lastTs ? `${API}/vehicles?since=${lastTs}` : `${API}/vehicles`;
    const d   = await fetch(url).then(r=>r.json());
    lastTs = d.ts;
    if (d.full) { allVehicles={}; for (const v of d.vehicles) allVehicles[v.id]=v; }
    else {
      for (const v of d.vehicles) allVehicles[v.id]=v;
      for (const id in allVehicles) if (allVehicles[id].age>300) delete allVehicles[id];
    }
    syncMarkers();
    updateHUD(d.total);
    document.getElementById('tstamp').textContent =
      new Date().toLocaleTimeString('en-CA',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
    if (trackedId && allVehicles[trackedId]) {
      const v=allVehicles[trackedId];
      map.panTo([v.lat,v.lng],{animate:true,duration:.3});
      fetchTrail(trackedId);
    }
    if (selVehicle && allVehicles[selVehicle.id]) { selVehicle=allVehicles[selVehicle.id]; renderVD(selVehicle); }
    if (currentTab==='all'&&currentView==='routes'&&!dpOpen()) liveUpdateList();
    if (dpOpen()&&selRoute) updateDetailStats();
    if (currentTab==='bunch') renderBunchingPanel();
  } catch {}
  finally { polling=false; }
}

// ── VEHICLE TRAIL ─────────────────────────────────────────────────────────
async function fetchTrail(id) {
  try {
    const d = await fetch(`${API}/vehicles/trail?id=${id}`).then(r=>r.json());
    if (!d.ok || !d.trail?.length) return;
    if (trailLayers[id]) { map.removeLayer(trailLayers[id]); }
    const segs = [];
    const trail = d.trail;
    const v = allVehicles[id];
    if (!v) return;
    const allPts = [...trail.map(p=>[p[0],p[1]]), [v.lat,v.lng]];
    for (let i=0;i<allPts.length-1;i++) {
      const opacity = 0.2 + 0.6*(i/(allPts.length-1));
      const weight  = 2 + 2*(i/(allPts.length-1));
      segs.push(L.polyline([allPts[i],allPts[i+1]], {
        color: isDark?'#f05540':'#da291c',
        weight, opacity, className:'trail-seg'
      }));
    }
    trailLayers[id] = L.layerGroup(segs).addTo(map);
  } catch {}
}

function clearTrail(id) {
  if (trailLayers[id]) { map.removeLayer(trailLayers[id]); delete trailLayers[id]; }
}

// ── MARKERS ───────────────────────────────────────────────────────────────
function makeIcon(type, isSel) {
  const cfg={bus:{ring:'#da291c',bg:'rgba(218,41,28,.12)',e:'🚌'},streetcar:{ring:'#b45309',bg:'rgba(180,83,9,.12)',e:'🚋'},subway:{ring:'#b91c1c',bg:'rgba(185,28,28,.14)',e:'🚇'}};
  const c=cfg[type]||cfg.bus,sz=isSel?32:24,bw=isSel?'2.5px':'1.5px';
  const shadow=isSel?`0 0 0 3px ${c.ring}44, 0 2px 6px rgba(0,0,0,.25)`:'0 1px 4px rgba(0,0,0,.18)';
  return L.divIcon({className:'',html:`<div style="width:${sz}px;height:${sz}px;border-radius:50%;background:${c.bg};border:${bw} solid ${c.ring};display:flex;align-items:center;justify-content:center;font-size:${isSel?14:10}px;cursor:pointer;box-shadow:${shadow};transition:transform .1s" onmouseover="this.style.transform='scale(1.25)'" onmouseout="this.style.transform='scale(1)'">${c.e}</div>`,iconSize:[sz,sz],iconAnchor:[sz/2,sz/2]});
}

function syncMarkers() {
  const live=new Set(Object.keys(allVehicles));
  for (const id in vMarkers) {
    if (!live.has(id)||!layerOn[vMarkers[id].type]) { map.removeLayer(vMarkers[id].marker); delete vMarkers[id]; }
  }
  for (const id in allVehicles) {
    const v=allVehicles[id],type=rType(v.route);
    if (!layerOn[type]||!v.lat||!v.lng||isNaN(v.lat)||isNaN(v.lng)) continue;
    const isSel=selVehicle?.id===id;
    if (vMarkers[id]) {
      vMarkers[id].marker.setLatLng([v.lat,v.lng]);
      if (vMarkers[id].isSel!==isSel) { vMarkers[id].marker.setIcon(makeIcon(type,isSel)); vMarkers[id].marker.setZIndexOffset(isSel?1000:0); vMarkers[id].isSel=isSel; }
    } else {
      const m=L.marker([v.lat,v.lng],{icon:makeIcon(type,isSel),zIndexOffset:isSel?1000:0});
      m.on('click',()=>openVD(allVehicles[id]||v));
      m.addTo(map); vMarkers[id]={marker:m,type,isSel};
    }
  }
}

// ── BUNCHING ON MAP ────────────────────────────────────────────────────────
async function fetchBunching() {
  try {
    const d = await fetch(`${API}/bunching`).then(r=>r.json());
    allBunching = d.bunching || [];
    document.getElementById('cnt-bunch').textContent = allBunching.length;
    const btn = document.getElementById('fl-bunch');
    btn.classList.toggle('warn', allBunching.length > 0);
    if (showBunch) renderBunchMarkers();
    if (currentTab==='bunch') renderBunchingPanel();
  } catch {}
}

function renderBunchMarkers() {
  for (const m of bunchMarkers) map.removeLayer(m);
  bunchMarkers=[];
  if (!showBunch) return;
  for (const b of allBunching) {
    const icon=L.divIcon({className:'',html:`<div style="width:20px;height:20px;border-radius:50%;background:rgba(220,38,38,.9);border:2px solid #fff;box-shadow:0 0 0 3px rgba(220,38,38,.3),0 2px 6px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;font-size:10px;cursor:pointer">⚠</div>`,iconSize:[20,20],iconAnchor:[10,10]});
    const m=L.marker([b.lat,b.lng],{icon,zIndexOffset:500});
    m.bindPopup(`<div><strong>Bunching — Route ${b.route}</strong><br>Vehicles ${b.vehicles.join(' & ')}<br>${b.dist}m apart</div>`);
    m.addTo(map); bunchMarkers.push(m);
  }
}

function toggleBunchLayer() {
  showBunch=!showBunch;
  const btn=document.getElementById('fl-bunch');
  btn.classList.toggle('on',showBunch);
  renderBunchMarkers();
}

// ── HUD ───────────────────────────────────────────────────────────────────
function updateHUD(total) {
  const all=Object.values(allVehicles),c={bus:0,streetcar:0,subway:0};
  for (const v of all) c[rType(v.route)]=(c[rType(v.route)]||0)+1;
  document.getElementById('hv').textContent=total??all.length;
  document.getElementById('hr').textContent=allRoutes.length||'—';
  document.getElementById('hs').textContent=all.filter(v=>v.age>120).length;
  const mv=all.filter(v=>v.spd>0);
  document.getElementById('ha').textContent=mv.length?Math.round(mv.reduce((s,v)=>s+v.spd,0)/mv.length):'—';
  document.getElementById('cnt-bus').textContent=c.bus;
  document.getElementById('cnt-sc').textContent=c.streetcar;
  document.getElementById('cnt-sub').textContent=c.subway;
}

// ── API ────────────────────────────────────────────────────────────────────
async function apiFetch(path) { const r=await fetch(API+path); if(!r.ok)throw new Error(`HTTP ${r.status}`); return r.json(); }

async function fetchRoutes() {
  try { const d=await apiFetch('/routes'); allRoutes=d.routes||[]; renderRouteList(); document.getElementById('hr').textContent=allRoutes.length; }
  catch(e) { document.getElementById('p-all').innerHTML=`<div class="apierr">⚠ Server not responding.<br>Run: <code>node server.js</code><br>${e.message}</div>`; }
}

async function fetchAlerts() {
  try {
    const d=await apiFetch('/alerts'); allAlerts=d.alerts||[];
    const btn=document.getElementById('vb-alerts');
    btn.innerHTML=allAlerts.length?`Alerts <span class="badge">${allAlerts.length}</span>`:'Alerts';
    if (currentView==='alerts') renderAlerts();
  } catch {}
}

async function getDetail(tag) {
  if (detailCache[tag]) return detailCache[tag];
  const d=await apiFetch(`/route?tag=${tag}`);
  detailCache[tag]=d; return d;
}

// ── ROUTE LIST ────────────────────────────────────────────────────────────
function renderRouteList(q='') {
  document.getElementById('rl-spin')?.remove();
  const lq=q.toLowerCase();
  const match=r=>!lq||r.tag.includes(lq)||r.title.toLowerCase().includes(lq);
  const groups=[{label:'🚇 Subway',type:'subway'},{label:'🚋 Streetcar',type:'streetcar'},{label:'🚌 Bus',type:'bus'}];
  let html='';
  for (const g of groups) {
    const rows=allRoutes.filter(r=>rType(r.tag)===g.type&&match(r));
    if (rows.length) html+=`<div class="sec">${g.label}</div>`+rows.map(routeRowHTML).join('');
  }
  if (!html) html='<div class="empty"><div class="empty-ic">🔍</div>No routes match.</div>';
  document.getElementById('p-all').innerHTML=html;
}

function routeRowHTML(r) {
  const type=rType(r.tag);
  const vc=Object.values(allVehicles).filter(v=>v.route===r.tag).length;
  const hasAlert=allAlerts.some(a=>Array.isArray(a.routes)&&a.routes.includes(r.tag));
  const hasBunch=allBunching.some(b=>b.route===r.tag);
  const pill=vc>0?(hasBunch?`<span class="chip warn">BUNCH</span>`:`<span class="chip ok">LIVE</span>`):hasAlert?`<span class="chip warn">ALERT</span>`:`<span class="chip none">—</span>`;
  const sub=vc>0?`${vc} vehicle${vc>1?'s':''} live${hasBunch?' · bunching!':''}`:hasAlert?'Service alert':'No live data';
  return `<div class="rrow${selRoute===r.tag?' sel':''}" id="rr-${r.tag}" onclick="openDetail('${r.tag}')">
    <div class="rtag ${rCls(type)}">${r.tag}</div>
    <div class="rinfo"><div class="rname">${r.title}</div><div class="rsub" id="rsub-${r.tag}">${sub}</div></div>
    ${pill}
    <button class="star${savedRoutes.has(r.tag)?' on':''}" onclick="event.stopPropagation();toggleStarRoute('${r.tag}')" title="Save">★</button>
  </div>`;
}

function liveUpdateList() {
  for (const r of allRoutes) {
    const subEl=document.getElementById(`rsub-${r.tag}`); if(!subEl)continue;
    const vc=Object.values(allVehicles).filter(v=>v.route===r.tag).length;
    const hasBunch=allBunching.some(b=>b.route===r.tag);
    const hasAlert=allAlerts.some(a=>Array.isArray(a.routes)&&a.routes.includes(r.tag));
    subEl.textContent=vc>0?`${vc} vehicle${vc>1?'s':''} live${hasBunch?' · bunching!':''}`:hasAlert?'Service alert':'No live data';
  }
}

// ── ROUTE DETAIL ──────────────────────────────────────────────────────────
function dpOpen() { return document.getElementById('dp').classList.contains('on'); }

async function openDetail(tag) {
  selRoute=tag;
  document.querySelectorAll('.rrow').forEach(el=>el.classList.remove('sel'));
  document.getElementById(`rr-${tag}`)?.classList.add('sel');
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('on'));
  document.getElementById('dp').classList.add('on');
  document.getElementById('foot-wrap').style.display='';
  document.getElementById('dp-content').innerHTML='<div class="loader" style="padding:32px"><div class="spin"></div>Loading…</div>';
  try {
    const [detail, msgsD] = await Promise.all([getDetail(tag), apiFetch(`/messages?route=${tag}`).catch(()=>({messages:[]}))]);
    const msgs=msgsD.messages||[];
    const type=rType(tag), color=detail?.color||'#da291c';
    drawShape(detail,color); fitRoute(tag,detail);
    renderDetailHTML(detail,msgs,type,color,tag);
    showStops(detail?.stops||[]);
  } catch(e) {
    document.getElementById('dp-content').innerHTML=`<div class="apierr" style="margin:12px">⚠ ${e.message}</div>`;
  }
}

function renderDetailHTML(detail, msgs, type, color, tag) {
  const vc=Object.values(allVehicles).filter(v=>v.route===tag).length;
  const st=Object.values(allVehicles).filter(v=>v.route===tag&&v.age>120).length;
  const mv=Object.values(allVehicles).filter(v=>v.route===tag&&v.spd>0);
  const avgSp=mv.length?Math.round(mv.reduce((s,v)=>s+v.spd,0)/mv.length):0;
  const dirs=detail?.directions||[];
  const bunchesOnRoute=allBunching.filter(b=>b.route===tag);
  const bunchHtml=bunchesOnRoute.length
    ?`<div class="bunch-bar">⚠ ${bunchesOnRoute.length} bunching event${bunchesOnRoute.length>1?'s':''} detected — vehicles within ${bunchesOnRoute.map(b=>b.dist+'m').join(', ')} of each other</div>`:'';
  const alertsHtml=allAlerts.filter(a=>Array.isArray(a.routes)&&a.routes.includes(tag))
    .map(a=>`<div class="rdmsg warn">⚠ <strong>${a.title}</strong>${a.desc?'<br>'+a.desc:''}</div>`).join('');
  const msgsHtml=msgs.map(m=>m.text?`<div class="rdmsg info">📢 ${m.text}</div>`:'').join('');
  const dirTabsHtml=dirs.length>1?`<div class="dirtabs">${dirs.map((d,i)=>`<div class="dirtab${i===0?' on':''}" onclick="switchDir(${i},this)">${d.title}</div>`).join('')}</div>`:'';
  const firstDir=dirs[0], stopTags=firstDir?firstDir.stops:(detail?.stops||[]).map(s=>s.tag);

  document.getElementById('dp-content').innerHTML=`
    <div class="rdhero">
      <div class="rdtag" style="background:${color}22;color:${color}">${rEmoji(type)} ${tag}</div>
      <div class="rdtitle">${detail?.title||tag}</div>
      <div class="rdtype">${rLabel(type)}</div>
      <div class="rdstats">
        <div class="rdstat"><div class="rdstat-n" id="rds-v">${vc}</div><div class="rdstat-l">Vehicles</div></div>
        <div class="rdstat"><div class="rdstat-n" id="rds-s">${st}</div><div class="rdstat-l">Stale</div></div>
        <div class="rdstat"><div class="rdstat-n" id="rds-sp">${avgSp||'—'}</div><div class="rdstat-l">Avg km/h</div></div>
        <div class="rdstat"><div class="rdstat-n" id="rds-h">—</div><div class="rdstat-l">Headway</div></div>
        <div class="rdstat"><div class="rdstat-n">${detail?.stops?.length||'—'}</div><div class="rdstat-l">Stops</div></div>
        <div class="rdstat"><div class="rdstat-n">${dirs.length||'—'}</div><div class="rdstat-l">Directions</div></div>
      </div>
    </div>
    ${bunchHtml}${alertsHtml}${msgsHtml}
    ${TTC_INFO[type]}
    ${dirTabsHtml}
    ${stopTags.length?`<div class="sec">Stops${firstDir?` — ${firstDir.title}`:''} <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--mu)">(${stopTags.length})</span></div><div id="stop-list">${buildStopList(detail,stopTags)}</div>`
    :'<div class="empty" style="padding:16px"><div class="empty-ic">🔍</div>No stop data.</div>'}`;
  updateDetailStats();
}

function updateDetailStats() {
  if (!selRoute) return;
  const vc=Object.values(allVehicles).filter(v=>v.route===selRoute).length;
  const st=Object.values(allVehicles).filter(v=>v.route===selRoute&&v.age>120).length;
  const mv=Object.values(allVehicles).filter(v=>v.route===selRoute&&v.spd>0);
  const sp=mv.length?Math.round(mv.reduce((s,v)=>s+v.spd,0)/mv.length):0;
  const ve=document.getElementById('rds-v'),se=document.getElementById('rds-s'),
        spe=document.getElementById('rds-sp'),he=document.getElementById('rds-h');
  if(ve)ve.textContent=vc; if(se)se.textContent=st;
  if(spe)spe.textContent=sp||'—'; if(he)he.textContent=vc>1?`~${Math.round(60/vc)}m`:'—';
}

function buildStopList(detail, stopTags) {
  const sm={}; for (const s of (detail?.stops||[])) sm[s.tag]=s;
  return stopTags.map(tag=>{
    const s=sm[tag]; if(!s)return'';
    const title=s.title.replace(/'/g,"\\'");
    const isSaved=savedStops.some(x=>x.tag===s.tag);
    return `<div class="srow" id="srow-${s.tag}" onclick="selectStop('${s.tag}','${title}')">
      <div class="sdot"></div>
      <div class="sname">${s.title}</div>
      <div class="sid">#${s.stopId||s.tag}</div>
      <button class="star${isSaved?' on':''}" onclick="event.stopPropagation();toggleSaveStop('${s.tag}','${title}')" title="Save stop">★</button>
      <div class="sarr" id="sarr-${s.tag}">—</div>
    </div>`;
  }).join('');
}

function switchDir(idx, el) {
  document.querySelectorAll('.dirtab').forEach(t=>t.classList.remove('on')); el.classList.add('on');
  const detail=detailCache[selRoute]; if(!detail)return;
  const dir=detail.directions[idx]; if(!dir)return;
  document.getElementById('stop-list').innerHTML=buildStopList(detail,dir.stops);
  const secs=[...document.querySelectorAll('.sec')],last=secs[secs.length-1];
  if(last)last.innerHTML=`Stops — ${dir.title} <span style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--mu)">(${dir.stops.length})</span>`;
}

function closeDetail() {
  selRoute=null; clearShape(); clearStops(); resetArrivals();
  document.getElementById('dp').classList.remove('on');
  document.getElementById('foot-wrap').style.display='none';
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('on'));
  document.getElementById(`p-${currentTab}`)?.classList.add('on');
  document.querySelectorAll('.rrow').forEach(el=>el.classList.remove('sel'));
}

// ── SHAPE + STOPS ─────────────────────────────────────────────────────────
function drawShape(detail,color){clearShape();if(!detail?.paths?.length)return;shapeLayer=L.layerGroup(detail.paths.map(pts=>L.polyline(pts,{color,weight:3.5,opacity:.82,lineJoin:'round',lineCap:'round'}))).addTo(map);}
function clearShape(){if(shapeLayer){map.removeLayer(shapeLayer);shapeLayer=null;}}
function showStops(stops){
  clearStops();
  for(const s of stops){if(!s.lat||!s.lng||isNaN(s.lat)||isNaN(s.lng))continue;
    const icon=L.divIcon({className:'',html:`<div style="width:8px;height:8px;border-radius:50%;background:var(--sf);border:2px solid var(--ac);box-shadow:0 1px 3px rgba(0,0,0,.2);cursor:pointer"></div>`,iconSize:[8,8],iconAnchor:[4,4]});
    const m=L.marker([s.lat,s.lng],{icon,zIndexOffset:-100});
    m.on('click',()=>selectStop(s.tag,s.title)); m.addTo(map); stopMarkers.push(m);}
}
function clearStops(){for(const m of stopMarkers)map.removeLayer(m);stopMarkers=[];}
function fitRoute(tag,detail){
  const rv=Object.values(allVehicles).filter(v=>v.route===tag);
  if(rv.length>1){map.fitBounds(L.latLngBounds(rv.map(v=>[v.lat,v.lng])),{padding:[50,50],maxZoom:14});return;}
  const pts=(detail?.stops||[]).filter(s=>s.lat&&s.lng).map(s=>[s.lat,s.lng]);
  if(pts.length)map.fitBounds(L.latLngBounds(pts),{padding:[40,40],maxZoom:14});
}

// ── ARRIVALS ──────────────────────────────────────────────────────────────
async function selectStop(stopTag, stopTitle) {
  selStop=stopTag;
  document.querySelectorAll('.srow').forEach(r=>r.classList.remove('active'));
  document.getElementById(`srow-${stopTag}`)?.classList.add('active');
  document.getElementById('foot-stop').textContent=stopTitle||`Stop #${stopTag}`;
  document.getElementById('flive').style.display='';
  for(let i=0;i<4;i++){document.getElementById(`fn${i}`).textContent='…';document.getElementById(`fn${i}`).className='farr-n';}
  await loadArrivals(stopTag);
  const detail=detailCache[selRoute],stop=detail?.stops?.find(s=>s.tag===stopTag);
  if(stop)map.setView([stop.lat,stop.lng],Math.max(map.getZoom(),15));
}

async function loadArrivals(stopTag) {
  try {
    const url=selRoute?`/arrivals?stop=${stopTag}&route=${selRoute}`:`/arrivals?stop=${stopTag}`;
    const d=await apiFetch(url); const arrs=d.arrivals||[];
    for(let i=0;i<4;i++){
      const a=arrs[i],nEl=document.getElementById(`fn${i}`),dEl=document.getElementById(`fd${i}`),card=document.getElementById(`fa${i}`);
      if(a&&a.min!=null){const m=a.min;nEl.textContent=m===0?'Now':`${m}m`;nEl.className=`farr-n${m===0?' now':m<=3?' soon':''}`;dEl.textContent=a.dir?a.dir.replace(/^To /i,'→ '):'';card.classList.toggle('hi',m<=5);}
      else{nEl.textContent=a?.noPred?'N/A':'—';nEl.className='farr-n';dEl.textContent=a?.dir||'';card.classList.remove('hi');}
    }
    const inEl=document.getElementById(`sarr-${stopTag}`);
    if(inEl&&arrs[0]?.min!=null){const m=arrs[0].min;inEl.textContent=m===0?'Now':`${m}m`;inEl.className=`sarr${m===0?' now':m<=3?' soon':''}`;}
  } catch { for(let i=0;i<4;i++)document.getElementById(`fn${i}`).textContent='—'; }
}

function resetArrivals(){
  selStop=null; document.getElementById('foot-stop').textContent='Tap a stop for arrivals'; document.getElementById('flive').style.display='none';
  for(let i=0;i<4;i++){document.getElementById(`fn${i}`).textContent='—';document.getElementById(`fn${i}`).className='farr-n';document.getElementById(`fd${i}`).textContent='';document.getElementById(`fa${i}`).classList.remove('hi');}
  document.querySelectorAll('.srow').forEach(r=>r.classList.remove('active'));
}

// ── STOP SEARCH ────────────────────────────────────────────────────────────
async function searchStops() {
  const q = document.getElementById('stop-q').value.trim();
  if (!q) return;
  const res = document.getElementById('stop-results');
  res.innerHTML='<div class="loader" style="padding:20px"><div class="spin"></div>Searching…</div>';
  try {
    const isNum = /^\d+$/.test(q);
    const d = await fetch(`${API}/stops/search?${isNum?'id':'q'}=${encodeURIComponent(q)}`).then(r=>r.json());
    if (!d.ok) { res.innerHTML=`<div class="empty"><div class="empty-ic">🔍</div>${d.error?.message||'No results'}</div>`; return; }
    const stops=d.stops||[];
    if (!stops.length) { res.innerHTML='<div class="empty"><div class="empty-ic">🔍</div>No stops found.</div>'; return; }
    res.innerHTML=stops.map(s=>{
      const isSaved=savedStops.some(x=>x.tag===s.tag);
      return `<div class="srow" onclick="panToStop(${s.lat},${s.lng},'${s.tag}','${s.title.replace(/'/g,"\\'")}')">
        <div class="sdot"></div>
        <div class="sname">${s.title}</div>
        <div class="sid">#${s.stopId||s.tag}</div>
        <button class="star${isSaved?' on':''}" onclick="event.stopPropagation();toggleSaveStop('${s.tag}','${s.title.replace(/'/g,"\\'")}')">★</button>
        <div class="rsub" style="font-size:9px;color:var(--mu)">${(s.routes||[]).slice(0,4).join(', ')}</div>
      </div>`;
    }).join('');
  } catch(e) { res.innerHTML=`<div class="apierr">⚠ ${e.message}</div>`; }
}

function panToStop(lat, lng, tag, title) {
  map.setView([lat,lng],16);
  selectStop(tag, title);
  document.getElementById('foot-wrap').style.display='';
}

// ── SAVED STOPS DASHBOARD ─────────────────────────────────────────────────
function toggleSaveStop(tag, title) {
  const idx=savedStops.findIndex(x=>x.tag===tag);
  if (idx>=0) savedStops.splice(idx,1);
  else savedStops.push({tag, title, routes:[]});
  localStorage.setItem('trackto-saved-stops',JSON.stringify(savedStops));
  renderFavStops();
  document.querySelectorAll(`[onclick*="toggleSaveStop('${tag}"]`).forEach(btn=>{btn.classList.toggle('on',savedStops.some(x=>x.tag===tag));});
}

async function refreshFavStops() {
  if (!savedStops.length) return;
  await Promise.allSettled(savedStops.map(async s => {
    try {
      const d=await fetch(`${API}/arrivals?stop=${s.tag}`).then(r=>r.json());
      s._arrs=d.arrivals||[];
    } catch { s._arrs=[]; }
  }));
  renderFavStops();
}

function renderFavStops() {
  const empty=document.getElementById('fav-empty'),list=document.getElementById('fav-list');
  if (!savedStops.length) { empty.style.display=''; list.innerHTML=''; return; }
  empty.style.display='none';
  list.innerHTML=savedStops.map(s=>{
    const arrs=s._arrs||[];
    const arrHtml=arrs.slice(0,4).map(a=>{
      const m=a.min??null;
      const cls=m===0?'now':m!=null&&m<=3?'soon':'';
      return `<div class="fav-arr"><div class="fav-arr-n${cls?' '+cls:''}">${m===null?'—':m===0?'Now':m+'m'}</div><div class="fav-arr-r">${a.route||''}</div></div>`;
    }).join('') || '<div style="font-size:10px;color:var(--mu);padding:4px 0">No predictions</div>';
    return `<div class="fav-stop">
      <div class="fav-stop-info">
        <div class="fav-stop-name" onclick="panToStop(0,0,'${s.tag}','${s.title.replace(/'/g,"\\'")}');selectStop('${s.tag}','${s.title.replace(/'/g,"\\'")}')" style="cursor:pointer">${s.title}</div>
        <div class="fav-stop-routes">Stop #${s.tag}</div>
        <div class="fav-arrs">${arrHtml}</div>
      </div>
      <button class="fav-rm" onclick="toggleSaveStop('${s.tag}','${s.title.replace(/'/g,"\\'")}')" title="Remove">✕</button>
    </div>`;
  }).join('');
}

// ── ALERTS ────────────────────────────────────────────────────────────────
function renderAlerts(){
  document.getElementById('al-spin')?.remove();
  const p=document.getElementById('p-alerts');
  if(!allAlerts.length){p.innerHTML='<div class="empty"><div class="empty-ic">✅</div>No active alerts.</div>';return;}
  p.innerHTML=allAlerts.map(a=>{
    const cls=a.severity==='major'?'major':a.severity==='minor'?'minor':'info';
    const rStr=Array.isArray(a.routes)&&a.routes.length?'Routes: '+a.routes.slice(0,6).join(', ')+(a.routes.length>6?'…':''):'';
    const meta=[rStr,a.effect,a.cause].filter(Boolean).join(' · ');
    return `<div class="alert-row"><div class="adot ${cls}"></div><div>
      <div class="atitle">${a.title}</div>
      ${a.desc?`<div class="adesc">${a.desc}</div>`:''}
      ${meta?`<div class="ameta">${meta}</div>`:''}
      ${a.url?`<a class="aurl" href="${a.url}" target="_blank">More info →</a>`:''}
    </div></div>`;
  }).join('');
}

// ── SUBWAY STATUS ─────────────────────────────────────────────────────────
async function fetchSubwayStatus() {
  document.getElementById('sw-spin')?.remove();
  const p=document.getElementById('p-subway');
  try {
    const d=await fetch(`${API}/subway`).then(r=>r.json());
    const lines=d.lines||[];
    const LINE_C={'1':'#FFCD00','2':'#00A650','3':'#0070C0','4':'#800080'};
    p.innerHTML=lines.map(l=>{
      const sev=l.severity;
      const sevChip=sev==='ok'?'<span class="chip ok">Good service</span>':sev==='major'?'<span class="chip err">Major disruption</span>':sev==='minor'?'<span class="chip warn">Minor delays</span>':'<span class="chip info">Advisory</span>';
      const alertsHtml=l.alerts.map(a=>`<div class="sl-alert ${a.severity||'info'}">${a.title}${a.desc?'<br><span style="opacity:.8">'+a.desc+'</span>':''}</div>`).join('');
      return `<div class="subway-line">
        <div class="sl-head">
          <div class="sl-num" style="background:${LINE_C[l.tag]||'#999'};color:${l.tag==='1'?'#000':'#fff'}">${l.tag}</div>
          <div><div class="sl-name">Line ${l.tag} — ${l.name}</div>${sevChip}</div>
        </div>
        <div class="sl-stats">
          <span class="sl-stat">🚇 ${l.vehicles} vehicles</span>
          ${l.avgSpd?`<span class="sl-stat">⚡ ${l.avgSpd} km/h avg</span>`:''}
        </div>
        ${alertsHtml?`<div class="sl-alerts">${alertsHtml}</div>`:''}
      </div>`;
    }).join('');
  } catch(e) { p.innerHTML=`<div class="apierr">⚠ ${e.message}</div>`; }
}

// ── BUNCHING PANEL ────────────────────────────────────────────────────────
function renderBunchingPanel() {
  document.getElementById('bn-spin')?.remove();
  const list=document.getElementById('bn-list');
  list.style.display='block';
  if (!allBunching.length) {
    list.innerHTML='<div class="empty"><div class="empty-ic">✅</div>No bunching detected right now.</div>';
    return;
  }
  list.innerHTML=`<div class="sec">Bunching events — vehicles &lt;400m apart (${allBunching.length})</div>`+allBunching.map(b=>{
    const r=allRoutes.find(x=>x.tag===b.route);
    return `<div class="bunch-row" onclick="map.setView([${b.lat},${b.lng}],16);document.body.classList.remove('sl')">
      <div class="bunch-dot"></div>
      <div class="bunch-info">
        <div class="bunch-route">${rEmoji(rType(b.route))} Route ${b.route}${r?' — '+r.title:''}</div>
        <div class="bunch-detail">Vehicles ${b.vehicles.join(' & ')}</div>
      </div>
      <div class="bunch-dist">${b.dist}m</div>
    </div>`;
  }).join('');
}

// ── TRIP PLANNER ──────────────────────────────────────────────────────────
async function planTrip() {
  const from=document.getElementById('trip-from').value.trim();
  const to  =document.getElementById('trip-to').value.trim();
  if (!from||!to) return;
  const res=document.getElementById('trip-result');
  res.innerHTML='<div class="loader" style="padding:20px"><div class="spin"></div>Planning trip…</div>';
  try {
    const d=await fetch(`${API}/trip?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`).then(r=>r.json());
    if (!d.ok) { res.innerHTML=`<div class="apierr" style="margin:12px">⚠ ${d.error?.message||'Error'}</div>`; return; }
    let html=`<div class="trip-result">
      <div style="font-size:11px;color:var(--mu);margin-bottom:10px">
        <strong style="color:var(--st)">From:</strong> ${d.from?.title||from} (#${d.from?.tag||from})<br>
        <strong style="color:var(--st)">To:</strong> ${d.to?.title||to} (#${d.to?.tag||to})
      </div>`;
    if (d.direct?.length) {
      html+=`<div class="sec">Direct routes (${d.direct.length})</div>`;
      html+=d.direct.map(r=>{
        const type=rType(r.route);
        return `<div class="trip-route" onclick="openDetail('${r.route}')">
          <div class="trip-route-top">
            <span class="rtag ${rCls(type)}" style="width:32px;height:32px;border-radius:7px;font-size:9px">${r.route}</span>
            <span class="trip-route-nm">${r.routeTitle}</span>
            ${r.vehicles>0?`<span class="chip ok">${r.vehicles} live</span>`:'<span class="chip none">—</span>'}
          </div>
          <div class="trip-route-meta">
            ${r.direction?`<span>→ ${r.direction}</span>`:''}
            ${r.stops!=null?`<span>${r.stops} stops between</span>`:''}
          </div>
        </div>`;
      }).join('');
    }
    if (d.transfers?.length) {
      html+=`<div class="sec" style="margin-top:8px">Transfer options</div>`;
      html+=d.transfers.map(t=>{
        return `<div class="trip-route">
          <div class="trip-route-top">
            <span class="rtag b" style="width:32px;height:32px;border-radius:7px;font-size:9px">${t.from}</span>
            <span style="color:var(--mu);font-size:12px">→</span>
            <span class="rtag b" style="width:32px;height:32px;border-radius:7px;font-size:9px">${t.to}</span>
          </div>
          <div class="trip-route-meta"><span>Transfer at ${t.transferAt?.title||t.transferAt?.tag||'?'}</span></div>
        </div>`;
      }).join('');
    }
    if (!d.direct?.length&&!d.transfers?.length) {
      html+='<div class="empty"><div class="empty-ic">🤷</div>No routes found between these stops.</div>';
    }
    html+=`<div style="font-size:10px;color:var(--mu);margin-top:8px;padding:0 2px">${d.note||''}</div></div>`;
    res.innerHTML=html;
  } catch(e) { res.innerHTML=`<div class="apierr" style="margin:12px">⚠ ${e.message}</div>`; }
}

// ── SAVED ROUTES ──────────────────────────────────────────────────────────
function toggleStarRoute(tag) {
  savedRoutes.has(tag)?savedRoutes.delete(tag):savedRoutes.add(tag);
  localStorage.setItem('trackto-saved-routes',JSON.stringify([...savedRoutes]));
  renderRouteList(document.getElementById('searchInput').value);
}

// ── NEARBY ────────────────────────────────────────────────────────────────
async function initNearby() {
  const loader=document.getElementById('nb-spin'),list=document.getElementById('nb-list');
  if (!navigator.geolocation){loader.innerHTML='<div style="padding:20px;font-size:11px;color:var(--mu)">Location not supported.</div>';return;}
  loader.style.display='flex'; list.style.display='none';
  navigator.geolocation.getCurrentPosition(async pos=>{
    loader.style.display='none'; list.style.display='block';
    const {latitude:lat,longitude:lng}=pos.coords;
    if (!userMarker){userMarker=L.circleMarker([lat,lng],{radius:8,fillColor:isDark?'#f05540':'#da291c',color:'#fff',weight:2,fillOpacity:.9});userMarker.addTo(map).bindPopup('<strong>You are here</strong>');}
    else userMarker.setLatLng([lat,lng]);
    map.setView([lat,lng],14);
    try {
      const d=await fetch(`${API}/stops/nearby?lat=${lat}&lng=${lng}&radius=400&limit=15`).then(r=>r.json());
      const stops=d.stops||[];
      list.innerHTML=stops.length
        ?`<div class="sec">Stops within 400m</div>`+stops.map(s=>{
          const isSaved=savedStops.some(x=>x.tag===s.tag);
          return `<div class="srow" onclick="panToStop(${s.lat},${s.lng},'${s.tag}','${s.title.replace(/'/g,"\\'")}')">
            <div class="sdot"></div>
            <div class="sname">${s.title}</div>
            <div class="sid">#${s.stopId||s.tag}</div>
            <button class="star${isSaved?' on':''}" onclick="event.stopPropagation();toggleSaveStop('${s.tag}','${s.title.replace(/'/g,"\\'")}')" title="Save">★</button>
            <div class="rsub" style="font-size:9px;color:var(--mu)">${s.dist}m · ${(s.routes||[]).slice(0,3).join(', ')}</div>
          </div>`;
        }).join('')
        :'<div class="empty">No stops within 400m.</div>';
    } catch(e) { list.innerHTML=`<div class="apierr">⚠ ${e.message}</div>`; }
  },()=>{loader.innerHTML='<div style="padding:20px;font-size:11px;color:var(--mu)">Location denied.</div>';});
}

// ── VEHICLE DETAIL ─────────────────────────────────────────────────────────
function openVD(v) {
  selVehicle=v; renderVD(v);
  document.getElementById('vd').classList.add('show');
  map.setView([v.lat,v.lng],Math.max(map.getZoom(),15),{animate:true});
  if (vMarkers[v.id]){vMarkers[v.id].marker.setIcon(makeIcon(vMarkers[v.id].type,true));vMarkers[v.id].marker.setZIndexOffset(1000);vMarkers[v.id].isSel=true;}
}
function renderVD(v) {
  if(!v)return;
  const type=rType(v.route),route=allRoutes.find(r=>r.tag===v.route),detail=detailCache[v.route],stale=v.age>120;
  document.getElementById('vd-type').textContent=`${rLabel(type)} · Route ${v.route}`;
  document.getElementById('vd-name').textContent=route?route.title:`Vehicle ${v.id}`;
  const dirEl=document.getElementById('vd-dir');
  if(v.dir){const d=detail?.directions?.find(d=>d.tag===v.dir);dirEl.textContent=d?`→ ${d.title}`:`→ ${v.dir}`;dirEl.style.display='';}else dirEl.style.display='none';
  const spEl=document.getElementById('vd-spd');spEl.textContent=Math.round(v.spd||0);spEl.className=`vd-val${v.spd>15?' g':v.spd>0?'':' r'}`;
  document.getElementById('vd-hdg').textContent=COMPASS[Math.round((v.hdg||0)/45)%8];
  const stEl=document.getElementById('vd-st');
  stale?(stEl.textContent='Stale',stEl.className='vd-val a'):!v.pred?(stEl.textContent='No pred',stEl.className='vd-val a'):(stEl.textContent='Live',stEl.className='vd-val g');
  const ageEl=document.getElementById('vd-age');ageEl.textContent=v.age<60?`${v.age}s`:`${Math.floor(v.age/60)}m`;ageEl.className=`vd-val${stale?' a':''}`;
  const tb=document.getElementById('vd-track');tb.textContent=trackedId===v.id?'⏹ Stop':'📍 Track';tb.className=`vdbtn track${trackedId===v.id?' on':''}`;
}
function closeVD(){
  if(selVehicle&&vMarkers[selVehicle.id]){vMarkers[selVehicle.id].marker.setIcon(makeIcon(vMarkers[selVehicle.id].type,false));vMarkers[selVehicle.id].marker.setZIndexOffset(0);vMarkers[selVehicle.id].isSel=false;}
  clearTrail(selVehicle?.id);
  document.getElementById('vd').classList.remove('show'); trackedId=null; selVehicle=null;
}
function toggleTrack(){
  if(!selVehicle)return; trackedId=(trackedId===selVehicle.id)?null:selVehicle.id;
  if(trackedId)fetchTrail(trackedId); else clearTrail(selVehicle.id);
  renderVD(selVehicle);
}
async function vdGoRoute(){if(!selVehicle)return;const tag=selVehicle.route;closeVD();await openDetail(tag);}

// ── LAYER / LOCATE ─────────────────────────────────────────────────────────
function toggleLayer(type,btn){layerOn[type]=!layerOn[type];btn.classList.toggle('on',layerOn[type]);btn.classList.toggle('off',!layerOn[type]);syncMarkers();}
function locateMe(){navigator.geolocation.getCurrentPosition(pos=>map.setView([pos.coords.latitude,pos.coords.longitude],15),()=>{});}

// ── API EXPLORER ────────────────────────────────────────────────────────────
function buildAPIExplorer() {
  const endpoints=[
    {path:'/vehicles',      params:[{n:'since',ph:'timestamp or 0'},{n:'route',ph:'route tag e.g. 501'}], desc:'Live vehicle positions'},
    {path:'/vehicles/trail',params:[{n:'id',ph:'vehicle id e.g. 4231'}], desc:'Vehicle trail'},
    {path:'/routes',        params:[], desc:'All TTC routes'},
    {path:'/route',         params:[{n:'tag',ph:'e.g. 501'}], desc:'Route detail'},
    {path:'/arrivals',      params:[{n:'stop',ph:'stop tag/id'},{n:'route',ph:'optional'}], desc:'Arrival predictions'},
    {path:'/alerts',        params:[{n:'route',ph:'optional filter'}], desc:'Service alerts'},
    {path:'/bunching',      params:[{n:'route',ph:'optional'}], desc:'Bunching detection'},
    {path:'/subway',        params:[], desc:'Lines 1-4 status'},
    {path:'/stops/search',  params:[{n:'q',ph:'stop name'},{n:'id',ph:'or stop number'}], desc:'Search stops'},
    {path:'/stops/nearby',  params:[{n:'lat',ph:'43.6532'},{n:'lng',ph:'-79.3832'},{n:'radius',ph:'metres'}], desc:'Nearby stops'},
    {path:'/trip',          params:[{n:'from',ph:'stop tag'},{n:'to',ph:'stop tag'}], desc:'Trip planner'},
    {path:'/health',        params:[], desc:'API health'},
  ];

  const ex=document.getElementById('api-explorer');
  ex.innerHTML=endpoints.map((ep,i)=>{
    const paramHtml=ep.params.map(p=>`<div class="ep-param"><label>${p.n}</label><input id="ep-${i}-${p.n}" placeholder="${p.ph}" type="text"></div>`).join('');
    return `<div class="ep-card">
      <div class="ep-head" onclick="toggleEp(${i})">
        <span class="ep-method">GET</span>
        <span class="ep-path">/api/v1${ep.path}</span>
        <span class="ep-desc">${ep.desc}</span>
      </div>
      <div class="ep-body" id="epb-${i}">
        ${paramHtml?`<div class="ep-params">${paramHtml}</div>`:''}
        <button class="ep-run" onclick="runEp('${ep.path}',${i},[${ep.params.map(p=>`'${p.n}'`).join(',')}])">▶ Run</button>
        <div class="ep-result" id="epr-${i}"></div>
      </div>
    </div>`;
  }).join('');
}

function toggleEp(i) { const b=document.getElementById(`epb-${i}`); b.classList.toggle('open'); }

async function runEp(path, i, paramNames) {
  const q=paramNames.map(n=>{const v=document.getElementById(`ep-${i}-${n}`)?.value?.trim();return v?`${n}=${encodeURIComponent(v)}`:null;}).filter(Boolean).join('&');
  const url=`${API}${path}${q?'?'+q:''}`;
  const resultEl=document.getElementById(`epr-${i}`);
  resultEl.textContent='Loading…'; resultEl.classList.add('show');
  try {
    const r=await fetch(url); const d=await r.json();
    resultEl.textContent=JSON.stringify(d,null,2);
  } catch(e){ resultEl.textContent=`Error: ${e.message}`; }
}

// ── SEARCH / VIEW / TAB ────────────────────────────────────────────────────
function onSearch(q){if(currentView==='routes'&&!dpOpen())renderRouteList(q);}

function showView(v,btn){
  currentView=v;
  document.querySelectorAll('.hbtn').forEach(b=>b.classList.remove('on')); btn.classList.add('on');
  if(dpOpen())closeDetail();
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('on'));
  document.getElementById('tab-bar').style.display=v==='routes'?'':'none';
  if(v==='routes'){document.getElementById('tab-bar').style.display='';switchTab(currentTab,document.getElementById(`tab-${currentTab}`));}
  else if(v==='alerts'){document.getElementById('p-alerts').classList.add('on');renderAlerts();}
  else if(v==='subway'){document.getElementById('p-subway').classList.add('on');fetchSubwayStatus();}
  else if(v==='api'){document.getElementById('p-api').classList.add('on');}
  setTimeout(()=>map.invalidateSize(),280);
}

function switchTab(tab,el){
  currentTab=tab;
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('on'));
  document.getElementById('dp').classList.remove('on');
  el?.classList.add('on');
  document.getElementById(`p-${tab}`)?.classList.add('on');
  setTimeout(()=>map.invalidateSize(),280);
  if(tab==='nearby')initNearby();
  if(tab==='fav'){refreshFavStops();renderFavStops();}
  if(tab==='bunch'){renderBunchingPanel();document.getElementById('bn-spin')?.remove();}
}

// ── MOBILE ─────────────────────────────────────────────────────────────────
function mobileNav(view,btn){
  document.querySelectorAll('.mnb').forEach(b=>b.classList.remove('on')); btn.classList.add('on');
  if(view==='map'){document.body.classList.remove('sl');return;}
  document.body.classList.add('sl');
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('on'));
  document.getElementById('dp').classList.remove('on');
  document.getElementById('tab-bar').style.display='flex';
  if(view==='routes'){currentView='routes';document.getElementById('p-all').classList.add('on');document.getElementById('tab-all')?.classList.add('on');renderRouteList();}
  else if(view==='stops'){currentView='routes';switchTab('stops',document.getElementById('tab-stops'));}
  else if(view==='trip'){currentView='routes';switchTab('trip',document.getElementById('tab-trip'));}
  else if(view==='alerts'){currentView='alerts';document.getElementById('tab-bar').style.display='none';document.getElementById('p-alerts').classList.add('on');renderAlerts();}
}

// ── INIT ──────────────────────────────────────────────────────────────────
applyTheme();
boot();
