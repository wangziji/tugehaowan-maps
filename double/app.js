/* 《替身 · THE DOUBLE》交互层 */
(function () {
  'use strict';

  var M = window.Model, DATA = window.DATA;
  var MIN_LINE = 300;          // 剔除「就在脚下」的 POI
  var BAND_W = 2;              // 等时窗口 ±2 分钟
  var SECTORS = 16;
  var MIN_CNT = 2, MIN_SECTOR = 6;

  var CAT_COLOR = {
    '公园': '#2e7d32', '博物馆': '#6d4c41', '商场': '#c0392b', '书店': '#1f6feb',
    '体育馆': '#ef6c00', '电影院': '#6a1b9a', '展览馆': '#00838f', '景点': '#ad1457'
  };
  function catColor(c) { return CAT_COLOR[c] || '#8892a0'; }

  var state = { ci: 0, oi: 0, cat: '商场', T: 20 };
  var map = null, lyRose = null, lyAll = null, lyHit = null, lyPin = null;
  var lastRows = [], lastDbl = null, lastAnchor = null;

  /* ---------- 工具 ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function err(msg) {
    var e = $('err');
    e.style.display = 'block';
    e.textContent = '出错：' + msg;
    if (window.console) console.error(msg);
  }
  function fmtKm(m) { return (m / 1000).toFixed(1) + ' km'; }
  function fmtMin(v) { return v.toFixed(1).replace(/\.0$/, '') + ' 分钟'; }

  function dotSVG(color, r, ring) {
    var s = r * 2 + (ring ? 6 : 2);
    var c = s / 2;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + s + '" height="' + s + '">' +
      (ring ? '<circle cx="' + c + '" cy="' + c + '" r="' + (r + 2) + '" fill="none" stroke="#ffffff" stroke-width="2"/>' : '') +
      '<circle cx="' + c + '" cy="' + c + '" r="' + r + '" fill="' + color + '" stroke="#ffffff" stroke-width="1"/></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  function pinSVG(color, glyph) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="40">' +
      '<path d="M15 0C7 0 1 6 1 14c0 10 13 25 14 25s14-15 14-25C29 6 23 0 15 0z" fill="' + color + '" stroke="#ffffff" stroke-width="2"/>' +
      '<circle cx="15" cy="14" r="6" fill="#ffffff"/>' +
      '<text x="15" y="18" font-size="9" text-anchor="middle" fill="' + color + '" font-family="sans-serif">' + glyph + '</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  /* ---------- 取当前 (城, 出发点) 的可达表 ---------- */
  function curCity() { return DATA.cities[state.ci]; }
  function rowsOf(ci, oi) {
    var c = DATA.cities[ci], o = c.origins[oi];
    var pois = c.pois.map(function (p) { return { name: p[0], cat: p[1], lat: p[2], lng: p[3] }; });
    var m = {};
    c.pois.forEach(function (p, j) { var x = c.matrix[oi][j]; if (x) m[p[0]] = { dur_s: x[0], dist_m: x[1] }; });
    return M.buildTable({ lat: o[2], lng: o[3] }, pois, m, MIN_LINE);
  }

  /* ---------- 控件 ---------- */
  function buildControls() {
    var cc = $('cityChips');
    cc.innerHTML = '';
    DATA.cities.forEach(function (c, i) {
      var b = document.createElement('button');
      b.className = 'chip' + (i === state.ci ? ' on' : '');
      b.setAttribute('data-ci', String(i));
      b.textContent = c.name;
      cc.appendChild(b);
    });
    // 监听器只能挂一次：容器上的 listener 不会被 innerHTML='' 清掉，
    // 每渲染一次就再挂一个 → 点一次触发 N 次 render，N 随交互次数指数增长。
    if (!cc._bound) {
      cc._bound = 1;
      cc.addEventListener('click', function (ev) {
        var t = ev.target;
        var ci = t && t.getAttribute && t.getAttribute('data-ci');
        if (ci === null || ci === undefined) return;
        state.ci = parseInt(ci, 10);
        state.oi = 0;
        buildControls(); render();
      });
    }

    var oc = $('originChips');
    oc.innerHTML = '';
    curCity().origins.forEach(function (o, i) {
      var b = document.createElement('button');
      b.className = 'chip' + (i === state.oi ? ' on' : '');
      b.setAttribute('data-oi', String(i));
      b.textContent = o[0];
      var s = document.createElement('span');
      s.className = 't'; s.textContent = o[1];
      b.appendChild(s);
      oc.appendChild(b);
    });
    if (!oc._bound) {
      oc._bound = 1;
      oc.addEventListener('click', function (ev) {
        var t = ev.target;
        var oi = t && t.getAttribute && t.getAttribute('data-oi');
        if (oi === null || oi === undefined) return;
        state.oi = parseInt(oi, 10);
        buildControls(); render();
      });
    }

    var cs = $('catSel');
    if (cs.options.length === 0) {
      DATA.cats.forEach(function (c) {
        var op = document.createElement('option');
        op.value = c; op.textContent = c;
        cs.appendChild(op);
      });
      cs.value = state.cat;
      cs.addEventListener('change', function () { state.cat = cs.value; render(); });
    } else { cs.value = state.cat; }

    var tr = $('tRange');
    tr.value = String(state.T);
    if (!tr._bound) {
      tr._bound = 1;
      tr.addEventListener('input', function () {
        state.T = parseInt(tr.value, 10);
        $('tVal').textContent = state.T + ' 分钟';
        render();
      });
    }
    $('tVal').textContent = state.T + ' 分钟';
  }

  /* ---------- 地图 ---------- */
  function ensureMap() {
    if (map || typeof window.TMap === 'undefined') return map;
    var o = curCity().origins[state.oi];
    map = new window.TMap.Map('map', {
      center: new window.TMap.LatLng(o[2], o[3]),
      zoom: 10, pitch: 0, showControl: true
    });
    // 图层按创建顺序叠：玫瑰在最底，其次全部候选点，再是替身，最后是锚点/出发点
    lyRose = new window.TMap.MultiPolygon({
      map: map,
      styles: {
        rose: new window.TMap.PolygonStyle({
          color: 'rgba(192,57,43,0.13)', showBorder: true,
          borderColor: '#c0392b', borderWidth: 2
        })
      },
      geometries: []
    });
    var stAll = {};
    DATA.cats.forEach(function (c) {
      stAll['c' + DATA.cats.indexOf(c)] = new window.TMap.MarkerStyle({
        width: 12, height: 12, anchor: { x: 6, y: 6 }, src: dotSVG('#b8c1cc', 4, false)
      });
    });
    lyAll = new window.TMap.MultiMarker({ map: map, styles: stAll, geometries: [] });

    var stHit = {};
    DATA.cats.forEach(function (c, i) {
      stHit['h' + i] = new window.TMap.MarkerStyle({
        width: 22, height: 22, anchor: { x: 11, y: 11 }, src: dotSVG(catColor(c), 8, true)
      });
    });
    lyHit = new window.TMap.MultiMarker({ map: map, styles: stHit, geometries: [] });

    lyPin = new window.TMap.MultiMarker({
      map: map,
      styles: {
        origin: new window.TMap.MarkerStyle({ width: 30, height: 40, anchor: { x: 15, y: 38 }, src: pinSVG('#151a22', '起') }),
        anchor: new window.TMap.MarkerStyle({ width: 30, height: 40, anchor: { x: 15, y: 38 }, src: pinSVG('#c0392b', '常') })
      },
      geometries: []
    });
    return map;
  }

  function fitTo(points) {
    if (!map || !points.length) return;
    var la = [], ln = [];
    points.forEach(function (p) { la.push(p.lat); ln.push(p.lng); });
    var minLat = Math.min.apply(null, la), maxLat = Math.max.apply(null, la);
    var minLng = Math.min.apply(null, ln), maxLng = Math.max.apply(null, ln);
    var el = $('map');
    var w = el.clientWidth || 600, h = el.clientHeight || 460;
    function x(lng) { return (lng + 180) / 360; }
    function y(lat) {
      var s = Math.sin(lat * Math.PI / 180);
      return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    }
    var dx = Math.abs(x(maxLng) - x(minLng)), dy = Math.abs(y(maxLat) - y(minLat));
    if (dx <= 0) dx = 0.0001;
    if (dy <= 0) dy = 0.0001;
    // fitBounds 只挪中心不改 zoom，这里自己解
    var zx = Math.log(w / 256 / dx) / Math.LN2;
    var zy = Math.log(h / 256 / dy) / Math.LN2;
    var z = Math.min(zx, zy) - 0.35;
    z = Math.max(4, Math.min(16, z));
    map.setCenter(new window.TMap.LatLng((minLat + maxLat) / 2, (minLng + maxLng) / 2));
    map.setZoom(Math.round(z * 10) / 10);
  }

  function updateMap(rows, dbl, origin) {
    if (!ensureMap()) return;
    var o = curCity().origins[state.oi];

    // 玫瑰多边形
    var rg = M.rose(rows, dbl.anchor ? dbl.anchor.durMin : state.T, SECTORS);
    var ring = [];
    for (var i = 0; i < SECTORS; i++) {
      var d = rg[i].maxM;
      if (d === null || !(d > 0)) d = 0;
      var pt = M.destPoint(o[2], o[3], i * 360 / SECTORS + 180 / SECTORS, d);
      ring.push(new window.TMap.LatLng(pt.lat, pt.lng));
    }
    if (ring.length) {
      ring.push(ring[0]);
      lyRose.setGeometries([{ id: 'rose', styleId: 'rose', paths: [ring] }]);
    } else {
      lyRose.setGeometries([]);
    }

    // 全部候选点
    lyAll.setGeometries(rows.map(function (r) {
      return { id: 'a' + r.idx, styleId: 'c' + DATA.cats.indexOf(r.cat), position: new window.TMap.LatLng(r.lat, r.lng) };
    }));

    // 替身
    var hitIds = {};
    dbl.list.forEach(function (r) { hitIds[r.idx] = 1; });
    lyHit.setGeometries(dbl.list.map(function (r) {
      return { id: 'h' + r.idx, styleId: 'h' + DATA.cats.indexOf(r.cat), position: new window.TMap.LatLng(r.lat, r.lng) };
    }));

    var pins = [{ id: 'o', styleId: 'origin', position: new window.TMap.LatLng(o[2], o[3]) }];
    if (dbl.anchor) pins.push({ id: 'a', styleId: 'anchor', position: new window.TMap.LatLng(dbl.anchor.lat, dbl.anchor.lng) });
    lyPin.setGeometries(pins);

    var pts = [{ lat: o[2], lng: o[3] }];
    if (dbl.anchor) pts.push({ lat: dbl.anchor.lat, lng: dbl.anchor.lng });
    dbl.list.forEach(function (r) { pts.push({ lat: r.lat, lng: r.lng }); });
    if (pts.length < 3) { // 没有替身时退回看全部候选点
      rows.slice(0, 30).forEach(function (r) { pts.push({ lat: r.lat, lng: r.lng }); });
    }
    fitTo(pts);
  }

  /* ---------- 可达玫瑰 SVG ---------- */
  function drawRose(rows, tMin) {
    var svg = $('rose');
    var rg = M.rose(rows, tMin, SECTORS);
    var vals = rg.map(function (s) { return s.maxM; }).filter(function (v) { return v !== null; });
    var maxV = vals.length ? Math.max.apply(null, vals) : 1;
    var cx = 160, cy = 95, R = 74;
    var out = [];
    var step = 2 * Math.PI / SECTORS;
    // 同心圈
    [0.25, 0.5, 0.75, 1].forEach(function (f) {
      out.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + (R * f).toFixed(1) + '" fill="none" stroke="#e3e7ed" stroke-width="1"/>');
    });
    var path = [];
    for (var i = 0; i < SECTORS; i++) {
      var v = rg[i].maxM;
      var r = (v === null || !(v > 0)) ? 0 : (v / maxV) * R;
      var ang = -Math.PI / 2 + i * step + step / 2;
      var px = cx + r * Math.cos(ang), py = cy + r * Math.sin(ang);
      path.push(px.toFixed(1) + ',' + py.toFixed(1));
    }
    out.push('<polygon points="' + path.join(' ') + '" fill="rgba(192,57,43,0.16)" stroke="#c0392b" stroke-width="1.6"/>');
    // 方位线
    for (var k = 0; k < 4; k++) {
      var a2 = -Math.PI / 2 + k * Math.PI / 2;
      out.push('<line x1="' + cx + '" y1="' + cy + '" x2="' + (cx + R * Math.cos(a2)).toFixed(1) +
        '" y2="' + (cy + R * Math.sin(a2)).toFixed(1) + '" stroke="#e3e7ed" stroke-width="1"/>');
    }
    out.push('<text x="' + cx + '" y="' + (cy - R - 7) + '" font-size="10" fill="#8892a0" text-anchor="middle">北</text>');
    out.push('<text x="' + (cx + R + 9) + '" y="' + (cy + 3) + '" font-size="10" fill="#8892a0" text-anchor="middle">东</text>');
    out.push('<text x="' + cx + '" y="' + (cy + R + 14) + '" font-size="10" fill="#8892a0" text-anchor="middle">南</text>');
    out.push('<text x="' + (cx - R - 9) + '" y="' + (cy + 3) + '" font-size="10" fill="#8892a0" text-anchor="middle">西</text>');
    svg.innerHTML = out.join('');

    var cov = rg.filter(function (s) { return s.maxM !== null; }).length;
    var di = M.distortion(rows, tMin, SECTORS, MIN_CNT, MIN_SECTOR);
    $('roseMeta').textContent = cov + '/' + SECTORS + ' 个方位够得到';
    $('roseT').innerHTML = tMin.toFixed(1).replace(/\.0$/, '') + ' 分钟内，最远的方位能到 <b>' +
      (maxV / 1000).toFixed(1) + ' km</b>' +
      (di ? '，最长瓣是最短瓣的 <b>' + di.ratio.toFixed(2) + ' 倍</b>' : '，<b>有效方位不足，不给畸变指数</b>');
  }

  /* ---------- 面板 ---------- */
  function renderPanel(rows, dbl) {
    var o = curCity().origins[state.oi];
    var c = curCity();
    var anchor = dbl.anchor;
    var th = anchor ? M.thickness(M.band(rows, anchor.durMin, BAND_W)) : null;
    var near = M.nearerDoubles(dbl);

    $('mapMeta').textContent = c.name + ' · ' + o[0] + '（' + o[1] + '） · ' + rows.length + ' 个候选去处';
    $('kpiMeta').textContent = '等时窗口 ±' + BAND_W + ' 分钟';

    $('kN').innerHTML = dbl.n + '<small>个</small>';
    $('kTh').innerHTML = th ? th.ratio.toFixed(2) + '<small>倍</small>' : '–';
    $('kNear').innerHTML = near.length + '<small>个</small>';
    $('kSlice').innerHTML = (M.sliceRate(dbl.n) * 100).toFixed(0) + '<small>%</small>';

    $('anchorV').innerHTML = anchor
      ? esc(anchor.name) + ' <span class="m">' + anchor.durMin.toFixed(1).replace(/\.0$/, '') + ' 分钟</span>' +
        '<span class="d">直线 ' + fmtKm(anchor.lineM) + '</span>'
      : '这个出发点没有「' + esc(state.cat) + '」类去处';

    // 替身清单
    var box = $('list');
    if (!dbl.list.length) {
      box.innerHTML = '<div class="empty">这个出发点、这个时间档内没有替身。<br>' +
        '把「愿意花多久」往上拖，或者换一个出发点。</div>';
    } else {
      var nearSet = {};
      near.forEach(function (r) { nearSet[r.idx] = 1; });
      var html = [];
      dbl.cats.forEach(function (cg) {
        html.push('<div class="catgrp"><div class="ch2">' +
          '<span class="dot" style="background:' + catColor(cg.cat) + '"></span>' + esc(cg.cat) +
          '<span class="c">' + cg.n + ' 个</span></div>');
        dbl.list.filter(function (r) { return r.cat === cg.cat; })
          .sort(function (a, b) { return b.lineM - a.lineM; })
          .forEach(function (r) {
            html.push('<div class="item' + (nearSet[r.idx] ? ' near' : '') + '" data-idx="' + r.idx + '">' +
              '<span class="nm">' + esc(r.name) + '</span>' +
              '<span class="mt"><b>' + r.durMin.toFixed(1).replace(/\.0$/, '') + '</b> 分 · ' + fmtKm(r.lineM) + '</span></div>');
          });
        html.push('</div>');
      });
      box.innerHTML = html.join('');
    }

    // 结论文案（数字与句子成对刷新）
    var ro = $('roMain'), rl = $('roList');
    if (anchor && dbl.n > 0) {
      ro.innerHTML = '从<b>' + esc(c.name) + '·' + esc(o[0]) + '</b>出发，路上花 <span class="cnt">' +
        anchor.durMin.toFixed(1).replace(/\.0$/, '') + ' 分钟</span>能到你常去的' + esc(state.cat) + '「' + esc(anchor.name) +
        '」。同样的时间，还有 <span class="cnt">' + dbl.n + '</span> 个<b>不是' + esc(state.cat) + '</b>的地方你也到得了，' +
        '分属 <span class="cnt">' + dbl.cats.length + '</span> 类。你大概只去过其中 1 个 —— 薄片率 <span class="cnt">' +
        (M.sliceRate(dbl.n) * 100).toFixed(0) + '%</span>。';
      var lis = [];
      if (th) lis.push('这些替身里，最远的在 <b>' + fmtKm(th.maxM) + '</b> 外，最近的只有 <b>' + fmtKm(th.minM) +
        '</b> —— 同样的时间，直线距离差 <b>' + th.ratio.toFixed(2) + ' 倍</b>。等时 ≠ 等距。');
      if (near.length) lis.push('有 <b>' + near.length + '</b> 个替身<b>比你常去的那个还近</b>，你却从没去过 —— ' +
        '你常去的地方正好在一个慢的方向上。');
      lis.push('替身最多的类别是 <b>' + esc(dbl.cats[0].cat) + '</b>（' + dbl.cats[0].n + ' 个）。');
      rl.innerHTML = lis.map(function (x) { return '<li>' + x + '</li>'; }).join('');
    } else if (anchor) {
      ro.innerHTML = '从<b>' + esc(c.name) + '·' + esc(o[0]) + '</b>出发，' + state.T +
        ' 分钟这一档里<b>一个替身都没有</b>。住在这儿，这个时间预算确实换不来别的选择 —— 把滑块往上拖，或者换个出发点。';
      rl.innerHTML = '';
    } else {
      ro.innerHTML = '这个出发点附近没有「' + esc(state.cat) + '」类的去处，换一类试试。';
      rl.innerHTML = '';
    }
  }

  /* ---------- 八城对比 ---------- */
  function renderBars() {
    var rows = [];
    DATA.cities.forEach(function (c, ci) {
      c.origins.forEach(function (o, oi) {
        var r = rowsOf(ci, oi);
        if (r.length < 8) return;
        var d = M.doubles(r, state.cat, BAND_W, state.T);
        rows.push({ city: c.name, o: o[0], type: o[1], n: d.n, me: (ci === state.ci && oi === state.oi) });
      });
    });
    var mx = Math.max.apply(null, rows.map(function (x) { return x.n; }).concat([1]));
    $('bars').innerHTML = rows.map(function (x) {
      return '<div class="bar' + (x.me ? ' me' : '') + '">' +
        '<span class="nm">' + x.city + '·' + x.o + '<span style="color:#8892a0"> ' + x.type + '</span></span>' +
        '<span class="tr"><span class="fl" style="width:' + (x.n / mx * 100).toFixed(1) + '%"></span></span>' +
        '<span class="vv">' + x.n + '</span></div>';
    }).join('');
  }

  /* ---------- 主渲染 ---------- */
  function render() {
    if (!DATA || !M) { err('数据或模型未加载'); return; }
    try {
      var rows = rowsOf(state.ci, state.oi);
      if (!rows.length) { err('当前出发点没有可用数据'); return; }
      var dbl = M.doubles(rows, state.cat, BAND_W, state.T);
      lastRows = rows; lastDbl = dbl; lastAnchor = dbl.anchor;
      buildControls();
      renderPanel(rows, dbl);
      drawRose(rows, dbl.anchor ? dbl.anchor.durMin : state.T);
      updateMap(rows, dbl);
      renderBars();
      var tot = 0;
      DATA.cities.forEach(function (c) { tot += c.pois.length * c.origins.length; });
      $('fCount').textContent = tot;
    } catch (e) {
      err(e && e.message ? e.message : String(e));
    }
  }

  function autostart() {
    try { render(); }
    catch (e) { err('启动失败：' + (e && e.message ? e.message : String(e))); }
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(autostart, 0);
  } else {
    document.addEventListener('DOMContentLoaded', autostart);
    window.addEventListener('load', autostart);
  }
  window.__db_boot = autostart;
  window.__db_state = state;
})();
