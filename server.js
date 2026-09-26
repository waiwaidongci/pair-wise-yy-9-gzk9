// 页面操作：HTTP 路由与页面渲染（业务规则见 rules.js，记录保存见 store.js）
import http from "node:http";
import { loadDb, saveDb, newId } from "./store.js";
import { STATUS, RuleError, createScan, completeScan, editScan, evaluateStatus, holdsStation } from "./rules.js";

const port = Number(process.env.PORT || 3040);
const fields = [["code","底片编号","text"],["plateSize","玻璃板尺寸","text"],["chemicalBatch","药液批次","text"],["exposure","曝光时间","text"],["waterSource","冲洗水源","text"],["box","存放盒位","text"]];
const stages = ["待曝光","冲洗中","待入盒","已交付"];
const statLabels = ["待曝光","冲洗中","待入盒","已交付"];
const extraFields = [["step","步骤"],["developStatus","显影状态"],["defect","缺陷类型"],["repair","修补记录"],["note","备注"]];

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
  }
  return stats;
}
function summarize(item) {
  const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  return { ...item, logCount };
}
function layout(title, subtitle, nav, content) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button, a.navbtn { display:inline-block; text-decoration:none; border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary, a.navbtn.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:120px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>${title}</h1><div class="meta">${subtitle}</div></div><div style="display:flex;gap:10px">${nav}</div></header>
  ${content}
</body>
</html>`;
}
function page() {
  const content = `
  <main>
    <section>
      <form id="createForm"><h2>新增底片</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存底片</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>记录工艺步骤</h2><label>选择底片</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><button>提交记录</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel"><h2>创建蓝晒任务后，按涂布、晾干、曝光、冲洗、复晒、入盒记录每一步历史。</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    const fields = [["code","底片编号","text"],["plateSize","玻璃板尺寸","text"],["chemicalBatch","药液批次","text"],["exposure","曝光时间","text"],["waterSource","冲洗水源","text"],["box","存放盒位","text"]];
    const stages = ["待曝光","冲洗中","待入盒","已交付"];
    const extraFields = [["step","步骤"],["developStatus","显影状态"],["defect","缺陷类型"],["repair","修补记录"],["note","备注"]];
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    let items = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
    }
    function render() {
      itemSelect.innerHTML = items.map(item => '<option value="'+(item.id || item.code)+'">'+(item.code || item.id)+' · '+(item.name || item.shipType || item.source || item.plateSize || '')+'</option>').join('');
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => { await api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); await load(); });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const id = btn.dataset.note; const note = prompt('记录备注'); if (note) { await api('/api/items/'+id+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } });
    }
    function cardHtml(item) {
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+(item[key] ?? '')+'</div>').join('');
      const tasks = (item.tasks || []).map(t => '<div class="meta">任务 '+t.position+' · '+t.status+' · '+t.tension+'</div>').join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+l.step+'：'+l.note+'</div>').join('');
      return '<article class="card"><h3>'+(item.code || item.id)+'</h3><span class="pill">'+item.status+'</span>'+main+tasks+'<label>状态</label><select data-status="'+(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select><button class="secondary" data-note="'+(item.id || item.code)+'">追加备注</button><div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    async function load() { items = await api('/api/items'); render(); }
    createForm.onsubmit = async event => { event.preventDefault(); await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); await load(); };
    actionForm.onsubmit = async event => { event.preventDefault(); await api('/api/items/'+itemSelect.value+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(actionForm).entries())) }); actionForm.reset(); await load(); };
    document.querySelector('#statusFilter').onchange = render; document.querySelector('#search').oninput = render; document.querySelector('#reload').onclick = load;
    renderForms(); load();
  </script>`;
  return layout("古法蓝晒底片整理室", "底片任务、工艺步骤、缺陷和入盒交付", '<a class="navbtn secondary" href="/scans">数字化交付</a><button id="reload">刷新</button>', content);
}
function scansPage() {
  const content = `
  <main>
    <section>
      <form id="scanForm"><h2 id="scanFormTitle">登记扫描单</h2><div id="scanFields"></div><button id="scanSubmit">登记扫描单</button><button type="button" class="secondary" id="cancelEdit" style="display:none;margin-top:8px">取消修改</button></form>
      <form id="completeForm" style="margin-top:14px"><h2>完成交付</h2><label>选择扫描单</label><select name="id" id="completeSelect" required></select><label>文件数</label><input name="fileCount" type="number" min="1" required><label>校验码</label><input name="checksum" required><label>复核人</label><input name="reviewer" required><button>提交交付</button></form>
    </section>
    <section>
      <div class="stats" id="scanStats"></div>
      <div class="panel"><h2>待复扫 / 已退回（不占工位）</h2><div class="grid" id="rescanList"></div></div>
      <div class="panel" style="margin-top:14px"><h2>已交付</h2><div class="grid" id="deliveredList"></div></div>
      <div class="panel" style="margin-top:14px"><h2>历次扫描</h2><div class="grid" id="historyList"></div></div>
    </section>
  </main>
  <datalist id="negativeCodes"></datalist>
  <script>
    const scanFields = [["negativeCode","底片编号","text"],["device","扫描设备","text"],["station","工位","text"],["calibrationDate","设备校准日期","date"],["resolution","目标分辨率(dpi)","number"],["scanner","扫描人","text"]];
    const statusList = ["进行中","待复扫","已交付","已退回"];
    const scanForm = document.querySelector('#scanForm');
    const completeForm = document.querySelector('#completeForm');
    const completeSelect = document.querySelector('#completeSelect');
    let scans = [], items = [], editingId = null;
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }
    function renderScanForm() {
      document.querySelector('#scanFields').innerHTML = scanFields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" required '+(key==='negativeCode'?'list="negativeCodes"':'')+'>').join('');
    }
    function setEditing(id) {
      editingId = id;
      document.querySelector('#scanFormTitle').textContent = id ? '修改扫描单 ' + id : '登记扫描单';
      document.querySelector('#scanSubmit').textContent = id ? '保存修改' : '登记扫描单';
      document.querySelector('#cancelEdit').style.display = id ? '' : 'none';
      if (!id) scanForm.reset();
    }
    function baseCard(scan) {
      return '<h3>'+scan.id+' · '+scan.negativeCode+'</h3><span class="pill">'+scan.status+'</span>'
        + '<div><b>设备</b> '+scan.device+'</div><div><b>工位</b> '+scan.station+'</div>'
        + '<div><b>校准日期</b> '+scan.calibrationDate+'</div><div><b>目标分辨率</b> '+scan.resolution+'</div><div><b>扫描人</b> '+scan.scanner+'</div>';
    }
    function historyHtml(scan) {
      return (scan.history || []).map(h => '<div>'+String(h.at).slice(0,16).replace('T',' ')+' '+h.step+'：'+h.note+'</div>').join('') || '暂无记录';
    }
    function render() {
      document.querySelector('#negativeCodes').innerHTML = items.map(i => '<option value="'+(i.code || i.id)+'">').join('');
      const stats = Object.fromEntries(statusList.map(s => [s, scans.filter(x => x.status === s).length]));
      document.querySelector('#scanStats').innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const open = scans.filter(s => s.status !== '已交付');
      completeSelect.innerHTML = open.map(s => '<option value="'+s.id+'">'+s.id+' · '+s.negativeCode+' · '+s.status+'</option>').join('');
      document.querySelector('#rescanList').innerHTML = scans.filter(s => s.status === '待复扫' || s.status === '已退回').map(scan => {
        const problems = (scan.problems || []).map(p => '<div class="warn">'+p+'</div>').join('');
        return '<article class="card">'+baseCard(scan)+problems+'<button class="secondary" data-edit="'+scan.id+'">修改</button><div class="logs meta">'+historyHtml(scan)+'</div></article>';
      }).join('') || '<div class="meta">暂无待复扫或退回的扫描单</div>';
      document.querySelector('#deliveredList').innerHTML = scans.filter(s => s.status === '已交付').map(scan =>
        '<article class="card">'+baseCard(scan)+'<div><b>文件数</b> '+scan.fileCount+'</div><div><b>校验码</b> '+scan.checksum+'</div><div><b>复核人</b> '+scan.reviewer+'</div><div class="meta">完成于 '+String(scan.completedAt || '').slice(0,16).replace('T',' ')+'</div><button class="secondary" data-edit="'+scan.id+'">修改</button><div class="logs meta">'+historyHtml(scan)+'</div></article>'
      ).join('') || '<div class="meta">暂无已交付的扫描单</div>';
      document.querySelector('#historyList').innerHTML = scans.map(scan =>
        '<article class="card">'+baseCard(scan)+'<div class="logs meta">'+historyHtml(scan)+'</div></article>'
      ).join('') || '<div class="meta">暂无扫描记录</div>';
      document.querySelectorAll('[data-edit]').forEach(btn => btn.onclick = () => {
        const scan = scans.find(s => s.id === btn.dataset.edit);
        if (!scan) return;
        for (const [key] of scanFields) scanForm.elements[key].value = scan[key] ?? '';
        setEditing(scan.id);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }
    async function load() {
      [items, scans] = await Promise.all([api('/api/items'), api('/api/scans')]);
      render();
    }
    scanForm.onsubmit = async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(scanForm).entries());
      try {
        if (editingId) await api('/api/scans/'+editingId, { method:'PATCH', body: JSON.stringify(data) });
        else await api('/api/scans', { method:'POST', body: JSON.stringify(data) });
        setEditing(null);
        await load();
      } catch (error) { alert(error.message); }
    };
    document.querySelector('#cancelEdit').onclick = () => setEditing(null);
    completeForm.onsubmit = async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(completeForm).entries());
      const id = data.id;
      delete data.id;
      try {
        await api('/api/scans/'+id+'/complete', { method:'POST', body: JSON.stringify(data) });
        completeForm.reset();
        await load();
      } catch (error) { alert(error.message); await load(); }
    };
    document.querySelector('#reload').onclick = load;
    renderScanForm(); load();
  </script>`;
  return layout("数字化交付", "扫描单登记、复扫、交付与历次扫描", '<a class="navbtn secondary" href="/">底片整理室</a><button id="reload">刷新</button>', content);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/scans") return html(res, scansPage());
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, db.items.map(summarize));
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      const item = { id: newId("CN"), ...input, logs: [{ at: new Date().toISOString(), step: "建档", note: "创建底片" }] };

      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, item);
    }
    if (req.method === "GET" && url.pathname === "/api/scans") {
      const now = new Date();
      return send(res, 200, db.scans.map(scan => ({
        ...scan,
        holdsStation: holdsStation(scan),
        problems: scan.status === STATUS.DELIVERED ? [] : evaluateStatus(scan, now).problems,
      })));
    }
    if (req.method === "POST" && url.pathname === "/api/scans") {
      try {
        const input = await body(req);
        const scan = createScan(db.scans, input, newId("SC"), new Date());
        db.scans.unshift(scan);
        await saveDb(db);
        return send(res, 201, scan);
      } catch (error) {
        if (error instanceof RuleError) return send(res, 409, { error: error.message, code: error.code });
        throw error;
      }
    }
    const scanPatch = url.pathname.match(/^\/api\/scans\/([^/]+)$/);
    if (scanPatch && req.method === "PATCH") {
      const scan = db.scans.find(x => x.id === scanPatch[1]);
      if (!scan) return send(res, 404, { error: "scan_not_found" });
      try {
        const result = editScan(db.scans, scan, await body(req), new Date());
        await saveDb(db);
        return send(res, 200, { ...result.scan, invalidated: result.invalidated });
      } catch (error) {
        if (error instanceof RuleError) return send(res, 409, { error: error.message, code: error.code });
        throw error;
      }
    }
    const scanComplete = url.pathname.match(/^\/api\/scans\/([^/]+)\/complete$/);
    if (scanComplete && req.method === "POST") {
      const scan = db.scans.find(x => x.id === scanComplete[1]);
      if (!scan) return send(res, 404, { error: "scan_not_found" });
      try {
        const result = completeScan(scan, await body(req), new Date());
        await saveDb(db);
        if (result.returned) return send(res, 409, { error: "复核人与扫描人相同，交付已退回", code: "returned" });
        return send(res, 200, result.scan);
      } catch (error) {
        if (error instanceof RuleError) return send(res, 409, { error: error.message, code: error.code });
        throw error;
      }
    }
    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const item = db.items.find(x => x.id === patch[1] || x.code === patch[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      Object.assign(item, await body(req));
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + item.status });
      await saveDb(db);
      return send(res, 200, item);
    }
    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const item = db.items.find(x => x.id === log[1] || x.code === log[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
      await saveDb(db);
      return send(res, 201, item);
    }
    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const item = db.items.find(x => x.id === action[1] || x.code === action[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.steps ||= [];
      item.steps.push({ at: new Date().toISOString(), ...input });
      if (input.defect) item.defect = input.defect;
      if (input.step === "冲洗") item.status = "冲洗中";
      else if (input.step === "入盒") item.status = "待入盒";
      else if (input.step === "交付") item.status = "已交付";
      else item.status = "待曝光";
      item.logs.push({ at: new Date().toISOString(), step: input.step || "工艺", note: input.note || input.developStatus || "步骤记录" });
      await saveDb(db);
      return send(res, 201, item);
    }
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("古法蓝晒底片整理室 listening on http://localhost:" + port));
