/* =====================================================================
 * 揉皱的城市 · CRUMPLED CITY —— 界面与地图
 *
 * 纪律（历次踩坑，逐条对应下面代码）：
 *  1. 入口必须自启动（祖先洪流：boot 挂在 window 上却忘了调用，断言全绿而页面空白）
 *  2. catch 里不许只 console.warn —— 必须留下用户可见痕迹
 *  3. marker 图标一律内联 SVG data URI（腾讯官方示例外链图已 404，会退化成同一个）
 *  4. 本版 TMap GL 的 fitBounds 只挪中心不改 zoom —— 自己按容器像素解 Mercator zoom
 *  5. 节流函数先判前置条件再写时间戳，否则早退会污染节流状态
 *  6. TMap GL 不接受 8 位十六进制颜色（#1e2430cc），一律 rgba()
 *  7. 跳过绘制的图层必须 setGeometries([])，否则残留上一种几何
 *  8. 运行时零 API 调用：288 条真实路径已预生成，点地图用经验查表，不受配额影响
 * ===================================================================== */
(function () {
  'use strict';

  var D = window.CRUMPLE_DATA, M = window.CRUMPLE;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };

  var SUM = {}, CITY = {};
  D.cities.forEach(function (c) { SUM[c.id] = M.summarize(c); CITY[c.id] = c; });
  var ORDER = D.cities.map(function (c) { return c.id; });

  var state = {
    cityId: 'beijing',
    minutes: 20,
    target: null,      // {lat,lng} 用户在地图上点选的终点
    showPaths: true,
    showCircle: true
  };

  function cur() { return CITY[state.cityId]; }
  function sum() { return SUM[state.cityId]; }

  /* ---------------- 格式化 ---------------- */
  function fmtM(v) {
    if (!isFinite(v)) return '—';
    return v >= 1000 ? (v / 1000).toFixed(2) + ' km' : Math.round(v) + ' m';
  }
  function fmtMin(v) {
    if (!isFinite(v)) return '—';
    return v >= 60 ? Math.floor(v / 60) + ' 小时 ' + Math.round(v % 60) + ' 分'
      : Math.round(v) + ' 分钟';
  }

  /* ---------------- 内联 SVG 图标（外链 markerDefault.png 已 404） ---------------- */
  function svg(body, w, h) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h +
      '" viewBox="0 0 ' + w + ' ' + h + '">' + body + '</svg>');
  }
  var ICON_CENTER = svg('<circle cx="14" cy="14" r="11" fill="#f97316" stroke="#fff" stroke-width="3"/>' +
    '<circle cx="14" cy="14" r="4" fill="#fff"/>', 28, 28);
  var ICON_TARGET = svg('<path d="M14 27 C14 27 5 17.6 5 11.6 A9 9 0 0 1 23 11.6 C23 17.6 14 27 14 27 Z" ' +
    'fill="#51cf66" stroke="#fff" stroke-width="2.4" stroke-linejoin="round"/>' +
    '<circle cx="14" cy="11.6" r="3.2" fill="#fff"/>', 28, 28);

  /* ---------------- 提示与报错 ---------------- */
  function toast(msg) {
    var t = $('toast'); if (!t) return;
    t.textContent = msg; t.classList.add('on');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('on'); }, 2000);
  }
  function showError(msg) {
    var b = $('maperr'); if (!b) return;
    b.textContent = msg; b.style.display = 'block';
  }
  function clearError() { var b = $('maperr'); if (b) { b.style.display = 'none'; b.textContent = ''; } }

  /* ---------------- 地图 ---------------- */
  var map = null, mapReady = false;
  var mkCenter = null, mkTarget = null, mlPaths = null, mlHi = null, mpIso = null, mpCircle = null;

  /** fitBounds 在本版 TMap GL 里只挪中心不改 zoom，自己按容器像素解 Web Mercator zoom */
  function zoomFor(spanMeters, wPx, hPx, lat) {
    var mPerPx = spanMeters / Math.max(60, Math.min(wPx, hPx));
    var z = Math.log(40075017 * Math.cos(lat * Math.PI / 180) / (256 * mPerPx)) / Math.LN2;
    return Math.max(3, Math.min(17, z));
  }

  function ensureMap() {
    if (map || typeof TMap === 'undefined') return map;
    var el = $('map'); if (!el) return null;
    try {
      map = new TMap.Map(el, {
        center: new TMap.LatLng(cur().lat, cur().lng),
        zoom: 13, pitch: 0, rotation: 0, baseMap: { type: 'vector' }
      });
      mkCenter = new TMap.MultiMarker({ map: map, styles: {
        c: new TMap.MarkerStyle({ width: 28, height: 28, anchor: { x: 14, y: 14 }, src: ICON_CENTER })
      }, geometries: [] });
      mkTarget = new TMap.MultiMarker({ map: map, styles: {
        t: new TMap.MarkerStyle({ width: 28, height: 28, anchor: { x: 14, y: 26 }, src: ICON_TARGET })
      }, geometries: [] });
      mlPaths = new TMap.MultiPolyline({ map: map, styles: {
        p: new TMap.PolylineStyle({ color: 'rgba(249,115,22,0.42)', width: 2, borderWidth: 0, lineCap: 'round' })
      }, geometries: [] });
      // 点选后高亮的那条实测路径单独一层，画在其它路径之上
      mlHi = new TMap.MultiPolyline({ map: map, styles: {
        hi: new TMap.PolylineStyle({ color: 'rgba(81,207,102,0.95)', width: 4,
          borderWidth: 1, borderColor: 'rgba(255,255,255,0.7)', lineCap: 'round' })
      }, geometries: [] });
      mpIso = new TMap.MultiPolygon({ map: map, styles: {
        iso: new TMap.PolygonStyle({ color: 'rgba(255,212,59,0.16)', showBorder: true,
          borderColor: 'rgba(255,212,59,0.95)', borderWidth: 2 })
      }, geometries: [] });
      mpCircle = new TMap.MultiPolygon({ map: map, styles: {
        cir: new TMap.PolygonStyle({ color: 'rgba(77,171,247,0.05)', showBorder: true,
          borderColor: 'rgba(77,171,247,0.9)', borderWidth: 2 })
      }, geometries: [] });
      map.on('click', onMapClick);
      mapReady = true;
      window.__cc_map = map;          // 供冒烟脚本驱动真实点击流程
      clearError();
    } catch (e) {
      showError('地图初始化失败：' + (e && e.message ? e.message : e) + '。页面上的数字与图表不依赖地图，仍可使用。');
    }
    return map;
  }

  function ring(lat, lng, radiusM, n) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var p = M.offsetLatLng(lat, lng, i * (360 / n), radiusM);
      out.push(new TMap.LatLng(p.lat, p.lng));
    }
    return out;
  }

  var lastFit = 0;
  function fitMap(spanMeters) {
    if (!mapReady) return;                    // 先判条件，再写时间戳
    var now = Date.now();
    if (now - lastFit < 250 && lastFit > 0) return;
    lastFit = now;
    var el = $('map'); if (!el) return;
    var c = cur();
    var lat = state.target ? (c.lat + state.target.lat) / 2 : c.lat;
    var lng = state.target ? (c.lng + state.target.lng) / 2 : c.lng;
    try {
      map.setCenter(new TMap.LatLng(lat, lng));
      map.setZoom(Math.round(zoomFor(spanMeters, el.clientWidth || 700, el.clientHeight || 430, lat) * 100) / 100);
    } catch (e) { showError('地图取景失败：' + (e && e.message ? e.message : e)); }
  }

  function drawMap() {
    if (!ensureMap() || !mapReady) return;
    var c = cur(), s = sum();
    try {
      // 真实路径（36 条）
      if (state.showPaths) {
        mlPaths.setGeometries(c.routes.map(function (r) {
          return { id: 'p' + r.b + '_' + r.d, styleId: 'p',
            paths: r.p.map(function (pt) { return new TMap.LatLng(pt[0], pt[1]); }) };
        }));
      } else {
        mlPaths.setGeometries([]);            // 不画就必须清空，否则残留
      }

      // 真实等时圈
      var iso = M.isochrone(c, state.minutes);
      mpIso.setGeometries([{ id: 'iso', styleId: 'iso',
        paths: iso.map(function (p) { return new TMap.LatLng(p.lat, p.lng); }) }]);

      // 对照组：同样时间、按几何距离能到的圆
      if (state.showCircle) {
        var rIdeal = s.speed * state.minutes;
        mpCircle.setGeometries([{ id: 'cir', styleId: 'cir', paths: ring(c.lat, c.lng, rIdeal, 48) }]);
      } else {
        mpCircle.setGeometries([]);
      }

      mkCenter.setGeometries([{ id: 'c', styleId: 'c', position: new TMap.LatLng(c.lat, c.lng) }]);

      // 点选终点 + 最接近的实测路径
      if (state.target) {
        var sd = M.haversine(c.lat, c.lng, state.target.lat, state.target.lng);
        var brg = M.bearingOf(c.lat, c.lng, state.target.lat, state.target.lng);
        var nr = M.nearestRoute(c, brg, sd);
        mkTarget.setGeometries([{ id: 't', styleId: 't',
          position: new TMap.LatLng(state.target.lat, state.target.lng) }]);
        mlHi.setGeometries([{ id: 'hi', styleId: 'hi',
          paths: nr.p.map(function (pt) { return new TMap.LatLng(pt[0], pt[1]); }) }]);
      } else {
        mkTarget.setGeometries([]);
        if (mlHi) mlHi.setGeometries([]);
      }
      var span = 7600;
      if (state.target) {
        var d2 = M.haversine(c.lat, c.lng, state.target.lat, state.target.lng);
        span = Math.max(7600, d2 * 2.4);
      }
      fitMap(span);
      clearError();
    } catch (e) {
      showError('地图绘制失败：' + (e && e.message ? e.message : e));
    }
  }

  function onMapClick(evt) {
    if (!evt || !evt.latLng) return;
    state.target = { lat: evt.latLng.getLat(), lng: evt.latLng.getLng() };
    drawMap(); renderTarget(); renderRho();
  }

  /* ---------------- 顶部城市条 ---------------- */
  function renderChips() {
    var box = $('cityChips'); if (!box) return;
    box.innerHTML = ORDER.map(function (id) {
      return '<button class="chip' + (id === state.cityId ? ' on' : '') + '" data-c="' + id + '">' +
        esc(SUM[id].name) + '</button>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('.chip'), function (b) {
      b.onclick = function () { state.cityId = b.dataset.c; state.target = null; renderAll(); };
    });
  }

  /* ---------------- KPI 卡 ---------------- */
  function renderKpis() {
    var s = sum(), f = s.fit;
    var reach1000 = M.reachDist(f, 1000);
    var scale = M.sensibleScale(f, 1500);
    var r6 = s.rhoByDist[600], r35 = s.rhoByDist[3500];
    $('kpis').innerHTML = [
      card('渐近揉皱 ρ∞', f.rhoInf.toFixed(2) + '<small> 倍</small>',
        '走很远时，每 1 米直线要走的米数'),
      card('绕行税 C', Math.round(f.C) + '<small> m</small>',
        '每次出门先付的固定绕行成本'),
      card('走 1000 米只前进', Math.round(reach1000) + '<small> m</small>',
        '其余 ' + Math.round(M.wastedFrac(f, 1000) * 100) + '% 没换来位移'),
      card('体感放大', scale.toFixed(2) + '<small> 倍</small>', '1.5 km 尺度下城市在你脚下的大小')
    ].join('');
    $('subRho').textContent = s.fit.rhoMean.toFixed(2) + ' 公里';
    $('claim').innerHTML =
      '<b>' + esc(s.name) + '</b>：600 米的路要绕 <b>' + r6.toFixed(2) + '</b> 倍，' +
      '3500 米反而只要 <b>' + r35.toFixed(2) + '</b> 倍。' +
      (f.C < 60
        ? '这座城的路网密到几乎<b>没有绕行税</b>（C≈0），多远都一样绕 —— 这在中国城市里是少数。'
        : '差额来自 <b>' + Math.round(f.C) + ' 米</b>的绕行税：它不随距离变，所以在短路上占比最大。');
  }
  function card(k, v, d) {
    return '<div class="kpi"><div class="k">' + k + '</div><div class="v">' + v +
      '</div><div class="d">' + d + '</div></div>';
  }

  /* ---------------- 揉皱曲线 ---------------- */
  function renderRho() {
    var cv = $('cRho'); if (!cv || !cv.getContext) return;
    var g = cv.getContext('2d');
    var W = cv.width, H = cv.height, PL = 52, PR = 18, PT = 18, PB = 40;
    g.clearRect(0, 0, W, H);
    var c = cur(), f = sum().fit;
    var xs = c.routes.map(function (r) { return r.sd; });
    var xMax = Math.max(4000, Math.ceil(Math.max.apply(null, xs) / 500) * 500);
    var yMax = Math.max(2.2, M.rhoAt(f, 600) + 0.2);
    var X = function (v) { return PL + (v / xMax) * (W - PL - PR); };
    var Y = function (v) { return H - PB - ((v - 1) / (yMax - 1)) * (H - PT - PB); };

    // 网格
    g.strokeStyle = '#2a313c'; g.fillStyle = '#6e7b8a'; g.font = '11px sans-serif'; g.lineWidth = 1;
    for (var yy = 1; yy <= yMax; yy += 0.2) {
      g.beginPath(); g.moveTo(PL, Y(yy)); g.lineTo(W - PR, Y(yy)); g.stroke();
      g.fillText(yy.toFixed(1), 10, Y(yy) + 4);
    }
    for (var xx = 0; xx <= xMax; xx += 500) {
      g.beginPath(); g.moveTo(X(xx), PT); g.lineTo(X(xx), H - PB); g.stroke();
      g.fillText(xx, X(xx) - 10, H - PB + 16);
    }
    g.fillText('直线距离（米）', W / 2 - 40, H - 8);
    g.save(); g.translate(14, H / 2); g.rotate(-Math.PI / 2);
    g.fillText('揉皱系数 ρ', 0, 0); g.restore();

    // 外推区（<600 m 无实测样本）
    g.fillStyle = 'rgba(110,123,138,0.10)';
    g.fillRect(PL, PT, X(600) - PL, H - PT - PB);

    // 实测散点
    var COL = { 600: '#ffd43b', 1500: '#f97316', 3500: '#e8590c' };
    c.routes.forEach(function (r) {
      var rho = r.wd / r.sd;
      g.beginPath(); g.fillStyle = COL[r.d] || '#f97316';
      g.arc(X(r.sd), Y(Math.min(rho, yMax)), 3.4, 0, 6.2832); g.fill();
    });

    // 拟合曲线
    g.beginPath(); g.strokeStyle = '#4dabf7'; g.lineWidth = 2.4;
    for (var d = 60; d <= xMax; d += 20) {
      var y = M.rhoAt(f, d);
      if (d === 60) g.moveTo(X(d), Y(Math.min(y, yMax))); else g.lineTo(X(d), Y(Math.min(y, yMax)));
    }
    g.stroke();

    // ρ∞ 渐近线
    g.beginPath(); g.setLineDash([5, 4]); g.strokeStyle = '#51cf66'; g.lineWidth = 1.6;
    g.moveTo(PL, Y(f.rhoInf)); g.lineTo(W - PR, Y(f.rhoInf)); g.stroke(); g.setLineDash([]);
    g.fillStyle = '#51cf66'; g.fillText('ρ∞ = ' + f.rhoInf.toFixed(2), W - PR - 88, Y(f.rhoInf) - 6);

    // 档位均值
    [[600, '600 m'], [1500, '1.5 km'], [3500, '3.5 km']].forEach(function (p) {
      var v = sum().rhoByDist[p[0]]; if (v == null) return;
      g.beginPath(); g.fillStyle = '#fff'; g.strokeStyle = '#0e1116'; g.lineWidth = 2;
      g.rect(X(p[0]) - 4, Y(Math.min(v, yMax)) - 4, 8, 8); g.fill(); g.stroke();
      g.fillStyle = '#e6edf3'; g.fillText(p[1] + ' → ' + v.toFixed(2), X(p[0]) - 22, Y(Math.min(v, yMax)) - 12);
    });

    // 用户点选
    if (state.target) {
      var sd = M.haversine(c.lat, c.lng, state.target.lat, state.target.lng);
      if (sd <= xMax) {
        g.beginPath(); g.strokeStyle = '#51cf66'; g.lineWidth = 1.4;
        g.moveTo(X(sd), PT); g.lineTo(X(sd), H - PB); g.stroke();
      }
    }
  }

  /* ---------------- 玫瑰图 ---------------- */
  function renderRose() {
    var el = $('cRose'); if (!el) return;
    var c = cur(), rs = M.rose(c, 1500);
    var CX = 180, CY = 172, RMAX = 132, RHO_MAX = 2.6;
    var R = function (rho) { return Math.max(6, Math.min(RMAX, rho / RHO_MAX * RMAX)); };
    var P = function (b, r) {
      var a = (b - 90) * Math.PI / 180;
      return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
    };
    var out = '';
    // 参考圆 ρ = 1
    out += '<circle cx="' + CX + '" cy="' + CY + '" r="' + R(1) +
      '" fill="none" stroke="#2a313c" stroke-width="1.5" stroke-dasharray="4 4"/>';
    for (var v = 1.5; v <= 2.5; v += 0.5) {
      out += '<circle cx="' + CX + '" cy="' + CY + '" r="' + R(v) +
        '" fill="none" stroke="#22282f" stroke-width="1"/>';
    }
    // 扇形
    rs.forEach(function (r) {
      var pts = [CX + ',' + CY];
      for (var a = r.b - 15; a <= r.b + 15; a += 3) {
        var p = P(a, R(r.rho)); pts.push(p[0].toFixed(1) + ',' + p[1].toFixed(1));
      }
      out += '<polygon points="' + pts.join(' ') +
        '" fill="rgba(249,115,22,0.30)" stroke="#f97316" stroke-width="1.5"/>';
    });
    // 外轮廓
    out += '<polygon points="' + rs.map(function (r) {
      var p = P(r.b, R(r.rho)); return p[0].toFixed(1) + ',' + p[1].toFixed(1);
    }).join(' ') + '" fill="none" stroke="#f97316" stroke-width="2.2"/>';
    // 方位与数值
    [['N', 0], ['E', 90], ['S', 180], ['W', 270]].forEach(function (t) {
      var p = P(t[1], RMAX + 16);
      out += '<text x="' + p[0].toFixed(1) + '" y="' + (p[1] + 4).toFixed(1) +
        '" fill="#9aa7b4" font-size="13" text-anchor="middle">' + t[0] + '</text>';
    });
    rs.forEach(function (r) {
      if (r.rho < 1.55) return;
      var p = P(r.b, R(r.rho) + 13);
      out += '<text x="' + p[0].toFixed(1) + '" y="' + (p[1] + 3).toFixed(1) +
        '" fill="#e6edf3" font-size="10.5" text-anchor="middle">' + r.rho.toFixed(2) + '</text>';
    });
    el.innerHTML = out;
    var best = rs.slice().sort(function (a, b) { return a.rho - b.rho; });
    var dirName = function (b) {
      var n = ['正北', '东北偏北', '东北', '东北偏东', '正东', '东南偏东', '东南', '东南偏南',
        '正南', '西南偏南', '西南', '西南偏西', '正西', '西北偏西', '西北', '西北偏北'];
      return n[Math.round(b / 30) % 12];
    };
    $('roseHint').textContent = '1.5 km 档：最好走的是 ' + dirName(best[0].b) + '（ρ=' +
      best[0].rho.toFixed(2) + '），最难走的是 ' + dirName(best[best.length - 1].b) + '（ρ=' +
      best[best.length - 1].rho.toFixed(2) + '），相差 ' + (best[best.length - 1].rho / best[0].rho).toFixed(2) + ' 倍。';
  }

  /* ---------------- 换算器 ---------------- */
  function renderCalc() {
    var s = sum(), f = s.fit;
    var d = M.num(parseFloat($('inDist').value), 0, 20000, 800);
    var w = M.walkDist(f, d);
    var t = w / s.speed;
    $('oWalk').textContent = fmtM(w);
    $('oTime').textContent = fmtMin(t);
    $('oWaste').textContent = Math.round(M.wastedFrac(f, w) * 100) + '%';

    var mins = M.num(parseFloat($('inMin').value), 1, 120, 20);
    var r = s.speed * mins;
    var reach = M.reachDist(f, r);
    $('oReach').textContent = fmtM(reach);
    $('oIdeal').textContent = fmtM(r);
    $('oLost').textContent = fmtM(Math.max(0, r - reach));
  }

  function renderTarget() {
    if (!state.target) return;
    var c = cur(), f = sum().fit;
    var sd = M.haversine(c.lat, c.lng, state.target.lat, state.target.lng);
    var brg = M.bearingOf(c.lat, c.lng, state.target.lat, state.target.lng);
    var emp = M.lookup(c, brg, sd);
    var model = M.walkDist(f, sd);
    toast('直线 ' + fmtM(sd) + ' → 模型 ' + fmtM(model) + '，实测查表 ' + fmtM(emp.wd) +
      '（偏差 ' + Math.round(Math.abs(emp.wd - model) / Math.max(1, emp.wd) * 100) + '%）');
  }

  /* ---------------- 表格 ---------------- */
  function renderTable() {
    var tb = $('tbl').querySelector('tbody');
    tb.innerHTML = ORDER.map(function (id) {
      var s = SUM[id], f = s.fit;
      return '<tr data-c="' + id + '" class="' + (id === state.cityId ? 'on' : '') + '">' +
        '<td>' + esc(s.name) + '</td>' +
        '<td>' + f.rhoInf.toFixed(2) + '</td>' +
        '<td>' + Math.round(f.C) + '</td>' +
        '<td class="hotv">' + s.rhoByDist[600].toFixed(2) + '</td>' +
        '<td>' + s.rhoByDist[3500].toFixed(2) + '</td>' +
        '<td class="hotv">' + Math.round(M.reachDist(f, 1000)) + ' m</td>' +
        '<td>' + M.sensibleScale(f, 1500).toFixed(2) + '×</td>' +
        '<td>' + f.r2.toFixed(2) + '</td></tr>';
    }).join('');
    Array.prototype.forEach.call(tb.querySelectorAll('tr'), function (tr) {
      tr.onclick = function () { state.cityId = tr.dataset.c; state.target = null; renderAll(); };
    });
  }

  /* ---------------- 说明 ---------------- */
  function renderExplain() {
    var s = sum(), f = s.fit;
    $('explain').innerHTML =
      '<b>ρ∞（渐近揉皱系数）</b>：把路走得很长以后剩下的那部分绕行。它来自路网本身的形状 —— ' +
      '棋盘格路网的理论值是 4/π ≈ 1.27（曼哈顿距离 / 直线距离的期望），八座城实测 ' +
      ORDER.map(function (id) { return SUM[id].fit.rhoInf.toFixed(2); }).join(' / ') + '。<br><br>' +
      '<b>C（绕行税）</b>：与距离无关的固定成本 —— 走出小区、绕到路口、过天桥、等红灯绕行。' +
      '它不随距离增长，所以在短路上占比最大：<b>这就是「越短越绕」的全部原因</b>。' +
      ('<b>' + esc(s.name) + '</b> 的 C 是 ' + Math.round(f.C) + ' 米。' +
        (f.C < 60 ? '—— 低到几乎为零，说明这里路网密到「出门就有路口」，短距离不需要额外绕行。' : '') + '<br><br>') +
      '<b>体感放大</b>：几何半径 R 的圆，在步行者体感里相当于半径 W(R) 的圆，面积放大 ρ(R)²。' +
      '<b>' + esc(s.name) + '</b> 在 1.5 km 尺度上是 ' + M.sensibleScale(f, 1500).toFixed(2) +
      ' 倍 —— 你走的地方，比你在地图上看到的那个范围要大这么多。<br><br>' +
      '<b>外推区</b>：实测样本只覆盖 600–3500 米。图中浅灰色区间（< 600 米）是模型外推，' +
      '那里两点往往在同一条街上，ρ 会向 1 回落，模型已做平滑处理但仍仅供参考。<br><br>' +
      '<b>方向差异</b>：模型给的是城市平均。同一个距离，往不同方位走的差距可以很大 —— 见玫瑰图。' +
      '点地图任意位置，页面会用 288 条实测路径插值出的经验曲面给你一个具体方位的答案。';
  }

  /* ---------------- 渲染入口 ---------------- */
  function renderAll() {
    renderChips(); renderKpis(); renderRho(); renderRose(); renderCalc(); renderTable();
    renderExplain(); drawMap();
  }

  function bind() {
    var rm = $('rngMin'); if (rm) rm.oninput = function () {
      state.minutes = M.num(parseInt(rm.value, 10), 5, 40, 20);
      $('vMin').textContent = state.minutes + ' 分钟';
      drawMap(); renderCalc();
    };
    var cp = $('ckPaths'); if (cp) cp.onchange = function () { state.showPaths = cp.checked; drawMap(); };
    var cc = $('ckCircle'); if (cc) cc.onchange = function () { state.showCircle = cc.checked; drawMap(); };
    var id = $('inDist'); if (id) id.oninput = renderCalc;
    var im = $('inMin'); if (im) im.oninput = renderCalc;
    var vm = $('vMin'); if (vm) vm.textContent = state.minutes + ' 分钟';
  }

  /* ---------------- 自启动（祖先洪流的教训：只挂不调 = 页面全白） ---------------- */
  function boot() {
    try {
      if (!D || !D.cities || !D.cities.length) throw new Error('数据未加载');
      bind(); renderAll();
      return true;
    } catch (e) {
      showError('初始化失败：' + (e && e.message ? e.message : e));
      return false;
    }
  }
  window.__cc_boot = boot;

  function autostart() { boot(); }
  if (document.readyState === 'complete' || document.readyState === 'interactive') autostart();
  else window.addEventListener('load', autostart);
})();
