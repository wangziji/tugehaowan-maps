/* 《路过 · PASSING BY》交互层。
   纪律备忘（本项目既往踩坑，逐条照做）：
   - 入口必须自启动，且冒烟断言要模拟真实 load 流程，不允许脚本自己调 boot 充数；
   - TMap GL 不接受 8 位十六进制颜色，只能用 rgb()/6 位十六进制；
   - 本版 fitBounds 只挪中心不改 zoom，zoom 自己按 Web Mercator 解；
   - 节流函数先判前置条件再写时间戳，早退不能污染节流状态；
   - catch 必须留下用户可见痕迹，静默失败 = 把 bug 藏起来；
   - 不画的图层要 setGeometries([]) 清掉残留；
   - Grid 用 minmax(0,1fr)，别让固定尺寸 canvas 撑住布局。 */
(function () {
  'use strict';

  var M = window.PASSBY;
  var DATA = window.__PASSBY_DATA__;
  var KEY = 'CVIBZ-RDZCD-J3B4T-HGLIP-V7Z2F-EQB5N';

  var state = {
    pairIdx: 0,
    rate: 0.8,
    layer: 'rec',      // rec | all
    poiMode: 'dest',   // dest | all
    known: {}          // poiId -> true
  };

  var map = null, ready = false;
  var lyRoute = null, lyPoi = null, lyEnd = null;
  var lastFit = 0;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function fmt(n, d) {
    var x = typeof n === 'number' ? n : parseFloat(n);
    if (!isFinite(x)) return '—';
    return x.toLocaleString('zh-CN', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  }
  function showErr(msg) {
    var e = $('err');
    if (!e) return;
    e.textContent = msg || '';
    e.style.display = msg ? 'block' : 'none';
  }
  function mapMsg(msg, warn) {
    var e = $('mapmsg');
    if (!e) return;
    e.textContent = msg || '';
    e.className = warn ? 'warn' : '';
  }

  /* ---------- Web Mercator 取景：本版 fitBounds 不改 zoom，自己解 ---------- */
  function mercY(lat) {
    var s = Math.sin(lat * Math.PI / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  }
  function fitTo(bounds, padPx) {
    if (!map) return;
    var el = $('map');
    var W = Math.max(200, el.clientWidth) - (padPx || 40);
    var H = Math.max(160, el.clientHeight) - (padPx || 40);
    var dx = Math.abs((bounds.e - bounds.w) / 360.0) || 1e-6;
    var dy = Math.abs(mercY(bounds.n) - mercY(bounds.s)) || 1e-6;
    var z = Math.min(Math.log(W / (256.0 * dx)) / Math.LN2,
                     Math.log(H / (256.0 * dy)) / Math.LN2);
    z = Math.max(3, Math.min(16, z));
    map.setCenter(new window.TMap.LatLng((bounds.n + bounds.s) / 2, (bounds.w + bounds.e) / 2));
    map.setZoom(Math.round(z * 10) / 10);
    return z;
  }
  function boundsOf(points) {
    var b = { n: -90, s: 90, e: -180, w: 180 };
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      b.n = Math.max(b.n, p[0]); b.s = Math.min(b.s, p[0]);
      b.e = Math.max(b.e, p[1]); b.w = Math.min(b.w, p[1]);
    }
    return b;
  }

  /* ---------- 地图 ---------- */
  function initMap() {
    if (map || typeof window.TMap === 'undefined') return;
    var p = DATA.pairs[state.pairIdx];
    map = new window.TMap.Map($('map'), {
      center: new window.TMap.LatLng((p.from[0] + p.to[0]) / 2, (p.from[1] + p.to[1]) / 2),
      zoom: 12, pitch: 0, baseMap: { type: 'vector' }
    });
    // 先建 POI 层再建路线层：TMap 按创建顺序叠，后建的在上面。
    // 顺序反了 500+ 个点会把路线整个盖住（第一版就是这样，路线几乎看不见）。
    lyPoi = new window.TMap.MultiCircle({
      map: map,
      styles: {
        s: new window.TMap.CircleStyle({ color: 'rgb(228,87,46)', opacity: 0.62, showBorder: false }),
        w: new window.TMap.CircleStyle({ color: 'rgb(47,111,208)', opacity: 0.42, showBorder: false }),
        b: new window.TMap.CircleStyle({ color: 'rgb(170,180,194)', opacity: 0.32, showBorder: false })
      },
      geometries: []
    });
    lyRoute = new window.TMap.MultiPolyline({
      map: map,
      styles: {
        base: new window.TMap.PolylineStyle({ color: 'rgb(110,120,138)', width: 5, borderWidth: 2, borderColor: 'rgb(255,255,255)', lineCap: 'round' }),
        other: new window.TMap.PolylineStyle({ color: 'rgb(150,160,176)', width: 4, borderWidth: 1, borderColor: 'rgb(255,255,255)', lineCap: 'round' }),
        rec: new window.TMap.PolylineStyle({ color: 'rgb(228,87,46)', width: 7, borderWidth: 2, borderColor: 'rgb(255,255,255)', lineCap: 'round' })
      },
      geometries: []
    });
    var ico = function (c, t) {
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="34" viewBox="0 0 26 34">'
        + '<path d="M13 0C6.4 0 1 5.4 1 12c0 8.4 12 22 12 22s12-13.6 12-22c0-6.6-5.4-12-12-12z" fill="' + c + '" stroke="#fff" stroke-width="2"/>'
        + '<text x="13" y="17" font-size="12" font-family="sans-serif" fill="#fff" text-anchor="middle">' + t + '</text></svg>';
      return { url: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg), width: 26, height: 34, anchor: { x: 13, y: 34 } };
    };
    lyEnd = new window.TMap.MultiMarker({
      map: map,
      styles: {
        a: new window.TMap.MarkerStyle(ico('rgb(31,111,235)', '起')),
        b: new window.TMap.MarkerStyle(ico('rgb(228,87,46)', '终'))
      },
      geometries: []
    });
    ready = true;
  }

  function drawMap() {
    if (!ready) return;
    var p = DATA.pairs[state.pairIdx];
    var rec = M.recommend(p.routes, state.rate);
    var pickK = rec.pick.k;

    // ---- 路线 ----
    var geoms = [], fitPts = [p.from, p.to];
    for (var i = 0; i < p.routes.length; i++) {
      var r = p.routes[i];
      var styleId = r.k === 0 ? 'base' : (r.k === pickK ? 'rec' : 'other');
      if (state.layer === 'rec' && !(r.k === 0 || r.k === pickK)) continue;
      geoms.push({
        id: 'r' + i,
        styleId: styleId,
        paths: r.p.map(function (q) { return new window.TMap.LatLng(q[0], q[1]); })
      });
      for (var j = 0; j < r.p.length; j += 3) fitPts.push(r.p[j]);
    }
    lyRoute.setGeometries(geoms);

    // ---- 终点标记 ----
    lyEnd.setGeometries([
      { id: 'from', styleId: 'a', position: new window.TMap.LatLng(p.from[0], p.from[1]) },
      { id: 'to', styleId: 'b', position: new window.TMap.LatLng(p.to[0], p.to[1]) }
    ]);

    // ---- POI ----
    var shown = p.routes.filter(function (r) {
      return state.layer === 'all' || r.k === 0 || r.k === pickK;
    });
    var circles = [];
    var seen = {};
    for (var a = 0; a < shown.length; a++) {
      var rr = shown[a];
      for (var b = 0; b < rr.poi.length; b++) {
        var q = rr.poi[b];
        var cls = M.poiClass(q[2]);
        if (state.poiMode === 'dest' && cls === 'bg') continue;
        var key = q[0];
        if (seen[key]) continue;
        seen[key] = 1;
        circles.push({
          id: 'c' + key,
          styleId: cls === 'strong' ? 's' : (cls === 'weak' ? 'w' : 'b'),
          center: new window.TMap.LatLng(q[3], q[4]),
          radius: cls === 'strong' ? 74 : (cls === 'weak' ? 56 : 44)
        });
      }
    }
    try {
      lyPoi.setGeometries(circles);
    } catch (e) {
      // 大样本下偶发失败，减半重试；失败必须留痕，不能只 console.warn
      try {
        lyPoi.setGeometries(circles.slice(0, Math.floor(circles.length / 2)));
        mapMsg('POI 图层一次绘制失败，已减半重绘（' + Math.floor(circles.length / 2) + '/' + circles.length + ' 个）', true);
      } catch (e2) {
        lyPoi.setGeometries([]);
        showErr('POI 图层绘制失败：' + (e2 && e2.message ? e2.message : '未知错误'));
      }
    }
    mapMsg('已绘制 ' + geoms.length + ' 条路线、' + circles.length + ' 个路过点'
      + (shown.length > 1 ? '（两条路线去重合计）' : '') + ' · 橙=目的地 蓝=弱目的地 灰=背景');
    fitTo(boundsOf(fitPts), 56);
  }

  /* ---------- 面板 ---------- */
  function renderLadder() {
    var p = DATA.pairs[state.pairIdx];
    var rec = M.recommend(p.routes, state.rate);
    var ld = rec.ladder;
    var tb = document.querySelector('#tbl-ladder tbody');
    var rows = '';
    for (var i = 0; i < ld.length; i++) {
      var L = ld[i];
      var cls = (i === rec.idx && rec.reason === 'detour') ? 'rec' : (L.k === 0 ? 'base' : '');
      var color = L.k === 0 ? 'var(--bg3)' : (i === rec.idx && rec.reason === 'detour' ? 'var(--accent)' : 'var(--ink3)');
      var name = L.k === 0 ? '直达'
        : (L.k > 0 ? '绕行 +' : '绕行 ') + Math.abs(L.k).toFixed(1) + ' 档';
      rows += '<tr class="' + cls + '">'
        + '<td><span class="pill" style="background:' + color + '"></span>' + esc(name) + '</td>'
        + '<td>' + fmt(L.d / 1000, 1) + ' km</td>'
        + '<td>' + fmt(L.t) + ' min</td>'
        + '<td>' + (L.dt < 0.05 ? '—' : '+' + fmt(L.dt, 1) + ' min') + '</td>'
        + '<td>' + fmt(L.st.nStrong) + '</td>'
        + '<td>' + (L.dt < 0.05 ? '—' : (L.dStrong === 0 ? '0' : '+' + fmt(L.dStrong))) + '</td>'
        + '<td>' + (L.dt < 0.05 ? '—' : fmt(L.perMin, 1)) + '</td>'
        + '</tr>';
    }
    tb.innerHTML = rows;

    var msg;
    if (rec.reason === 'no-worth-detour') {
      msg = '这一条不值：绕行每分钟换不回 ' + state.rate.toFixed(1) + ' 个新地方，导航给你的直达就是答案。';
    } else {
      var L2 = rec.pick;
      msg = '多花 ' + fmt(L2.dt, 1) + ' 分钟，多路过 ' + fmt(L2.dStrong) + ' 个地方 —— 每分钟 ' + fmt(L2.perMin, 1)
        + ' 个。' + (M.routeStats(p.routes.filter(function (r) { return r.k === 0; })[0]).nStrong)
        + ' → ' + L2.st.nStrong + ' 个目的地。';
    }
    $('ladder-msg').textContent = msg;

    // 递减曲线
    var W = 520, H = 190, pl = 42, pr = 12, pt = 12, pb = 30;
    var maxX = Math.max(1, ld[ld.length - 1].dt);
    var maxY = Math.max(1, ld[ld.length - 1].dStrong);
    var X = function (v) { return pl + (W - pl - pr) * (v / maxX); };
    var Y = function (v) { return H - pb - (H - pt - pb) * (v / maxY); };
    var pts = ld.map(function (L) { return [X(L.dt), Y(L.dStrong)]; });
    var g = '';
    g += '<line x1="' + pl + '" y1="' + (H - pb) + '" x2="' + (W - pr) + '" y2="' + (H - pb) + '" stroke="#d8dde6"/>';
    g += '<line x1="' + pl + '" y1="' + pt + '" x2="' + pl + '" y2="' + (H - pb) + '" stroke="#d8dde6"/>';
    g += '<polyline fill="none" stroke="#e4572e" stroke-width="2.5" points="' + pts.map(function (q) { return q[0].toFixed(1) + ',' + q[1].toFixed(1); }).join(' ') + '"/>';
    for (var i2 = 0; i2 < pts.length; i2++) {
      var rec2 = (i2 === rec.idx && rec.reason === 'detour');
      g += '<circle cx="' + pts[i2][0].toFixed(1) + '" cy="' + pts[i2][1].toFixed(1) + '" r="' + (rec2 ? 6 : 4) + '" fill="' + (rec2 ? '#e4572e' : '#fff') + '" stroke="#e4572e" stroke-width="2"/>';
      g += '<text x="' + pts[i2][0].toFixed(1) + '" y="' + (pts[i2][1] - 9).toFixed(1) + '" font-size="10" fill="#5a6478" text-anchor="middle">' + (ld[i2].k === 0 ? '直达' : (ld[i2].k > 0 ? '+' : '−') + Math.abs(ld[i2].k).toFixed(1)) + '</text>';
    }
    g += '<text x="' + (W / 2) + '" y="' + (H - 8) + '" font-size="11" fill="#8a93a6" text-anchor="middle">多花的分钟数</text>';
    g += '<text x="14" y="' + (pt + 10) + '" font-size="11" fill="#8a93a6">多路过</text>';
    g += '<text x="' + pl + '" y="' + (H - pb + 14) + '" font-size="10" fill="#8a93a6" text-anchor="middle">0</text>';
    g += '<text x="' + (W - pr) + '" y="' + (H - pb + 14) + '" font-size="10" fill="#8a93a6" text-anchor="end">' + fmt(maxX, 1) + '</text>';
    $('curve').innerHTML = g;
  }

  function renderBands() {
    var p = DATA.pairs[state.pairIdx];
    var rec = M.recommend(p.routes, state.rate);
    var r = p.routes.filter(function (x) { return x.k === rec.pick.k; })[0] || p.routes[0];
    var s = M.routeStats(r);
    var max = Math.max(1, s.bands.side, s.bands.near, s.bands.far);
    var html = '';
    for (var i = 0; i < M.BANDS.length; i++) {
      var b = M.BANDS[i];
      var n = s.bands[b.id];
      html += '<div class="bar"><span class="t">' + esc(b.name) + '</span>'
        + '<span class="track"><span class="fill" style="width:' + (100.0 * n / max).toFixed(1) + '%"></span></span>'
        + '<span class="n">' + fmt(n) + '</span></div>';
    }
    html += '<div class="bar"><span class="t">其中目的地</span>'
      + '<span class="track"><span class="fill s" style="width:' + (100.0 * s.nStrong / max).toFixed(1) + '%"></span></span>'
      + '<span class="n">' + fmt(s.nStrong) + '</span></div>';
    $('bars-band').innerHTML = html;
  }

  function renderCats() {
    var p = DATA.pairs[state.pairIdx];
    var rec = M.recommend(p.routes, state.rate);
    var r = p.routes.filter(function (x) { return x.k === rec.pick.k; })[0] || p.routes[0];
    var s = M.routeStats(r);
    var top = M.sortedCats(s.l2s, 10);
    var max = Math.max(1, top.length ? top[0][1] : 1);
    var html = '';
    for (var i = 0; i < top.length; i++) {
      html += '<div class="bar"><span class="t">' + esc(top[i][0]) + '</span>'
        + '<span class="track"><span class="fill s" style="width:' + (100.0 * top[i][1] / max).toFixed(1) + '%"></span></span>'
        + '<span class="n">' + fmt(top[i][1]) + '</span></div>';
    }
    if (!top.length) html = '<div class="hint">这条路线上没有识别到目的地类 POI。</div>';
    $('bars-cat').innerHTML = html;
    $('k-H').textContent = s.H.toFixed(2);
  }

  function renderProfile() {
    var p = DATA.pairs[state.pairIdx];
    var rec = M.recommend(p.routes, state.rate);
    var r = p.routes.filter(function (x) { return x.k === rec.pick.k; })[0] || p.routes[0];
    var pf = M.profile(r, 24);
    var max = Math.max.apply(null, pf.bins.concat([1]));
    var html = '';
    for (var i = 0; i < pf.bins.length; i++) {
      var h = Math.max(1, Math.round(64.0 * pf.bins[i] / max));
      html += '<i style="height:' + h + 'px" title="第 ' + (i + 1) + ' 段：' + pf.bins[i] + ' 个"></i>';
    }
    $('prof').innerHTML = html;
  }

  function renderKpis() {
    var p = DATA.pairs[state.pairIdx];
    var rec = M.recommend(p.routes, state.rate);
    var r = p.routes.filter(function (x) { return x.k === rec.pick.k; })[0] || p.routes[0];
    var s = M.routeStats(r);
    var an = M.annual(s.nStrong, M.WORKDAYS, M.TRIPS_PER_DAY);
    var known = 0, k;
    for (k in state.known) if (state.known[k]) known++;
    var sr = M.strangerRate(s.nStrong, known);

    $('k-nstrong').textContent = fmt(s.nStrong);
    $('k-trips').textContent = fmt(M.WORKDAYS * M.TRIPS_PER_DAY);
    $('k-year').textContent = an.perYear >= 10000 ? fmt(an.perYear / 10000, 1) + ' 万' : fmt(an.perYear);
    $('k-year-n').textContent = fmt(s.nStrong) + ' 个 × ' + M.WORKDAYS + ' 天 × ' + M.TRIPS_PER_DAY + ' 趟';
    $('k-stranger').textContent = fmt(sr.unknown) + ' 个';
    $('k-stranger-n').textContent = known === 0
      ? '陌生率 100.0% · 在下面清单里勾掉你进去过的'
      : '陌生率 ' + (sr.rate * 100).toFixed(1) + '% · 认识 ' + known + ' 个 / 共 ' + s.nStrong + ' 个';

    var kmYear = r.d / 1000.0 * M.WORKDAYS * M.TRIPS_PER_DAY;
    var laps = kmYear / 40075.0;
    $('k-laps').textContent = laps >= 1 ? fmt(laps, 1) + ' 圈' : fmt(laps, 2) + ' 圈';
    $('k-laps-n').textContent = '一年 ' + fmt(kmYear) + ' km';

    // 荒诞换算
    var ns = M.nameScale(s.chars, M.WORKDAYS, M.TRIPS_PER_DAY);
    var hours = r.t / 60.0 * M.WORKDAYS * M.TRIPS_PER_DAY;
    var abs = [
      ['一年路过 ' + (an.perYear >= 10000 ? fmt(an.perYear / 10000, 1) + ' 万次' : fmt(an.perYear) + ' 次'), '门', '你从这些地方门口经过的次数'],
      [fmt(ns.honglou, 2) + ' 部《红楼梦》', '字数', '把一年路过的名字连起来共 ' + fmt(ns.chars / 10000, 1) + ' 万字'],
      [fmt(hours) + ' 小时', '路上', '相当于 ' + fmt(hours / 24, 1) + ' 个整天待在这条路上'],
      [fmt(ns.chars / 300 / 60, 1) + ' 小时', '读完要多久', '按每分钟读 300 字，读完一年路过的所有名字']
    ];
    var l2 = M.sortedCats(s.l2s, 3);
    if (l2.length) {
      abs.push([l2.map(function (x) { return x[0] + ' ' + x[1]; }).join('、'), '最常路过', '二级分类 TOP3']);
    }
    var html = '';
    for (var i = 0; i < abs.length; i++) {
      html += '<div class="ab"><div class="v">' + esc(abs[i][0]) + '</div><div class="k">' + esc(abs[i][1]) + ' · ' + esc(abs[i][2]) + '</div></div>';
    }
    $('absurd').innerHTML = html;
  }

  function renderPoiList() {
    var p = DATA.pairs[state.pairIdx];
    var rec = M.recommend(p.routes, state.rate);
    var r = p.routes.filter(function (x) { return x.k === rec.pick.k; })[0] || p.routes[0];
    var strong = r.poi.filter(function (q) { return M.poiClass(q[2]) === 'strong'; })
      .sort(function (a, b) { return a[5] - b[5]; }).slice(0, 40);
    var html = '';
    for (var i = 0; i < strong.length; i++) {
      var q = strong[i];
      var on = !!state.known[q[0]];
      html += '<li><label><input type="checkbox" data-id="' + esc(q[0]) + '"' + (on ? ' checked' : '') + '>'
        + '<span class="nm">' + esc(q[1]) + '</span>'
        + '<span class="ct">' + esc(M.level2(q[2])) + '</span>'
        + '<span class="ds">' + (q[5] <= 15 ? '路边' : fmt(q[5]) + ' m') + '</span></label></li>';
    }
    if (!strong.length) html = '<li><span class="ct">这条路线上没有强目的地类 POI。</span></li>';
    $('lst-poi').innerHTML = html;
    var boxes = $('lst-poi').querySelectorAll('input[type=checkbox]');
    for (var j = 0; j < boxes.length; j++) {
      boxes[j].addEventListener('change', function () {
        state.known[this.getAttribute('data-id')] = this.checked;
        renderKpis();
        renderKnownHint(r);   // 勾选后"还剩几个"必须跟着变，光更新 KPI 会留下过期文案
      });
    }
    renderKnownHint(r);
  }

  function renderKnownHint(r) {
    var s = M.routeStats(r);
    var known = 0, k;
    for (k in state.known) if (state.known[k]) known++;
    var sr = M.strangerRate(s.nStrong, known);
    $('known-hint').textContent = '还剩 ' + fmt(sr.unknown) + ' 个地方，你天天路过，从没进去过。'
      + '（陌生率 ' + (sr.rate * 100).toFixed(1) + '%）';
  }

  function renderAll() {
    renderLadder();
    renderBands();
    renderCats();
    renderProfile();
    renderKpis();
    renderPoiList();
    drawMap();
  }

  /* ---------- 事件 ---------- */
  function buildSelect() {
    var sel = $('sel-pair');
    var html = '';
    for (var i = 0; i < DATA.pairs.length; i++) {
      var p = DATA.pairs[i];
      html += '<option value="' + i + '">' + esc(p.city) + ' · ' + esc(p.name) + '</option>';
    }
    sel.innerHTML = html;
    sel.value = String(state.pairIdx);
    sel.addEventListener('change', function () {
      state.pairIdx = Math.max(0, Math.min(DATA.pairs.length - 1, parseInt(this.value, 10) || 0));
      state.known = {};
      renderAll();
    });
  }

  function bindSeg(id, key) {
    var seg = $(id);
    var btns = seg.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () {
        var v = this.getAttribute('data-v');
        for (var j = 0; j < btns.length; j++) btns[j].className = (btns[j] === this) ? 'on' : '';
        state[key] = v;
        renderAll();
      });
    }
  }

  /* 节流：先判前置条件，再写时间戳，早退不污染节流状态 */
  var lastResize = 0;
  function onResize() {
    if (!ready || !map) return;
    var now = Date.now();
    if (now - lastResize < 300) return;
    lastResize = now;
    try {
      var p = DATA.pairs[state.pairIdx];
      var pts = [p.from, p.to];
      var r0 = p.routes[0];
      for (var j = 0; j < r0.p.length; j += 3) pts.push(r0.p[j]);
      fitTo(boundsOf(pts), 56);
    } catch (e) { /* 尺寸变化时取景失败不影响数据面板 */ }
  }

  function boot() {
    try {
      if (!DATA || !DATA.pairs || !DATA.pairs.length) { showErr('数据未加载：passby/data.js 缺失或为空'); return; }
      $('gen-at').textContent = (DATA.meta && DATA.meta.generated_at) ? DATA.meta.generated_at : '—';
      // HTML 里的静态初值可能与 state 漂移，boot 时以 state 为准写回去
      $('v-rate').textContent = state.rate.toFixed(1);
      $('rng-rate').value = String(state.rate);
      buildSelect();
      bindSeg('seg-layer', 'layer');
      bindSeg('seg-poi', 'poiMode');
      $('rng-rate').addEventListener('input', function () {
        state.rate = parseFloat(this.value);
        $('v-rate').textContent = state.rate.toFixed(1);
        renderLadder(); renderBands(); renderCats(); renderProfile(); renderKpis(); renderPoiList(); drawMap();
      });
      window.addEventListener('resize', onResize);
      initMap();
      renderAll();
      var p = DATA.pairs[state.pairIdx];
      $('pair-hint').textContent = p.city + ' · ' + p.name + '：直线 ' + fmt(p.sd / 1000, 1)
        + ' km，5 条候选路线（直达 + 左右各两档绕行），沿路每 '
        + (DATA.meta && DATA.meta.step ? DATA.meta.step : 600) + ' 米做一次半径 '
        + (DATA.meta && DATA.meta.rad ? DATA.meta.rad : 350) + ' 米的 POI 检索后去重。';
    } catch (e) {
      showErr('初始化失败：' + (e && e.message ? e.message : e));
      throw e;
    }
  }

  // 自启动：真实页面加载流程（冒烟脚本同样只走 load 事件，不允许外部调 boot 充数）
  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot);
})();
