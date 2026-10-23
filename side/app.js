/* 《对岸 · THE OTHER SIDE》交互层 */
(function () {
  'use strict';

  var M = window.SIDE;
  var DATA = window.SIDE_DATA;
  var GREEN = '#4dd4ac', MID = '#ffd166', BAD = '#ff6b6b', DIM = '#33445c', POIC = '#ffffff';

  var CITIES = [];
  var CELLS = null, CITYAGG = null, OVERALL = null, BADPOI = null;
  var state = { ci: 0, poi: -1, d: 60, sel: -1, d2: 60 };
  var map = null, lineLayer = null, markLayer = null, ready = false;

  function $(id) { return document.getElementById(id); }
  function fmt(n, d) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    var p = Math.pow(10, d === undefined ? 0 : d);
    return (Math.round(n * p) / p).toFixed(d === undefined ? 0 : d);
  }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c;
    });
  }
  var BRGNAME = ['正北', '东北', '正东', '东南', '正南', '西南', '正西', '西北'];

  function svgIcon(color, r, ring) {
    var s = '<svg xmlns="http://www.w3.org/2000/svg" width="' + (r * 2) + '" height="' + (r * 2) + '">' +
      '<circle cx="' + r + '" cy="' + r + '" r="' + (r - 2) + '" fill="' + color + '" ' +
      'stroke="' + (ring || '#0b1017') + '" stroke-width="2"/></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
  }

  /* ---------- 派生数据 ---------- */
  function init() {
    BADPOI = M.badPois(DATA);
    CELLS = M.cells(DATA);
    CITYAGG = M.cityAgg(DATA);
    OVERALL = M.overall(DATA);
    var seen = {};
    DATA.pois.forEach(function (p, i) {
      if (BADPOI[i]) return;
      if (!seen[p.city]) { seen[p.city] = true; CITIES.push(p.city); }
    });
    state.poi = firstPoiOf(CITIES[0]);
  }
  function poiIdxByCity(city) {
    var out = [];
    DATA.pois.forEach(function (p, i) { if (!BADPOI[i] && p.city === city) out.push(i); });
    return out;
  }
  function firstPoiOf(city) { var a = poiIdxByCity(city); return a.length ? a[0] : -1; }
  function cellOf(pi, d) {
    for (var i = 0; i < CELLS.length; i++) {
      if (CELLS[i].poiIdx === pi && CELLS[i].d === d) return CELLS[i];
    }
    return null;
  }

  /* ---------- KPI ---------- */
  function renderKpi() {
    var o = OVERALL;
    $('k1').textContent = fmt(o.worst60);
    $('k2').textContent = fmt(o.best60);
    $('k3').textContent = fmt(o.spread60);
    $('k4').textContent = fmt(o.unitRatio, 2);
    $('leadWorst').textContent = fmt(o.worst60) + ' 米';
    $('leadBest').textContent = fmt(o.best60) + ' 米';
    $('metaLine').textContent = '8 座城市 · ' + o.nPoi + ' 个临街目的地 · ' + o.nRoute +
      ' 次真实步行路线规划 · 采集时间 ' + DATA.meta.generated_at;
    $('footData').textContent = DATA.meta.calls + ' 次调用 / ' + DATA.meta.fail + ' 次失败，' +
      '有效样本 ' + o.nCell + ' 组（每组 8 个方位）。';
  }

  /* ---------- 选择器 ---------- */
  function buildChips(boxId) {
    var box = $(boxId);
    if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    CITIES.forEach(function (c, i) {
      var b = document.createElement('button');
      b.className = 'chip' + (i === state.ci ? ' on' : '');
      b.textContent = c;
      b.setAttribute('data-c', String(i));
      b.addEventListener('click', function () {
        state.ci = i; state.poi = firstPoiOf(c); state.sel = -1;
        buildChips('cityChips'); buildChips('cityChips2'); buildPoiSel(); render();
      });
      box.appendChild(b);
    });
  }
  function buildDChips() {
    var box = $('dChips');
    if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    DATA.meta.ds.forEach(function (d) {
      var b = document.createElement('button');
      b.className = 'chip' + (d === state.d ? ' on' : '');
      b.textContent = d + ' 米';
      b.setAttribute('data-d', String(d));
      b.addEventListener('click', function () {
        state.d = d; state.sel = -1; buildDChips(); render();
      });
      box.appendChild(b);
    });
  }
  function buildPoiSel() {
    var sel = $('poiSel');
    if (!sel) return;
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    poiIdxByCity(CITIES[state.ci]).forEach(function (pi) {
      var o = document.createElement('option');
      o.value = String(pi);
      o.textContent = DATA.pois[pi].name;
      if (pi === state.poi) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = function () {
      state.poi = parseInt(sel.value, 10); state.sel = -1; render();
    };
  }

  /* ---------- 方位条 ---------- */
  function colorOf(ratio) {
    if (ratio <= 1.35) return GREEN;
    if (ratio <= 2.2) return MID;
    return BAD;
  }
  function renderBars() {
    var box = $('bars');
    if (!box) return;
    var c = cellOf(state.poi, state.d);
    while (box.firstChild) box.removeChild(box.firstChild);
    if (!c) { $('barNote').textContent = '这一家在这一档没有可用样本。'; return; }
    var max = c.worst;
    c.list.slice().sort(function (a, b) { return a.b - b.b; }).forEach(function (r) {
      var ratio = r.dist / state.d;
      var el = document.createElement('div');
      el.className = 'bar' + (state.sel === r.b ? ' on' : '') +
        (r.dist === c.best ? ' best' : '') + (r.dist === c.worst ? ' worst' : '');
      el.setAttribute('data-b', String(r.b));
      var hd = document.createElement('div');
      hd.className = 'hd';
      var nm = document.createElement('span'); nm.className = 'nm';
      nm.textContent = BRGNAME[Math.round(r.b / 45) % 8];
      var tt = document.createElement('span'); tt.className = 'tt';
      tt.innerHTML = '<b>' + fmt(r.dist) + '</b> 米 · ' + fmt(ratio, 2) + ' 倍';
      hd.appendChild(nm); hd.appendChild(tt);
      var tr = document.createElement('div'); tr.className = 'track';
      var sg = document.createElement('div'); sg.className = 'seg';
      sg.style.width = Math.max(4, 100 * r.dist / max) + '%';
      sg.style.background = colorOf(ratio);
      tr.appendChild(sg);
      el.appendChild(hd); el.appendChild(tr);
      el.addEventListener('click', function () {
        state.sel = (state.sel === r.b ? -1 : r.b); renderBars(); drawLines();
      });
      box.appendChild(el);
    });
    $('barNote').textContent = (c.n < 8 ? '这家店有 ' + c.n + ' 个方向的样本可用（其余方向落进了走不进去的地方）。' : '') +
      '这 ' + c.n + ' 条起点直线都是 ' + state.d + ' 米，实际走出 ' + fmt(c.best) + ' ~ ' +
      fmt(c.worst) + ' 米；最贵的那一条，路线最远点离店 ' + fmt(c.devWorst) + ' 米 —— 它是先走远了再折回来的。';
  }

  /* ---------- 城市表 ---------- */
  function renderCityTable() {
    var t = $('cityTable');
    if (!t) return;
    while (t.firstChild) t.removeChild(t.firstChild);
    var rows = CITYAGG.slice().sort(function (a, b) { return b.spread60 - a.spread60; });
    var head = document.createElement('tr');
    ['城市', '过街费', '最贵方位', '单价'].forEach(function (h) {
      var th = document.createElement('th'); th.textContent = h; head.appendChild(th);
    });
    t.appendChild(head);
    rows.forEach(function (c) {
      var tr = document.createElement('tr');
      var td0 = document.createElement('td'); td0.textContent = c.city;
      var td1 = document.createElement('td'); td1.innerHTML = '<b>' + fmt(c.spread60) + '</b> 米';
      var td2 = document.createElement('td'); td2.textContent = fmt(c.worst60) + ' 米';
      var td3 = document.createElement('td'); td3.textContent = fmt(c.unit60, 2) + ' 倍';
      tr.appendChild(td0); tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
      t.appendChild(tr);
    });
    var hi = rows[0], lo = rows[rows.length - 1];
    var exc = rows.filter(function (c) { return c.unit60 <= c.unit240; });
    $('cityNote').textContent = '「过街费」= 同一家店同一距离、最贵方位与最便宜方位之差，取该城中位数。' +
      hi.city + ' 最贵（' + fmt(hi.spread60) + ' 米），' + lo.city + ' 最便宜（' + fmt(lo.spread60) + ' 米）。' +
      (exc.length ? ' 反例：' + exc.map(function (c) { return c.city; }).join('、') +
        ' 在这批样本里「越近越贵」不成立（' + exc.map(function (c) {
          return fmt(c.unit60, 2) + ' 对 ' + fmt(c.unit240, 2);
        }).join('、') + '），差得很少，属于没翻过去。' : '');
  }

  /* ---------- 决策 ---------- */
  function renderDecision() {
    var city = CITIES[state.ci];
    var e = M.estimate(DATA, null, state.d2);
    $('dVal').textContent = String(e.d);
    $('cityVal').textContent = '按 ' + city + ' 的同城实测';
    $('decision').innerHTML =
      '离它 <b>' + e.d + '</b> 米：最便宜的一边走 <b>' + fmt(e.best) + '</b> 米（约 ' + fmt(e.durBest) +
      ' 分钟），最贵的一边走 <b>' + fmt(e.worst) + '</b> 米（约 ' + fmt(e.durWorst) + ' 分钟）。' +
      '差的 <b>' + fmt(e.spread) + '</b> 米基本不随距离变 —— 你离得越近，这笔固定费用摊得越狠：' +
      '现在每米直线要付 <b>' + fmt(e.unit, 2) + '</b> 米的路。' +
      '<span class="alt">能停在同一边就别过街；非过不可，就往有路口 / 斑马线 / 天桥的那一侧走。</span>';
    var c2 = $('cityChips2');
    if (c2) {
      Array.prototype.forEach.call(c2.children, function (b, i) {
        b.className = 'chip' + (i === state.ci ? ' on' : '');
      });
    }
  }

  /* ---------- 地图 ---------- */
  function mercY(lat) {
    return Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / (2 * Math.PI);
  }
  function fitTo(pts) {
    if (!map || !pts.length) return;
    var minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    pts.forEach(function (p) {
      if (p[0] < minLat) minLat = p[0]; if (p[0] > maxLat) maxLat = p[0];
      if (p[1] < minLng) minLng = p[1]; if (p[1] > maxLng) maxLng = p[1];
    });
    var el = $('map');
    var W = (el && el.clientWidth) || 600, H = (el && el.clientHeight) || 430;
    var dx = Math.max(1e-7, (maxLng - minLng) / 360) * 1.25;
    var dy = Math.max(1e-7, Math.abs(mercY(maxLat) - mercY(minLat))) * 1.25;
    var z = Math.min(Math.log(W / (256 * dx)) / Math.LN2, Math.log(H / (256 * dy)) / Math.LN2);
    z = Math.max(3, Math.min(18, z));
    map.setCenter(new window.TMap.LatLng((minLat + maxLat) / 2, (minLng + maxLng) / 2));
    map.setZoom(Math.round(z * 100) / 100);
  }

  /* 样式必须在构造时一次建齐：TMap 的 MultiMarker / MultiPolyline 没有 updateStyles，
   * 也不保证 setStyles 可用，所以这里用一张固定色板，之后只换 geometries。 */
  function stylePalette() {
    var P = {}, K = {};
    [['g', GREEN], ['m', MID], ['b', BAD]].forEach(function (p) {
      ['4', '7'].forEach(function (w) {
        P[p[0] + w] = new window.TMap.PolylineStyle({
          color: p[1], width: parseInt(w, 10), borderWidth: 0, lineCap: 'round'
        });
      });
      ['12', '16'].forEach(function (s) {
        var n = parseInt(s, 10);
        K[p[0] + s] = new window.TMap.MarkerStyle({
          width: n, height: n, anchor: { x: n / 2, y: n / 2 }, src: svgIcon(p[1], n / 2)
        });
      });
    });
    P.d2 = new window.TMap.PolylineStyle({ color: DIM, width: 2, borderWidth: 0, lineCap: 'round' });
    K.d12 = new window.TMap.MarkerStyle({ width: 12, height: 12, anchor: { x: 6, y: 6 }, src: svgIcon(DIM, 6) });
    K.d16 = new window.TMap.MarkerStyle({ width: 16, height: 16, anchor: { x: 8, y: 8 }, src: svgIcon(DIM, 8) });
    K.poi = new window.TMap.MarkerStyle({
      width: 26, height: 26, anchor: { x: 13, y: 13 }, src: svgIcon(POIC, 13, '#ffd166')
    });
    return { P: P, K: K };
  }
  var PAL = null;

  function ensureMap() {
    if (map) return true;
    if (!window.TMap || !$('map')) return false;
    try {
      map = new window.TMap.Map($('map'), {
        center: new window.TMap.LatLng(39.9042, 116.4074),
        zoom: 16, pitch: 0, showControl: false
      });
      PAL = stylePalette();
      // 线先建、点后建：TMap 图层后建的在上，点要压在线上面
      lineLayer = new window.TMap.MultiPolyline({ map: map, styles: PAL.P, geometries: [] });
      markLayer = new window.TMap.MultiMarker({ map: map, styles: PAL.K, geometries: [] });
      ready = true;
    } catch (e) {
      $('mapmsg').textContent = '地图初始化失败：' + (e && e.message ? e.message : String(e));
      return false;
    }
    return true;
  }

  function drawLines() {
    if (!ready || !lineLayer) return;
    var c = cellOf(state.poi, state.d);
    if (!c) { lineLayer.setGeometries([]); markLayer.setGeometries([]); return; }
    try {
      var geoms = [], mgeoms = [], pts = [];
      c.list.forEach(function (r) {
        var ratio = r.dist / state.d;
        var dim = (state.sel >= 0 && state.sel !== r.b);
        var cp = dim ? 'd' : (ratio <= 1.35 ? 'g' : (ratio <= 2.2 ? 'm' : 'b'));
        var hi = (r.dist === c.best || r.dist === c.worst);
        var path = r.poly.map(function (p) { return new window.TMap.LatLng(p[0], p[1]); });
        geoms.push({
          id: 'g' + r.b,
          styleId: cp === 'd' ? 'd2' : cp + (state.sel === r.b ? '7' : '4'),
          paths: path
        });
        path.forEach(function (ll) { pts.push([ll.lat, ll.lng]); });
        mgeoms.push({
          id: 'm' + r.b,
          styleId: cp === 'd' ? (hi ? 'd16' : 'd12') : cp + (hi ? '16' : '12'),
          position: path[0]
        });
      });
      mgeoms.push({ id: 'poi', styleId: 'poi', position: new window.TMap.LatLng(c.lat, c.lng) });
      pts.push([c.lat, c.lng]);
      lineLayer.setGeometries(geoms);
      markLayer.setGeometries(mgeoms);
      fitTo(pts);
      $('mapmsg').textContent = '圆心是这家店，八个小圆点是八个方向的起点（直线都是 ' + state.d +
        ' 米），线是真实步行轨迹。';
    } catch (e) {
      $('mapmsg').textContent = '画轨迹失败：' + (e && e.message ? e.message : String(e));
    }
  }

  function render() {
    renderBars();
    drawLines();
  }

  function bindRange() {
    var r = $('dRange');
    if (!r) return;
    r.addEventListener('input', function () {
      state.d2 = M.num(r.value, 20, 600, 60);
      renderDecision();
    });
  }

  function boot() {
    if (!DATA || !M) {
      var m = $('mapmsg');
      if (m) m.textContent = '数据未加载';
      return;
    }
    try {
      init();
      renderKpi();
      buildChips('cityChips'); buildChips('cityChips2');
      buildDChips(); buildPoiSel();
      bindRange();
      renderCityTable();
      renderDecision();
      render();
      ensureMap();
      drawLines();
    } catch (e) {
      var mm = $('mapmsg');
      if (mm) mm.textContent = '初始化出错：' + (e && e.message ? e.message : String(e));
      throw e;
    }
  }

  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot);
  window.__side_boot = boot;   /* 仅供调试，页面不依赖它 */
})();
