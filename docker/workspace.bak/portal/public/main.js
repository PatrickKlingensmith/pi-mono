const slider = document.getElementById('slider');
const overlay = document.getElementById('overlay');
const tabsEl = document.getElementById('tabs');
const tabcontent = document.getElementById('tabcontent');
const homeBtn = document.getElementById('homeBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');

let tiles = [];
let selectedId = null;

// drag state
let startPos = 0; let base = 0; let isDragging=false;

async function loadTiles(){
  try{
    const r = await fetch('/api/tiles');
    const arr = await r.json();
    tiles = arr.map((t) => ({ id: (t.url||Math.random().toString(36)).replace(/[^a-zA-Z0-9]/g,'') + Math.random().toString(36).slice(2,6), ...t }));
  }catch(e){
    const arr = [
      { url: 'https://monitor.starkitconsulting.com', title: 'Monitor' },
      { url: 'https://weathermax.starkitconsulting.com', title: 'WeatherMax' },
      { url: 'https://starkitconsulting.com', title: 'Starkit' },
    ];
    tiles = arr.map((t) => ({ id: (t.url||Math.random().toString(36)).replace(/[^a-zA-Z0-9]/g,'') + Math.random().toString(36).slice(2,6), ...t }));
  }
  // prepend dynamic Test Runs tile
  tiles.unshift({ id: 'testruns'+Math.random().toString(36).slice(2,6), title: 'Test Runs', type: 'testruns' });
  renderTiles();
}

function favicon(url){
  try{
    const u = new URL(url);
    return `https://www.google.com/s2/favicons?sz=64&domain=${u.hostname}`;
  }catch{ return '/favicon.ico'; }
}

function domain(url){
  try{ return new URL(url).hostname; }catch{ return url; }
}

function createTile(t){
  const card = document.createElement('div');
  card.className = 'tile' + (t.id===selectedId ? ' selected' : '');
  card.dataset.id = t.id;

  if (t.type === 'testruns') {
    const runsEl = document.createElement('div');
    runsEl.className = 'runs';
    const header = document.createElement('div');
    header.style.display='flex'; header.style.justifyContent='space-between'; header.style.alignItems='center';
    const h = document.createElement('div'); h.textContent='Recent Test Runs'; h.style.fontWeight='600';
    const refresh = document.createElement('button'); refresh.className='chip'; refresh.textContent='Refresh';
    refresh.addEventListener('click', (e)=>{ e.stopPropagation(); loadRunsInto(runsEl); });
    header.append(h, refresh); runsEl.appendChild(header);
    const list = document.createElement('div'); runsEl.appendChild(list);
    async function loadRunsInto(container){
      container.innerHTML='';
      const hdr = document.createElement('div'); hdr.textContent='Recent Test Runs'; hdr.style.fontWeight='600'; hdr.style.marginBottom='6px';
      const meta = document.createElement('div'); meta.className='run-meta'; meta.textContent='Sorted newest first'; meta.style.marginBottom='8px';
      container.append(hdr, meta);
      try{
        const r = await fetch('/api/test-runs');
        const data = await r.json();
        for (const run of data){
          const item = document.createElement('div'); item.className='run-item';
          const label = document.createElement('div'); label.className='run-label'; label.textContent = run.label;
          const right = document.createElement('div'); right.className='run-meta';
          const dt = new Date(run.timestamp).toLocaleString(); right.textContent = `${dt} • ${run.fileCount} files`;
          item.append(label, right);
          item.addEventListener('click', async (e)=>{ e.stopPropagation(); await showRunViewer(run.id); });
          container.appendChild(item);
        }
        if (data.length===0){ const empty=document.createElement('div'); empty.className='run-meta'; empty.textContent='No runs yet'; container.appendChild(empty); }
      } catch(err){ const er=document.createElement('div'); er.className='run-meta'; er.textContent='Failed to load runs'; container.appendChild(er); }
    }
    // initial load
    loadRunsInto(list);
    card.appendChild(runsEl);
    // clicking tile simply centers/enlarges
    card.addEventListener('click', ()=>{ selectedId=t.id; renderTiles(); requestAnimationFrame(applySelectedSizingAndCenter); });
    return card;
  }

  const iframe = document.createElement('iframe');
  iframe.sandbox = 'allow-scripts allow-same-origin';
  iframe.referrerPolicy = 'no-referrer';
  iframe.src = t.url;

  const placeholder = document.createElement('div');
  placeholder.className = 'placeholder';
  const img = document.createElement('img');
  img.src = favicon(t.url); img.width=32; img.height=32; img.alt='';
  const title = document.createElement('div');
  title.textContent = t.title || domain(t.url);
  const open = document.createElement('button');
  open.className='open-btn'; open.textContent='Open';
  open.addEventListener('click', (e)=>{ e.stopPropagation(); ensureTab(t.url); showOverlay(); });
  placeholder.append(img,title,open);

  let loaded = false;
  iframe.addEventListener('load', ()=>{ loaded = true; placeholder.style.display='none'; });
  setTimeout(()=>{ if(!loaded) placeholder.style.display='flex'; }, 1500);

  // interaction veil (shown when not selected)
  const veil = document.createElement('div');
  veil.className = 'veil';
  const top = document.createElement('div'); top.className='top';
  const dragChip = document.createElement('div'); dragChip.className='chip'; dragChip.textContent='DRAG TO SCROLL';
  top.appendChild(dragChip);
  const bottom = document.createElement('div'); bottom.className='bottom';
  const interact = document.createElement('button'); interact.className='chip'; interact.textContent='INTERACT';
  interact.addEventListener('click', (e)=>{ e.stopPropagation(); selectedId=t.id; renderTiles(); requestAnimationFrame(applySelectedSizingAndCenter); });
  const expand = document.createElement('button'); expand.className='chip'; expand.textContent='EXPAND';
  expand.addEventListener('click', (e)=>{ e.stopPropagation(); animateExpandFrom(card, t.url); });
  bottom.append(interact, expand);
  veil.append(top, bottom);

  // deselect chip when selected
  const deselect = document.createElement('button');
  deselect.className='chip deselect'; deselect.textContent='Back to scroll';
  deselect.addEventListener('click', (e)=>{ e.stopPropagation(); selectedId=null; renderTiles(); });

  card.append(iframe, placeholder, veil, deselect);

  // clicking tile centers and selects/enlarges
  card.addEventListener('click', ()=>{
    selectedId = t.id;
    renderTiles();
    requestAnimationFrame(applySelectedSizingAndCenter);
  });

  return card;
}

