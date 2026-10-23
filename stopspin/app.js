/* 停转之日 · 交互层
 * 全部计算在浏览器本地完成：内置 0.5° 全球高程栅格 + 等势面模型（见 model.js）
 *
 * 为什么用 ImageTileLayer 而不是 CanvasGroundLayer：
 * TMap 的 ImageGroundLayer / CanvasGroundLayer 在覆盖全球（±180°）时会抛几百条
 * 「LatLng.lat 取值应在 [-90,90]」——它要把整块地皮细分成网格再逐点投影，跨范围就炸。
 * 瓦片图层天然按墨卡托 256px 切片，不碰这条路径，刷新也可控（整层重建）。
 */
(function () {
  'use strict';

  var M = window.StopSpin;
  var DATA = window.__STOP_DATA;

  var TILE = 256;
  var MAX_DATA_ZOOM = 5;      // 超过此层级直接拉伸 z=5 瓦片（数据本身只有 0.5°，够用）
  var MAP_THROTTLE = 260;     // 地图重绘节流（毫秒）；数字与图表不节流

  var state = { k: 1, map: null, layer: null, marker: null, pending: null, lastSwap: 0 };
  var lastStats = null;

  // ---------------- 瓦片渲染 ----------------
  function latOfTileRow(y, z, frac) {
    var n = 1 << z;
    var my = Math.PI * (1 - 2 * (y + frac) / n);
    return Math.atan(Math.sinh(my)) * 180 / Math.PI;
  }

  function paintTile(ctx, x, y, z, k) {
    var img = ctx.createImageData(TILE, TILE);
    var d = img.data;
    var W = TILE + 1;                       // 多算一行一列，用于海岸线判定
    var stat = new Uint8Array(W * W);
    var seaRow = new Float64Array(W);
    for (var r = 0; r < W; r++) seaRow[r] = M.seaLevelM(latOfTileRow(y, z, (r + 0.5) / TILE), k);

    var n = 1 << z;
    for (var yy = 0; yy < W; yy++) {
      var lat = latOfTileRow(y, z, (yy + 0.5) / TILE);
      var D = seaRow[yy];
      for (var xx = 0; xx < W; xx++) {
        var lon = ((x + (xx + 0.5) / TILE) / n) * 360 - 180;
        var h = M.elevAt(lat, lon, true);
        var wasLand = h > 0;
        var sub = h < D;
        var s = 0;
        if (wasLand && sub) s = 1; else if (!wasLand && !sub) s = 2;
        stat[yy * W + xx] = s;
        if (yy >= TILE || xx >= TILE) continue;
        var o = (yy * TILE + xx) * 4;
        if (s === 1) {
          var a = 0.34 + 0.46 * Math.min(1, (D - h) / 4000);
          d[o] = 32; d[o + 1] = 118; d[o + 2] = 208; d[o + 3] = Math.round(a * 255);
        } else if (s === 2) {
          var a2 = 0.30 + 0.40 * Math.min(1, (h - D) / 2000);
          d[o] = 226; d[o + 1] = 170; d[o + 2] = 92; d[o + 3] = Math.round(a2 * 255);
        } else {
          d[o + 3] = 0;
        }
      }
    }
    ctx.putImageData(img, 0, 0);

    ctx.fillStyle = 'rgba(160,230,255,0.95)';
    for (var ey = 0; ey < TILE; ey++) {
      for (var ex = 0; ex < TILE; ex++) {
        var s0 = stat[ey * W + ex];
        if (s0 === 0) continue;
        if (stat[ey * W + ex + 1] !== s0 || stat[(ey + 1) * W + ex] !== s0) ctx.fillRect(ex, ey, 1, 1);
      }
    }
  }

  function makeLayer(k, map) {
    var cv = document.createElement('canvas');
    cv.width = TILE; cv.height = TILE;
    var ctx = cv.getContext('2d');
    return new TMap.ImageTileLayer({
      getTileUrl: function (x, y, z) {
        ctx.clearRect(0, 0, TILE, TILE);
        paintTile(ctx, x, y, z, k);
        return Promise.resolve(cv.toDataURL('image/png'));
      },
      map: map, minZoom: 1, maxZoom: 18, maxDataZoom: MAX_DATA_ZOOM,
      opacity: 1, zIndex: 100, visible: true, isMainThreadLoaded: true
    });
  }

  /** 重建覆盖层：先挂新的，再撤旧的，避免闪白 */
  function setOverlay(k) {
    if (!state.map) return;
    var old = state.layer;
    state.layer = makeLayer(k, state.map);
    if (old) setTimeout(function () { try { old.destroy(); } catch (e) { } }, 300);
  }

  function scheduleOverlay(k) {
    if (!state.map || state.pending) return;
    var wait = Math.max(0, MAP_THROTTLE - (Date.now() - state.lastSwap));
    state.pending = setTimeout(function () {
      state.pending = null;
      state.lastSwap = Date.now();
      setOverlay(state.k);
    }, wait);
  }

  // ---------------- 图表 ----------------
  function drawProfile(k) {
    var cv = document.getElementById('prof');
    if (!cv || !cv.getContext) return;
    var ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    var padL = 54, padR = 16, padT = 14, padB = 30;
    var x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
    var vMax = 9000, vMin = -12000;
    var X = function (lat) { return x0 + (lat + 90) / 180 * (x1 - x0); };
    var Y = function (v) { return y1 - (v - vMin) / (vMax - vMin) * (y1 - y0); };

    ctx.strokeStyle = '#1d2c46'; ctx.lineWidth = 1; ctx.font = '11px sans-serif'; ctx.fillStyle = '#65799a';
    for (var v = -12000; v <= 9000; v += 3000) {
      var yy = Y(v);
      ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke();
      ctx.fillText((v / 1000) + ' km', 6, yy + 4);
    }
    for (var la = -90; la <= 90; la += 30) {
      var xx = X(la);
      ctx.beginPath(); ctx.moveTo(xx, y0); ctx.lineTo(xx, y1); ctx.stroke();
      ctx.fillText(Math.abs(la) + '°' + (la === 0 ? '' : (la > 0 ? 'N' : 'S')), xx - 12, y1 + 16);
    }

    var pts = M.profileAt(116, k, 1);
    ctx.beginPath();
    ctx.moveTo(X(pts[0].lat), Y(vMin));
    for (var i = 0; i < pts.length; i++) ctx.lineTo(X(pts[i].lat), Y(Math.max(vMin, Math.min(vMax, pts[i].elevM))));
    ctx.lineTo(X(pts[pts.length - 1].lat), Y(vMin));
    ctx.closePath();
    ctx.fillStyle = 'rgba(150,160,180,0.30)'; ctx.fill();

    ctx.beginPath();
    for (var j = 0; j < pts.length; j++) {
      var px = X(pts[j].lat), py = Y(Math.max(vMin, Math.min(vMax, pts[j].elevM)));
      if (j === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = '#9aa6bd'; ctx.lineWidth = 1.2; ctx.stroke();

    ctx.beginPath(); ctx.moveTo(x0, Y(0)); ctx.lineTo(x1, Y(0));
    ctx.strokeStyle = '#4a5b76'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1; ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    for (var m = 0; m < pts.length; m++) {
      var qx = X(pts[m].lat), qy = Y(Math.max(vMin, Math.min(vMax, pts[m].seaM)));
      if (m === 0) ctx.moveTo(qx, qy); else ctx.lineTo(qx, qy);
    }
    ctx.strokeStyle = '#3aa0e8'; ctx.lineWidth = 2.4; ctx.stroke();
    ctx.fillStyle = '#3aa0e8'; ctx.font = 'bold 12px sans-serif';
    ctx.fillText('停转后海面', x1 - 78, Math.max(y0 + 12, Y(pts[pts.length - 1].seaM) - 8));
  }

  function drawCurve(k) {
    var cv = document.getElementById('curve');
    if (!cv || !cv.getContext) return;
    var ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    var padL = 46, padR = 14, padT = 12, padB = 26;
    var x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
    var lMin = 100e6, lMax = 160e6;
    var X = function (kk) { return x0 + (1 - kk) * (x1 - x0); };
    var Y = function (v) { return y1 - (v - lMin) / (lMax - lMin) * (y1 - y0); };

    ctx.strokeStyle = '#1d2c46'; ctx.fillStyle = '#65799a'; ctx.font = '11px sans-serif';
    for (var v = 100e6; v <= 160e6; v += 10e6) {
      var yy = Y(v);
      ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke();
      ctx.fillText((v / 1e6) + '', 8, yy + 4);
    }
    ctx.fillText('Mm²', 8, y0 + 8);
    for (var kk = 0; kk <= 1.0001; kk += 0.25) {
      var xx = X(kk);
      ctx.beginPath(); ctx.moveTo(xx, y0); ctx.lineTo(xx, y1); ctx.stroke();
      ctx.fillText(Math.round(kk * 100) + '%', xx - 10, y1 + 16);
    }

    ctx.beginPath();
    for (var i = 0; i <= 100; i++) {
      var key = (1 - 0.01 * i).toFixed(2);
      var v2 = DATA.stats[key].land;
      var px = X(1 - 0.01 * i), py = Y(v2);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = '#e8b463'; ctx.lineWidth = 2.2; ctx.stroke();

    var minK = null, minV = Infinity;
    for (var j = 0; j <= 100; j++) {
      var kk2 = 1 - 0.01 * j, v3 = DATA.stats[kk2.toFixed(2)].land;
      if (v3 < minV) { minV = v3; minK = kk2; }
    }
    ctx.beginPath(); ctx.arc(X(minK), Y(minV), 4, 0, Math.PI * 2);
    ctx.fillStyle = '#ff6fb0'; ctx.fill();

    var cx = X(k), cyv = Y(lastStats.land);
    ctx.beginPath(); ctx.moveTo(cx, y0); ctx.lineTo(cx, y1);
    ctx.strokeStyle = '#3ad6f5'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(cx, cyv, 5, 0, Math.PI * 2); ctx.fillStyle = '#3ad6f5'; ctx.fill();
  }

  // ---------------- 数字与表格 ----------------
  function fmtM(v) {
    var a = Math.abs(v);
    if (a >= 1000) return (v / 1000).toFixed(a >= 10000 ? 1 : 2) + ' km';
    return Math.round(v) + ' m';
  }
  function fmtSigned(v) {
    if (Math.abs(v) < 1) return '0 m';
    return (v >= 0 ? '+' : '−') + fmtM(Math.abs(v));
  }
  function setTxt(id, t) { var e = document.getElementById(id); if (e) e.textContent = t; }

  // TMap 的墨卡托投影在 lat=±90 处会抛「LatLng.lat 取值应在 [-90,90]」，标记点必须避开两极
  function safeLat(v) { return Math.max(-89.5, Math.min(89.5, v)); }
  function ll(lat, lon) { return new TMap.LatLng(safeLat(lat), lon); }

  function renderCities(k) {
    var tb = document.getElementById('cityBody');
    if (!tb) return;
    var html = '';
    DATA.cities.forEach(function (c) {
      var s = M.statusAt(c.lat, c.lon, k);
      var wasLand = c.h > 0;                       // 今天就是陆地？不能只看「现在没沉」就当它新生
      var today = wasLand ? '<span class="tag dry">陆</span>' : '<span class="tag wet">海 ' + fmtM(-c.h) + '</span>';
      var now = wasLand
        ? (s.sub ? '<span class="tag wet">沉没</span>' : '<span class="tag dry">陆地</span>')
        : (s.sub ? '<span class="tag wet">海域</span>' : '<span class="tag dry">新生</span>');
      var val = s.sub ? fmtM(s.depthM) : fmtM(s.altM);
      html += '<tr data-lat="' + c.lat + '" data-lon="' + c.lon + '" data-name="' + c.name + '">' +
        '<td>' + c.name + '</td>' +
        '<td>' + Math.abs(c.lat).toFixed(1) + '°' + (c.lat >= 0 ? 'N' : 'S') + '</td>' +
        '<td>' + fmtM(c.h) + '</td>' +
        '<td>' + today + '</td>' +
        '<td>' + now + '</td>' +
        '<td>' + val + '</td></tr>';
    });
    tb.innerHTML = html;
    Array.prototype.forEach.call(tb.querySelectorAll('tr'), function (tr) {
      tr.onclick = function () {
        var lat = parseFloat(tr.getAttribute('data-lat')), lon = parseFloat(tr.getAttribute('data-lon'));
        if (state.map) state.map.setCenter(ll(lat, lon));
        showPoint(lat, lon, tr.getAttribute('data-name'));
      };
    });
    setTxt('thNow', '自转 ' + Math.round(k * 100) + '% 时');
  }

  function updateMarkers(k) {
    if (!state.marker) return;
    state.marker.updateGeometries(DATA.cities.map(function (c, i) {
      var s = M.statusAt(c.lat, c.lon, k);
      return { id: 'c' + i, styleId: s.sub ? 'wet' : 'dry', position: ll(c.lat, c.lon), properties: { title: c.name } };
    }));
  }

  function svgIcon(fill, ring) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">' +
      '<circle cx="11" cy="11" r="8" fill="' + fill + '" stroke="' + ring + '" stroke-width="2.5"/></svg>');
  }

  var lastPoint = null;
  function showPoint(lat, lon, name) {
    lastPoint = [lat, lon, name];
    var el = document.getElementById('ptInfo');
    if (!el) return;
    var s1 = M.statusAt(lat, lon, 1), s0 = M.statusAt(lat, lon, state.k);
    var wasLand = !s1.sub;
    var nowTxt = (wasLand && s0.sub) ? '<span style="color:#7cc8ff">沉没，水深 ' + fmtM(s0.depthM) + '</span>'
      : (!wasLand && !s0.sub) ? '<span style="color:#f0c78a">成为陆地，高出新海面 ' + fmtM(s0.altM) + '</span>'
        : wasLand ? '<span style="color:#9fe3a8">仍是陆地，高出新海面 ' + fmtM(s0.altM) + '</span>'
          : '<span style="color:#8fa8bd">仍是海域，水深 ' + fmtM(s0.depthM) + '</span>';
    el.innerHTML = '<b>' + (name || (Math.abs(lat).toFixed(2) + '°, ' + Math.abs(lon).toFixed(2) + '°')) + '</b>' +
      '　今天：' + (s1.sub ? '海底 ' + fmtM(s1.depthM) + ' 深' : '陆地 ' + fmtM(s1.elevM)) +
      '　→　自转 ' + Math.round(state.k * 100) + '%：' + nowTxt;
  }

  // ---------------- 主更新 ----------------
  function update(k, opts) {
    opts = opts || {};
    k = Math.max(0, Math.min(1, k));
    state.k = k;
    lastStats = M.scanStats(k);
    var st = lastStats;

    setTxt('kval', Math.round(k * 100) + '%');
    setTxt('nEq', fmtSigned(M.seaLevelM(0, k)));
    setTxt('nPole', fmtSigned(M.seaLevelM(90, k)));
    setTxt('nDrop', fmtM(M.A_COEF_KM * (1 - k * k) * 1000));

    var crit = null;
    for (var la = 0; la <= 90; la += 0.05) { if (M.seaLevelM(la, k) >= 0) { crit = la; break; } }
    setTxt('nCrit', crit === null ? '无（海面处处下降）' : '±' + crit.toFixed(1) + '°');

    setTxt('nLand', (st.land / 1e6).toFixed(1) + ' Mm²');
    setTxt('nCen', st.centroid.toFixed(1) + '°');
    setTxt('nDrown', (st.drowned / 1e6).toFixed(1) + ' Mm²');
    setTxt('nNew', (st.newborn / 1e6).toFixed(1) + ' Mm²');
    setTxt('nSurv', (st.survive / 1e6).toFixed(1) + ' Mm²');

    drawProfile(k);
    drawCurve(k);
    renderCities(k);
    updateMarkers(k);
    if (lastPoint) showPoint(lastPoint[0], lastPoint[1], lastPoint[2]);
    else showPoint(39.9042, 116.4074, '北京');

    if (opts.map === false || !state.map) return;
    if (opts.immediate) { setOverlay(k); state.lastSwap = Date.now(); }
    else scheduleOverlay(k);
  }

  var brakeTimer = null;
  function toggleBrake() {
    if (brakeTimer) { clearInterval(brakeTimer); brakeTimer = null; setTxt('btnBrake', '▶ 一键刹车（100% → 0）'); return; }
    setTxt('btnBrake', '■ 停止');
    var kk = state.k <= 0.001 ? 1 : state.k;
    var tick = 0;
    brakeTimer = setInterval(function () {
      kk -= 0.008;
      if (kk <= 0) {
        kk = 0; clearInterval(brakeTimer); brakeTimer = null;
        setTxt('btnBrake', '▶ 一键刹车（100% → 0）');
      }
      var r = document.getElementById('krange');
      if (r) r.value = String(Math.round(kk * 100));
      tick++;
      update(kk, { map: (tick % 4 === 0) || kk === 0, immediate: kk === 0 });
    }, 60);
  }

  var VIEWS = {
    china: [35, 104, 4], east: [30, 120, 4], world: [20, 60, 2],
    arctic: [75, 20, 3], equator: [6, 105, 3]
  };

  function boot() {
    var D = window.__STOP_DATA;
    if (!D || !window.__STOP_TERRAIN_B64) {
      document.body.insertAdjacentHTML('afterbegin', '<div class="loading">数据未加载，请检查 terrain.js / data.js</div>');
      return;
    }
    M.init(D, M.decodeTerrain(window.__STOP_TERRAIN_B64));

    var minK = null, minV = Infinity;
    for (var i = 0; i <= 100; i++) {
      var key = (1 - 0.01 * i).toFixed(2), v = D.stats[key].land;
      if (v < minV) { minV = v; minK = 1 - 0.01 * i; }
    }
    setTxt('nMinK', Math.round(minK * 100) + '%');
    setTxt('nMinL', (minV / 1e6).toFixed(1) + ' Mm²');

    var rangeEl = document.getElementById('krange');
    if (rangeEl) {
      rangeEl.addEventListener('input', function () { update(parseInt(rangeEl.value, 10) / 100, {}); });
      rangeEl.addEventListener('change', function () { update(parseInt(rangeEl.value, 10) / 100, { immediate: true }); });
    }
    var bb = document.getElementById('btnBrake');
    if (bb) bb.onclick = toggleBrake;
    Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (b) {
      b.onclick = function () {
        Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        var v = VIEWS[b.getAttribute('data-view')];
        if (state.map) { state.map.setCenter(ll(v[0], v[1])); state.map.setZoom(v[2]); }
      };
    });

    update(1, { map: false });          // 先出数字，不依赖底图

    if (typeof TMap === 'undefined') {
      var mf = document.getElementById('mapfail');
      if (mf) mf.style.display = 'block';
      window.__STOP_READY = true;
      return;
    }
    try {
      state.map = new TMap.Map(document.getElementById('tmap'), {
        center: ll(35, 104), zoom: 4, pitch: 0, showControl: true
      });
      state.layer = makeLayer(1, state.map);
      state.marker = new TMap.MultiMarker({
        map: state.map,
        styles: {
          dry: new TMap.MarkerStyle({ width: 22, height: 22, src: svgIcon('#e8b463', '#2a1d08') }),
          wet: new TMap.MarkerStyle({ width: 22, height: 22, src: svgIcon('#3aa0e8', '#07263d') })
        },
        geometries: DATA.cities.map(function (c, i) {
          return { id: 'c' + i, styleId: 'dry', position: ll(c.lat, c.lon), properties: { title: c.name } };
        })
      });
      state.map.on('click', function (evt) {
        if (!evt.latLng) return;
        showPoint(evt.latLng.getLat(), evt.latLng.getLng(), null);
      });
      update(state.k, { map: false });
    } catch (e) {
      var mf2 = document.getElementById('mapfail');
      if (mf2) { mf2.style.display = 'block'; mf2.textContent += '（' + e.message + '）'; }
    }
    window.__STOP_READY = true;
  }

  window.__STOP_boot = boot;
  window.__STOP_update = update;
  window.__STOP_paintTile = paintTile;
  window.__STOP_state = state;
  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot);
})();
