/* 《折痕 THE CREASE》交互层 */
(function () {
  'use strict';

  var M = window.CreaseModel;
  var D = window.CREASE_DATA;
  var errBox = document.getElementById('err');

  function err(msg) {
    if (!errBox) return;
    errBox.style.display = 'block';
    errBox.textContent = String(msg);
  }
  function clearErr() { if (errBox) { errBox.style.display = 'none'; errBox.textContent = ''; } }

  if (!M || !D || !D.cities || !D.cities.length) {
    err('数据或模型未加载，页面无法渲染。');
    return;
  }

  var state = { ci: 0, n: 2 };
  var map = null, ready = false;
  var L = {};                       // 图层：按顺序创建，后建的在上
  var _lastFit = 0;
  var cache = {};                   // cityName -> crease

  /* ---------------- 工具 ---------------- */
  function city() { return D.cities[state.ci]; }
  function min(s) { return (s / 60); }
  function f1(x) { return (Math.round(x * 10) / 10).toFixed(1); }
  function f0(x) { return Math.round(x).toString(); }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]; }); }

  function creaseOf(c) {
    if (!cache[c.name]) cache[c.name] = M.creaseStats(c);
    return cache[c.name];
  }

  /** 公平度 → 颜色（teal → amber → red）。f ∈ [0,1]，1 = 完全公平 */
  function fairColor(f) {
    var stops = [[13, 148, 136], [245, 158, 11], [220, 38, 38]];
    var x = 1 - Math.max(0, Math.min(1, f));         // 0 = 公平
    var t = x * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(t)), u = t - i;
    var a = stops[i], b = stops[i + 1];
    return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * u) + ',' +
      Math.round(a[1] + (b[1] - a[1]) * u) + ',' + Math.round(a[2] + (b[2] - a[2]) * u) + ')';
  }
  /** Δt → 发散色（蓝 = A 更快 = 对 A 有利；橙 = B 更快） */
  function dtColor(dt, mx) {
    if (!(mx > 0)) return 'rgb(148,163,184)';
    var x = Math.max(-1, Math.min(1, dt / mx));
    var base = [148, 163, 184], blue = [29, 78, 216], orange = [234, 88, 12];
    var t = x < 0 ? blue : orange, a = Math.abs(x);
    return 'rgb(' + Math.round(base[0] + (t[0] - base[0]) * a) + ',' +
      Math.round(base[1] + (t[1] - base[1]) * a) + ',' + Math.round(base[2] + (t[2] - base[2]) * a) + ')';
  }

  function svgIcon(svg) { return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); }
  /** 'rgb(r,g,b)' → 'r,g,b'，方便拼 rgba */
  function rgbOf(s) {
    var m = /rgb\((\d+),(\d+),(\d+)\)/.exec(String(s));
    return m ? m[1] + ',' + m[2] + ',' + m[3] : '148,163,184';
  }
  function pinIcon(color, label) {
    return svgIcon('<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34">' +
      '<circle cx="17" cy="17" r="13" fill="' + color + '" stroke="#ffffff" stroke-width="3"/>' +
      '<text x="17" y="22" font-size="14" font-family="sans-serif" font-weight="700" fill="#ffffff" text-anchor="middle">' + label + '</text></svg>');
  }
  var ICON_GEO = svgIcon('<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 30 30">' +
    '<circle cx="15" cy="15" r="11" fill="#ffffff" stroke="#64748b" stroke-width="3"/>' +
    '<path d="M10 10 L20 20 M20 10 L10 20" stroke="#64748b" stroke-width="3" stroke-linecap="round"/></svg>');
  var ICON_FAIR = svgIcon('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">' +
    '<circle cx="20" cy="20" r="15" fill="#f59e0b" stroke="#ffffff" stroke-width="3"/>' +
    '<path d="M20 10 L23.5 17.6 L32 18.4 L25.6 23.6 L27.6 31.8 L20 27.4 L12.4 31.8 L14.4 23.6 L8 18.4 L16.5 17.6 Z" fill="#ffffff"/></svg>');
  var PIN_COLORS = ['#1d4ed8', '#ea580c', '#0d9488', '#7c3aed'];

  /* ---------------- 自动取景（自带 zoom，不用 fitBounds） ---------------- */
  function fitTo(pts) {
    if (!map || !pts || !pts.length) return null;
    var minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    for (var i = 0; i < pts.length; i++) {
      var la = pts[i][0], lo = pts[i][1];
      if (!isFinite(la) || !isFinite(lo)) continue;
      if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
      if (lo < minLng) minLng = lo; if (lo > maxLng) maxLng = lo;
    }
    if (minLat > maxLat) return null;
    minLat = Math.max(-85, minLat); maxLat = Math.min(85, maxLat);
    var el = document.getElementById('map');
    var W = (el && el.clientWidth) || 800, H = (el && el.clientHeight) || 520;
    var dLng = Math.max(1e-5, (maxLng - minLng) / 360);
    var a = Math.log(Math.tan(Math.PI / 4 + maxLat * Math.PI / 360));
    var b = Math.log(Math.tan(Math.PI / 4 + minLat * Math.PI / 360));
    var dLat = Math.max(1e-5, Math.abs(a - b) / (2 * Math.PI));
    var z = Math.min(Math.log(W / (256 * dLng)) / Math.LN2, Math.log(H / (256 * dLat)) / Math.LN2) - 0.25;
    z = Math.max(3, Math.min(16, Math.round(z * 100) / 100));
    var c = [(minLat + maxLat) / 2, (minLng + maxLng) / 2];
    map.setCenter(new window.TMap.LatLng(c[0], c[1]));
    map.setZoom(z);
    _lastFit = Date.now();
    return { zoom: z, center: c };
  }
  window.__crease_fit = fitTo;

  /* ---------------- 地图 ---------------- */
  function initMap() {
    var T = window.TMap;
    if (!T) { err('腾讯地图 JSAPI 未加载，地图区无法显示（下方数字与表格仍可用）。'); return false; }
    var c = city();
    var ctr = new T.LatLng(c.geo.lat, c.geo.lng);
    try {
      map = new T.Map(document.getElementById('map'), {
        center: ctr, zoom: 11, pitch: 0, showControl: true, baseMap: { type: 'vector' }
      });
    } catch (e) { err('地图初始化失败：' + e.message); return false; }

    // 顺序 = 叠放次序，后建的在上
    var cstyles = {}, dstyles = {};
    for (var i = 0; i < 12; i++) {
      cstyles['f' + i] = new T.CircleStyle({
        color: 'rgba(' + rgbOf(fairColor(1 - i / 11)) + ',0.72)',
        showBorder: true, borderColor: 'rgb(255,255,255)', borderWidth: 1
      });
      dstyles['d' + i] = new T.CircleStyle({
        color: 'rgba(' + rgbOf(dtColor(-1 + 2 * i / 11, 1)) + ',0.30)',
        showBorder: false, borderWidth: 0
      });
    }
    try {
      L.samp = new T.MultiCircle({ map: map, styles: dstyles, geometries: [] });          // 最底：Δt 散点
      L.crease = new T.MultiPolyline({
        map: map, styles: {
          k: new T.PolylineStyle({ color: 'rgb(255,255,255)', width: 8, borderWidth: 0, lineCap: 'round', showArrow: false }),
          k2: new T.PolylineStyle({ color: 'rgb(220,38,38)', width: 5, borderWidth: 1, borderColor: 'rgb(255,255,255)', lineCap: 'round', showArrow: false })
        }, geometries: []
      });
      L.arrow = new T.MultiPolyline({
        map: map, styles: {
          a: new T.PolylineStyle({ color: 'rgb(180,83,9)', width: 3, borderWidth: 0, lineCap: 'round', showArrow: true, arrowOptions: { width: 5, height: 7, space: 40 } })
        }, geometries: []
      });
      L.cand = new T.MultiCircle({ map: map, styles: cstyles, geometries: [] });
      var mstyles = {};
      for (var k = 0; k < 4; k++) mstyles['p' + k] = new T.MarkerStyle({
        width: 34, height: 34, anchor: { x: 17, y: 17 }, src: pinIcon(PIN_COLORS[k], 'ABCD'.charAt(k))
      });
      mstyles.geo = new T.MarkerStyle({ width: 30, height: 30, anchor: { x: 15, y: 15 }, src: ICON_GEO });
      mstyles.fair = new T.MarkerStyle({ width: 40, height: 40, anchor: { x: 20, y: 20 }, src: ICON_FAIR });
      L.mark = new T.MultiMarker({ map: map, styles: mstyles, geometries: [] });
    } catch (e) { err('图层创建失败：' + e.message); return false; }
    ready = true;
    return true;
  }

  function bucketFair(f) {
    var i = Math.round((1 - f) * 11);
    return 'f' + Math.max(0, Math.min(11, i));
  }
  function bucketDt(dt, mx) {
    var x = mx > 0 ? Math.max(-1, Math.min(1, dt / mx)) : 0;
    return 'd' + Math.max(0, Math.min(11, Math.round((x + 1) / 2 * 11)));
  }

  function updateMap() {
    if (!ready) return;
    var T = window.TMap, c = city(), s = M.solve(c, state.n);
    var cr = creaseOf(c);
    var pts = [];
    try {
      // 1. 采样散点（Δt 场）
      var mxDt = 0, i;
      for (i = 0; i < c.samples.length; i++) {
        var d = c.samples[i].ta - c.samples[i].tb;
        if (isFinite(d)) mxDt = Math.max(mxDt, Math.abs(d));
      }
      var gs = [];
      for (i = 0; i < c.samples.length; i++) {
        var sp = c.samples[i];
        gs.push({ styleId: bucketDt(sp.ta - sp.tb, mxDt), center: new T.LatLng(sp.lat, sp.lng), radius: 500 });
      }
      L.samp.setGeometries(gs);

      // 2. 折痕（marching squares 得到的等值线，允许断成多段）：白衬底 + 红主线
      var gl = [];
      for (i = 0; i < cr.polys.length; i++) {
        var chain = cr.polys[i].map(function (p) { return new T.LatLng(p.lat, p.lng); });
        gl.push({ styleId: 'k', paths: chain });
        gl.push({ styleId: 'k2', paths: chain });
        for (var z = 0; z < chain.length; z++) pts.push([chain[z].lat, chain[z].lng]);
      }
      L.crease.setGeometries(gl);

      // 3. 候选点 + 4. 偏移箭头
      var gc = [], ga = [];
      if (s && s.scored) {
        for (i = 0; i < s.scored.length; i++) {
          var it = s.scored[i];
          gc.push({
            styleId: bucketFair(M.fairness(it.spread, s.refSpread || 1)),
            center: new T.LatLng(it.cand.lat, it.cand.lng), radius: 800
          });
        }
        if (s.fair) {
          ga.push({
            styleId: 'a',
            paths: [new T.LatLng(c.geo.lat, c.geo.lng), new T.LatLng(s.fair.cand.lat, s.fair.cand.lng)]
          });
        }
      }
      L.cand.setGeometries(gc);
      L.arrow.setGeometries(ga);

      // 5. marker（最上）
      var gm = [], k;
      for (k = 0; k < state.n; k++) {
        var o = c.origins[k];
        gm.push({ styleId: 'p' + k, position: new T.LatLng(o.lat, o.lng) });
        pts.push([o.lat, o.lng]);
      }
      gm.push({ styleId: 'geo', position: new T.LatLng(c.geo.lat, c.geo.lng) });
      if (s && s.fair) gm.push({ styleId: 'fair', position: new T.LatLng(s.fair.cand.lat, s.fair.cand.lng) });
      L.mark.setGeometries(gm);

      // 取景只看：折痕 + 起点 + 中点 + 公平点。折痕是主角，别让最远的候选点把视野撑爆
      fitTo(pts);
    } catch (e) {
      err('地图绘制出错：' + e.message);
    }
  }

  /* ---------------- 渲染 ---------------- */
  function agg() {
    var g = [], f = [], off = [], near = [], far = [], bias = 0, n2 = [], n4 = [];
    for (var i = 0; i < D.cities.length; i++) {
      var c = D.cities[i], s = M.solve(c, 2);
      if (!s || s.geoSpread == null || !s.fair) continue;
      g.push(s.geoSpread); f.push(s.fairSpread); off.push(s.offsetKm || 0);
      if (s.bias > 0) bias++;
      var cs = M.creaseStats(c);
      if (cs) { near.push(cs.near); far.push(cs.far); }
      var s4 = M.solve(c, 4);
      if (s && s.fairSpread != null) n2.push(s.fairSpread);
      if (s4 && s4.fairSpread != null) n4.push(s4.fairSpread);
    }
    var avg = function (a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; };
    var mx = function (a) { return a.length ? Math.max.apply(null, a) : null; };
    return { geo: avg(g), geoMax: mx(g), geoMaxCity: cityOfMax(g),
             fair: avg(f), off: avg(off), near: avg(near), far: avg(far),
             bias: bias, n2: avg(n2), n4: avg(n4), nCity: g.length };
  }
  function cityOfMax(arr) {
    var bi = 0;
    for (var i = 1; i < arr.length; i++) if (arr[i] > arr[bi]) bi = i;
    return D.cities[bi] ? D.cities[bi].name : '';
  }

  function renderHero() {
    var a = agg();
    var box = function (k, v, unit, note, hi) {
      return '<div class="box' + (hi ? ' hi' : '') + '"><div class="k">' + k + '</div>' +
        '<div class="v">' + v + ' <small>' + unit + '</small></div><div class="n">' + note + '</div></div>';
    };
    document.getElementById('hero').innerHTML =
      box('约在「正中间」，两个人差', f1(min(a.geo)), '分钟', '八城平均；最狠的' + a.geoMaxCity + ' ' + f1(min(a.geoMax)) + ' 分钟', true) +
      box('折痕离正中间最近的一侧', f1(a.near / 1000), '公里', '往这一侧挪这么点就能扯平') +
      box('折痕离正中间最远的一侧', f1(a.far / 1000), '公里',
        '八城平均差 ' + f1(a.far / Math.max(0.001, a.near)) + ' 倍：在北京差 32 倍，在西安只差 1.4 倍', true) +
      box('四个人时，最优会面点仍差', f1(min(a.n4)), '分钟', '两个人时只差 ' + f1(min(a.n2)) + ' 分钟');
  }

  function renderChips() {
    var h = '';
    for (var i = 0; i < D.cities.length; i++) {
      h += '<button class="chip' + (i === state.ci ? ' on' : '') + '" data-c="' + i + '">' + esc(D.cities[i].name) + '</button>';
    }
    document.getElementById('cityChips').innerHTML = h;
    var ns = [[2, '两个人'], [3, '三个人'], [4, '四个人']], hn = '';
    for (var j = 0; j < ns.length; j++) {
      hn += '<button class="chip n' + (ns[j][0] === state.n ? ' on' : '') + '" data-n="' + ns[j][0] + '">' + ns[j][1] + '</button>';
    }
    document.getElementById('nChips').innerHTML = hn;
    var c = city(), names = c.origins.slice(0, state.n).map(function (o) { return o.name + '（' + o.role + '）'; });
    document.getElementById('pairNote').innerHTML =
      '本城参与者的出发点：' + esc(names.join(' · ')) +
      '。折痕始终只画 A、B 两人的等时线；候选点的公平度按上面选的人数计算。';
  }

  function renderPanel() {
    var c = city(), s = M.solve(c, state.n);
    if (!s) { document.getElementById('cmp').innerHTML = '<div class="card">该城数据不足，无法求解。</div>'; return; }
    var n = state.n;
    var geoMax = s.geoMaxT;
    var fairMax = s.fair ? s.fair.maxT : null;
    var fairName = s.fair ? s.fair.cand.name : '—';
    var slowName = s.slowIdx != null ? c.origins[s.slowIdx].name : '—';
    var dMax = (geoMax != null && fairMax != null) ? (geoMax - fairMax) : null;

    function perRow(list, ts, slowIdx) {
      var mxv = Math.max.apply(null, ts.filter(function (x) { return x != null; }));
      var h = '';
      for (var i = 0; i < n; i++) {
        var v = ts[i];
        h += '<div class="prow' + (i === slowIdx ? ' slow' : '') + '">' +
          '<span class="pn">' + esc(c.origins[i].name) + '</span>' +
          '<span class="tb"><i style="width:' + (mxv > 0 ? (100 * v / mxv).toFixed(1) : 0) + '%"></i></span>' +
          '<span class="vv">' + f0(min(v)) + ' 分钟</span></div>';
      }
      return h;
    }

    var html = '';
    html += '<div class="card"><div class="hd"><span class="nm">坐标正中间</span><span class="tag">大家的第一反应</span></div>' +
      '<div class="big">差 ' + f1(min(s.geoSpread)) + ' 分钟</div>' +
      '<div class="sub2">两个人到这个点的耗时差；最长的人要花 ' + f0(min(geoMax)) + ' 分钟</div>' +
      '<div class="per">' + perRow(c.origins, s.geo, s.slowIdx) + '</div></div>';
    html += '<div class="card hi"><div class="hd"><span class="nm">' + esc(fairName) + '</span><span class="tag">这批点里最公平</span></div>' +
      '<div class="big">差 ' + f1(min(s.fairSpread)) + ' 分钟</div>' +
      '<div class="sub2">最长的人要花 ' + f0(min(fairMax)) + ' 分钟；' +
      '距坐标中点 ' + f1(s.offsetKm) + ' 公里</div>' +
      '<div class="per">' + perRow(c.origins, s.fair ? s.fair.cand.t.slice(0, n) : s.geo, s.slowIdx) + '</div></div>';
    document.getElementById('cmp').innerHTML = html;

    var cs = s.crease;
    var v = '';
    if (dMax != null && s.offsetKm != null) {
      v = '把会面点从<b>坐标正中间</b>挪到<b>' + esc(fairName) + '</b>（直线 ' + f1(s.offsetKm) + ' 公里），' +
        '耗时差从 ' + f1(min(s.geoSpread)) + ' 分钟压到 ' + f1(min(s.fairSpread)) + ' 分钟' +
        (dMax > 30 ? '，最长的人还能少花 ' + f0(min(dMax)) + ' 分钟' : '') + '。';
    }
    if (cs) {
      v += '<br>折痕离正中间<b>最近的一侧在' + M.bearingName(cs.nearBearing) + '方，只有 ' + f1(cs.near / 1000) +
        ' 公里</b>；<b>最远的一侧在' + M.bearingName(cs.farBearing) + '方，要 ' + f1(cs.far / 1000) + ' 公里</b>，' +
        '差 ' + f1(cs.far / Math.max(1, cs.near)) + ' 倍' +
        (cs.far / Math.max(1, cs.near) > 2.5 ? '。这条折痕很歪，往哪边挪差别巨大。'
          : '。这条折痕接近圆形，往哪边挪都差不多。');
    }
    document.getElementById('verdict').innerHTML = v || '数据不足，无法给出结论。';

    // 谁吃亏
    var gm = s.geo, mean = gm.reduce(function (a, b) { return a + b; }, 0) / gm.length;
    var mx2 = Math.max.apply(null, gm.map(function (x) { return Math.abs(x - mean); })) || 1;
    var ph = '';
    for (var i = 0; i < n; i++) {
      var dv = gm[i] - mean;
      ph += '<div class="prow' + (dv > 0 ? ' slow' : '') + '">' +
        '<span class="pn">' + esc(c.origins[i].name) + '</span>' +
        '<span class="tb"><i style="width:' + (100 * Math.abs(dv) / mx2).toFixed(1) + '%"></i></span>' +
        '<span class="vv">' + (dv >= 0 ? '+' : '−') + f1(min(Math.abs(dv))) + ' 分钟</span></div>';
    }
    document.getElementById('per').innerHTML = ph ||
      '<div class="prow"><span class="pn">—</span><span class="tb"></span><span class="vv">—</span></div>';
  }

  function renderTable() {
    var tb = document.querySelector('#tbl tbody');
    if (!tb) return;
    var h = '';
    for (var i = 0; i < D.cities.length; i++) {
      var c = D.cities[i], s = M.solve(c, 2), cr = creaseOf(c);
      if (!s || !s.fair) continue;
      var cs = M.creaseStats(c);
      h += '<tr' + (i === state.ci ? ' class="me"' : '') + '>' +
        '<td>' + esc(c.name) + '</td>' +
        '<td class="n">' + f1(c.ab_km) + ' km</td>' +
        '<td class="n">' + f1(min(s.geoSpread)) + ' 分钟</td>' +
        '<td class="n">' + (cs ? f1(cs.near / 1000) + ' km · ' + M.bearingName(cs.nearBearing) + '方' : '—') + '</td>' +
        '<td class="n">' + (cs ? f1(cs.far / 1000) + ' km · ' + M.bearingName(cs.farBearing) + '方' : '—') + '</td>' +
        '<td class="n">' + (cs ? f1(cs.far / Math.max(1, cs.near)) + ' 倍' : '—') + '</td>' +
        '<td>' + esc(s.fair.cand.name) + '</td>' +
        '<td class="n">' + f1(min(s.fairSpread)) + ' 分钟</td></tr>';
    }
    tb.innerHTML = h;
  }

  function renderUsage() {
    var a = agg();
    var worst = null, worstGeo = -1;
    for (var i = 0; i < D.cities.length; i++) {
      var p = M.solve(D.cities[i], 2);
      if (p && p.geoSpread > worstGeo) { worstGeo = p.geoSpread; worst = D.cities[i].name; }
    }
    document.getElementById('usage').innerHTML =
      '<p>① <b>别约在坐标中点。</b>八座城市平均下来，「正中间」会让两个人差 <em>' + f1(min(a.geo)) +
      ' 分钟</em>，最狠的是' + esc(worst) + '的 <em>' + f1(min(worstGeo)) + ' 分钟</em>——' +
      '不是误差，是一个人实打实多开这么久。</p>' +
      '<p>② <b>先问方向，再问距离。</b>折痕离正中间最近的一侧平均只有 <em>' + f1(a.near / 1000) +
      ' 公里</em>，最远的一侧却有 <em>' + f1(a.far / 1000) + ' 公里</em>，八城平均差 <em>' +
      f1(a.far / Math.max(0.001, a.near)) + ' 倍</em>。' +
      '在北京这对数字是 0.5 km 对 15.9 km——往对的方向挪一步就扯平，往错的方向挪十五公里还在扯皮；' +
      '但在西安折痕几乎是个圆（0.5 对 0.7 km），往哪边挪都差不多。' +
      '折痕长什么样由路网决定，猜不出来，只能算。</p>' +
      '<p>③ <b>人越多，越没有公平点。</b>两个人的时候，最优会面点的耗时差是 <em>' + f1(min(a.n2)) +
      ' 分钟</em>；加到四个人，同一个算法也只能做到 <em>' + f1(min(a.n4)) + ' 分钟</em>（八城平均）。' +
      '四人以上就别找公平点了，直接挑交通最方便的那一个枢纽，让跑得最远的那个人少跑。</p>';
  }

  function renderFoot() {
    var n = 0;
    for (var i = 0; i < D.cities.length; i++) {
      var c = D.cities[i];
      n += c.cands.length * c.origins.length + c.samples.length * 2 + c.origins.length;
      if (c.grid) n += c.grid.ta.length * 2;
    }
    var e = document.getElementById('nEles');
    if (e) e.textContent = n.toLocaleString('en-US');
  }

  function render() {
    renderHero(); renderChips(); renderPanel(); renderTable(); renderUsage();
    updateMap();
  }

  /* ---------------- 事件 ---------------- */
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.getAttribute) return;
    var ci = t.getAttribute('data-c'), ni = t.getAttribute('data-n');
    if (ci != null) { state.ci = Math.max(0, Math.min(D.cities.length - 1, parseInt(ci, 10) || 0)); render(); return; }
    if (ni != null) { state.n = Math.max(2, Math.min(4, parseInt(ni, 10) || 2)); render(); return; }
  });

  /* ---------------- 启动 ---------------- */
  function autostart() {
    try {
      clearErr();
      initMap();
      renderFoot();
      render();
      window.__crease_ready = true;
    } catch (e) {
      err('启动失败：' + (e && e.message) + '\n' + (e && e.stack));
    }
  }
  window.__crease_autostart = autostart;
  if (document.readyState === 'complete') autostart();
  else window.addEventListener('load', autostart);
})();
