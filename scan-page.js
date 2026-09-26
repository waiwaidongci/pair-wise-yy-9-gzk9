// 数字化交付页面与页面操作：登记扫描单、完成交付、更正扫描单，以及待复扫/已交付/历次扫描视图。
export function scanPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>数字化交付 · 扫描单</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; margin-top:12px; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar input { width:auto; min-width:200px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:110px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    .panel { margin-bottom:14px; } .hrow { border-top:1px solid var(--line); padding:8px 0; }
    .nav { display:flex; gap:12px; align-items:center; } .nav a { color:var(--accent); font-weight:700; text-decoration:none; }
    #msg { display:none; padding:10px 28px; background:#fff; border-bottom:1px solid var(--line); font-weight:700; } #msg.show { display:block; } #msg.warn { color:var(--warn); }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>数字化交付 · 扫描单</h1><div class="meta">登记底片扫描、复扫拦截、交付复核与历次扫描</div></div><div class="nav"><a href="/">底片整理室</a><button id="reload">刷新</button></div></header>
  <div id="msg"></div>
  <main>
    <section>
      <form id="createForm"><h2>登记扫描单</h2><div class="scanFields"></div><button>登记</button><div class="meta" style="margin-top:10px">设备校准过期或目标分辨率低于 1200 时留在待复扫，不占工位。</div></form>
      <form id="completeForm" style="margin-top:14px"><h2>完成交付</h2><label>扫描中的扫描单</label><select name="id" id="completeSelect"></select><label>文件数</label><input name="fileCount" type="number" min="1" step="1" required><label>校验码</label><input name="checksum" required><label>复核人</label><input name="reviewer" required><button>交付</button><div class="meta" style="margin-top:10px">复核人与扫描人相同时交付退回。</div></form>
      <form id="editForm" style="margin-top:14px"><h2>更正扫描单</h2><label>选择扫描单</label><select name="id" id="editSelect"></select><div class="scanFields"></div><button>保存更正</button><div class="meta" style="margin-top:10px">已交付的单子更换底片编号或设备后，原交付失效。</div></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><input id="search" placeholder="搜索编号、设备或人员"></div>
      <div class="panel"><h2>扫描中 · 占用工位</h2><div class="grid" id="activeCards"></div></div>
      <div class="panel"><h2>待复扫 · 不占工位</h2><div class="grid" id="rescanCards"></div></div>
      <div class="panel"><h2>已交付</h2><div class="grid" id="deliveredCards"></div></div>
      <div class="panel"><h2>历次扫描</h2><div id="history"></div></div>
    </section>
  </main>
  <script>
    const scanFields = [["filmCode","底片编号","text"],["device","设备（工位）","text"],["calibrationDate","校准日期","date"],["resolution","目标分辨率","number"],["scanner","扫描人","text"]];
    const statuses = ["扫描中","待复扫","已交付","已失效"];
    const createForm = document.querySelector('#createForm');
    const completeForm = document.querySelector('#completeForm');
    const editForm = document.querySelector('#editForm');
    const completeSelect = document.querySelector('#completeSelect');
    const editSelect = document.querySelector('#editSelect');
    const statsEl = document.querySelector('#stats');
    const msgEl = document.querySelector('#msg');
    let orders = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }
    function showMsg(text, warn) { msgEl.textContent = text; msgEl.className = warn ? 'show warn' : 'show'; }
    function renderForms() {
      const html = scanFields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" required>').join('');
      document.querySelectorAll('.scanFields').forEach(el => { el.innerHTML = html; });
    }
    function cardHtml(o) {
      const base = [['底片编号',o.filmCode],['设备（工位）',o.device],['校准日期',o.calibrationDate],['目标分辨率',o.resolution],['扫描人',o.scanner]].map(p => '<div><b>'+p[0]+'</b> '+(p[1] ?? '')+'</div>').join('');
      const warn = o.status === '待复扫' ? '<div class="warn">'+(o.rescanReasons || []).join('；')+'，不占工位</div>' : '';
      const delivered = o.status === '已交付' ? '<div><b>文件数</b> '+o.fileCount+'</div><div><b>校验码</b> '+o.checksum+'</div><div><b>复核人</b> '+o.reviewer+'</div>' : '';
      const logs = (o.logs || []).slice(-3).map(l => '<div>'+(l.at || '').slice(0,10)+' '+l.step+'：'+l.note+'</div>').join('');
      return '<article class="card"><h3>'+o.id+'</h3><span class="pill">'+o.status+'</span>'+base+warn+delivered+'<div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    function historyHtml(o) {
      const logs = (o.logs || []).map(l => '<div>'+(l.at || '').slice(0,10)+' '+l.step+'：'+l.note+'</div>').join('');
      return '<div class="hrow"><b>'+o.id+'</b> <span class="pill">'+o.status+'</span> <span class="meta">底片 '+o.filmCode+' · 设备 '+o.device+' · 扫描人 '+o.scanner+'</span><div class="logs meta">'+(logs || '暂无记录')+'</div></div>';
    }
    function render() {
      const q = document.querySelector('#search').value.trim();
      const match = o => !q || JSON.stringify(o).includes(q);
      statsEl.innerHTML = statuses.map(s => '<div class="stat"><span>'+s+'</span><strong>'+orders.filter(o => o.status === s).length+'</strong></div>').join('');
      const section = (id, s) => { const list = orders.filter(o => o.status === s && match(o)); document.querySelector(id).innerHTML = list.map(cardHtml).join('') || '<div class="meta">暂无</div>'; };
      section('#activeCards', '扫描中');
      section('#rescanCards', '待复扫');
      section('#deliveredCards', '已交付');
      const history = orders.filter(match);
      document.querySelector('#history').innerHTML = history.map(historyHtml).join('') || '<div class="meta">暂无记录</div>';
      renderSelects();
    }
    function renderSelects() {
      const curComplete = completeSelect.value;
      const actives = orders.filter(o => o.status === '扫描中');
      completeSelect.innerHTML = actives.map(o => '<option value="'+o.id+'">'+o.id+' · '+o.filmCode+' · '+o.device+'</option>').join('') || '<option value="">暂无扫描中的扫描单</option>';
      completeSelect.value = curComplete;
      const curEdit = editSelect.value;
      const editable = orders.filter(o => o.status !== '已失效');
      editSelect.innerHTML = editable.map(o => '<option value="'+o.id+'">'+o.id+' · '+o.filmCode+' · '+o.status+'</option>').join('') || '<option value="">暂无可更正的扫描单</option>';
      editSelect.value = curEdit;
      prefillEdit();
    }
    function prefillEdit() {
      const o = orders.find(x => x.id === editSelect.value);
      scanFields.forEach(([key]) => { editForm.elements[key].value = o ? (o[key] ?? '') : ''; });
    }
    async function load() { orders = await api('/api/scan-orders'); render(); }
    createForm.onsubmit = async event => {
      event.preventDefault();
      try {
        const order = await api('/api/scan-orders', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) });
        createForm.reset();
        showMsg(order.id + ' 登记成功：' + order.status, order.status === '待复扫');
        await load();
      } catch (error) { alert(error.message); }
    };
    completeForm.onsubmit = async event => {
      event.preventDefault();
      if (!completeSelect.value) { alert('暂无扫描中的扫描单可交付'); return; }
      try {
        const data = await api('/api/scan-orders/' + completeSelect.value + '/complete', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(completeForm).entries())) });
        completeForm.reset();
        showMsg(data.outcome === 'delivered' ? data.order.id + ' 已交付' : data.order.id + ' 交付退回：复核人与扫描人相同', data.outcome !== 'delivered');
        await load();
      } catch (error) { alert(error.message); }
    };
    editForm.onsubmit = async event => {
      event.preventDefault();
      if (!editSelect.value) { alert('请选择扫描单'); return; }
      try {
        const order = await api('/api/scan-orders/' + editSelect.value, { method:'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(editForm).entries())) });
        showMsg(order.status === '已失效' ? order.id + ' 底片编号或设备已更换，原交付失效' : order.id + ' 已保存更正：' + order.status, order.status !== '扫描中');
        await load();
      } catch (error) { alert(error.message); }
    };
    editSelect.onchange = prefillEdit;
    document.querySelector('#search').oninput = render;
    document.querySelector('#reload').onclick = load;
    renderForms(); load();
  </script>
</body>
</html>`;
}
