/**
 * The human play page. Embedded string, vanilla JS, no build step.
 *
 * Written for a clinician who has never seen the tool: a big clock, plain words
 * (no "reward"/"stress"/"disp" jargon), and a guidance line that always says
 * what to do next. Turn-based: pick a patient, click what to do (it queues),
 * advance the clock.
 */
export const PLAY_PAGE = String.raw`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ER — play</title>
<style>
  :root{--bg:#0e1116;--panel:#161b22;--line:#2a313c;--fg:#e6edf3;--dim:#8b949e;
    --e1:#f85149;--e2:#fb8500;--e3:#e3b341;--e4:#3fb950;--e5:#58a6ff;--acc:#2f81f7;--ok:#3fb950;--bad:#f85149;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  button{font:inherit;background:#21262d;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:7px 12px;cursor:pointer}
  button:hover{border-color:var(--acc);background:#262c36}
  button.primary{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600;font-size:16px;padding:10px 22px}
  button.primary:hover{background:#4c96ff}
  select,input{font:inherit;background:#0d1117;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:7px}

  /* setup */
  #setup{max-width:560px;margin:70px auto;text-align:center}
  #setup .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:30px}
  #setup h1{font-size:26px;margin:0 0 6px}
  #setup p{color:var(--dim)}
  .row{display:flex;gap:10px;align-items:center;justify-content:center;margin:12px 0}

  /* game header */
  header{display:flex;align-items:center;gap:22px;padding:12px 18px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:5;flex-wrap:wrap}
  .clock{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:.5px}
  .stat{text-align:center;line-height:1.1}
  .stat b{display:block;font-size:20px;font-variant-numeric:tabular-nums}
  .stat span{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.4px}
  .stat.warn b{color:var(--e3)} .stat.bad b{color:var(--bad)}
  .spacer{flex:1}

  /* guidance */
  #guide{padding:10px 18px;background:#12233a;border-bottom:1px solid #1f3a5f;color:#cfe4ff;font-size:15px}
  #guide b{color:#fff}

  .wrap{display:grid;grid-template-columns:1fr 420px;gap:14px;padding:14px 18px}
  .col{display:flex;flex-direction:column;gap:14px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:9px;overflow:hidden}
  .card h2{margin:0;padding:9px 13px;font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:var(--dim);border-bottom:1px solid var(--line)}
  .body{padding:11px 13px;max-height:56vh;overflow:auto}

  table{width:100%;border-collapse:collapse}
  th{text-align:left;color:var(--dim);font-weight:500;padding:4px 8px;font-size:12px}
  td{padding:7px 8px;border-top:1px solid var(--line)}
  tr.pt{cursor:pointer} tr.pt:hover td{background:#1c2432} tr.sel td{background:#22314a}
  .badge{display:inline-block;min-width:22px;text-align:center;padding:1px 7px;border-radius:11px;font-size:12px;font-weight:700;color:#0e1116}
  .p1{background:var(--e1)}.p2{background:var(--e2)}.p3{background:var(--e3)}.p4{background:var(--e4)}.p5{background:var(--e5)}.pu{background:#6e7681;color:#fff}
  .tag{font-size:11px;color:var(--dim)}
  .beds{display:flex;flex-wrap:wrap;gap:5px}
  .bed{width:58px;height:40px;border-radius:6px;border:1px solid var(--line);display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:10px}
  .clean{background:#0f2418;border-color:#1f4d2e}.occupied{background:#16283d;border-color:#2b5580}.dirty{background:#33220f;border-color:#7a4a24}.cleaning{background:#2b2710}
  .bed .free{color:var(--e4);font-weight:700}

  .who{padding:9px 13px;border-bottom:1px solid var(--line);background:#1a2130}
  .who b{font-size:15px}
  .grp{margin:11px 0}
  .grp .lbl{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px}
  .grp .btns{display:flex;flex-wrap:wrap;gap:6px}
  .form{display:flex;flex-wrap:wrap;gap:6px;align-items:center}

  .dim{color:var(--dim)}.bad{color:var(--bad)}.ok{color:var(--ok)}.warn{color:var(--e3)}
  .queued div{padding:7px 0;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:10px;align-items:center}
  .queued .x{color:var(--bad);cursor:pointer;font-weight:700}

  #final{position:fixed;inset:0;background:rgba(0,0,0,.9);display:none;align-items:center;justify-content:center;z-index:20}
  #final .card{max-width:680px;padding:30px;text-align:center}
  .score{font-size:52px;font-weight:800;font-variant-numeric:tabular-nums;margin:6px 0}
</style></head><body>

<div id="setup">
  <div class="card">
    <h1>Run the ER</h1>
    <p>You are the charge nurse for one shift. Patients arrive on their own. Your job: see them, treat them, and move them out — without making an unsafe call.<br><br>
    It works in 5-minute rounds. Each round: <b>pick a patient, click what to do, then advance the clock.</b></p>
    <div class="row"><label class="dim">Your name</label><input id="player" value="nurse" size="18"></div>
    <div class="row"><label class="dim">Scenario</label><select id="scenario"></select></div>
    <div class="row"><label class="dim">Seed</label><input id="seed" value="s1" size="6"></div>
    <div class="row"><button class="primary" onclick="start()">Start the shift →</button></div>
  </div>
</div>

<div id="game" style="display:none">
<header>
  <div class="clock" id="clock">07:00</div>
  <div class="stat"><b id="inDept">0</b><span>in dept</span></div>
  <div class="stat warn"><b id="needTriage">0</b><span>need triage</span></div>
  <div class="stat warn"><b id="needBed">0</b><span>need a bed</span></div>
  <div class="stat"><b id="boarding">0</b><span>waiting to go up</span></div>
  <div class="stat bad"><b id="lwbs">0</b><span>walked out</span></div>
  <div class="stat bad"><b id="deaths">0</b><span>died</span></div>
  <div class="spacer"></div>
  <div class="tag" id="progress"></div>
  <button class="primary" onclick="advance()">Advance clock ▶</button>
</header>
<div id="guide"></div>
<div class="wrap">
  <div class="col">
    <div class="card"><h2>Patients — click one to work on it</h2><div class="body" style="max-height:48vh">
      <table><thead><tr><th>#</th><th>acuity</th><th>complaint</th><th>status</th><th>waiting</th><th>vitals</th><th>plan</th></tr></thead>
      <tbody id="pts"></tbody></table></div></div>
    <div class="card"><h2>Beds <span class="tag" id="bedsum"></span></h2><div class="body"><div class="beds" id="beds"></div></div></div>
  </div>
  <div class="col">
    <div class="card">
      <div class="who" id="who"><span class="dim">No patient selected</span></div>
      <div class="body" id="actions" style="max-height:44vh"><span class="dim">Click a patient on the left to see what you can do.</span></div>
    </div>
    <div class="card"><h2>Phones & the rest of the department</h2><div class="body" id="dept"></div></div>
    <div class="card"><h2>Queued for this round — <span id="qn">0</span></h2><div class="body queued" id="queued"><span class="dim">Nothing queued. Click actions above, then advance the clock.</span></div></div>
  </div>
</div>
</div>

<div id="final"><div class="card">
  <h1>Shift over</h1>
  <div class="score" id="finalScore">—</div>
  <p id="finalLine" class="dim"></p>
  <div id="finalDetail" class="dim"></div>
  <div class="row"><button class="primary" onclick="location.reload()">New shift</button></div>
</div></div>

<script>
let S=null, sel=null;
const $=id=>document.getElementById(id);
const post=(p,b)=>fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());
const acuityCls=e=>e?'p'+e:'pu';

fetch('/api/scenarios').then(r=>r.json()).then(d=>{
  $('scenario').innerHTML=d.scenarios.map(s=>'<option value="'+s.name+'">'+s.name+'</option>').join('');
});

async function start(){
  $('setup').querySelector('button').textContent='Starting…';
  S=await post('/api/reset',{player:$('player').value,scenario:$('scenario').value,seed:$('seed').value});
  $('setup').style.display='none'; $('game').style.display='block'; render();
}
async function queue(a){ S=await post('/api/queue',{sessionId:S.sessionId,action:a}); render(); }
async function unqueue(i){ S=await post('/api/unqueue',{sessionId:S.sessionId,index:i}); render(); }
async function advance(){
  S=await post('/api/advance',{sessionId:S.sessionId});
  if(S.final) showFinal(S.final); else render();
}

function guide(){
  if(S.needTriage>0) return 'You have <b>'+S.needTriage+'</b> patient(s) who need triage. Click one, take their vitals, then set an acuity level.';
  if(S.needBed>0) return '<b>'+S.needBed+'</b> patient(s) are triaged and waiting for a bed. Click one and put them in a bed so a doctor can see them.';
  const q=S.queued.length;
  if(q>0) return '<b>'+q+'</b> action(s) queued. Click <b>Advance clock</b> to carry them out and move 5 minutes forward.';
  if(S.inDept===0) return 'Quiet right now. Click <b>Advance clock</b> to let time pass — more patients will arrive.';
  return 'Work your patients: order tests, get a doctor on them, then decide where they go. Advance the clock when you are done this round.';
}

function render(){
  $('clock').textContent=S.clock;
  $('inDept').textContent=S.inDept; $('needTriage').textContent=S.needTriage;
  $('needBed').textContent=S.needBed; $('boarding').textContent=S.boarding;
  $('lwbs').textContent=S.leftWithoutCare; $('deaths').textContent=S.deaths;
  $('progress').textContent='round '+S.step+' / '+S.totalSteps+(S.onDiversion?' · ON DIVERSION':'');
  $('qn').textContent=S.queued.length;
  $('guide').innerHTML=guide();

  const clean=S.beds.filter(b=>b.status==='clean'&&!b.patient).length;
  $('bedsum').textContent=clean+' open · '+S.beds.filter(b=>b.status==='occupied').length+' full';
  $('beds').innerHTML=S.beds.map(b=>'<div class="bed '+b.status+'" title="'+b.id+' — '+b.status+(b.monitored?', monitored':'')+'">'
    +'<span>'+b.id.replace('fast-track','fast').replace('hallway','hall')+'</span>'
    +'<span class="'+(b.status==='clean'&&!b.patient?'free':'dim')+'">'+(b.patient?b.patient.replace('pt-','#'):b.status==='clean'?'open':b.status)+'</span></div>').join('');

  const ord={1:0,2:1,3:2,4:3,5:4,null:9};
  $('pts').innerHTML=[...S.patients].sort((a,b)=>(ord[a.esi]??9)-(ord[b.esi]??9)||b.waitingMinutes-a.waitingMinutes).map(p=>{
    const v=p.lastVitals?('HR '+p.lastVitals.hr+' · BP '+p.lastVitals.sbp+' · O₂ '+p.lastVitals.spo2+'%'):'<span class="warn">not taken</span>';
    const acu=p.esi?p.esi:'?';
    return '<tr class="pt '+(sel===p.id?'sel':'')+'" onclick="pick(\''+p.id+'\')">'
      +'<td>'+p.id.replace('pt-','#')+'</td>'
      +'<td><span class="badge '+acuityCls(p.esi)+'">'+acu+'</span></td>'
      +'<td>'+p.chiefComplaint+'</td>'
      +'<td>'+phase(p.phase)+'</td>'
      +'<td class="'+(p.waitingMinutes>120?'bad':p.waitingMinutes>60?'warn':'dim')+'">'+p.waitingMinutes+' min</td>'
      +'<td class="tag">'+v+'</td>'
      +'<td>'+(p.disposition?plan(p.disposition):'')+'</td></tr>';
  }).join('')||'<tr><td colspan="7" class="dim">No patients right now.</td></tr>';

  renderActions();
  $('dept').innerHTML=S.department.map(g=>grp(g)).join('')||'<span class="dim">Nothing needs you right now.</span>';
  $('queued').innerHTML=S.queued.map(q=>'<div><span>'+q.label+'</span><span class="x" onclick="unqueue('+q.i+')" title="remove">✕</span></div>').join('')
    ||'<span class="dim">Nothing queued. Click actions above, then advance the clock.</span>';
}

function phase(p){
  return {'waiting-registration':'just arrived','waiting-room':'waiting for a bed','in-bed':'in a bed','at-imaging':'in imaging','boarding':'admitted, waiting for a ward bed'}[p]||p;
}
function plan(d){ return d==='admit'?'admit':d; }

function pick(id){ sel=id; renderActions();
  document.querySelectorAll('tr.pt').forEach(r=>r.classList.remove('sel'));
  if(event&&event.currentTarget) event.currentTarget.classList.add('sel');
}

function grp(g){
  return '<div class="grp"><div class="lbl">'+g.name+'</div><div class="btns">'
    +g.buttons.map(b=>'<button onclick=\'queue('+JSON.stringify(b.action)+')\'>'+b.label+'</button>').join('')+'</div></div>';
}

function renderActions(){
  if(!sel||!S.legal[sel]){ $('who').innerHTML='<span class="dim">No patient selected</span>';
    $('actions').innerHTML='<span class="dim">Click a patient on the left to see what you can do.</span>'; return; }
  const p=S.patients.find(x=>x.id===sel), L=S.legal[sel];
  $('who').innerHTML='<b>'+sel.replace('pt-','#')+' — '+(p?p.chiefComplaint:'')+'</b> <span class="tag">'+(p?phase(p.phase):'')+(p&&p.esi?' · acuity '+p.esi:'')+'</span>';
  let html=L.groups.map(g=>grp(g)).join('');
  for(const m of L.orderMenus) html+=orderForm(m);
  $('actions').innerHTML=html||'<span class="dim">Nothing to do for this patient right now.</span>';
}

function orderForm(m){
  const id='ord_'+m.kind, label={lab:'Order a lab test',imaging:'Order imaging',med:'Give a medication',consult:'Call a consult'}[m.kind];
  const opts=m.items.map(i=>'<option>'+i+'</option>').join('');
  const extra=m.kind==='lab'?'<select id="'+id+'_route"><option value="central">central lab</option><option value="poct">bedside</option></select>'
    :m.kind==='med'?'<select id="'+id+'_src"><option value="cabinet">cabinet</option><option value="central">pharmacy</option><option value="compounding">compounded</option></select>':'';
  return '<div class="grp"><div class="lbl">'+label+'</div><div class="form">'
    +'<select id="'+id+'">'+opts+'</select>'
    +'<select id="'+id+'_pri"><option value="stat">STAT</option><option value="routine">routine</option></select>'
    +extra+'<button onclick="submitOrder(\''+m.kind+'\')">Order</button></div></div>';
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
  const pct=f.score===null?null:Math.round(f.score*100);
  $('finalScore').textContent=pct===null?'—':pct+'%';
  $('finalScore').className='score '+(f.score>0?'ok':'bad');
  $('finalLine').innerHTML=pct===null?'':'<b>0% = walking away and doing nothing. 100% = a flawless run with perfect information.</b><br>Where you landed between those two.';
  const m=f.metrics;
  $('finalDetail').innerHTML='Patients: '+m.access.arrivals+' · died: '+m.clinical.deaths
    +' · walked out: '+Math.round((m.access.lwbsRate||0)*m.access.arrivals)
    +' · safety violations: '+(Object.values(m.safety).reduce((a,b)=>a+b,0))
    +'<br><span class="dim" style="font-size:12px">saved to '+f.runRecord+'</span>';
}
</script>
</body></html>`;