function renderTiles(){
  slider.innerHTML = '';
  tiles.forEach(t => slider.appendChild(createTile(t)));
  // after render, if a tile is selected ensure it is centered and sized
  requestAnimationFrame(applySelectedSizingAndCenter);
}

// drag to scroll
slider.addEventListener('mousedown', (e)=>{ isDragging=true; slider.style.cursor='grabbing'; startPos=e.clientX; base=slider.scrollLeft; });
slider.addEventListener('mouseleave', ()=>{ isDragging=false; slider.style.cursor='grab'; });
slider.addEventListener('mouseup', ()=>{ isDragging=false; slider.style.cursor='grab'; });
slider.addEventListener('mousemove', (e)=>{ if(!isDragging) return; e.preventDefault(); const dx=e.clientX-startPos; slider.scrollLeft=base-dx; });
// touch
slider.addEventListener('touchstart', (e)=>{ isDragging=true; startPos=e.touches[0].clientX; base=slider.scrollLeft; }, {passive:true});
slider.addEventListener('touchend', ()=>{ isDragging=false; }, {passive:true});
slider.addEventListener('touchmove', (e)=>{ if(!isDragging) return; const dx=e.touches[0].clientX-startPos; slider.scrollLeft=base-dx; }, {passive:true});

function centerTile(el){
  const left = el.offsetLeft;
  const cardWidth = el.getBoundingClientRect().width;
  const target = left - (slider.clientWidth/2 - cardWidth/2);
  slider.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
}

function applySelectedSizingAndCenter(){
  if(!selectedId) return;
  const el = slider.querySelector(`.tile[data-id="${selectedId}"]`);
  if(!el) return;
  // compute adaptive size
  const vw = window.innerWidth, vh = window.innerHeight;
  const baseW = 400, baseH = 500;
  let factor = 1.2;
  if(vw >= 1400) factor = 2.4; else if(vw >= 1024) factor = 1.8; else if(vw >= 600) factor = 1.4;
  const maxW = vw * 0.8, maxH = vh * 0.75;
  const newW = Math.min(baseW * factor, maxW);
  const newH = Math.min(baseH * factor, maxH);
  el.style.setProperty('--tile-w', `${Math.round(newW)}px`);
  el.style.setProperty('--tile-h', `${Math.round(newH)}px`);
  centerTile(el);
}

window.addEventListener('resize', ()=>{
  if(selectedId) requestAnimationFrame(applySelectedSizingAndCenter);
});

// tabs overlay (persist iframes to avoid reloads)
const tabs = [];
function ensureTab(url){
  const existing = tabs.find(t => t.url===url);
  if(existing){ setActive(existing.id); updateTabbarVisibility(); return existing.id; }
  const id = Math.random().toString(36).slice(2);
  const iframe = document.createElement('iframe');
  iframe.sandbox = 'allow-scripts allow-same-origin';
  iframe.src = url; iframe.referrerPolicy='no-referrer';
  iframe.style.display = 'none';
  tabcontent.appendChild(iframe);
  const tab = { id, url, iframe, active: false };
  tabs.push(tab);
  renderTabs();
  updateTabbarVisibility();
  return id;
}
function showOverlay(){ overlay.classList.remove('hidden'); document.body.classList.add('overlay-active'); }
function hideOverlay(){ overlay.classList.add('hidden'); document.body.classList.remove('overlay-active'); }

