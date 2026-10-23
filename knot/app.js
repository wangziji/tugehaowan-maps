/* 《绳结 · THE KNOT》应用层 */
(function () {
  'use strict';
  var M = window.KnotModel;
  var DATA = window.KNOT_DATA;

  var CITIES = DATA.cities.map(function (c) {
    return { city: c.city, sets: c.sets.map(M.normalizeSet) };
  });
  var ALL = [];
  CITIES.forEach(function (c) { c.sets.forEach(function (s) { ALL.push({ city: c.city, set: s }); }); });

  var state = {
    ci: 0, si: 0, sel: [1, 2, 3, 4], closed: false, metric: 'time', hot: -1
  };

  var map = null, layers = {}, markers = null, ready = false;

  function $(id) { return document.getElementById(id); }
  function fmtCost(v) {
    if (!isFinite(v)) return '—';
    return state.metric === 'time' ? (Math.round(v) + ' 分钟') : ((v / 1000).toFixed(2) + ' 公里');
  }
  function fmtNum(v) {
    if (!isFinite(v)) return '—';
    return state.metric === 'time' ? (Math.round(v * 10) / 10 + ' 分') : ((v / 1000).toFixed(2) + ' km');
  }
  function pct(v) { return (v * 100).toFixed(0) + '%'; }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function curSet() { return CITIES[state.ci].sets[state.si]; }
  function analyze() { return M.analyze(curSet(), state.sel, state.closed, state.metric); }

  /* ---------------- 全局统计（32 个任务集，4 件事全选、不回起点、按耗时） ---------------- */
  var G = null;
  function globalStats() {
    if (G) return G;
    var spreads = [], gGaps = [], nf = [], ff = [], means = [];
    var gnb = 0, farLast = 0, farFirst = 0, knot0 = 0, knotN = 0, plainN = 0;
    var knotted = [], plain = [], bestInPlain = 0;
    ALL.forEach(function (o) {
      var a = M.analyze(o.set, [1, 2, 3, 4], false, 'time');
      spreads.push(a.spread); gGaps.push(a.greedyGap); nf.push(a.nfGap); ff.push(a.ffGap); means.push(a.meanGap);
      if (!a.greedyIsBest) gnb++;
      if (a.farLast) farLast++;
      if (a.farFirstPos) farFirst++;
      var bestK = M.knotCount(o.set, a.best.order, 0, false);
      if (bestK === 0) { knot0++; bestInPlain++; }
      a.rows.forEach(function (r) {
        var k = M.knotCount(o.set, r.order, 0, false);
        if (k > 0) { knotN++; knotted.push(r.cost); } else { plainN++; plain.push(r.cost); }
      });
    });
    var mean = function (x) { return x.reduce(function (a, b) { return a + b; }, 0) / x.length; };
    G = {
      n: ALL.length,
      spread: mean(spreads), spreadMax: Math.max.apply(null, spreads), spreadMin: Math.min.apply(null, spreads),
      meanGap: mean(means), gGap: mean(gGaps), gnbPct: gnb / ALL.length,
      nf: mean(nf), ff: mean(ff), farLast: farLast, farFirst: farFirst,
      knot0Pct: knot0 / ALL.length, bestInPlainPct: bestInPlain / ALL.length,
      knotN: knotN, plainN: plainN, total: knotN + plainN,
      knotMean: mean(knotted), plainMean: mean(plain),
      perCity: CITIES.map(function (c) {
        return { city: c.city, v: mean(c.sets.map(function (s) { return M.analyze(s, [1, 2, 3, 4], false, 'time').spread; })) };
      })
    };
    return G;
  }

  /* ---------------- 控件 ---------------- */
  function buildControls() {
    var cr = $('cityRow');
    cr.innerHTML = '';
    CITIES.forEach(function (c, i) {
      var b = document.createElement('button');
      b.className = 'chip' + (i === state.ci ? ' on' : '');
      b.textContent = c.city;
      b.setAttribute('data-city', String(i));
      b.onclick = function () { state.ci = i; state.si = 0; state.hot = -1; markCity(); buildAnchors(); render(); };
      cr.appendChild(b);
    });
    buildAnchors();
    buildErrands();
  }

  function markCity() {
    var kids = $('cityRow').children || [];
    for (var i = 0; i < kids.length; i++) {
      kids[i].className = 'chip' + (i === state.ci ? ' on' : '');
    }
  }

  function buildAnchors() {
    var ar = $('anchorRow');
    ar.innerHTML = '';
    CITIES[state.ci].sets.forEach(function (s, i) {
      var b = document.createElement('button');
      b.className = 'chip' + (i === state.si ? ' on' : '');
      b.textContent = s.anchor;
      b.setAttribute('data-anchor', String(i));
      b.onclick = function () { state.si = i; state.hot = -1; render(); };
      ar.appendChild(b);
    });
  }

  function buildErrands() {
    var box = $('errandBox');
    box.innerHTML = '';
    var s = curSet();
    for (var i = 1; i < s.pts.length; i++) {
      (function (idx) {
        var lab = document.createElement('label');
        lab.className = 'cb';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = state.sel.indexOf(idx) >= 0;
        cb.setAttribute('data-c', String(idx));
        cb.onchange = function () {
          var on = state.sel.indexOf(idx) >= 0;
          if (on) {
            if (state.sel.length <= 2) { cb.checked = true; return; }
            state.sel = state.sel.filter(function (x) { return x !== idx; });
          } else {
            state.sel = state.sel.concat([idx]).sort(function (a, b) { return a - b; });
          }
          state.hot = -1;
          render();
        };
        var nm = document.createElement('span');
        nm.className = 'n';
        nm.textContent = s.pts[idx].name;
        var kd = document.createElement('span');
        kd.className = 'k';
        kd.textContent = s.pts[idx].kind;
        lab.appendChild(cb); lab.appendChild(nm); lab.appendChild(kd);
        box.appendChild(lab);
      })(i);
    }
  }

  function bindToggles() {
    $('btnOpen').onclick = function () { state.closed = false; $('btnOpen').className = 'chip on'; $('btnClosed').className = 'chip'; state.hot = -1; render(); };
    $('btnClosed').onclick = function () { state.closed = true; $('btnClosed').className = 'chip on'; $('btnOpen').className = 'chip'; state.hot = -1; render(); };
    $('btnTime').onclick = function () { state.metric = 'time'; $('btnTime').className = 'chip on'; $('btnDist').className = 'chip'; render(); };
    $('btnDist').onclick = function () { state.metric = 'dist'; $('btnDist').className = 'chip on'; $('btnTime').className = 'chip'; render(); };
  }

  /* ---------------- 文本渲染 ---------------- */
  function stepHtml(idx, cls) {
    var s = curSet();
    return '<span class="step ' + cls + '">' + s.pts[idx].kind + '·' + esc(String(s.pts[idx].name).slice(0, 10)) + '</span>';
  }
  function lineHtml(order, cls) {
    var s = curSet();
    var h = '<span class="step ' + cls + '">起·' + esc(String(s.anchor)) + '</span>';
    for (var i = 0; i < order.length; i++) {
      h += '<span class="arrow">→</span>' + stepHtml(order[i], cls);
    }
    if (state.closed) h += '<span class="arrow">→</span><span class="step ' + cls + '">回起点</span>';
    return h;
  }

  function renderText(a) {
    var g = globalStats();
    $('hSpread').textContent = pct(g.spread);
    $('hSets').textContent = g.n + ' 个任务集 · ' + (g.n * 20) + ' 条真实路线';
    $('nOrders').textContent = a.rows.length;
    $('kBest').textContent = fmtNum(a.best.cost);
    $('kWorst').textContent = fmtNum(a.worst.cost);
    var saveAbs = a.worst.cost - a.best.cost;
    $('kGain').textContent = state.metric === 'time'
      ? (Math.round(saveAbs) + ' 分钟') : ((saveAbs / 1000).toFixed(2) + ' km');
    $('kGreedy').textContent = pct(a.greedyGap);
    $('cBest').textContent = fmtNum(a.best.cost);
    $('cWorst').textContent = fmtNum(a.worst.cost);
    $('cWorstG').textContent = pct(a.spread);
    $('cGreedy').textContent = fmtNum(a.greedy.cost);
    $('cGreedyG').textContent = pct(a.greedyGap);
    $('cNF').textContent = fmtNum(a.nearFirst.cost);
    $('cNFG').textContent = pct(a.nfGap);
    $('cFF').textContent = fmtNum(a.farFirst.cost);
    $('cFFG').textContent = pct(a.ffGap);
    $('cMean').textContent = fmtNum(a.mean);
    $('cMeanG').textContent = pct(a.meanGap);
    $('bestLine').innerHTML = lineHtml(a.best.order, 'b');
    $('worstLine').innerHTML = lineHtml(a.worst.order, 'w');
    var kb = M.knotCount(curSet(), a.best.order, 0, state.closed);
    $('knotNote').innerHTML = '这套最优走法' + (kb === 0 ? '<b>不打结</b>' : '打了 <b>' + kb + '</b> 个结（自身交叉）') +
      '。全部 ' + a.rows.length + ' 种走法里，有 ' +
      a.rows.filter(function (r) { return M.knotCount(curSet(), r.order, 0, state.closed) > 0; }).length +
      ' 种是打结的。';
  }

  function renderBars(a) {
    var box = $('bars');
    box.innerHTML = '';
    var mx = a.worst.cost || 1, mn = a.best.cost;
    a.rows.forEach(function (r, i) {
      var cls = '';
      if (i === 0) cls = 'best';
      else if (i === a.rows.length - 1) cls = 'worst';
      else if (r.order.join(',') === a.greedy.order.join(',')) cls = 'greedy';
      if (i === state.hot) cls += ' hot';
      var d = document.createElement('div');
      d.className = 'bar ' + cls;
      d.setAttribute('data-i', String(i));
      var names = r.order.map(function (x) { return curSet().pts[x].kind; }).join('→');
      var w = mx > mn ? ((r.cost - mn) / (mx - mn)) * 80 + 20 : 100;
      d.innerHTML = '<span class="lab">' + (i + 1) + '. ' + names + '</span>' +
        '<span class="track"><span class="fill" style="width:' + w.toFixed(1) + '%"></span></span>' +
        '<span class="num">' + fmtNum(r.cost) + '</span>';
      d.onmouseenter = function () { state.hot = i; renderBars(a); drawRoutes(a); };
      d.onmouseleave = function () { state.hot = -1; renderBars(a); drawRoutes(a); };
      box.appendChild(d);
    });
  }

  function renderFindings() {
    var g = globalStats();
    var pc = g.perCity.slice().sort(function (a, b) { return b.v - a.v; });
    var html = [
      '<b>① 最差的走法比最优平均多花 ' + pct(g.spread) + '。</b>' +
      ' ' + g.n + ' 个真实任务集（8 城 × 4 个出发点），同一份清单换个顺序，最慢的那种平均要慢 ' +
      pct(g.spread) + '，最夸张的一组慢 ' + pct(g.spreadMax) + '，最轻微的一组是 ' + pct(g.spreadMin) + '。',

      '<b>② 随便排一个顺序，平均多花 ' + pct(g.meanGap) + '。</b>' +
      ' 24 种走法的平均代价，比最优高出 ' + pct(g.meanGap) + '——也就是说"没想过顺序"这件事本身就要付费。',

      '<b>③ "每步去最近的那家"在 ' + pct(g.gnbPct) + ' 的任务集里不是最优。</b>' +
      ' 这个最像人脑的贪心策略，平均多花 ' + pct(g.gGap) + '；它确实常常对，但错的那部分足以让你白跑一趟。',

      '<b>④ "先去最远的"是错的那一个。</b>' +
      ' 由远到近平均多花 ' + pct(g.ff) + '，由近到远只多花 ' + pct(g.nf) + '。' +
      ' 在最优顺序里，离你最远的那件事有 ' + g.farLast + '/' + g.n + ' 次排在<b>最后</b>，只有 ' + g.farFirst + ' 次排在最前。' +
      ' 它该排最后不是因为它远，而是因为——办完它你就不用从那儿回来了。勾上"还要回家"再看一次，这条规律就不灵了。',

      '<b>⑤ 你不需要算 24 遍，只要避开自己打结的那几条。</b>' +
      ' 全部 ' + g.total + ' 条走法里有 ' + g.knotN + ' 条自身交叉（打结），' +
      ' 而 ' + pct(g.knot0Pct) + ' 的最优走法<b>不打结</b>——只看不打结的那几条，你就已经拿到了绝大多数情况下的最优。',

      '<b>⑥ 最"绕"的城市是' + pc[0].city + '（' + pct(pc[0].v) + '），最"直"的是' + pc[pc.length - 1].city + '（' + pct(pc[pc.length - 1].v) + '）。</b>' +
      ' 顺序的代价是路网的形状决定的，不是距离决定的。'
    ].map(function (s) { return '· ' + s; }).join('<br><br>');
    $('findings').innerHTML = html;
  }

  /* ---------------- 地图 ---------------- */
  function svgIcon(color, label) {
    var s = '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">' +
      '<circle cx="18" cy="18" r="14" fill="' + color + '" stroke="#ffffff" stroke-width="3"/>' +
      '<text x="18" y="24" font-size="15" font-family="-apple-system,sans-serif" fill="#ffffff" text-anchor="middle">' + label + '</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
  }
  var KIND_COLOR = { '超市': '#1a73e8', '药店': '#0f9d58', '干洗店': '#8e5bd0', '咖啡': '#d97a1a' };

  function initMap() {
    if (!window.TMap) { showErr('腾讯地图 JSAPI 未加载，地图区域不可用（其余数字与图表不受影响）。'); return; }
    var s = curSet();
    map = new TMap.Map('map', {
      center: new TMap.LatLng(s.pts[0].lat, s.pts[0].lng),
      zoom: 13, pitch: 0, showControl: false
    });
    var mk = function (o) { return new TMap.PolylineStyle(o); };
    // 图层按创建顺序叠：后建的在上
    layers.others = new TMap.MultiPolyline({
      map: map, styles: { o: mk({ color: 'rgba(140,150,163,0.35)', width: 2, lineCap: 'round' }) }, geometries: []
    });
    layers.greedy = new TMap.MultiPolyline({
      map: map, styles: { o: mk({ color: 'rgba(240,138,36,0.85)', width: 4, lineCap: 'round' }) }, geometries: []
    });
    layers.worst = new TMap.MultiPolyline({
      map: map, styles: { o: mk({ color: 'rgba(232,69,60,0.9)', width: 4, lineCap: 'round', borderWidth: 0 }) }, geometries: []
    });
    layers.best = new TMap.MultiPolyline({
      map: map, styles: { o: mk({ color: 'rgba(26,115,232,0.95)', width: 6, lineCap: 'round' }) }, geometries: []
    });
    layers.hot = new TMap.MultiPolyline({
      map: map, styles: { o: mk({ color: 'rgba(30,36,48,0.9)', width: 3, lineCap: 'round' }) }, geometries: []
    });

    var styles = {};
    styles.home = new TMap.MarkerStyle({
      width: 30, height: 30, anchor: { x: 15, y: 15 }, src: svgIcon('#1e2430', '起')
    });
    for (var i = 1; i < 5; i++) {
      styles['e' + i] = new TMap.MarkerStyle({
        width: 28, height: 28, anchor: { x: 14, y: 14 },
        src: svgIcon(KIND_COLOR[curSet().pts[i].kind] || '#5b6472', String(i))
      });
    }
    markers = new TMap.MultiMarker({ map: map, styles: styles, geometries: [] });
    ready = true;
  }

  function showErr(msg) {
    var e = $('mapErr');
    if (e) { e.style.display = 'block'; e.textContent = msg; }
  }

  function toLatLng(pts) {
    return pts.map(function (p) { return new TMap.LatLng(p[0], p[1]); });
  }

  function mercY(lat) {
    var s = Math.sin(lat * Math.PI / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  }

  function autoFit(pts) {
    if (!map || !pts.length) return;
    var minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    pts.forEach(function (p) {
      if (p[0] < minLat) minLat = p[0]; if (p[0] > maxLat) maxLat = p[0];
      if (p[1] < minLng) minLng = p[1]; if (p[1] > maxLng) maxLng = p[1];
    });
    var el = $('map');
    var W = (el && el.clientWidth) || 640, H = (el && el.clientHeight) || 440;
    var dLngFrac = Math.max((maxLng - minLng) / 360, 0.000002);   /* 经度差 -> 世界宽度占比 */
    var dLatFrac = Math.max(Math.abs(mercY(maxLat) - mercY(minLat)), 0.000002);
    var zx = Math.log(W / (256 * dLngFrac * 1.25)) / Math.LN2;
    var zy = Math.log(H / (256 * dLatFrac * 1.25)) / Math.LN2;
    var z = Math.max(3, Math.min(17, Math.floor(Math.min(zx, zy))));
    map.setCenter(new TMap.LatLng((minLat + maxLat) / 2, (minLng + maxLng) / 2));
    map.setZoom(z);
    window.__knot_lastZoom = z;
  }

  function drawRoutes(a) {
    if (!ready) return;
    var s = curSet();
    var bestKey = a.best.order.join(','), worstKey = a.worst.order.join(','), gKey = a.greedy.order.join(',');
    var others = [];
    a.rows.forEach(function (r, i) {
      var k = r.order.join(',');
      if (k === bestKey || k === worstKey || k === gKey) return;
      if (i === state.hot) return;
      var g = M.orderGeom(s, r.order, 0, state.closed);
      if (g.length > 1) others.push({ styleId: 'o', paths: toLatLng(g) });
    });
    layers.others.setGeometries(others);

    var setOne = function (layer, order) {
      var g = order && order.length ? M.orderGeom(s, order, 0, state.closed) : [];
      layer.setGeometries(g.length > 1 ? [{ styleId: 'o', paths: toLatLng(g) }] : []);
    };
    setOne(layers.greedy, a.greedy.order);
    setOne(layers.worst, a.worst.order);
    setOne(layers.best, state.hot >= 0 ? null : a.best.order);
    var hotOrder = state.hot >= 0 && a.rows[state.hot] ? a.rows[state.hot].order : null;
    setOne(layers.hot, hotOrder);

    var gs = [{ id: 'home', styleId: 'home', position: new TMap.LatLng(s.pts[0].lat, s.pts[0].lng) }];
    state.sel.forEach(function (idx) {
      gs.push({ id: 'e' + idx, styleId: 'e' + idx, position: new TMap.LatLng(s.pts[idx].lat, s.pts[idx].lng) });
    });
    markers.setGeometries(gs);

    // 取景点位：所有选中点 + 最优路线
    var fit = state.sel.map(function (i) { return [s.pts[i].lat, s.pts[i].lng]; });
    fit.push([s.pts[0].lat, s.pts[0].lng]);
    autoFit(fit);
  }

  /* ---------------- 主渲染 ---------------- */
  function render() {
    var a = analyze();
    renderText(a);
    renderBars(a);
    renderFindings();
    drawRoutes(a);
    window.__knot_state = { ci: state.ci, si: state.si, sel: state.sel.slice(), closed: state.closed, metric: state.metric };
  }

  function boot() {
    try {
      buildControls();
      bindToggles();
      initMap();
      render();
      window.__knot_ready = true;
    } catch (e) {
      showErr('初始化失败：' + (e && e.message ? e.message : e));
      window.__knot_ready = false;
      throw e;
    }
  }

  window.__knot_boot = boot;
  window.__knot_render = render;
  window.__knot_analyze = analyze;
  window.__knot_stats = globalStats;
  window.__knot_data = { CITIES: CITIES, ALL: ALL };

  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot);
})();
