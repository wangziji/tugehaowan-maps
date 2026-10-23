/* 《同路 · THE SAME ROAD》交互层
 *
 * 依赖：data.js（window.SR_DATA）、model.js（window.SR）、腾讯地图 JSAPI GL（window.TMap）
 * 运行时零 WebService 请求（WebService 无 CORS 头，浏览器直调不通，数据全部预生成打包）。
 */
(function () {
  'use strict';

  var DATA = window.SR_DATA || { cities: [] };
  var M = window.SR;
  var CITY_COLORS = ['#ffd166', '#3aa0ff', '#ff5fb0', '#4ddb9a'];

  var state = { ci: 0, rid: 0, pIdx: 0, rate: 2.5, vmin: 0.6 };
  var map = null, ready = false;
  var L = {};   // 图层：base / mate / sel / shared / mk

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function city() { return DATA.cities[state.ci]; }
  function route() { return city().routes[state.rid]; }
  function partner() {
    var r = route();
    if (!r.partners || !r.partners.length) return null;
    return r.partners[Math.min(state.pIdx, r.partners.length - 1)];
  }
  function showErr(msg) {
    var b = el('errbox');
    if (b) b.innerHTML = '<div class="err">' + esc(msg) + '</div>';
    if (window.console) console.warn('[SR] ' + msg);
  }
  function clearErr() { var b = el('errbox'); if (b) b.innerHTML = ''; }

  /* ---------------- 城市 / 路线选择 ---------------- */
  function buildTabs() {
    var t = el('tabs');
    if (!t) return;
    var h = '';
    DATA.cities.forEach(function (c, i) {
      h += '<button data-c="' + i + '" class="' + (i === state.ci ? 'on' : '') + '">' + esc(c.name) + '</button>';
    });
    t.innerHTML = h;
    Array.prototype.forEach.call(t.querySelectorAll('button'), function (b) {
      b.addEventListener('click', function () {
        state.ci = parseInt(b.getAttribute('data-c'), 10) || 0;
        state.rid = 0; state.pIdx = 0;
        buildTabs(); buildRouteSelect(); renderAll();
      });
    });
  }

  function buildRouteSelect() {
    var s = el('sel-route');
    if (!s) return;
    var C = city();
    var h = '';
    C.routes.forEach(function (r) {
      var tag = r.kind === 'radial' ? '进城' : '横向';
      h += '<option value="' + r.id + '"' + (r.id === state.rid ? ' selected' : '') + '>' +
        esc(tag + ' · ' + r.oName + ' → ' + r.dName) + '</option>';
    });
    s.innerHTML = h;
    if (!s.__bound) {
      s.__bound = true;
      s.addEventListener('change', function () {
        state.rid = parseInt(s.value, 10) || 0;
        state.pIdx = 0;
        renderAll();
      });
    }
  }

  /* ---------------- 地图 ---------------- */
  function mercY(lat) {
    var l = Math.max(-85, Math.min(85, lat));
    return Math.log(Math.tan(Math.PI / 4 + (l * Math.PI / 180) / 2));
  }
  /** 本版 fitBounds 只挪中心不改 zoom，自己按 Web Mercator 解 zoom */
  function fitTo(pts) {
    if (!map || !pts || !pts.length) return;
    var la0 = 90, la1 = -90, ln0 = 180, ln1 = -180;
    pts.forEach(function (p) {
      if (p[0] < la0) la0 = p[0];
      if (p[0] > la1) la1 = p[0];
      if (p[1] < ln0) ln0 = p[1];
      if (p[1] > ln1) ln1 = p[1];
    });
    var w = map.getContainer().offsetWidth || 600;
    var h = map.getContainer().offsetHeight || 400;
    var dxF = Math.max(1e-6, (ln1 - ln0) / 360);
    var dyF = Math.max(1e-6, (mercY(la1) - mercY(la0)) / (2 * Math.PI));
    var z = Math.min(Math.log(w / (256 * dxF)) / Math.LN2, Math.log(h / (256 * dyF)) / Math.LN2) - 0.45;
    z = Math.max(3, Math.min(16, Math.round(z * 10) / 10));
    map.setCenter(new window.TMap.LatLng((la0 + la1) / 2, (ln0 + ln1) / 2));
    map.setZoom(z);
    if (window.__sr_hooks) window.__sr_hooks.lastZoom = z;
  }

  function initMap() {
    if (!window.TMap) { showErr('腾讯地图 JSAPI 未加载，地图不可用（右侧数字与图表仍可使用）。'); return; }
    var C = city();
    try {
      map = new window.TMap.Map('map', {
        center: new window.TMap.LatLng(C.center[0], C.center[1]),
        zoom: 10,
        pitch: 0,
        baseMap: { type: 'vector' }
      });
    } catch (e) {
      showErr('地图初始化失败：' + e.message);
      return;
    }
    // 图层按创建顺序叠：后建的在上。共享段要压在最上面，故最后建（markers 除外）。
    L.base = new window.TMap.MultiPolyline({
      map: map, styles: { base: new window.TMap.PolylineStyle({
        color: 'rgb(58,74,94)', width: 3, borderWidth: 0, lineCap: 'round' }) },
      geometries: []
    });
    L.mate = new window.TMap.MultiPolyline({
      map: map, styles: { mate: new window.TMap.PolylineStyle({
        color: 'rgb(58,160,255)', width: 5, borderWidth: 0, lineCap: 'round' }) },
      geometries: []
    });
    L.sel = new window.TMap.MultiPolyline({
      map: map, styles: { sel: new window.TMap.PolylineStyle({
        color: 'rgb(255,209,102)', width: 5, borderWidth: 0, lineCap: 'round' }) },
      geometries: []
    });
    L.shared = new window.TMap.MultiPolyline({
      map: map, styles: { sh: new window.TMap.PolylineStyle({
        color: 'rgb(255,95,176)', width: 8, borderWidth: 0, lineCap: 'round' }) },
      geometries: []
    });
    L.mk = new window.TMap.MultiMarker({
      map: map,
      styles: {
        center: new window.TMap.MarkerStyle({ width: 16, height: 16, anchor: { x: 8, y: 8 },
          src: svgDot('#ffffff', '#0b1017') }),
        me: new window.TMap.MarkerStyle({ width: 20, height: 20, anchor: { x: 10, y: 10 },
          src: svgDot('#ffd166', '#0b1017') }),
        mate: new window.TMap.MarkerStyle({ width: 20, height: 20, anchor: { x: 10, y: 10 },
          src: svgDot('#3aa0ff', '#0b1017') })
      },
      geometries: []
    });
    ready = true;
    if (window.__sr_hooks) window.__sr_hooks.mapReady = true;
  }

  function svgDot(fill, stroke) {
    var s = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
      '<circle cx="12" cy="12" r="8" fill="' + fill + '" stroke="' + stroke + '" stroke-width="3"/></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
  }

  /** 取两条线重合的那几段折线（用于地图高亮） */
  function sharedSegments(ri, rj, lat0) {
    var cellsJ = M.cellsOf(rj.pts, lat0);
    var out = [];
    var pts = ri.pts;
    for (var i = 0; i < pts.length - 1; i++) {
      var mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
      var p = M.proj(mx, my, lat0);
      var key = Math.floor(p[0] / M.CELL) + ',' + Math.floor(p[1] / M.CELL);
      if (Object.prototype.hasOwnProperty.call(cellsJ, key)) out.push([pts[i], pts[i + 1]]);
    }
    return out;
  }

  function drawMap() {
    if (!ready || !map) return;
    var C = city(), lat0 = C.center[0], r = route(), p = partner();
    var base = [], mk = [];
    C.routes.forEach(function (x) {
      if (x.id === state.rid) return;
      if (p && x.id === p.j) return;
      base.push({ id: 'b' + x.id, styleId: 'base',
        paths: x.pts.map(function (q) { return new window.TMap.LatLng(q[0], q[1]); }) });
    });
    L.base.setGeometries(base);
    L.sel.setGeometries([{ id: 'sel', styleId: 'sel',
      paths: r.pts.map(function (q) { return new window.TMap.LatLng(q[0], q[1]); }) }]);
    mk.push({ id: 'mk-c', styleId: 'center', position: new window.TMap.LatLng(C.center[0], C.center[1]) });
    mk.push({ id: 'mk-me', styleId: 'me', position: new window.TMap.LatLng(r.o[0], r.o[1]) });

    if (p) {
      var rj = C.routes[p.j];
      L.mate.setGeometries([{ id: 'mate', styleId: 'mate',
        paths: rj.pts.map(function (q) { return new window.TMap.LatLng(q[0], q[1]); }) }]);
      mk.push({ id: 'mk-mate', styleId: 'mate', position: new window.TMap.LatLng(rj.o[0], rj.o[1]) });
      var segs = sharedSegments(r, rj, lat0);
      L.shared.setGeometries(segs.map(function (s, k) {
        return { id: 'sh' + k, styleId: 'sh', paths: [
          new window.TMap.LatLng(s[0][0], s[0][1]), new window.TMap.LatLng(s[1][0], s[1][1])] };
      }));
      if (window.__sr_hooks) window.__sr_hooks.sharedCount = segs.length;
    } else {
      L.mate.setGeometries([]);
      L.shared.setGeometries([]);
      if (window.__sr_hooks) window.__sr_hooks.sharedCount = 0;
    }
    L.mk.setGeometries(mk);
    if (window.__sr_hooks) window.__sr_hooks.baseCount = base.length;

    var pts = r.pts.slice();
    if (p) pts = pts.concat(C.routes[p.j].pts);
    fitTo(pts);
  }

  /* ---------------- 面板 ---------------- */
  function renderKpis() {
    var C = city(), r = route();
    var radIds = C.routes.filter(function (x) { return x.kind === 'radial'; }).map(function (x) { return x.id; });
    var pop = M.popularity(C.ov[r.id], r.id, radIds);
    var core = C.profile[0].ov, far = C.profile[3].ov;
    var rows = [
      ['brand', M.fmtPct(pop.best, 1), '和你最顺路的那个人<br>重合的里程占比'],
      ['blue', M.fmtPct(pop.mean, 1), '和其余 11 条进城线<br>平均重合率'],
      ['pink', core === null ? '—' : M.fmtPct(core, 0), '距市中心 0–2 公里处<br>你和别人共走的比例'],
      ['green', far === null ? '—' : M.fmtPct(far, 1), '距市中心 6–9 公里处<br>你和别人共走的比例']
    ];
    el('kpis').innerHTML = rows.map(function (x) {
      return '<div class="kpi ' + x[0] + '"><b>' + x[1] + '</b><span>' + x[2] + '</span></div>';
    }).join('');
    el('hl-core').textContent = core === null ? '—' : M.fmtPct(core, 0);
    var desc = '从 <b>' + esc(r.oName) + '</b> 到 <b>' + esc(r.dName) + '</b> · ' +
      M.fmtKm(r.dist) + ' 公里 / ' + r.dur + ' 分钟 · ' +
      (r.kind === 'radial' ? '进城通勤' : '横向通勤（不进城）');
    el('route-desc').innerHTML = desc;
    el('pop-note').innerHTML = r.kind === 'radial'
      ? '在这座城市的 12 条进城通勤里，和你最像的那条有 <b>' + M.fmtPct(pop.best, 1) +
        '</b> 的里程和你压在同一个 150 米格子里——你们每天早高峰擦肩而过，从未相识。'
      : '你选的是一条不进城的横向线。它和进城线的平均重合率只有 <b>' + M.fmtPct(pop.mean, 1) +
        '</b>——横向通勤活在另一座城市里。';
  }

  function renderProfile() {
    var C = city(), pr = C.profile;
    var mx = 0;
    pr.forEach(function (x) { if (x.ov !== null && x.ov > mx) mx = x.ov; });
    mx = Math.max(mx, 0.01);
    var W = 400, H = 130, pad = 26, bw = 46;
    var s = '';
    pr.forEach(function (x, i) {
      var v = x.ov === null ? 0 : x.ov;
      var hh = (v / mx) * (H - 44);
      var cx = pad + i * ((W - pad - 10) / pr.length) + 16;
      var col = i === 0 ? '#ff5fb0' : (i <= 2 ? '#3aa0ff' : '#3a4a5e');
      if (x.ov === null) col = '#222c38';
      s += '<rect x="' + (cx - bw / 2) + '" y="' + (H - 26 - hh) + '" width="' + bw + '" height="' +
        Math.max(1, hh) + '" rx="3" fill="' + col + '"/>';
      s += '<text x="' + cx + '" y="' + (H - 30 - hh) + '" text-anchor="middle" font-size="10" fill="#e8eef6">' +
        (x.ov === null ? '—' : (100 * v).toFixed(0) + '%') + '</text>';
      s += '<text x="' + cx + '" y="' + (H - 12) + '" text-anchor="middle" font-size="9.5" fill="#8fa3b8">' +
        x.bin + '</text>';
    });
    s += '<text x="4" y="12" font-size="9.5" fill="#61738a">重合率</text>';
    s += '<text x="' + (W - 4) + '" y="12" text-anchor="end" font-size="9.5" fill="#61738a">距市中心（公里）</text>';
    el('chart-profile').innerHTML = s;
    var c0 = pr[0].ov, c3 = pr[3].ov;
    el('prof-note').innerHTML =
      '在离市中心 0–2 公里的地方，通勤路线有 <b>' + M.fmtPct(c0, 0) + '</b> 的里程是别人也在走的；' +
      '到了 6 公里外，这个数字掉到 <b>' + (c3 === null ? '0' : M.fmtPct(c3, 1)) + '</b>。' +
      '<b>你的通勤在起点 100% 属于你，在终点几乎不属于你。</b>';
  }

  function renderPartners() {
    var C = city(), r = route();
    var box = el('plist');
    if (!r.partners || !r.partners.length) {
      box.innerHTML = '<div class="note">这条是横向通勤，没有进城拼车对象——' +
        '这正是「横向通勤活在另一座城市」的证据。</div>';
      el('partner-note').innerHTML = '';
      return;
    }
    box.innerHTML = r.partners.map(function (p, i) {
      var rj = C.routes[p.j];
      return '<div class="pitem' + (i === state.pIdx ? ' on' : '') + '" data-p="' + i + '">' +
        '<div class="r1"><span class="nm">' + esc(rj.oName) + '</span>' +
        '<span class="ov">' + M.fmtPct(p.ov, 1) + '</span></div>' +
        '<div class="r2">' + M.fmtKm(rj.dist) + ' 公里 / ' + rj.dur + ' 分钟 · 接驾绕行 ' +
        M.fmtKm(p.pickup) + ' 公里（' + p.pickupT + ' 分钟）</div></div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('.pitem'), function (n) {
      n.addEventListener('click', function () {
        state.pIdx = parseInt(n.getAttribute('data-p'), 10) || 0;
        renderAll();
      });
    });
    var p = partner(), rj = C.routes[p.j];
    var shared = M.sharedMeters(M.cellsOf(r.pts, C.center[0]), M.cellsOf(rj.pts, C.center[0]));
    el('partner-note').innerHTML = '你们共同走过的路是 <b>' + M.fmtKm(shared) +
      ' 公里</b>（地图上粉色那段）。但重合发生在<b>终点端</b>，接驾绕行发生在<b>起点端</b>——' +
      '所以「顺路」和「拼车划算」是两件事。';
  }

  function renderLedger() {
    var C = city(), r = route(), p = partner();
    var box = el('ledger');
    if (!p) { box.innerHTML = ''; el('verdict').innerHTML = ''; el('settle').innerHTML = ''; el('settle-note').innerHTML = ''; return; }
    var rj = C.routes[p.j];
    var bk = M.legBooks(r, rj, p.pickup, p.pickupT);
    var ord = M.bestOrder(bk);
    function row(name, total, save, exI, exJ, hi) {
      return '<tr><td>' + name + '</td><td>' + M.fmtKm(total) + ' 公里</td><td>' +
        (save >= 0 ? '−' : '+') + M.fmtKm(Math.abs(save)) + ' 公里</td><td' + (hi ? ' class="hi"' : '') + '>' +
        M.fmtMin(exI) + '</td><td>' + M.fmtMin(exJ) + '</td></tr>';
    }
    var html = '<thead><tr><th>' + (ord === 'i' ? '方案（社会最优在前）' : '方案（社会最优在前）') +
      '</th><th>总里程</th><th>比各开各的</th><th>你多花</th><th>他多花</th></tr></thead><tbody>';
    var solo = r.dist + rj.dist;
    html += row('各开各的（基线）', solo, 0, 0, 0, false);
    html += row((ord === 'i' ? '★ ' : '') + '你先上车', bk.iFirst.totalM, bk.iFirst.saveM,
      bk.iFirst.extraI, bk.iFirst.extraJ, ord === 'i');
    html += row((ord === 'j' ? '★ ' : '') + '他先上车', bk.jFirst.totalM, bk.jFirst.saveM,
      bk.jFirst.extraI, bk.jFirst.extraJ, ord === 'j');
    html += '</tbody>';
    box.innerHTML = html;

    var best = ord === 'i' ? bk.iFirst : bk.jFirst;
    var v = [];
    if (best.totalM > solo) {
      v.push('两个人拼一辆车，跑的总里程是 <b>' + M.fmtKm(best.totalM) + ' 公里</b>，' +
        '比各开各的（' + M.fmtKm(solo) + ' 公里）还多 <b>' + M.fmtKm(best.totalM - solo) +
        ' 公里</b>。接人的绕行吃掉了全部节省——<b>拼车不减排，只减车</b>。');
    } else {
      v.push('社会最优方案总里程 <b>' + M.fmtKm(best.totalM) + ' 公里</b>，比各开各的省 <b>' +
        M.fmtKm(solo - best.totalM) + ' 公里</b>。');
    }
    if (ord === 'i') {
      v.push('你先上车：你多花 <b>' + M.fmtMin(bk.iFirst.extraI) + '</b>，他多花 <b>0 分钟</b>。');
    } else {
      v.push('他先上车：他多花 <b>' + M.fmtMin(bk.jFirst.extraJ) + '</b>，你多花 <b>0 分钟</b>。');
    }
    v.push('<b>后上车的人，时间成本恒为 0</b>——两条进城线终点相同，他上车之后的路线和他自己开车一模一样。' +
      '接人的那段绕行，只有先上车的人一个人在付。');
    el('verdict').innerHTML = v.join('<br>');
    renderSettle(bk, ord);
  }

  function renderSettle(bk, ord) {
    var C = city(), r = route(), p = partner();
    var rj = C.routes[p.j];
    var st = M.settle(bk, ord, r.dist, rj.dist, 14, state.rate, state.vmin);
    var iAmFirst = (ord === 'i');
    var myExtra = iAmFirst ? st.extraI : st.extraJ;
    var hisExtra = iAmFirst ? st.extraJ : st.extraI;
    function line(who, solo, pay, extra, net, hi) {
      return '<tr><td>' + who + '</td><td>' + solo.toFixed(1) + ' 元</td><td>' + pay.toFixed(1) +
        ' 元</td><td' + (hi ? ' class="hi"' : '') + '>' + (net >= 0 ? '+' : '−') +
        Math.abs(net).toFixed(1) + ' 元</td></tr>';
    }
    el('settle').innerHTML = '<thead><tr><th>按独立里程占比分摊</th><th>各开各的</th><th>分摊后</th>' +
      '<th>扣掉多花的时间</th></tr></thead><tbody>' +
      line('你', st.soloI, st.payI, myExtra, st.netI, true) +
      line('他', st.soloJ, st.payJ, hisExtra, st.netJ, false) + '</tbody>';
    var who = iAmFirst ? '你' : '他';
    var net = iAmFirst ? st.netI : st.netJ;
    el('settle-note').innerHTML =
      '拼车总价 ' + st.poolFare.toFixed(1) + ' 元，按两人独立里程占比分摊。' +
      '先上车的是<b>' + who + '</b>，多花 ' + M.fmtMin(Math.max(myExtra, hisExtra)) +
      '，按你设定的时间单价折成 ' + (Math.max(myExtra, hisExtra) * state.vmin).toFixed(1) + ' 元。' +
      '扣掉之后，' + who + '的净收益是 <b>' + (net >= 0 ? '+' : '−') + Math.abs(net).toFixed(1) + ' 元</b>' +
      (net < 0 ? '——<b>拼车让他亏了</b>。' : '。');
  }

  function renderSliders() {
    function bind(id, vid, key, fmt) {
      var n = el(id);
      if (!n || n.__b) return;
      n.__b = true;
      n.addEventListener('input', function () {
        state[key] = M.num(n.value, state[key]);
        el(vid).textContent = fmt(state[key]);
        renderLedger();
      });
    }
    bind('in-rate', 'v-rate', 'rate', function (v) { return v.toFixed(1) + ' 元/km'; });
    bind('in-min', 'v-min', 'vmin', function (v) { return v.toFixed(1) + ' 元/分钟'; });
    el('v-rate').textContent = state.rate.toFixed(1) + ' 元/km';
    el('v-min').textContent = state.vmin.toFixed(1) + ' 元/分钟';
  }

  function renderScatter() {
    var W = 400, H = 190, pad = { l: 34, r: 10, t: 12, b: 26 };
    var pts = [];
    DATA.cities.forEach(function (C, ci) {
      C.routes.forEach(function (r) {
        if (r.kind !== 'radial') return;
        r.partners.forEach(function (p) {
          var rj = C.routes[p.j];
          var bk = M.legBooks(r, rj, p.pickup, p.pickupT);
          pts.push({ ci: ci, ov: p.ov, ex: bk.iFirst.extraI });
        });
      });
    });
    var xm = 0, y0 = 1e9, y1 = -1e9;
    pts.forEach(function (p) { if (p.ov > xm) xm = p.ov; if (p.ex < y0) y0 = p.ex; if (p.ex > y1) y1 = p.ex; });
    y0 = Math.min(y0, -5); y1 = Math.max(y1, 10);
    function X(v) { return pad.l + (v / Math.max(xm, 0.01)) * (W - pad.l - pad.r); }
    function Y(v) { return H - pad.b - ((v - y0) / (y1 - y0)) * (H - pad.t - pad.b); }
    var s = '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="none"/>';
    // 零线
    if (y0 < 0 && y1 > 0) {
      s += '<line x1="' + pad.l + '" y1="' + Y(0) + '" x2="' + (W - pad.r) + '" y2="' + Y(0) +
        '" stroke="#3a4a5e" stroke-dasharray="3 3"/>';
      s += '<text x="' + (W - pad.r) + '" y="' + (Y(0) - 4) + '" text-anchor="end" font-size="9" fill="#61738a">不多花</text>';
    }
    pts.forEach(function (p) {
      var c = p.ci === state.ci ? '#ffd166' : '#2f3c4d';
      var rr = p.ci === state.ci ? 2.6 : 1.8;
      s += '<circle cx="' + X(p.ov).toFixed(1) + '" cy="' + Y(p.ex).toFixed(1) + '" r="' + rr +
        '" fill="' + c + '"/>';
    });
    // 当前选中点
    var pNow = partner(), rNow = route();
    if (pNow && rNow.kind === 'radial') {
      var rj = city().routes[pNow.j];
      var bk = M.legBooks(rNow, rj, pNow.pickup, pNow.pickupT);
      s += '<circle cx="' + X(pNow.ov).toFixed(1) + '" cy="' + Y(bk.iFirst.extraI).toFixed(1) +
        '" r="5" fill="none" stroke="#ff5fb0" stroke-width="1.6"/>';
    }
    s += '<line x1="' + pad.l + '" y1="' + (H - pad.b) + '" x2="' + (W - pad.r) + '" y2="' + (H - pad.b) +
      '" stroke="#3a4a5e"/>';
    s += '<text x="' + pad.l + '" y="' + (H - 8) + '" font-size="9" fill="#61738a">顺路度 0</text>';
    s += '<text x="' + (W - pad.r) + '" y="' + (H - 8) + '" text-anchor="end" font-size="9" fill="#61738a">' +
      (100 * Math.max(xm, 0.01)).toFixed(0) + '%</text>';
    s += '<text x="4" y="' + pad.t + '" font-size="9" fill="#61738a">你多花（分钟）</text>';
    s += '<text x="4" y="' + (H - pad.b) + '" font-size="9" fill="#61738a">' + y0.toFixed(0) + '</text>';
    el('chart-scatter').innerHTML = s;
    el('scatter-note').innerHTML = '288 组「进城线 × 顺路人」实测。横轴是顺路度，纵轴是你先上车要多花的分钟，' +
      '相关系数只有 <b>r = −0.15</b>——<b>顺路度基本预测不了你会多花多久</b>。' +
      '决定它的不是你们有多像，是你们住得有多远。';
  }

  function renderArtery() {
    var C = city();
    var o = C.outer && C.outer[0];
    var n = C.routes.filter(function (r) { return r.kind === 'radial'; }).length;
    if (!o) { el('artery-note').innerHTML = ''; return; }
    el('artery-note').innerHTML = '距市中心 ' + M.fmtKm(o.d) + ' 公里处，<b>' + esc(o.name || '（无名路段）') +
      '</b> 这 150 米见方的地方，被 <b>' + o.n + ' / ' + n + '</b> 条进城通勤线同时穿过。' +
      '全市 ' + n + ' 个方向的通勤，最后都挤进同一条管子。';
  }

  function renderAll() {
    try {
      clearErr();
      renderKpis();
      renderProfile();
      renderPartners();
      renderLedger();
      renderScatter();
      renderArtery();
      drawMap();
    } catch (e) {
      showErr('渲染出错：' + (e && e.message ? e.message : e));
    }
  }

  function boot() {
    window.__sr_hooks = window.__sr_hooks || {};
    try {
      buildTabs();
      buildRouteSelect();
      renderSliders();
      initMap();
      renderAll();
      if (window.__sr_hooks) window.__sr_hooks.booted = true;
    } catch (e) {
      showErr('初始化失败：' + (e && e.message ? e.message : e));
    }
  }

  window.__sr_boot = boot;
  window.__sr_state = state;
  window.__sr_render = renderAll;

  var started = false;
  function autostart() { if (started) return; started = true; boot(); }
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    autostart();
  } else {
    document.addEventListener('DOMContentLoaded', autostart);
    window.addEventListener('load', autostart);
  }
})();
