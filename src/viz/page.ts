/**
 * The dashboard page.
 *
 * Embedded as a string so `tsc` alone produces a working build — no asset
 * copying, no bundler, no static-path resolution that breaks between `tsx` and
 * `dist`. It is one page; the tradeoff is worth it.
 *
 * Vanilla JS on purpose. This should still run in five years.
 */
export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>er-gym · live board</title>
<style>
  :root{
    --bg:#0e1116; --panel:#161b22; --line:#262d38; --fg:#e6edf3; --dim:#7d8590;
    --esi1:#f85149; --esi2:#fb8500; --esi3:#e3b341; --esi4:#3fb950; --esi5:#58a6ff;
    --ok:#3fb950; --warn:#e3b341; --bad:#f85149; --acc:#58a6ff;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
       font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  header{display:flex;gap:18px;align-items:baseline;flex-wrap:wrap;
         padding:10px 14px;border-bottom:1px solid var(--line);
         position:sticky;top:0;background:var(--bg);z-index:5}
  h1{font-size:13px;margin:0;letter-spacing:.5px}
  .clock{font-size:20px;font-variant-numeric:tabular-nums}
  .kv{color:var(--dim)} .kv b{color:var(--fg);font-weight:600}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:10px;padding:10px}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:6px;overflow:hidden}
  .panel>h2{margin:0;padding:6px 10px;font-size:11px;text-transform:uppercase;
            letter-spacing:.8px;color:var(--dim);border-bottom:1px solid var(--line);
            display:flex;justify-content:space-between}
  .body{padding:8px 10px;max-height:280px;overflow:auto}
  .wide{grid-column:1/-1}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;color:var(--dim);font-weight:500;padding:2px 6px 4px;position:sticky;top:0;background:var(--panel)}
  td{padding:2px 6px;border-top:1px solid #1f2630;white-space:nowrap}
  /* Key/value tables: fix the layout so a long value can never shove the
     right-hand column out of the panel. Values wrap instead of overflowing. */
  .kvt{table-layout:fixed}
  .kvt td:first-child{width:42%}
  .kvt td:last-child{text-align:right;white-space:normal;word-break:break-word}
  .beds{display:flex;flex-wrap:wrap;gap:4px}
  .bed{width:52px;height:34px;border-radius:4px;border:1px solid var(--line);
       display:flex;flex-direction:column;align-items:center;justify-content:center;
       font-size:9px;line-height:1.1;cursor:default}
  .clean{background:#12261a;border-color:#1f4d2e}
  .occupied{background:#1b2b3d;border-color:#2b5580}
  .dirty{background:#3a2418;border-color:#7a4a24}
  .cleaning{background:#2e2a12;border-color:#6b5f1e}
  .pill{display:inline-block;padding:0 5px;border-radius:8px;font-size:10px;font-weight:600;color:#0e1116}
  .e1{background:var(--esi1)}.e2{background:var(--esi2)}.e3{background:var(--esi3)}
  .e4{background:var(--esi4)}.e5{background:var(--esi5)}.eu{background:#484f58;color:#e6edf3}
  .bar{height:6px;background:#21262d;border-radius:3px;overflow:hidden;min-width:70px}
  .bar>i{display:block;height:100%;background:var(--acc)}
  .bar.hot>i{background:var(--bad)}
  .dim{color:var(--dim)} .bad{color:var(--bad)} .ok{color:var(--ok)} .warn{color:var(--warn)}
  .stale{color:var(--warn);font-size:10px}
  #acts div{padding:1px 0;border-bottom:1px solid #1f2630}
  #safety div{padding:2px 0;color:var(--bad);border-bottom:1px solid #1f2630}
  .off{opacity:.45}
  .flash{animation:f .6s}
  @keyframes f{from{background:#2d1b1b}to{background:transparent}}
  .status{padding:2px 8px;border-radius:10px;font-size:10px;border:1px solid var(--line)}
  .live{color:var(--ok);border-color:#1f4d2e}
  .down{color:var(--bad);border-color:#5c2626}
</style>
</head>
<body>
<header>
  <h1>ER-GYM</h1>
  <span class="clock" id="clock">--:--</span>
  <span class="kv">scenario <b id="scen">—</b></span>
  <span class="kv">step <b id="step">0</b></span>
  <span class="kv">reward <b id="rew">0</b></span>
  <span class="kv">census <b id="census">0</b></span>
  <span class="kv">waiting <b id="waiting">0</b></span>
  <span class="kv">boarding <b id="boarding">0</b></span>
  <span class="kv">holds <b id="holds">0</b></span>
  <span class="kv">restrained <b id="restr">0</b></span>
  <span class="kv">stress~ <b id="stress">—</b></span>
  <span class="kv" id="divwrap" style="display:none">· <b class="bad">DIVERSION</b></span>
  <span class="kv" id="dtwrap" style="display:none">· <b class="bad" id="dt">IT DOWN</b></span>
  <span class="status down" id="conn" style="margin-left:auto">connecting…</span>
</header>

<div class="grid">
  <div class="panel wide">
    <h2>ED beds <span class="dim" id="bedsum"></span></h2>
    <div class="body"><div class="beds" id="beds"></div></div>
  </div>

  <div class="panel wide">
    <h2>Patients <span class="dim" id="ptsum"></span></h2>
    <div class="body" style="max-height:340px">
      <table><thead><tr>
        <th>id</th><th>esi</th><th>complaint</th><th>phase</th><th>loc</th>
        <th>wait</th><th>vitals</th><th>age</th><th>rn</th><th>md</th><th>ord</th><th>dispo</th><th>board</th><th>flags</th>
      </tr></thead><tbody id="pts"></tbody></table>
    </div>
  </div>

  <div class="panel">
    <h2>Interrupts <span class="dim" id="intsum"></span></h2>
    <div class="body">
      <table><thead><tr>
        <th>src</th><th>clm</th><th>role</th><th>wait</th><th>rb</th><th>ddl</th><th>defer</th>
      </tr></thead><tbody id="ints"></tbody></table>
    </div>
  </div>

  <div class="panel">
    <h2>Role attention load</h2>
    <div class="body"><table class="kvt" id="roles"></table></div>
  </div>

  <div class="panel">
    <h2>Downstream capacity <span class="dim">noisy · stale</span></h2>
    <div class="body"><table class="kvt" id="down"></table></div>
  </div>

  <div class="panel">
    <h2>Report handoffs <span class="dim">bed ≠ moved</span></h2>
    <div class="body"><table id="hand"></table></div>
  </div>

  <div class="panel">
    <h2>Queues</h2>
    <div class="body"><table class="kvt" id="queues"></table></div>
  </div>

  <div class="panel">
    <h2>Supply <span class="dim">noisy · stale</span></h2>
    <div class="body"><table class="kvt" id="supply"></table></div>
  </div>

  <div class="panel">
    <h2>Last actions</h2>
    <div class="body" id="acts"></div>
  </div>

  <div class="panel">
    <h2>Safety floors</h2>
    <div class="body" id="safety"><span class="dim">none</span></div>
  </div>

  <div class="panel">
    <h2>Reward components</h2>
    <div class="body"><table class="kvt" id="comp"></table></div>
  </div>
</div>

<script>
const $ = id => document.getElementById(id);
const esiCls = e => e ? 'e'+e : 'eu';
const t = (x, d='—') => (x===null||x===undefined) ? d : x;

function rows(el, pairs){
  el.innerHTML = pairs.map(([k,v]) =>
    '<tr><td class="dim">'+k+'</td><td style="text-align:right">'+v+'</td></tr>').join('');
}
// Restraint clocks and psych holds are the two things that quietly go wrong
// while you are looking at the bed grid, so surface them on the patient row.
function behFlags(p){
  const out = [];
  if (p.psychHold) out.push('<span class="pill e2" title="psychiatric hold">HOLD</span>');
  if (p.sitter) out.push('<span class="pill e4" title="sitter assigned">SIT</span>');
  if (p.restraint){
    const due = p.restraint.minutesUntilCheckDue;
    const cls = due < 0 ? 'e1' : due <= 5 ? 'e2' : 'e5';
    const label = due < 0 ? 'CHK '+Math.abs(due)+'m LATE' : 'CHK '+due+'m';
    out.push('<span class="pill '+cls+'" title="restraint check clock">'+label+'</span>');
    if (p.restraint.checksMissed) out.push('<span class="bad" title="missed checks">x'+p.restraint.checksMissed+'</span>');
  }
  return out.join(' ');
}
function bar(v, max, hot){
  const p = max ? Math.min(100, Math.round(100*v/max)) : 0;
  return '<div class="bar'+(hot?' hot':'')+'"><i style="width:'+p+'%"></i></div>';
}

let lastSafety = 0;

function render(f){
  const o = f.observation;
  $('clock').textContent = f.clock;
  $('scen').textContent = f.scenario;
  $('step').textContent = f.step;
  const total = f.components && f.components.total || 0;
  $('rew').textContent = Math.round(total).toLocaleString();
  $('rew').className = total < 0 ? 'bad' : 'ok';
  $('stress').textContent = t(o.stressProxy);
  $('divwrap').style.display = o.onDiversion ? '' : 'none';
  $('dtwrap').style.display = o.itDowntime ? '' : 'none';
  if (o.itDowntime) $('dt').textContent = 'IT DOWN ('+o.itDowntime.severity+')';

  const pts = o.patients;
  $('census').textContent = pts.length;
  $('waiting').textContent = pts.filter(p=>p.phase.startsWith('waiting')).length;
  $('boarding').textContent = pts.filter(p=>p.phase==='boarding').length;
  $('holds').textContent = pts.filter(p=>p.psychHold).length;
  const restrained = pts.filter(p=>p.restraint);
  $('restr').textContent = restrained.length;
  // An overdue restraint check is a hard floor accruing right now — make it shout.
  const overdue = restrained.filter(p=>p.restraint.minutesUntilCheckDue < 0).length;
  $('restr').className = overdue ? 'bad' : '';

  // beds
  const beds = o.ed.beds;
  $('bedsum').textContent = beds.filter(b=>b.status==='clean').length+' clean · '
    + beds.filter(b=>b.status==='occupied').length+' occupied · '
    + beds.filter(b=>b.status==='dirty'||b.status==='cleaning').length+' dirty';
  $('beds').innerHTML = beds.map(b =>
    '<div class="bed '+b.status+'" title="'+b.id+' · '+b.status+(b.monitored?' · monitored':'')+(b.negativePressure?' · neg-press':'')+'">'
    + '<span>'+b.id.replace('fast-track','ft').replace('hallway','hall')+'</span>'
    + '<span class="dim">'+(b.patient? b.patient.replace('pt-','#') : b.status[0].toUpperCase())+'</span></div>').join('');

  // patients, sickest first
  const order = {1:0,2:1,3:2,4:3,5:4,null:9};
  $('ptsum').textContent = pts.length+' in dept';
  $('pts').innerHTML = [...pts].sort((a,b)=>(order[a.esi]??9)-(order[b.esi]??9) || b.waitingMinutes-a.waitingMinutes)
    .map(p => {
      const v = p.lastVitals;
      const vs = v ? v.hr+'/'+v.sbp+' rr'+v.rr+' '+v.spo2+'%' : '<span class="dim">not measured</span>';
      const age = p.vitalsAgeMinutes===null ? '<span class="dim">—</span>'
        : '<span class="'+(p.vitalsAgeMinutes>60?'bad':p.vitalsAgeMinutes>30?'warn':'dim')+'">'+p.vitalsAgeMinutes+'m</span>';
      return '<tr><td>'+p.id.replace('pt-','#')+'</td>'
        + '<td><span class="pill '+esiCls(p.esi)+'">'+(p.esi??'?')+'</span></td>'
        + '<td class="dim">'+p.chiefComplaint.slice(0,22)+'</td>'
        + '<td>'+p.phase+'</td>'
        + '<td class="dim">'+t(p.location)+'</td>'
        + '<td class="'+(p.waitingMinutes>120?'bad':p.waitingMinutes>60?'warn':'')+'">'+p.waitingMinutes+'m</td>'
        + '<td>'+vs+'</td><td>'+age+'</td>'
        + '<td class="dim">'+t(p.assignedNurse,'—').replace('rn-','')+'</td>'
        + '<td class="dim">'+t(p.assignedProvider,'—').replace('md-','').replace('app-','a')+'</td>'
        + '<td class="dim">'+p.orders.length+'</td>'
        + '<td>'+t(p.disposition,'')+'</td>'
        + '<td class="'+(p.boardingMinutes>240?'bad':'warn')+'">'+(p.boardingMinutes!==null?p.boardingMinutes+'m':'')+'</td>'
        + '<td>'+behFlags(p)+'</td></tr>';
    }).join('') || '<tr><td colspan="13" class="dim">empty department</td></tr>';

  // interrupts
  $('intsum').textContent = o.interrupts.length+' pending';
  $('ints').innerHTML = [...o.interrupts].sort((a,b)=>a.claimedPriority-b.claimedPriority)
    .map(i => '<tr><td>'+i.source+'</td>'
      + '<td><span class="pill '+esiCls(i.claimedPriority)+'">'+i.claimedPriority+'</span></td>'
      + '<td class="dim">'+i.roleRequired.replace('-nurse','').replace('ed-','')+'</td>'
      + '<td>'+i.waitingMinutes+'m</td>'
      + '<td class="'+(i.ringbacks>2?'bad':'dim')+'">'+i.ringbacks+'</td>'
      + '<td class="'+(i.deadlineInMinutes!==null&&i.deadlineInMinutes<10?'bad':'dim')+'">'+t(i.deadlineInMinutes,'∞')+'</td>'
      + '<td class="'+(i.deferability==='immediate'?'bad':'dim')+'">'+i.deferability+'</td></tr>').join('')
    || '<tr><td class="dim">quiet</td></tr>';

  rows($('roles'), Object.entries(o.roleLoad).map(([r,l]) =>
    [r, bar(l,1,l>0.7)+'<span class="dim"> '+Math.round(l*100)+'%</span>']));

  rows($('down'), o.downstream.length
    ? o.downstream.map(d => [d.level,
        bar(d.occupied,d.capacity,d.occupied/d.capacity>0.9)
        + '<span class="dim"> '+d.occupied+'/'+d.capacity+' +'+d.expectedReleases
        + '</span> <span class="stale">'+d.staleness+'m old</span>'])
    : [['<span class="bad">feed dark — you cannot see, this is not "no capacity"</span>','']]);

  $('hand').innerHTML = o.handoffs.map(h =>
    '<tr><td>'+h.patient.replace('pt-','#')+'</td><td class="dim">'+h.level+'</td>'
    + '<td>'+h.status+'</td><td>'+h.attempts+'x</td>'
    + '<td class="'+(h.openMinutes>45?'bad':'warn')+'">'+h.openMinutes+'m</td>'
    + '<td class="dim">'+t(h.lastRefusal,'')+'</td>'
    + '<td>'+(h.escalated?'<span class="ok">esc</span>':'')+'</td></tr>').join('')
    || '<tr><td class="dim">none open</td></tr>';

  const q = o.queues;
  rows($('queues'), [
    ['collections', q.pendingCollections.length],
    ['awaiting read', q.awaitingRead.length],
    ['pharmacy verify', q.verification.length],
    ['open criticals', (q.openCriticals.length?'<span class="bad">':'<span>')+q.openCriticals.length+'</span>'],
    ['open controlled', q.openControlled.length],
    ['beds dirty', q.cleaning.length],
    ['imaging', q.imaging.map(m=>({'plain-film':'xr'}[m.modality]||m.modality)+':'+m.depth).join(' ')||'—'],
  ]);

  rows($('supply'), o.supply.length
    ? o.supply.map(s => [s.name, '<span class="'+(s.available?'':'bad')+'">'+s.available+'/'+s.capacity
        +'</span> <span class="dim">eta '+t(s.etaHint,'—')+'</span> <span class="stale">'+s.staleness+'m</span>'])
    : [['<span class="bad">feed dark</span>','']]);

  $('acts').innerHTML = (f.lastActions||[]).slice(0,40).map(a =>
    '<div><span class="'+(a.ok?'ok':'bad')+'">'+(a.ok?'✓':'✗')+'</span> '+a.action
    + (a.reason? ' <span class="dim">— '+a.reason.slice(0,70)+'</span>':'')+'</div>').join('')
    || '<span class="dim">idle</span>';

  if (f.safety && f.safety.length){
    $('safety').innerHTML = f.safety.slice().reverse().map(s =>
      '<div'+(f.safety.length>lastSafety?' class="flash"':'')+'>['+Math.round(s.at)+'m] <b>'+s.kind+'</b> '
      + (s.patient? s.patient.replace('pt-','#'):'') + ' <span class="dim">'+s.detail.slice(0,90)+'</span></div>').join('');
    lastSafety = f.safety.length;
  }

  rows($('comp'), Object.entries(f.components||{})
    .filter(([k,v])=>k!=='total' && v)
    .sort((a,b)=>a[1]-b[1])
    .map(([k,v]) => [k, '<span class="'+(v<0?'bad':'ok')+'">'+Math.round(v).toLocaleString()+'</span>']));
}

function connect(){
  const es = new EventSource('/events');
  es.onopen = () => { $('conn').textContent='live'; $('conn').className='status live'; };
  es.onmessage = e => { try { render(JSON.parse(e.data)); } catch(err){ console.error(err); } };
  es.onerror = () => { $('conn').textContent='reconnecting…'; $('conn').className='status down'; };
}
connect();
</script>
</body>
</html>`;
