/* 《上坡 · UPHILL》交互层。
   纪律备忘（来自本项目既往踩坑）：
   - 入口必须自启动，且冒烟断言要模拟真实 load 流程，不允许脚本自己调 boot 充数；
   - TMap GL 不接受 8 位十六进制颜色，只能用 rgb()/6 位；
   - 本版 fitBounds 只挪中心不改 zoom，zoom 自己按 Web Mercator 解；
   - 节流函数先判前置条件再写时间戳，早退不能污染节流状态；
   - catch 必须留下用户可见痕迹，静默失败 = 把 bug 藏起来；
   - 不画的图层要 setGeometries([]) 清掉残留。 */
(function () {
  'use strict';
  var M = window.UPHILL;
  var DATA = window.__UPHILL_DATA__;
  var KEY = 'CVIBZ-RDZCD-J3B4T-HGLIP-V7Z2F-EQB5N';

  var state = {
    cityIdx: 0,
    centerIdx: 0,
    dist: 3000,
    layer: 'both',        // both | go | bk
    sel: null,            // 选中的方位角（null = 全部）
  };

  var map = null, mapReady = false;
  var layerGo = null, layerBk = null, markers = [];
  var mapBootTried = false;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmtKm(m) { return (m / 1000).toFixed(1) + ' km'; }
  function fmtMin(m) { return Math.round(m) + ' min'; }
  function fmtPct(x) { return (x * 100).toFixed(0) + '%'; }
  function showErr(msg) {
    var e = $('err');
    if (!e) return;
    e.style.display = 'block';
    e.textContent = msg;
  }

  function city() { return DATA.cities[state.cityIdx]; }
  function center() { return city().centers[state.centerIdx]; }
  function ledger() { return M.bearingLedger(center(), state.dist); }

  /* ---------- 地图 ---------- */
  function mercY(lat) {
    var s = Math.sin(lat * Math.PI / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  }
  function fitZoom(b, wPx, hPx, pad) {
    var dLng = Math.max(1e-7, b.maxLng - b.minLng) / 360;
    var dY = Math.max(1e-9, Math.abs(mercY(b.maxLat) - mercY(b.minLat)));
    var availW = Math.max(40, wPx - pad), availH = Math.max(40, hPx - pad);
    var zx = Math.log2(availW / (256 * dLng));
    var zy = Math.log2(availH / (256 * dY));
    var z = Math.min(zx, zy) - 0.32;   // 留一点边距，8 个端点不会被裁到容器边缘
    return Math.max(3, Math.min(16, z));
  }
  function boundsOf(pts) {
    var b = { minLat: 90, maxLat: -90, minLng: 180, maxLng: -180 };
    pts.forEach(function (p) {
      b.minLat = Math.min(b.minLat, p[0]); b.maxLat = Math.max(b.maxLat, p[0]);
      b.minLng = Math.min(b.minLng, p[1]); b.maxLng = Math.max(b.maxLng, p[1]);
    });
    return b;
  }

  var fitStamp = 0;
  function fitMap(force) {
    // 先判前置条件，再写时间戳：早退不能污染节流状态
    if (!mapReady || !map) return;
    var now = Date.now();
    if (!force && now - fitStamp < 320) return;
    fitStamp = now;
    var rows = ledger();
    var pts = [[center().lat, center().lng]];
    rows.forEach(function (r) { pts.push(r.endpoint); });
    var b = boundsOf(pts);
    // 画的是「直线距离 d」的圈，按纬度换算成框，避免高纬被压扁
    var padLat = state.dist / 111320 * 0.35;
    var padLng = state.dist / (111320 * Math.cos(M.rad(center().lat))) * 0.35;
    b.minLat -= padLat; b.maxLat += padLat; b.minLng -= padLng; b.maxLng += padLng;
    var el = $('map');
    var z = fitZoom(b, el.clientWidth || 640, el.clientHeight || 480, 70);
    try {
      map.setCenter(new TMap.LatLng(center().lat, center().lng));
      map.setZoom(z);
    } catch (e) {
      showErr('地图取景失败：' + (e && e.message ? e.message : e));
    }
  }

  function svgIcon(fill, label) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 30 30">'
      + '<circle cx="15" cy="15" r="11" fill="' + fill + '" stroke="#ffffff" stroke-width="2.5"/>'
      + '<text x="15" y="20" font-size="13" font-family="sans-serif" font-weight="700" '
      + 'text-anchor="middle" fill="#ffffff">' + label + '</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function ensureMap() {
    if (map || mapBootTried) return map;
    mapBootTried = true;
    if (typeof TMap === 'undefined') {
      showErr('腾讯地图 JSAPI 未加载成功，地图区域不可用（下方账本与图表仍可正常查看）。');
      return null;
    }
    try {
      map = new TMap.Map('map', {
        center: new TMap.LatLng(center().lat, center().lng),
        zoom: 12,
        pitch: 0,
        baseMap: { type: 'vector' }
      });
      map.on('tilesloaded', function () { mapReady = true; fitStamp = 0; fitMap(true); });
      // 兜底：tilesloaded 可能不触发
      setTimeout(function () {
        if (!mapReady) { mapReady = true; fitStamp = 0; fitMap(true); }
      }, 1800);
      layerGo = new TMap.MultiPolyline({
        map: map, styles: {
          g: new TMap.PolylineStyle({ color: 'rgb(37,99,235)', width: 5, borderWidth: 1, borderColor: 'rgb(255,255,255)', lineCap: 'round' })
        }, geometries: []
      });
      layerBk = new TMap.MultiPolyline({
        map: map, styles: {
          b: new TMap.PolylineStyle({ color: 'rgb(234,88,12)', width: 5, borderWidth: 1, borderColor: 'rgb(255,255,255)', lineCap: 'round' })
        }, geometries: []
      });
      mapReady = true;
    } catch (e) {
      showErr('地图初始化失败：' + (e && e.message ? e.message : e));
      return null;
    }
    return map;
  }

  function clearMarkers() {
    markers.forEach(function (m) { try { m.setMap(null); } catch (e) { /* 用户可见状态不受影响 */ } });
    markers = [];
  }

  function drawMap() {
    if (!ensureMap()) return;
    var rows = ledger();
    var goGeom = [], bkGeom = [];
    clearMarkers();

    rows.forEach(function (r) {
      if (state.sel !== null && r.b !== state.sel) return;
      var rt = center().routes.filter(function (x) { return x.b === r.b; });
      // 折线用最接近当前距离的实测档，端点用插值后的位置
      var src = null, bestGap = Infinity;
      rt.forEach(function (x) {
        var g = Math.abs(x.d - state.dist);
        if (g < bestGap) { bestGap = g; src = x; }
      });
      if (!src) return;
      if (state.layer === 'both' || state.layer === 'go') {
        goGeom.push({ id: 'go' + r.b, styleId: 'g',
          paths: src.p_go.map(function (p) { return new TMap.LatLng(p[0], p[1]); }) });
      }
      if (state.layer === 'both' || state.layer === 'bk') {
        bkGeom.push({ id: 'bk' + r.b, styleId: 'b',
          paths: src.p_bk.map(function (p) { return new TMap.LatLng(p[0], p[1]); }) });
      }
    });

    try {
      layerGo.setGeometries(goGeom);        // 空数组也要 set，否则残留上一次的线
      layerBk.setGeometries(bkGeom);
    } catch (e) {
      showErr('路线绘制失败：' + (e && e.message ? e.message : e));
    }

    try {
      // 本版 TMap GL 的 MultiMarker 没有 updateStyles，三种样式必须一次建齐
      var mk = new TMap.MultiMarker({
        map: map,
        styles: {
          home: new TMap.MarkerStyle({ width: 30, height: 30, anchor: { x: 15, y: 15 }, src: svgIcon('#ea580c', '家') }),
          best: new TMap.MarkerStyle({ width: 30, height: 30, anchor: { x: 15, y: 15 }, src: svgIcon('#b45309', '优') }),
          office: new TMap.MarkerStyle({ width: 30, height: 30, anchor: { x: 15, y: 15 }, src: svgIcon('#1e2430', '司') })
        },
        geometries: []
      });
      var g = [{ id: 'office', styleId: 'office', position: new TMap.LatLng(center().lat, center().lng) }];
      rows.forEach(function (r) {
        if (state.sel !== null && r.b !== state.sel) return;
        var isBest = r.rank === 1;
        g.push({
          id: 'h' + r.b,
          styleId: isBest ? 'best' : 'home',
          position: new TMap.LatLng(r.endpoint[0], r.endpoint[1])
        });
      });
      mk.setGeometries(g);
      markers.push(mk);
    } catch (e) {
      showErr('标记绘制失败：' + (e && e.message ? e.message : e));
    }
    fitMap(false);
  }

  /* ---------- 渲染 ---------- */
  function renderHero() {
    var rows = ledger();
    var slope = M.citySlope(city());
    var best = rows[0], worstB = rows[rows.length - 1];
    var gapH = (worstB.round_t - best.round_t) * M.WORKDAYS / 60;
    var boxes = [
      { k: '本城平均坡度（时长）', v: fmtPct(slope.mean_t), n: '去与回平均差这么些' },
      { k: '最快的方位', v: best.name, n: '往返 ' + fmtMin(best.round_t) + '（去 ' + Math.round(best.go_t) + ' / 回 ' + Math.round(best.bk_t) + '）' },
      { k: '最慢的方位', v: worstB.name, n: '往返 ' + fmtMin(worstB.round_t) + '（去 ' + Math.round(worstB.go_t) + ' / 回 ' + Math.round(worstB.bk_t) + '）' },
      { k: '选对方位一年省', v: gapH.toFixed(1) + ' <small>小时</small>', n: '按 250 个工作日、每天一趟往返' }
    ];
    $('hero').innerHTML = boxes.map(function (b) {
      return '<div class="box"><div class="k">' + esc(b.k) + '</div><div class="v">' + b.v + '</div>'
        + '<div class="n">' + esc(b.n) + '</div></div>';
    }).join('');
  }

  function renderLedger() {
    var rows = ledger();
    $('ledger').innerHTML = rows.map(function (r) {
      var a = r.asym_t;
      var side = a >= 0 ? 'go' : 'bk';
      var w = Math.min(50, Math.abs(a) * 100 / 0.6);   // 0.6 不对称度铺满半条
      var bar = side === 'go'
        ? '<i style="left:50%;width:' + w.toFixed(1) + '%;background:var(--go)"></i>'
        : '<i style="right:50%;width:' + w.toFixed(1) + '%;background:var(--bk)"></i>';
      return '<div class="bcard' + (r.rank === 1 ? ' best' : '') + (state.sel === r.b ? ' sel' : '') + '" data-b="' + r.b + '">'
        + '<div class="top"><span class="bn">' + esc(r.name)
        + (r.rank === 1 ? '<span class="tagbest">最快</span>' : '') + '</span>'
        + '<span class="rk">第 ' + r.rank + ' / 8</span></div>'
        + '<div class="rt">' + fmtMin(r.round_t) + ' <small>往返</small></div>'
        + '<div class="duo"><span>去 <b>' + Math.round(r.go_t) + '</b> min</span><span>回 <b>' + Math.round(r.bk_t) + '</b> min</span>'
        + '<span style="margin-left:auto;color:' + (a >= 0 ? 'var(--go)' : 'var(--bk)') + '">'
        + (a >= 0 ? '去程贵 ' : '回程贵 ') + fmtPct(Math.abs(a)) + '</span></div>'
        + '<div class="slope">' + bar + '</div>'
        + '<div class="yr">一年 ' + r.year_h.toFixed(1) + ' 小时 · 实际路 ' + fmtKm(r.round_d)
        + '（直线 ' + fmtKm(state.dist) + '）</div></div>';
    }).join('');
    Array.prototype.forEach.call($('ledger').children, function (el) {
      el.addEventListener('click', function () {
        var b = parseInt(el.getAttribute('data-b'), 10);
        state.sel = (state.sel === b) ? null : b;
        renderLedger(); drawMap();
      });
    });
  }

  /* 八方位坡度条图：从中线向两侧发散。
     早前版本用的是极坐标「玫瑰图」（负值向垂直方向折），读不出正负号，已改掉。 */
  function renderRose() {
    var rows = ledger().slice().sort(function (a, b) { return a.b - b.b; });
    var MAXA = 0.6;
    $('rose').innerHTML = rows.map(function (r) {
      var a = r.asym_t;
      var w = Math.min(50, Math.abs(a) / MAXA * 50);
      var col = a >= 0 ? 'var(--go)' : 'var(--bk)';
      var style = a >= 0
        ? 'left:50%;width:' + w.toFixed(1) + '%;background:' + col
        : 'right:50%;width:' + w.toFixed(1) + '%;background:' + col;
      return '<div class="brow"><span class="bl">' + esc(r.name) + '</span>'
        + '<span class="bare"><i style="' + style + '"></i></span>'
        + '<span class="bv">' + (a >= 0 ? '+' : '−') + Math.abs(a * 100).toFixed(0) + '%</span></div>';
    }).join('');
  }

  function renderRank() {
    var slopes = DATA.cities.map(function (c) { return M.citySlope(c); });
    slopes.sort(function (a, b) { return b.mean_t - a.mean_t; });
    var mx = Math.max.apply(null, slopes.map(function (s) { return s.mean_t; }));
    $('rank').innerHTML = slopes.map(function (s) {
      var cur = s.id === city().id;
      return '<div class="r"><span class="nm" style="' + (cur ? 'font-weight:700;color:var(--ink)' : '') + '">'
        + esc(s.name) + '</span>'
        + '<span class="bar"><i style="width:' + (100 * s.mean_t / mx).toFixed(1) + '%;background:'
        + (cur ? 'var(--ink)' : 'var(--go)') + '"></i></span>'
        + '<span class="vl">' + (s.mean_t * 100).toFixed(1) + '%</span></div>';
    }).join('');
    var w = M.citySlope(city()).worst;
    if (w) {
      // 谁更贵必须跟着符号走，不能一律写「回程比去程多」
      var goWorse = w.asym_t >= 0;
      var more = goWorse ? '去程比回程' : '回程比去程';
      var dDiff = Math.abs(w.go_d - w.bk_d);
      var tDiff = goWorse ? (w.go_t - w.bk_t) : (w.bk_t - w.go_t);
      $('worst').innerHTML = '<div class="t">本城最斜的一段路 · ' + esc(w.center) + ' ' + esc(w.b)
        + '° 方向，直线 ' + fmtKm(w.sd) + '</div>'
        + '<div class="m">去程 ' + fmtKm(w.go_d) + ' / ' + w.go_t + ' min，回程 ' + fmtKm(w.bk_d) + ' / ' + w.bk_t
        + ' min —— <b>' + (goWorse ? '去程更贵' : '回程更贵') + ' ' + fmtPct(Math.abs(w.asym_t)) + '</b>，'
        + '也就是' + more + '<b>多走 ' + fmtKm(dDiff) + '、多花 ' + tDiff + ' 分钟</b>。</div>';
    }
  }

  function renderChips() {
    $('cityChips').innerHTML = DATA.cities.map(function (c, i) {
      return '<span class="chip' + (i === state.cityIdx ? ' on' : '') + '" data-c="' + i + '">' + esc(c.name) + '</span>';
    }).join('');
    Array.prototype.forEach.call($('cityChips').children, function (el) {
      el.addEventListener('click', function () {
        state.cityIdx = parseInt(el.getAttribute('data-c'), 10);
        state.centerIdx = 0; state.sel = null;
        renderChips(); renderAll();
      });
    });
    $('centerChips').innerHTML = city().centers.map(function (c, i) {
      return '<span class="chip' + (i === state.centerIdx ? ' on' : '') + '" data-n="' + i + '">' + esc(c.name) + '</span>';
    }).join('');
    Array.prototype.forEach.call($('centerChips').children, function (el) {
      el.addEventListener('click', function () {
        state.centerIdx = parseInt(el.getAttribute('data-n'), 10);
        state.sel = null;
        renderChips(); renderAll();
      });
    });
    var L = [{ k: 'both', t: '去回都画' }, { k: 'go', t: '只看去程' }, { k: 'bk', t: '只看回程' }];
    $('layerChips').innerHTML = L.map(function (x) {
      return '<span class="chip' + (state.layer === x.k ? ' on' : '') + '" data-l="' + x.k + '">' + x.t + '</span>';
    }).join('');
    Array.prototype.forEach.call($('layerChips').children, function (el) {
      el.addEventListener('click', function () {
        state.layer = el.getAttribute('data-l');
        renderChips(); drawMap();
      });
    });
  }

  function renderHint() {
    var d = state.dist;
    var lo = M.MEASURED_DISTS[0], hi = M.MEASURED_DISTS[1];
    var t = (d >= lo && d <= hi)
      ? '实测档位区间 ' + fmtKm(lo) + ' – ' + fmtKm(hi) + '：当前为区间内线性插值。'
      : '<b style="color:var(--warn)">已超出实测区间（' + fmtKm(lo) + ' – ' + fmtKm(hi) + '），当前为按比例外推</b>，量级可参考，具体数值不要当导航用。';
    $('distHint').innerHTML = t + ' 地图上的折线始终取自最接近的那一档实测路线。';
  }

  function renderAll() {
    renderHero(); renderLedger(); renderRose(); renderRank(); renderHint(); drawMap();
  }

  /* ---------- 入口 ---------- */
  function boot() {
    var err = $('err'); if (err) { err.style.display = 'none'; err.textContent = ''; }
    renderChips();
    $('dist').addEventListener('input', function () {
      state.dist = M.num(this.value, M.D_MIN, M.D_MAX, 3000);
      $('distV').textContent = fmtKm(state.dist);
      renderHero(); renderLedger(); renderRose(); renderHint(); drawMap();
    });
    $('distV').textContent = fmtKm(state.dist);
    renderAll();
  }

  window.__uphill_boot = boot;
  window.__uphill_state = state;

  function autostart() {
    try { boot(); }
    catch (e) { showErr('页面初始化出错：' + (e && e.message ? e.message : e)); }
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(autostart, 0);
  } else {
    document.addEventListener('DOMContentLoaded', autostart);
  }
  window.addEventListener('load', function () {
    if (!mapBootTried) autostart();
  });
})();