function setActive(id){
  tabs.forEach(t => {
    t.active = (t.id===id);
    if (t.iframe) t.iframe.style.display = t.active ? 'block' : 'none';
  });
  renderTabs();
}

async function showRunViewer(runId){
  // Open overlay without creating a tab; render a simple gallery
  showOverlay();
  // Clear any iframes content, show our own panel
  tabcontent.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.style.position='absolute'; wrap.style.inset='0'; wrap.style.overflow='auto'; wrap.style.padding='12px';
  const h = document.createElement('div'); h.textContent = 'Test Run: ' + runId; h.style.fontWeight='700'; h.style.margin='6px 0 12px 0';
  wrap.appendChild(h);
  try{
    const r = await fetch('/api/test-runs/'+encodeURIComponent(runId));
    const data = await r.json();
    const grid = document.createElement('div');
    grid.style.display='grid'; grid.style.gridTemplateColumns='repeat(auto-fill,minmax(320px,1fr))'; grid.style.gap='12px';
    for (const f of data.files){
      const ext = f.name.split('.').pop().toLowerCase();
      const card = document.createElement('div'); card.style.border='1px solid var(--border)'; card.style.borderRadius='12px'; card.style.padding='8px'; card.style.background='rgba(255,255,255,0.03)';
      const cap = document.createElement('div'); cap.textContent=f.name; cap.style.fontSize='12px'; cap.style.color='var(--text2)'; cap.style.marginBottom='6px';
      if(['png','jpg','jpeg','webp'].includes(ext)){
        const img = document.createElement('img'); img.src=f.url; img.style.width='100%'; img.style.borderRadius='8px'; img.alt=f.name; card.append(cap,img);
      } else if(['mp4','webm'].includes(ext)){
        const vid = document.createElement('video'); vid.src=f.url; vid.controls=true; vid.style.width='100%'; vid.style.borderRadius='8px'; card.append(cap,vid);
      } else {
        const a = document.createElement('a'); a.href=f.url; a.textContent='Download'; a.target='_blank'; a.rel='noopener'; card.append(cap,a);
      }
      grid.appendChild(card);
    }
    wrap.appendChild(grid);
  } catch(err){ const er=document.createElement('div'); er.textContent='Failed to load run files'; wrap.appendChild(er); }
  tabcontent.appendChild(wrap);
}

function closeTab(id){
  const idx = tabs.findIndex(t=>t.id===id);
  if(idx>=0){
    const removingActive = tabs[idx].active;
    const iframe = tabs[idx].iframe;
    if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe);
    tabs.splice(idx,1);
    if(removingActive && tabs.length>0){ setActive(tabs[tabs.length-1].id); }
    else if(tabs.length===0){ overlay.classList.add('hidden'); }
    renderTabs();
  }
}

function renderTabs(){
  tabsEl.innerHTML='';
  tabs.forEach(t => {
    const el = document.createElement('div');
    el.className='tab'+(t.active?' active':'');
    const img = document.createElement('img'); img.src=favicon(t.url); img.alt='';
    const label = document.createElement('span'); label.textContent = domain(t.url);
    const close = document.createElement('button'); close.className='close'; close.textContent='×';
    close.addEventListener('click', (e)=>{ e.stopPropagation(); closeTab(t.id); });
    el.addEventListener('click', ()=> { setActive(t.id); showOverlay(); });
    el.append(img,label,close);
    tabsEl.appendChild(el);
  });
}

function updateTabbarVisibility(){
  const bar = document.getElementById('tabbar');
  if(tabs.length>0){ bar.classList.remove('hidden'); document.body.classList.add('has-tabs'); }
  else { bar.classList.add('hidden'); document.body.classList.remove('has-tabs'); }
}

homeBtn.addEventListener('click', ()=>{ hideOverlay(); });

fullscreenBtn?.addEventListener('click', ()=>{
  const active = tabs.find(t=>t.active) || tabs[0];
  if(active){ window.open(active.url, '_blank', 'noopener'); }
});

function animateExpandFrom(card, url){
  const rect = card.getBoundingClientRect();
  const ghost = document.createElement('div');
  ghost.className = 'expand-ghost';
  ghost.style.left = rect.left + window.scrollX + 'px';
  ghost.style.top = rect.top + window.scrollY + 'px';
  ghost.style.width = rect.width + 'px';
  ghost.style.height = rect.height + 'px';
  document.body.appendChild(ghost);
  const id = ensureTab(url);
  requestAnimationFrame(()=>{
    ghost.style.left = window.scrollX + 'px';
    ghost.style.top = window.scrollY + 'px';
    ghost.style.width = window.innerWidth + 'px';
    ghost.style.height = window.innerHeight + 'px';
    ghost.style.borderRadius = '0px';
  });
  const done = ()=>{
    ghost.remove();
    setActive(id);
    showOverlay();
  };
  ghost.addEventListener('transitionend', done, { once: true });
}

loadTiles();
