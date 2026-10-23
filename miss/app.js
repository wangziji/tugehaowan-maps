/* 《错过 · THE MISS》前端接线
 * 纪律备忘（本项目踩过的坑，改动时别踩回去）：
 *  1. 自启动必须真的被调用（readyState + load 兜底），不能只挂 window 上给冒烟脚本用。
 *  2. catch 一定要 showErr，console.warn 等于把 bug 藏起来。
 *  3. fitBounds 在本版只挪中心不改 zoom，zoom 自己按 Web Mercator 解。
 *  4. 颜色只接受 rgb() 或 6 位十六进制，8 位会刷「属性无效」。
 *  5. marker 图标用内联 SVG data URI，官方示例的外链图已 404。
 *  6. 图层按创建顺序叠，后建的在上：路线先建、弯点后建。
 *  7. 不画的图层要 setGeometries([])，否则残留上一种几何。
 */
(function () {
  'use strict';
  var DATA = window.MISS_DATA;
  var M = window.MISS;
  var state = { cityIdx: 0, mode: 'drive', k: 1.0, trips: 500, eps: 0.02, sel: null };

  var map = null, mapReady = false, mapBootTried = false;
  var layerLine = null, layerTurn = null, layerFatal = null, layerEnd = null;
  var fitStamp = 0;

  function $(id) { return document.getElementById(id); }
  function showErr(msg) {
    var e = $('err');
    if (!e) return;
    e.style.display = 'block';
    e.textContent = msg;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function fmtM(m) {
    if (m == null || !isFinite(m)) return '-';
    var a = Math.abs(m);
    if (a >= 1000) return (m / 1000).toFixed(a >= 10000 ? 1 : 2) + ' 公里';
    return Math.round(m) + ' 米';
  }
  function fmtMin(t) {
    if (t == null || !isFinite(t)) return '-';
    var a = Math.abs(t);
    return (a >= 10 ? a.toFixed(0) : a.toFixed(1)) + ' 分钟';
  }
  function fmtKm(m) {
    if (m == null || !isFinite(m)) return '-';
    return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';
  }

  function city() { return DATA.cities[state.cityIdx]; }
  function stats() { return M.cityStats(city(), { k: state.k, eps: state.eps, tripsPerYear: state.trips }); }
  function modeOf(key) {
    var s = stats(), m = null;
    s.modes.forEach(function (x) { if (x.key === key) m = x; });
    return m;
  }
  function curMode() { return modeOf(state.mode); }

  /* 按代价给弯上色（6 位十六进制，不用 8 位） */
  var COLD = '#2563eb', GREY = '#94a3b8', YEL = '#f59e0b', ORG = '#ea580c', RED = '#dc2626', DARK = '#7f1d1d';
  function costColor(c, isFatal) {
    if (isFatal) return DARK;
    if (c < 0) return COLD;
    if (c < 100) return GREY;
    if (c < 500) return YEL;
    if (c < 1500) return ORG;
    return RED;
  }
  function bubble(fill, label, size) {
    var r = Math.round(size / 2) - 2;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
      '" viewBox="0 0 ' + size + ' ' + size + '">' +
      '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="' + fill +
      '" stroke="#ffffff" stroke-width="2.5"/>' +
      '<text x="' + size / 2 + '" y="' + (size / 2 + 4.5) + '" font-size="' + Math.round(size * 0.42) +
      '" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#ffffff">' +
      label + '</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  /* ---------- 地图 ---------- */
  function mercY(lat) {
    var s = Math.sin(lat * Math.PI / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  }
  function fitZoom(b, wPx, hPx, pad) {
    var dLng = Math.max(1e-7, b.maxLng - b.minLng) / 360;
    var dY = Math.max(1e-9, Math.abs(mercY(b.maxLat) - mercY(b.minLat)));
    var availW = Math.max(40, wPx - pad), availH = Math.max(40, hPx - pad);
    var z = Math.min(Math.log2(availW / (256 * dLng)), Math.log2(availH / (256 * dY))) - 0.30;
    return Math.max(3, Math.min(16, z));
  }
  function boundsOf(pts) {
    var b = { minLat: 90, maxLat: -90, minLng: 180, maxLng: -180 };
    pts.forEach(function (p) {
      if (p[0] < b.minLat) b.minLat = p[0];
      if (p[0] > b.maxLat) b.maxLat = p[0];
      if (p[1] < b.minLng) b.minLng = p[1];
      if (p[1] > b.maxLng) b.maxLng = p[1];
    });
    return b;
  }

  function ensureMap() {
    if (map || mapBootTried) return map;
    mapBootTried = true;
    if (typeof TMap === 'undefined') {
      showErr('腾讯地图 JSAPI 未加载成功，地图区域不可用（下方账本、剖面图与排行仍可正常查看）。');
      return null;
    }
    try {
      var c = city();
      map = new TMap.Map('map', {
        center: new TMap.LatLng(c.from[0], c.from[1]),
        zoom: 12, pitch: 0, baseMap: { type: 'vector' }
      });
      map.on('tilesloaded', function () { mapReady = true; fitStamp = 0; fitMap(true); });
      setTimeout(function () { if (!mapReady) { mapReady = true; fitStamp = 0; fitMap(true); } }, 1800);
      // 顺序即叠放顺序：路线在最底，弯点在上，命运的岔口最上
      layerLine = new TMap.MultiPolyline({
        map: map, styles: {
          d: new TMap.PolylineStyle({ color: 'rgb(37,99,235)', width: 5, borderWidth: 1, borderColor: 'rgb(255,255,255)', lineCap: 'round' }),
          b: new TMap.PolylineStyle({ color: 'rgb(13,148,136)', width: 5, borderWidth: 1, borderColor: 'rgb(255,255,255)', lineCap: 'round' }),
          w: new TMap.PolylineStyle({ color: 'rgb(120,113,108)', width: 5, borderWidth: 1, borderColor: 'rgb(255,255,255)', lineCap: 'round' })
        }, geometries: []
      });
      layerTurn = new TMap.MultiMarker({ map: map, styles: {}, geometries: [] });
      layerFatal = new TMap.MultiMarker({ map: map, styles: {}, geometries: [] });
      layerEnd = new TMap.MultiMarker({
        map: map,
        styles: {
          s: new TMap.MarkerStyle({ width: 30, height: 30, anchor: { x: 15, y: 15 }, src: bubble('#1e2430', '起', 30) }),
          e: new TMap.MarkerStyle({ width: 30, height: 30, anchor: { x: 15, y: 15 }, src: bubble('#0f766e', '终', 30) })
        }, geometries: []
      });
      mapReady = true;
    } catch (e) {
      showErr('地图初始化失败：' + (e && e.message ? e.message : e));
      return null;
    }
    return map;
  }

  function fitMap(force) {
    if (!mapReady || !map) return;
    var now = Date.now();
    if (!force && now - fitStamp < 320) return;
    fitStamp = now;
    var src = null;
    city().modes.forEach(function (m) { if (m.key === state.mode) src = m; });
    if (!src) return;
    var b = boundsOf(src.polyline);
    var el = $('map');
    var z = fitZoom(b, el.clientWidth || 640, el.clientHeight || 480, 70);
    try {
      map.setCenter(new TMap.LatLng((b.minLat + b.maxLat) / 2, (b.minLng + b.maxLng) / 2));
      map.setZoom(z);
    } catch (e) { showErr('地图取景失败：' + (e && e.message ? e.message : e)); }
  }

  function drawMap() {
    var m = ensureMap();
    if (!m) return;
    var src = null;
    city().modes.forEach(function (x) { if (x.key === state.mode) src = x; });
    if (!src) return;
    try {
      layerLine.setGeometries([{
        id: 'r', styleId: state.mode === 'drive' ? 'd' : (state.mode === 'bike' ? 'b' : 'w'),
        paths: src.polyline.map(function (p) { return new TMap.LatLng(p[0], p[1]); })
      }]);
      layerEnd.setGeometries([
        { id: 'S', styleId: 's', position: new TMap.LatLng(city().from[0], city().from[1]) },
        { id: 'E', styleId: 'e', position: new TMap.LatLng(city().to[0], city().to[1]) }
      ]);

      var md = curMode();
      var fatal = md && md.fatalTurn ? md.fatalTurn : null;
      var styles = {}, geos = [];
      md.turns.forEach(function (t, i) {
        var isF = fatal && t.s === fatal.s && t.cost === fatal.cost;
        var size = isF ? 40 : (t.cost >= 1500 ? 30 : (t.cost >= 500 ? 25 : (t.cost < 0 ? 22 : 20)));
        var sid = 't' + i;
        styles[sid] = new TMap.MarkerStyle({
          width: size, height: size, anchor: { x: size / 2, y: size / 2 },
          src: bubble(costColor(t.cost, isF), isF ? '!' : String(i + 1), size)
        });
        geos.push({ id: 'g' + i, styleId: sid, position: new TMap.LatLng(t.p[0], t.p[1]) });
      });
      // MultiMarker 没有 updateStyles，样式必须一次建齐 -> 每次重建图层
      layerTurn.setMap(null);
      layerTurn = new TMap.MultiMarker({ map: m, styles: styles, geometries: geos });
      layerTurn.on('click', function (evt) {
        var id = evt && evt.geometry && evt.geometry.id;
        if (!id) return;
        var idx = parseInt(String(id).replace('g', ''), 10);
        if (isFinite(idx) && md.turns[idx]) {
          state.sel = idx;
          renderFatal();
        }
      });
      layerFatal.setGeometries([]);
    } catch (e) {
      showErr('地图绘制失败：' + (e && e.message ? e.message : e));
    }
    fitMap(true);
  }

  /* ---------- Hero ---------- */
  function renderHero() {
    var s = stats(), d = s.drive, w = s.walk;
    var ratio = s.ratioDriveWalk;
    $('hero').innerHTML =
      box('当前路线', city().fromName + ' → ' + city().toName, city().city) +
      box('驾车全程', fmtKm(d.dist) + ' / ' + d.dur + ' 分钟', d.nTurns + ' 个采样弯') +
      box('错过一个弯（驾车）', fmtM(d.typRisk), '最惨 ' + fmtM(d.fatal)) +
      box('开车 ÷ 走路', '<span style="font-size:32px">' + Math.round(ratio) + '</span> 倍',
        '走路典型只要 ' + fmtM(w.typRisk), 'hi');
  }
  function box(k, v, n, cls) {
    return '<div class="box' + (cls ? ' ' + cls : '') + '"><div class="k">' + esc(k) +
      '</div><div class="v">' + v + '</div><div class="n">' + esc(n) + '</div></div>';
  }

  /* ---------- 命运岔口 ---------- */
  function renderFatal() {
    var s = stats(), md = curMode();
    var t = (state.sel != null && md.turns[state.sel]) ? md.turns[state.sel] : (md.fatalTurn || null);
    var isSel = state.sel != null && md.turns[state.sel];
    var el = $('fatalPanel');
    if (!t) { el.innerHTML = '<h3>命运的岔口</h3><p class="note">这条路没有采样到转弯点。</p>'; return; }
    var word = t.cost < 0
      ? '这个弯错过了反而更近 —— 是导航自己绕了路'
      : (t.cost < 100 ? '这个弯几乎错过得起' : '这个弯错过不起');
    el.innerHTML =
      '<h3>' + (isSel ? '你选中的弯' : '命运的岔口 · 这条路上最输不起的弯') + '</h3>' +
      '<div class="fatal"><div class="top"><span class="nm">' + esc(t.road || '无名路段') +
      '</span><span class="tm">距起点 ' + fmtKm(t.s) + '</span></div>' +
      '<div class="big">' + fmtM(t.cost) + '</div>' +
      '<div class="sub2">' + word + '，按这条路的平均速度折算约 ' + fmtMin(t.costMin) + '</div>' +
      '<dl class="kv">' +
      '<dt>转弯角度</dt><dd>' + Math.abs(t.deg).toFixed(0) + '° ' + (t.deg > 0 ? '左' : '右') + '转</dd>' +
      '<dt>出行方式</dt><dd>' + esc(md.name) + '（纠正距离 ' + Math.round(md.Lbase * state.k) + ' 米）</dd>' +
      '<dt>安全余量</dt><dd>为它多留 ' + fmtMin(md.bufferMin) + '</dd>' +
      '</dl></div>' +
      '<p class="note">点地图上的圆点可以看任意一个弯；再点一次城市或方式会回到「最惨的那个」。</p>';
  }

  /* ---------- 三方式 ---------- */
  function renderModes() {
    var s = stats();
    var max = 0;
    s.modes.forEach(function (m) { if (m.typRisk > max) max = m.typRisk; });
    $('modes').innerHTML = s.modes.map(function (m) {
      var w = max > 0 ? Math.max(3, Math.round(100 * Math.max(0, m.typRisk) / max)) : 3;
      var col = m.key === 'drive' ? '#dc2626' : (m.key === 'bike' ? '#ea580c' : '#0f766e');
      return '<div class="mrow' + (m.key === state.mode ? ' on' : '') + '" data-m="' + m.key + '">' +
        '<div class="top"><span class="nm">' + esc(m.name) + '</span>' +
        '<span class="tm">' + fmtKm(m.dist) + ' · ' + m.dur + ' 分钟</span></div>' +
        '<div class="big" style="color:' + col + '">' +
        (m.typRisk < 1 ? '几乎为零' : fmtM(m.typRisk)) + '</div>' +
        '<div class="sub2">错过一个弯的典型代价 ｜ 最惨 ' + fmtM(m.fatal) +
        ' ｜ ' + m.nTurns + ' 个弯中有 ' + m.riskN + ' 个会亏</div>' +
        '<div class="bar"><i style="width:' + w + '%;background:' + col + '"></i></div>' +
        '</div>';
    }).join('');
    Array.prototype.forEach.call($('modes').querySelectorAll('.mrow'), function (el) {
      el.addEventListener('click', function () {
        state.mode = el.getAttribute('data-m');
        state.sel = null;
        renderChips(); renderHero(); renderModes(); renderFatal(); renderProfile(); drawMap();
      });
    });
  }

  /* ---------- 沿程代价剖面 ---------- */
  function renderProfile() {
    var md = curMode();
    var W = 900, H = 300, padL = 62, padR = 16, padT = 18, padB = 44;
    var iw = W - padL - padR, ih = H - padT - padB;
    var cs = md.turns.map(function (t) { return t.cost; });
    var mx = Math.max(100, Math.max.apply(null, cs.map(Math.abs)));
    var mn = Math.min(0, Math.min.apply(null, cs));
    var span = Math.max(1, mx - mn);
    function yOf(v) { return padT + ih * (mx - v) / span; }
    var zero = yOf(0);
    var bw = Math.max(8, Math.min(46, iw / Math.max(1, md.turns.length) - 12));
    var step = iw / Math.max(1, md.turns.length);
    var fatal = md.fatalTurn;
    var svg = '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#ffffff"/>';
    [0, 0.25, 0.5, 0.75, 1].forEach(function (f) {
      var v = mn + span * f, y = yOf(v);
      svg += '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y.toFixed(1) +
        '" stroke="#eef2f7" stroke-width="1"/>';
      svg += '<text x="' + (padL - 8) + '" y="' + (y + 4).toFixed(1) +
        '" font-size="11" fill="#8b95a6" text-anchor="end">' +
        (Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'km' : Math.round(v) + 'm') + '</text>';
    });
    svg += '<line x1="' + padL + '" y1="' + zero.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + zero.toFixed(1) +
      '" stroke="#94a3b8" stroke-width="1.5"/>';
    md.turns.forEach(function (t, i) {
      var x = padL + step * i + (step - bw) / 2;
      var y0 = yOf(Math.max(0, t.cost)), y1 = yOf(Math.min(0, t.cost));
      var isF = fatal && t.s === fatal.s && t.cost === fatal.cost;
      var col = costColor(t.cost, isF);
      svg += '<rect x="' + x.toFixed(1) + '" y="' + y0.toFixed(1) + '" width="' + bw.toFixed(1) +
        '" height="' + Math.max(2, y1 - y0).toFixed(1) + '" fill="' + col + '" rx="3"/>';
      svg += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - padB + 16) +
        '" font-size="11" fill="#5a6577" text-anchor="middle">弯' + (i + 1) + '</text>';
      svg += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - padB + 31) +
        '" font-size="10" fill="#8b95a6" text-anchor="middle">' + fmtKm(t.s) + '</text>';
      if (isF) {
        svg += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (y0 - 6).toFixed(1) +
          '" font-size="12" font-weight="700" fill="#7f1d1d" text-anchor="middle">命运的岔口</text>';
      }
    });
    svg += '<line x1="' + padL + '" y1="' + (padT + ih) + '" x2="' + (W - padR) + '" y2="' + (padT + ih) +
      '" stroke="#cbd5e1" stroke-width="1"/>';
    svg += '<text x="' + padL + '" y="' + (H - 6) + '" font-size="11" fill="#8b95a6">起点</text>';
    svg += '<text x="' + (W - padR) + '" y="' + (H - 6) + '" font-size="11" fill="#8b95a6" text-anchor="end">终点</text>';
    $('prof').innerHTML = svg;
  }

  /* ---------- 排行 ---------- */
  function renderRank() {
    var r = M.rank(DATA.cities, { k: state.k, eps: state.eps, tripsPerYear: state.trips });
    var mx = r[0].drive.typRisk || 1;
    var me = city().code;
    $('rank').innerHTML = r.map(function (c) {
      var w = Math.max(2, Math.round(100 * c.drive.typRisk / mx));
      return '<div class="rrow' + (c.code === me ? ' me' : '') + '">' +
        '<span class="cn">' + esc(c.city) + '</span>' +
        '<span class="tb"><i style="width:' + w + '%"></i></span>' +
        '<span class="vv">' + fmtM(c.drive.typRisk) + '</span></div>';
    }).join('');
  }

  /* ---------- 年损失 ---------- */
  function renderAnnual() {
    var s = stats(), d = s.drive;
    var h = d.annualHours;
    var days = h / 8;
    $('annual').innerHTML =
      '<p style="margin:10px 0 0;font-size:15px">按每年 <b>' + state.trips + '</b> 趟、每个弯 <b>' +
      (state.eps * 100).toFixed(1) + '%</b> 的走错概率估算，' +
      '你一年要为「走错」多花 <b style="font-size:20px;color:#dc2626">' + h.toFixed(1) + ' 小时</b>' +
      '（约 ' + days.toFixed(1) + ' 个工作日），多走 <b>' + (state.trips * d.expM / 1000).toFixed(1) +
      ' 公里</b>。</p>' +
      '<p class="note">这里只累加「真的会亏」的那些弯。代价为负的弯（走错反而更近）不计入，' +
      '所以这是一个偏保守的估计。</p>';
  }

  /* ---------- 控件 ---------- */
  function renderChips() {
    $('cityChips').innerHTML = DATA.cities.map(function (c, i) {
      return '<span class="chip' + (i === state.cityIdx ? ' on' : '') + '" data-c="' + i + '">' +
        esc(c.city) + '</span>';
    }).join('');
    $('modeChips').innerHTML = stats().modes.map(function (m) {
      return '<span class="chip mo' + (m.key === state.mode ? ' on' : '') + '" data-m="' + m.key + '">' +
        esc(m.name) + '</span>';
    }).join('');
    $('kChips').innerHTML = [
      [0.33, '有导航语音提醒'],
      [1.0, '凭记忆开'],
      [2.5, '完全不熟 / 没看导航']
    ].map(function (p) {
      return '<span class="chip' + (p[0] === state.k ? ' on' : '') + '" data-k="' + p[0] + '">' +
        esc(p[1]) + '</span>';
    }).join('');
    var L = curMode();
    $('kNote').textContent = L
      ? '当前：' + L.name + '，走错后要开（走）约 ' + Math.round(L.Lbase * state.k) +
        ' 米才能纠正。三档同比缩放，所以「方式之间的倍数」不随这一档改变。'
      : '';
    bindChips('cityChips', 'c', function (v) {
      state.cityIdx = parseInt(v, 10); state.sel = null; renderAll();
    });
    bindChips('modeChips', 'm', function (v) {
      state.mode = v; state.sel = null; renderAll();
    });
    bindChips('kChips', 'k', function (v) {
      state.k = parseFloat(v); renderAll();
    });
  }
  function bindChips(id, attr, fn) {
    Array.prototype.forEach.call($(id).querySelectorAll('.chip'), function (el) {
      el.addEventListener('click', function () { fn(el.getAttribute('data-' + attr)); });
    });
  }

  function renderAll() {
    renderChips(); renderHero(); renderModes(); renderFatal();
    renderProfile(); renderRank(); renderAnnual(); drawMap();
  }

  /* ---------- 入口 ---------- */
  function boot() {
    var e = $('err');
    if (e) { e.style.display = 'none'; e.textContent = ''; }
    $('trips').addEventListener('input', function () {
      state.trips = M.num(this.value, 500, 50, 1000);
      $('tripsV').textContent = state.trips;
      renderAnnual();
    });
    $('eps').addEventListener('input', function () {
      state.eps = M.num(parseFloat(this.value) / 100, 0.02, 0.002, 0.08);
      $('epsV').textContent = (state.eps * 100).toFixed(1) + '%';
      renderAnnual();
    });
    $('tripsV').textContent = state.trips;
    $('epsV').textContent = (state.eps * 100).toFixed(1) + '%';
    renderAll();
  }

  window.__miss_boot = boot;
  window.__miss_state = state;

  function autostart() {
    try { boot(); }
    catch (err) { showErr('页面初始化出错：' + (err && err.message ? err.message : err)); }
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(autostart, 0);
  } else {
    document.addEventListener('DOMContentLoaded', autostart);
  }
  window.addEventListener('load', function () { if (!mapBootTried) autostart(); });
})();
