/* 《三岔口 · THE TRIDENT》交互层。
 * 依赖：data.js（实测数据）、model.js（门到门模型）、腾讯地图 JSAPI GL。 */
(function () {
  'use strict';

  var DATA = window.TRIDENT_DATA;
  var M = window.TridentModel;
  var CITY = {}, PAIRS = DATA.pairs;
  DATA.cities.forEach(function (c) { CITY[c.id] = c; });

  var MODE_META = {
    car:  { name: '自驾', color: '#2563eb', tint: '#dbeafe' },
    rail: { name: '高铁', color: '#ea580c', tint: '#ffedd5' },
    air:  { name: '飞机', color: '#0d9488', tint: '#ccfbf1' }
  };
  var ORDER = ['car', 'rail', 'air'];

  var state = {
    a: 'beijing', b: 'shanghai',
    acc: null,               // {aRail,aAir,bRail,bAir} null = 用城市实测值
    params: { railSpeed: M.DEFAULTS.railSpeed, airEarly: M.DEFAULTS.airEarly }
  };

  var MAP = null, POLY = null, MARK = null, mapReady = false;

  /* ---------- 工具 ---------- */
  function $(id) { return document.getElementById(id); }
  function fmtMin(m) {
    m = Math.round(m);
    var h = Math.floor(m / 60), r = m % 60;
    if (h <= 0) return m + ' 分钟';
    return h + ' 小时 ' + (r ? r + ' 分' : '');
  }
  function fmtMinShort(m) {
    m = Math.round(m);
    if (m < 60) return m + '′';
    return Math.floor(m / 60) + 'h' + (m % 60 ? (m % 60) + 'm' : '');
  }
  function pairOf(a, b) {
    for (var i = 0; i < PAIRS.length; i++) {
      var p = PAIRS[i];
      if ((p.a === a && p.b === b) || (p.a === b && p.b === a)) return p;
    }
    return null;
  }
  function currentAcc() {
    var A = CITY[state.a], B = CITY[state.b];
    return {
      aRail: state.acc ? state.acc.aRail : A.station.acc_min,
      aAir: state.acc ? state.acc.aAir : A.airport.acc_min,
      bRail: state.acc ? state.acc.bRail : B.station.acc_min,
      bAir: state.acc ? state.acc.bAir : B.airport.acc_min
    };
  }
  function evaluate() {
    return M.evaluate(pairOf(state.a, state.b), CITY[state.a], CITY[state.b],
                      state.params, currentAcc());
  }
  function num(v, fb) { var x = Number(v); return isFinite(x) ? x : fb; }

  /* ---------- 静态洞察（数字与 verify.js 逐条对应） ---------- */
  function allEvals() {
    return PAIRS.map(function (p) {
      return { p: p, e: M.evaluate(p, CITY[p.a], CITY[p.b], M.normParams({})) };
    });
  }
  var STATS = (function () {
    var es = allEvals();
    var wins = { car: 0, rail: 0, air: 0 };
    es.forEach(function (x) { wins[x.e.win]++; });
    var bestCar = null, bestGap = Infinity;
    var airG = [], railG = [];
    es.forEach(function (x) {
      var gap = x.e.car.total - Math.min(x.e.rail.total, x.e.air.total);
      if (gap >= 0 && gap < bestGap) { bestGap = gap; bestCar = x; }
      airG.push(x.e.airGroundRatio); railG.push(x.e.railGroundRatio);
    });
    function med(a) { a = a.slice().sort(function (x, y) { return x - y; }); return a[Math.floor(a.length / 2)]; }
    var P0 = M.normParams({});
    return {
      n: es.length, wins: wins,
      bestCar: bestCar, bestGap: bestGap,
      medAirG: med(airG), medRailG: med(railG),
      carRailBreak30: M.carRailBreak(60, P0),
      carRailBreak60: M.carRailBreak(120, P0),
      railAirBreak0: M.railAirBreak(0, 60, P0),
      railAirBreak30: M.railAirBreak(30, 60, P0),
      maxAirG: Math.max.apply(null, airG)
    };
  })();

  /* ---------- 渲染：顶部 KPI ---------- */
  function renderHero(e) {
    var A = CITY[state.a], B = CITY[state.b];
    var g = e[e.win];
    var h = [
      box('直线距离', Math.round(e.sd) + '', 'km', A.name + ' → ' + B.name + '，自驾实际 ' + Math.round(e.dkm) + ' km'),
      box('最快方式', MODE_META[e.win].name, '', '门到门 ' + fmtMin(g.total) + '，领先第二名 ' + Math.round(e.margin) + ' 分钟', true),
      box('地面时间占比', Math.round(100 * g.ground / g.total) + '%', '',
          '不算在轮子/座位上的那部分：' + fmtMin(g.ground)),
      box('在途时间', fmtMinShort(g.ride), '', '真正花在路 / 车上 / 空中的时间')
    ];
    $('hero').innerHTML = h.join('');
  }
  function box(k, v, unit, n, hi) {
    return '<div class="box' + (hi ? ' hi' : '') + '"><div class="k">' + k + '</div>' +
      '<div class="v">' + v + (unit ? ' <small>' + unit + '</small>' : '') + '</div>' +
      '<div class="n">' + n + '</div></div>';
  }

  /* ---------- 渲染：三种方式 ---------- */
  function renderModes(e) {
    var html = ORDER.map(function (m) {
      var t = e[m], mt = MODE_META[m];
      var hi = (m === e.win);
      var bar = t.parts.map(function (p) {
        var w = (p.v / t.total * 100);
        var col = (p.k === 'ride' || p.k === 'fly' || p.k === 'drive') ? mt.color : '#94a3b8';
        return '<div style="width:' + w.toFixed(2) + '%;background:' + col + '">' +
               (w > 8 ? fmtMinShort(p.v) : '') + '</div>';
      }).join('');
      var parts = t.parts.map(function (p) {
        var col = (p.k === 'ride' || p.k === 'fly' || p.k === 'drive') ? mt.color : '#94a3b8';
        return '<span><span><i style="background:' + col + '"></i>' + p.label + '</span>' +
               '<b>' + fmtMin(p.v) + '</b></span>';
      }).join('');
      return '<div class="card' + (hi ? ' hi' : '') + '" data-mode="' + m + '">' +
        '<div class="hd"><span class="nm" style="color:' + mt.color + '">' + mt.name + '</span>' +
        (hi ? '<span class="win">最快</span>' : '') + '</div>' +
        '<div class="big">' + fmtMin(t.total) + '</div>' +
        '<div class="sub2">门到门 · 其中 ' + fmtMin(t.ground) + ' 不在交通工具上</div>' +
        '<div class="bar">' + bar + '</div>' +
        '<div class="parts">' + parts + '</div></div>';
    }).join('');
    $('modes').innerHTML = html;
  }

  /* ---------- 渲染：相图 ---------- */
  function renderPhase(e) {
    var cv = $('phase');
    if (!cv || !cv.getContext) return;
    var ctx = cv.getContext('2d');
    var W = cv.width, H = cv.height;
    var L = 58, R = 14, T = 14, B = 52;
    var x0 = Math.log(80), x1 = Math.log(3400);
    var y0 = -50, y1 = 140;
    function px(d) { return L + (Math.log(Math.max(80, Math.min(3400, d))) - x0) / (x1 - x0) * (W - L - R); }
    function py(dl) { return H - B - (Math.max(y0, Math.min(y1, dl)) - y0) / (y1 - y0) * (H - T - B); }
    function invX(x) { return Math.exp(x0 + (x - L) / (W - L - R) * (x1 - x0)); }

    ctx.clearRect(0, 0, W, H);
    // 背景：按当前「两端高铁接驳之和」预测胜者
    var base = e.accSum.rail;
    var step = 4;
    for (var x = L; x < W - R; x += step) {
      var d = invX(x + step / 2);
      for (var y = T; y < H - B; y += step) {
        var dl = y0 + (H - B - y) / (H - T - B) * (y1 - y0);
        var w = M.predict(d, dl, base, M.normParams(state.params));
        ctx.fillStyle = MODE_META[w].tint;
        ctx.fillRect(x, y, step + 1, step + 1);
      }
    }
    // 边框与网格
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1;
    ctx.strokeRect(L, T, W - L - R, H - T - B);
    ctx.fillStyle = '#8b95a6'; ctx.font = '11px -apple-system,sans-serif';
    [100, 200, 500, 1000, 2000, 3000].forEach(function (d) {
      var x = px(d);
      ctx.strokeStyle = '#e8edf4';
      ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, H - B); ctx.stroke();
      ctx.fillText(d + '', x - 10, H - B + 16);
    });
    [-40, 0, 40, 80, 120].forEach(function (v) {
      var y = py(v);
      ctx.strokeStyle = '#e8edf4';
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke();
      ctx.fillText((v > 0 ? '+' : '') + v, 20, y + 4);
    });
    ctx.fillText('两城直线距离（km，对数轴）', (W - L - R) / 2 + L - 60, H - 14);
    ctx.save();
    ctx.translate(14, (H - B + T) / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText('机场比高铁站远（分钟）', -70, -2);
    ctx.restore();

    // 分界线：高铁 ↔ 飞机（斜率随参数变，位置与 base 无关）
    var P = M.normParams(state.params);
    function railAirD(dl) { return M.railAirBreak(dl, base, P); }
    ctx.strokeStyle = '#7f1d1d'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.beginPath();
    var started = false;
    for (var yy = T; yy <= H - B; yy += 2) {
      var dl = y0 + (H - B - yy) / (H - T - B) * (y1 - y0);
      var dd = railAirD(dl);
      if (!isFinite(dd) || dd < 80 || dd > 3400) { started = false; continue; }
      var xx = px(dd);
      if (!started) { ctx.moveTo(xx, yy); started = true; } else ctx.lineTo(xx, yy);
    }
    ctx.stroke(); ctx.setLineDash([]);
    // 分界线：自驾 ↔ 高铁（水平线）
    var cb = M.carRailBreak(base, P);
    if (isFinite(cb) && cb >= 80 && cb <= 3400) {
      ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(px(cb), T); ctx.lineTo(px(cb), H - B); ctx.stroke();
      ctx.setLineDash([]);
    }

    // 91 个真实城市对
    allEvals().forEach(function (x) {
      var p = x.p, ee = x.e;
      var cx = px(p.sd), cy = py(ee.accDelta);
      ctx.beginPath(); ctx.arc(cx, cy, 3.6, 0, Math.PI * 2);
      ctx.fillStyle = MODE_META[ee.win].color;
      ctx.globalAlpha = 0.55; ctx.fill(); ctx.globalAlpha = 1;
      if (p.a === state.a && p.b === state.b || p.a === state.b && p.b === state.a) {
        ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2);
        ctx.strokeStyle = '#1e2430'; ctx.lineWidth = 2.4; ctx.stroke();
      }
    });

    // 图例
    var lx = L + 8, ly = T + 10;
    ORDER.forEach(function (m, i) {
      ctx.fillStyle = MODE_META[m].tint; ctx.fillRect(lx, ly + i * 16 - 8, 12, 12);
      ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1; ctx.strokeRect(lx, ly + i * 16 - 8, 12, 12);
      ctx.fillStyle = '#1e2430'; ctx.font = '11px -apple-system,sans-serif';
      ctx.fillText(MODE_META[m].name + '更快', lx + 17, ly + i * 16 + 2);
    });

    $('phaseNote').innerHTML =
      '每个圆点是一个真实城市对（14 城两两组合共 ' + STATS.n + ' 对），颜色是它实际的赢家；' +
      '背景色是模型在同一接驳条件下给出的预测，两者一致率 ' +
      '<b id="agreeRate">—</b>。虚线是两条切换边界：<span style="color:#2563eb">蓝线</span>左边自驾更快，' +
      '<span style="color:#7f1d1d">红线</span>右边飞机更快，中间是高铁的地盘。' +
      '把「出发地 → 机场」滑杆往上推，红线会整个往右挪——机场越偏远，飞机越需要距离才划算。';

    // 一致率
    var agree = 0;
    allEvals().forEach(function (x) {
      if (M.predict(x.p.sd, x.e.accDelta, x.e.accSum.rail, P) === x.e.win) agree++;
    });
    var el = $('agreeRate');
    if (el) el.textContent = (100 * agree / STATS.n).toFixed(1) + '%';
  }

  /* ---------- 渲染：洞察 ---------- */
  function renderInsights(e) {
    var A = CITY[state.a], B = CITY[state.b];
    var bn = STATS.bestCar ? (CITY[STATS.bestCar.p.a].name + ' → ' + CITY[STATS.bestCar.p.b].name) : '—';
    var items = [
      '<li class="c2"><b>' + Math.round(100 * STATS.medAirG) + '%</b> —— 一趟飞行里，中位有这么大比例的时间' +
      '你不在天上：接驳、提前到场、起降滑行。样本中最夸张的一对高达 <b>' +
      Math.round(100 * STATS.maxAirG) + '%</b>。高铁同口径只有 <b>' +
      Math.round(100 * STATS.medRailG) + '%</b>。</li>',
      '<li class="c3"><b>' + STATS.wins.car + ' / ' + STATS.n + '</b> —— 自驾在这 ' + STATS.n +
      ' 个城市对里赢过 ' + STATS.wins.car + ' 次。最接近的一次是 <b>' + bn + '</b>（' +
      Math.round(STATS.bestCar.p.sd) + ' km），只差 <b>' + STATS.bestGap.toFixed(1) + ' 分钟</b>。' +
      '但把两端接驳各拉到 60 分钟，自驾就开始赢了——切换点从 ' + Math.round(STATS.carRailBreak30) +
      ' km 推到 <b>' + Math.round(STATS.carRailBreak60) + ' km</b>。</li>',
      '<li><b>每 30 分钟</b> —— 机场比高铁站每偏远 30 分钟，飞机就要再多飞约 <b>' +
      Math.round(STATS.railAirBreak30 - STATS.railAirBreak0) + ' km</b> 才追得回来（' +
      Math.round(STATS.railAirBreak0) + ' km → ' + Math.round(STATS.railAirBreak30) + ' km）。' +
      '所以「这个城市机场太远」不是抱怨，是一条可以算出来的分界线。</li>',
      '<li class="c2"><b>当前这一对</b>：' + A.name + ' → ' + B.name + '，' + Math.round(e.sd) +
      ' km，最快是 <b>' + MODE_META[e.win].name + '</b>（' + fmtMin(e[e.win].total) +
      '），领先第二名 ' + Math.round(e.margin) + ' 分钟。这一趟里你在交通工具上的时间是 ' +
      fmtMin(e[e.win].ride) + '，其余 ' + fmtMin(e[e.win].ground) + ' 都在地面。</li>'
    ];
    $('ins').innerHTML = items.map(function (s) { return s; }).join('');
  }

  /* ---------- 渲染：表格 ---------- */
  function renderTable() {
    var rows = allEvals().sort(function (x, y) { return x.p.sd - y.p.sd; });
    var html = rows.map(function (x) {
      var p = x.p, ee = x.e;
      var cur = ((p.a === state.a && p.b === state.b) || (p.a === state.b && p.b === state.a));
      return '<tr' + (cur ? ' style="background:#fff7ed"' : '') + '>' +
        '<td><a href="#" data-a="' + p.a + '" data-b="' + p.b + '" class="lk">' +
        CITY[p.a].name + ' → ' + CITY[p.b].name + '</a></td>' +
        '<td>' + Math.round(p.sd) + '</td>' +
        '<td>' + fmtMinShort(ee.car.total) + '</td>' +
        '<td>' + fmtMinShort(ee.rail.total) + '</td>' +
        '<td>' + fmtMinShort(ee.air.total) + '</td>' +
        '<td style="color:' + MODE_META[ee.win].color + ';font-weight:700">' + MODE_META[ee.win].name + '</td>' +
        '<td>' + Math.round(100 * ee[ee.win].ground / ee[ee.win].total) + '%</td></tr>';
    }).join('');
    $('tbl').querySelector('tbody').innerHTML = html;
    Array.prototype.forEach.call(document.querySelectorAll('#tbl .lk'), function (a) {
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        state.a = a.getAttribute('data-a'); state.b = a.getAttribute('data-b');
        state.acc = null;
        $('selA').value = state.a; $('selB').value = state.b;
        syncSliders(); render();
      });
    });
  }

  /* ---------- 渲染：免责 ---------- */
  function renderDisclaimer() {
    $('disclaimer').innerHTML =
      '<b>实测部分</b>：14 座城市的市中心 / 机场 / 高铁站坐标，以及「市中心 → 机场」「市中心 → 高铁站」的驾车接驳里程与时长、' +
      '91 个城市对的驾车里程与时长，全部来自腾讯位置服务 WebService 实测，已打包进页面，运行时不再发请求。<br>' +
      '<b>估算部分</b>：高铁在途按「铁路里程 ≈ 自驾里程 × 1.10，平均旅行速度可调（默认 280 km/h）」折算；' +
      '飞行在途按「航路 ≈ 直线 × 1.02，巡航 750 km/h + 起降滑行 25 分钟」折算；' +
      '候车 30 分钟、提前到机场 90 分钟、自驾每 4 小时休息 30 分钟，均为典型值，可用滑杆调整。<br>' +
      '<b>边界</b>：模型不区分是否有直达高铁 / 直飞航班，也不含票价、准点率、舒适度与天气因素；' +
      '接驳时间取的是含路况的典型值，节假日与极端天气会显著偏离。' +
      '本页为演示用途，所有数字为估算，<b>不构成出行建议</b>。';
  }

  /* ---------- 地图 ---------- */
  var ICONS = {
    city: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><circle cx="14" cy="14" r="10" fill="#1e2430" stroke="#fff" stroke-width="3"/></svg>'),
    airport: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26"><circle cx="13" cy="13" r="9" fill="#0d9488" stroke="#fff" stroke-width="2.5"/></svg>'),
    station: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26"><rect x="4" y="4" width="18" height="18" rx="4" fill="#ea580c" stroke="#fff" stroke-width="2.5"/></svg>')
  };

  function mapMsg(t) {
    var el = $('mapmsg');
    if (!el) return;
    if (t) { el.textContent = t; el.style.display = 'block'; }
    else { el.style.display = 'none'; }
  }

  function initMap() {
    if (typeof TMap === 'undefined') { mapMsg('地图 SDK 未加载'); return; }
    try {
      MAP = new TMap.Map('map', {
        center: new TMap.LatLng(33.5, 112.0),
        zoom: 4.2,
        pitch: 0,
        showControl: true
      });
      // 图层顺序：先建线，再建点，点才压在线上
      POLY = new TMap.MultiPolyline({
        map: MAP, styles: {
          acc: new TMap.PolylineStyle({ color: 'rgb(203,213,225)', width: 4, borderWidth: 0, lineCap: 'round' }),
          link: new TMap.PolylineStyle({ color: 'rgb(100,116,139)', width: 3, borderWidth: 0, lineCap: 'round', showArrow: true })
        }, geometries: []
      });
      MARK = new TMap.MultiMarker({
        map: MAP, styles: {
          city: new TMap.MarkerStyle({ width: 28, height: 28, src: ICONS.city, anchor: { x: 14, y: 14 } }),
          airport: new TMap.MarkerStyle({ width: 26, height: 26, src: ICONS.airport, anchor: { x: 13, y: 13 } }),
          station: new TMap.MarkerStyle({ width: 26, height: 26, src: ICONS.station, anchor: { x: 13, y: 13 } })
        }, geometries: []
      });
      mapReady = true;
      mapMsg('');
    } catch (err) {
      mapMsg('地图初始化失败：' + (err && err.message ? err.message : err));
    }
  }

  /** 自写 fitBounds：本版 TMap 的 fitBounds 只挪中心不改 zoom。 */
  function fitTo(pts) {
    if (!MAP || !pts.length) return;
    var la = pts.map(function (p) { return p[0]; }), ln = pts.map(function (p) { return p[1]; });
    var minLat = Math.min.apply(null, la), maxLat = Math.max.apply(null, la);
    var minLng = Math.min.apply(null, ln), maxLng = Math.max.apply(null, ln);
    var W = MAP.getContainer().clientWidth || 640, H = MAP.getContainer().clientHeight || 520;
    function merc(lat) { return Math.log(Math.tan(Math.PI / 4 + Math.min(85, Math.max(-85, lat)) * Math.PI / 360)); }
    var dx = Math.max(1e-6, (maxLng - minLng) / 360);
    var dy = Math.max(1e-6, (merc(maxLat) - merc(minLat)) / (2 * Math.PI));
    var z = Math.min(Math.log(W / 256 / dx) / Math.LN2, Math.log(H / 256 / dy) / Math.LN2);
    z = Math.max(3, Math.min(14, z - 0.25));
    MAP.setCenter(new TMap.LatLng((minLat + maxLat) / 2, (minLng + maxLng) / 2));
    MAP.setZoom(z);
  }

  function renderMap() {
    if (!mapReady) return;
    var A = CITY[state.a], B = CITY[state.b];
    try {
      var geos = [
        { id: 'm1', styleId: 'city', position: new TMap.LatLng(A.lat, A.lng) },
        { id: 'm2', styleId: 'city', position: new TMap.LatLng(B.lat, B.lng) },
        { id: 'm3', styleId: 'airport', position: new TMap.LatLng(A.airport.lat, A.airport.lng) },
        { id: 'm4', styleId: 'airport', position: new TMap.LatLng(B.airport.lat, B.airport.lng) },
        { id: 'm5', styleId: 'station', position: new TMap.LatLng(A.station.lat, A.station.lng) },
        { id: 'm6', styleId: 'station', position: new TMap.LatLng(B.station.lat, B.station.lng) }
      ];
      MARK.setGeometries(geos);
      POLY.setGeometries([
        { id: 'p1', styleId: 'acc', paths: [new TMap.LatLng(A.lat, A.lng), new TMap.LatLng(A.airport.lat, A.airport.lng)] },
        { id: 'p2', styleId: 'acc', paths: [new TMap.LatLng(A.lat, A.lng), new TMap.LatLng(A.station.lat, A.station.lng)] },
        { id: 'p3', styleId: 'acc', paths: [new TMap.LatLng(B.lat, B.lng), new TMap.LatLng(B.airport.lat, B.airport.lng)] },
        { id: 'p4', styleId: 'acc', paths: [new TMap.LatLng(B.lat, B.lng), new TMap.LatLng(B.station.lat, B.station.lng)] },
        { id: 'p5', styleId: 'link', paths: [new TMap.LatLng(A.lat, A.lng), new TMap.LatLng(B.lat, B.lng)] }
      ]);
      fitTo([[A.lat, A.lng], [B.lat, B.lng],
             [A.airport.lat, A.airport.lng], [B.airport.lat, B.airport.lng],
             [A.station.lat, A.station.lng], [B.station.lat, B.station.lng]]);
      mapMsg('');
    } catch (err) {
      mapMsg('地图渲染失败：' + (err && err.message ? err.message : err));
    }
  }

  /* ---------- 控件 ---------- */
  function syncSliders() {
    var acc = currentAcc();
    ['aRail', 'aAir', 'bRail', 'bAir'].forEach(function (k) {
      var el = $(k);
      if (!el) return;
      el.value = Math.round(acc[k]);
      $(k + 'V').textContent = Math.round(acc[k]) + ' 分钟';
    });
    $('railSpeed').value = state.params.railSpeed;
    $('railSpeedV').textContent = state.params.railSpeed + ' km/h';
    $('airEarly').value = state.params.airEarly;
    $('airEarlyV').textContent = state.params.airEarly + ' 分钟';
  }

  function bind() {
    var opts = DATA.cities.map(function (c) {
      return '<option value="' + c.id + '">' + c.name + '</option>';
    }).join('');
    $('selA').innerHTML = opts; $('selB').innerHTML = opts;
    $('selA').value = state.a; $('selB').value = state.b;

    function onCity(which) {
      return function () {
        var v = $(which).value;
        if (which === 'selA') {
          if (v === state.b) state.b = state.a;
          state.a = v;
        } else {
          if (v === state.a) state.a = state.b;
          state.b = v;
        }
        $('selA').value = state.a; $('selB').value = state.b;
        state.acc = null;
        syncSliders(); render();
      };
    }
    $('selA').addEventListener('change', onCity('selA'));
    $('selB').addEventListener('change', onCity('selB'));
    $('btnSwap').addEventListener('click', function () {
      var t = state.a; state.a = state.b; state.b = t;
      $('selA').value = state.a; $('selB').value = state.b;
      state.acc = null; syncSliders(); render();
    });
    $('btnReset').addEventListener('click', function () {
      state.acc = null;
      state.params.railSpeed = M.DEFAULTS.railSpeed;
      state.params.airEarly = M.DEFAULTS.airEarly;
      syncSliders(); render();
    });
    ['aRail', 'aAir', 'bRail', 'bAir'].forEach(function (k) {
      $(k).addEventListener('input', function () {
        if (!state.acc) state.acc = currentAcc();
        state.acc[k] = num($(k).value, 0);
        $(k + 'V').textContent = Math.round(state.acc[k]) + ' 分钟';
        render();
      });
    });
    $('railSpeed').addEventListener('input', function () {
      state.params.railSpeed = num($('railSpeed').value, M.DEFAULTS.railSpeed);
      $('railSpeedV').textContent = state.params.railSpeed + ' km/h';
      render();
    });
    $('airEarly').addEventListener('input', function () {
      state.params.airEarly = num($('airEarly').value, M.DEFAULTS.airEarly);
      $('airEarlyV').textContent = state.params.airEarly + ' 分钟';
      render();
    });
  }

  /* ---------- 主渲染 ---------- */
  function render() {
    var p = pairOf(state.a, state.b);
    if (!p) return;
    var e = evaluate();
    renderHero(e);
    renderModes(e);
    renderPhase(e);
    renderInsights(e);
    renderTable();
    renderMap();
  }

  function boot() {
    bind();
    syncSliders();
    renderDisclaimer();
    render();
    if (typeof TMap !== 'undefined') initMap();
    else mapMsg('地图 SDK 未加载（离线或网络受限）');
    renderMap();
  }

  // 自启动：不许只挂不调
  window.__trident_boot = boot;
  if (document.readyState === 'complete' || document.readyState === 'interactive') boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
