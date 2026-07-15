/**
 * The human play page. Embedded string, vanilla JS, no build step (same rules
 * as the live board). Turn-based: select a patient, click legal actions to queue
 * them, advance the 5-minute window.
 */
export const PLAY_PAGE = String.raw`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>er-gym · play</title>
<style>
  :root{--bg:#0e1116;--panel:#161b22;--line:#262d38;--fg:#e6edf3;--dim:#7d8590;
    --e1:#f85149;--e2:#fb8500;--e3:#e3b341;--e4:#3fb950;--e5:#58a6ff;--acc:#58a6ff;--ok:#3fb950;--bad:#f85149;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.45 ui-monospace,Menlo,Consolas,monospace}
  header{display:flex;gap:16px;align-items:baseline;flex-wrap:wrap;padding:8px 14px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:5}
  h1{font-size:14px;margin:0;letter-spacing:.5px}
  .clock{font-size:20px;font-variant-numeric:tabular-nums}
  .kv{color:var(--dim)} .kv b{color:var(--fg)}
  button{font:inherit;background:#21262d;color:var(--fg);border:1px solid var(--line);border-radius:5px;padding:4px 9px;cursor:pointer}
  button:hover{border-color:var(--acc)}
  button.big{padding:8px 16px;font-size:14px;background:#1f6feb;border-color:#1f6feb}
  button.big:hover{background:#388bfd}
  select,input{font:inherit;background:#0d1117;color:var(--fg);border:1px solid var(--line);border-radius:5px;padding:4px}
  .wrap{display:grid;grid-template-columns:1fr 380px;gap:10px;padding:10px}
  .col{display:flex;flex-direction:column;gap:10px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:6px}
  .card h2{margin:0;padding:6px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--dim);border-bottom:1px solid var(--line)}
  .body{padding:8px 10px;max-height:44vh;overflow:auto}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;color:var(--dim);font-weight:500;padding:2px 6px}
  td{padding:3px 6px;border-top:1px solid #1f2630}
  tr.pt{cursor:pointer} tr.pt:hover td{background:#1c2230} tr.sel td{background:#22314a}
  .pill{display:inline-block;padding:0 6px;border-radius:8px;font-size:11px;font-weight:600;color:#0e1116}
  .p1{background:var(--e1)}.p2{background:var(--e2)}.p3{background:var(--e3)}.p4{background:var(--e4)}.p5{background:var(--e5)}.pu{background:#484f58;color:#e6edf3}
  .beds{display:flex;flex-wrap:wrap;gap:3px}
  .bed{width:46px;height:30px;border-radius:4px;border:1px solid var(--line);display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:9px}
  .clean{background:#12261a;border-color:#1f4d2e}.occupied{background:#1b2b3d}.dirty{background:#3a2418}.cleaning{background:#2e2a12}
  .grp{margin-bottom:8px} .grp .lbl{color:var(--dim);font-size:11px;margin-bottom:3px}
  .grp .btns{display:flex;flex-wrap:wrap;gap:4px}
  .dim{color:var(--dim)}.bad{color:var(--bad)}.ok{color:var(--ok)}.warn{color:var(--e3)}
  .queued div{padding:3px 0;border-top:1px solid #1f2630;display:flex;justify-content:space-between;gap:8px}
  .queued .x{color:var(--bad);cursor:pointer}
  #setup{max-width:520px;margin:60px auto;text-align:center}
  #setup .card{padding:24px}
  .row{display:flex;gap:8px;align-items:center;justify-content:center;margin:10px 0}
  #final{position:fixed;inset:0;background:rgba(0,0,0,.85);display:none;align-items:center;justify-content:center;z-index:20}
  #final .card{max-width:640px;padding:24px}
  .score{font-size:40px;font-variant-numeric:tabular-nums}
  .refused{color:var(--bad);font-size:11px}
</style></head><body>

<div id="setup">
  <div class="card">
    <h1 style="font-size:20px">er-gym</h1>
    <p class="dim">You are the charge nurse. Run the shift: triage, room, treat, and move patients — without crossing a safety line. Turn-based: queue your actions, then advance 5 minutes.</p>
    <div class="row"><label class="dim">Your name</label><input id="player" value="nurse" size="16"></div>
    <div class="row"><label class="dim">Scenario</label><select id="scenario"></select></div>
    <div class="row"><label class="dim">Seed</label><input id="seed" value="s1" size="6"></div>
    <div class="row"><button class="big" onclick="start()">Start shift</button></div>
  </div>
</div>

<div id="game" style="display:none">
<header>
  <h1>ER-GYM</h1>
  <span class="clock" id="clock">--:--</span>
  <span class="kv">step <b id="step">0</b></span>
  <span class="kv">reward <b id="reward">0</b></span>
  <span class="kv">census <b id="census">0</b></span>
  <span class="kv">waiting <b id="waiting">0</b></span>
  <span class="kv">boarding <b id="boarding">0</b></span>
  <span class="kv">stress~ <b id="stress">—</b></span>
  <span class="kv" id="divwrap" style="display:none">· <b class="bad">DIVERSION</b></span>
  <button class="big" style="margin-left:auto" onclick="advance()">Advance 5 min ▶ (<span id="qn">0</span> queued)</button>
</header>
<div class="wrap">
  <div class="col">
    <div class="card"><h2>Beds</h2><div class="body"><div class="beds" id="beds"></div></div></div>
    <div class="card"><h2>Patients — click one to act</h2><div class="body" style="max-height:52vh">
      <table><thead><tr><th>id</th><th>esi</th><th>complaint</th><th>phase</th><th>wait</th><th>vitals</th><th>disp</th></tr></thead>
      <tbody id="pts"></tbody></table></div></div>
  </div>
  <div class="col">
    <div class="card"><h2 id="actH">Actions</h2><div class="body" id="actions"><span class="dim">Select a patient.</span></div></div>
    <div class="card"><h2>Department</h2><div class="body" id="dept"></div></div>
    <div class="card"><h2>Queued this window</h2><div class="body queued" id="queued"><span class="dim">nothing queued</span></div></div>
  </div>
</div>
</div>

<div id="final"><div class="card">
  <h1>Shift complete</h1>
  <div class="score" id="finalScore">—</div>
  <p class="dim" id="finalLine"></p>
  <div id="finalDetail" class="dim"></div>
  <div class="row"><button class="big" onclick="location.reload()">New shift</button></div>
</div></div>

<script>
let S=null, sel=null;
const $=id=>document.getElementById(id);
const post=(p,b)=>fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());
const esiCls=e=>e?'p'+e:'pu';

fetch('/api/scenarios').then(r=>r.json()).then(d=>{
  $('scenario').innerHTML=d.scenarios.map(s=>'<option value="'+s.name+'">'+s.name+'</option>').join('');
});

async function start(){
  S=await post('/api/reset',{player:$('player').value,scenario:$('scenario').value,seed:$('seed').value});
  $('setup').style.display='none'; $('game').style.display='block'; render();
}
async function queue(a){ S=await post('/api/queue',{sessionId:S.sessionId,action:a}); render(); }
async function unqueue(i){ S=await post('/api/unqueue',{sessionId:S.sessionId,index:i}); render(); }
async function advance(){
  S=await post('/api/advance',{sessionId:S.sessionId});
  if(S.final) showFinal(S.final); else render();
}

function render(){
  $('clock').textContent=S.clock; $('step').textContent=S.step;
  $('reward').textContent=S.reward.toLocaleString(); $('reward').className=S.reward<0?'bad':'ok';
  $('census').textContent=S.census; $('waiting').textContent=S.waiting; $('boarding').textContent=S.boarding;
  $('stress').textContent=S.stressProxy; $('divwrap').style.display=S.onDiversion?'':'none';
  $('qn').textContent=S.queued.length;

  $('beds').innerHTML=S.beds.map(b=>'<div class="bed '+b.status+'" title="'+b.id+' '+b.status+(b.monitored?' mon':'')+'">'
    +'<span>'+b.id.replace('fast-track','ft').replace('hallway','hall')+'</span>'
    +'<span class="dim">'+(b.patient?b.patient.replace('pt-','#'):b.status[0].toUpperCase())+'</span></div>').join('');

  const ord={1:0,2:1,3:2,4:3,5:4,null:9};
  $('pts').innerHTML=[...S.patients].sort((a,b)=>(ord[a.esi]??9)-(ord[b.esi]??9)||b.waitingMinutes-a.waitingMinutes).map(p=>{
    const v=p.lastVitals?p.lastVitals.hr+'/'+p.lastVitals.sbp+' '+p.lastVitals.spo2+'%':'<span class="dim">—</span>';
    return '<tr class="pt '+(sel===p.id?'sel':'')+'" onclick="pick(\''+p.id+'\')">'
      +'<td>'+p.id.replace('pt-','#')+'</td><td><span class="pill '+esiCls(p.esi)+'">'+(p.esi??'?')+'</span></td>'
      +'<td class="dim">'+p.chiefComplaint.slice(0,20)+'</td><td>'+p.phase+'</td>'
      +'<td class="'+(p.waitingMinutes>120?'bad':p.waitingMinutes>60?'warn':'')+'">'+p.waitingMinutes+'m</td>'
      +'<td>'+v+'</td><td>'+(p.disposition||'')+'</td></tr>';
  }).join('')||'<tr><td colspan="7" class="dim">empty</td></tr>';

  renderActions();
  $('dept').innerHTML=S.department.map(g=>grp(g)).join('')||'<span class="dim">quiet</span>';
  $('queued').innerHTML=S.queued.map(q=>'<div><span>'+q.label+'</span><span class="x" onclick="unqueue('+q.i+')">✕</span></div>').join('')||'<span class="dim">nothing queued</span>';
}

function pick(id){ sel=id; renderActions();
  document.querySelectorAll('tr.pt').forEach(r=>r.classList.remove('sel'));
  event&&event.currentTarget&&event.currentTarget.classList.add('sel');
}

function grp(g){
  return '<div class="grp"><div class="lbl">'+g.name+'</div><div class="btns">'
    +g.buttons.map(b=>'<button onclick=\'queue('+JSON.stringify(b.action)+')\'>'+b.label+'</button>').join('')+'</div></div>';
}

function renderActions(){
  if(!sel||!S.legal[sel]){ $('actH').textContent='Actions'; $('actions').innerHTML='<span class="dim">Select a patient.</span>'; return; }
  const L=S.legal[sel];
  $('actH').textContent='Actions · '+sel.replace('pt-','#');
  let html=L.groups.map(g=>grp(g)).join('');
  for(const m of L.orderMenus){ html+=orderForm(m); }
  $('actions').innerHTML=html||'<span class="dim">no legal actions</span>';
}

function orderForm(m){
  const id='ord_'+m.kind;
  const opts=m.items.map(i=>'<option>'+i+'</option>').join('');
  const extra = m.kind==='lab'
    ? '<select id="'+id+'_route"><option value="central">central</option><option value="poct">poct</option></select>'
    : m.kind==='med'
    ? '<select id="'+id+'_src"><option value="cabinet">cabinet</option><option value="central">central</option><option value="compounding">compounding</option></select>'
    : '';
  return '<div class="grp"><div class="lbl">Order '+m.kind+'</div><div class="btns">'
    +'<select id="'+id+'">'+opts+'</select>'
    +'<select id="'+id+'_pri"><option value="stat">stat</option><option value="routine">routine</option></select>'
    +extra
    +'<button onclick="submitOrder(\''+m.kind+'\')">Order</button></div></div>';
}

function submitOrder(kind){
  const name=$('ord_'+kind).value, pri=$('ord_'+kind+'_pri').value;
  let a;
  if(kind==='lab') a={type:'order_lab',patient:sel,test:name,priority:pri,route:$('ord_lab_route').value};
  else if(kind==='imaging') a={type:'order_imaging',patient:sel,study:name,priority:pri,escort:false};
  else if(kind==='med') a={type:'order_med',patient:sel,drug:name,priority:pri,source:$('ord_med_src').value};
  else a={type:'order_consult',patient:sel,service:name,priority:pri};
  queue(a);
}

function showFinal(f){
  $('game').style.display='none'; $('final').style.display='flex';
  $('finalScore').textContent=f.score===null?'n/a':f.score.toFixed(2);
  $('finalScore').className='score '+(f.score>0?'ok':'bad');
  $('finalLine').textContent='0 = doing nothing ('+f.nullAnchor.toLocaleString()+'), 1 = perfect play ('+f.oracleAnchor.toLocaleString()+'). You: '+f.reward.toLocaleString()+'.';
  const m=f.metrics;
  $('finalDetail').innerHTML='deaths '+m.clinical.deaths+' · LWBS '+m.access.lwbsRate
    +' · boarding p90 '+(m.boarding.boardingHoursP90??'—')+'h · safety floors '+JSON.stringify(m.safety)
    +'<br><span class="dim">saved: '+f.runRecord+'</span>';
}
</script>
</body></html>`;
