/* 停转之日 · 物理模型
 *
 * 有效势 U = V(r,φ) − ½ω²r²cos²φ，海面是 U 的等势面。
 * 等势面扁率（一阶）：f = ³⁄₂·J2 + ½·m ，m = ω²a³/(GM)
 * 令 ω′ = kω（k=1 今天，k=0 停转），固体地球形状冻结，
 * 则新海面扁率 f_s(k) = ³⁄₂·J2 + ½·m_eff·k²，
 * m_eff 取 2(f − 1.5·J2)，使 k=1 时 f_s 严格等于 WGS84 扁率（海面 ≡ 大地水准面）。
 *
 * 「海面相对当前地表的高度」：D(φ,k) = δ(k) + A(k)·sin²φ ，A(k) = a·½m_eff·(1−k²)
 * δ(k) 由水量守恒二分求解：Σ_{h<D}(D−h)·ΔA = V_ocean
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.StopSpin = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var R_MEAN = 6371.0088;      // km
  var DEG = Math.PI / 180;
  var A_EQ = 6378.137;
  var F_WGS = 1 / 298.257223563;
  var J2 = 1.08262668e-3;
  // 与 Python model.py 完全同一套常数
  var M_EFF = 2 * (F_WGS - 1.5 * J2);
  var A_COEF_KM = A_EQ * 0.5 * M_EFF;        // ≈ 11.027 km

  var S = null;    // 内部状态

  function decodeTerrain(b64) {
    var bin = (typeof atob === 'function')
      ? atob(b64)
      : Buffer.from(b64, 'base64').toString('binary');
    var n = bin.length / 2;
    var out = new Int16Array(n);
    for (var i = 0; i < n; i++) {
      var lo = bin.charCodeAt(i * 2);
      var hi = bin.charCodeAt(i * 2 + 1);
      var v = lo | (hi << 8);          // 小端
      out[i] = v;
    }
    return out;
  }

  /** lat 行号 i → 该行中心纬度（行 0 = 南纬 89.75°，行 nlat-1 = 北纬 89.75°） */
  function latOfRow(i) { return -90 + S.step * (i + 0.5); }
  function rowOfLat(lat) {
    var i = Math.floor((lat + 90) / S.step);
    return Math.max(0, Math.min(S.nlat - 1, i));
  }
  function colOfLon(lon) {
    var j = Math.floor((lon + 180) / S.step);
    return ((j % S.nlon) + S.nlon) % S.nlon;
  }

  /** 第 i 行的球面积（km²），按纬度带精确积分 */
  var _areaCache = null;
  function rowArea(i) {
    if (!_areaCache) {
      _areaCache = new Float64Array(S.nlat);
      for (var r = 0; r < S.nlat; r++) {
        var lc = latOfRow(r);
        _areaCache[r] = R_MEAN * R_MEAN * (S.step * DEG) *
          (Math.sin((lc + S.step / 2) * DEG) - Math.sin((lc - S.step / 2) * DEG));
      }
    }
    return _areaCache[i];
  }

  /** δ(k)：由 Python 预解的 0.01 步长表线性插值 */
  function deltaAt(k) {
    var t = (1 - Math.max(0, Math.min(1, k))) * 100;
    var i0 = Math.floor(t);
    if (i0 >= 100) return S.deltaArr[100];
    var fr = t - i0;
    return S.deltaArr[i0] * (1 - fr) + S.deltaArr[i0 + 1] * fr;
  }

  /** 海面相对「当前地表」的高度，单位米；正 = 涨水，负 = 落水 */
  function seaLevelM(latDeg, k) {
    var A = A_COEF_KM * (1 - k * k) * 1000;      // 米
    var s = Math.sin(latDeg * DEG);
    return deltaAt(k) * 1000 + A * s * s;
  }

  /** 采样高程（米）；bilinear=true 时双线性插值 */
  function elevAt(lat, lon, bilinear) {
    if (!bilinear) return S.terrain[rowOfLat(lat) * S.nlon + colOfLon(lon)];
    var fi = (lat + 90) / S.step - 0.5;
    var fj = (lon + 180) / S.step - 0.5;
    var i0 = Math.floor(fi), j0 = Math.floor(fj);
    var ti = fi - i0, tj = fj - j0;
    function g(i, j) {
      i = Math.max(0, Math.min(S.nlat - 1, i));
      j = ((j % S.nlon) + S.nlon) % S.nlon;
      return S.terrain[i * S.nlon + j];
    }
    return (g(i0, j0) * (1 - ti) + g(i0 + 1, j0) * ti) * (1 - tj) +
           (g(i0, j0 + 1) * (1 - ti) + g(i0 + 1, j0 + 1) * ti) * tj;
  }

  /** 单点在给定 k 下的状态 */
  function statusAt(lat, lon, k) {
    var h = elevAt(lat, lon, true);
    var D = seaLevelM(lat, k);
    var sub = h < D;
    return {
      elevM: h, seaM: D, sub: sub,
      depthM: sub ? (D - h) : 0,          // 淹没时的水深
      altM: sub ? 0 : (h - D)             // 未淹没时相对新海平面的海拔
    };
  }

  /** 全格统计：陆地/海洋面积、水量、幸存/新生/淹没、陆地重心纬度 */
  function scanStats(k) {
    var land = 0, landPos = 0, ocean = 0, vol = 0, survive = 0, newborn = 0, drowned = 0, wsum = 0;
    var seaM = new Float64Array(S.nlat);
    for (var i = 0; i < S.nlat; i++) seaM[i] = seaLevelM(latOfRow(i), k) / 1000;  // km
    for (var r = 0; r < S.nlat; r++) {
      var A = rowArea(r), D = seaM[r];
      var base = r * S.nlon;
      for (var c = 0; c < S.nlon; c++) {
        var h = S.terrain[base + c] / 1000;   // km
        if (h > 0) landPos += A;
        if (h < D) { ocean += A; vol += (D - h) * A; if (h > 0) drowned += A; }
        else {
          land += A;
          if (h > 0) survive += A; else newborn += A;
          wsum += A * Math.abs(latOfRow(r));
        }
      }
    }
    return {
      land: land, landPos: landPos, ocean: ocean, vol: vol,
      survive: survive, newborn: newborn, drowned: drowned,
      centroid: land > 0 ? wsum / land : 0
    };
  }

  /** 沿一条经线的地表 / 海面剖面 */
  function profileAt(lon, k, stepDeg) {
    var out = [];
    var st = stepDeg || 2;
    var j = colOfLon(lon);
    for (var lat = -90; lat <= 90.0001; lat += st) {
      var i = rowOfLat(lat);
      out.push({ lat: lat, elevM: S.terrain[i * S.nlon + j], seaM: seaLevelM(lat, k) });
    }
    return out;
  }

  function init(data, terrainArr) {
    S = {
      nlat: data.nlat, nlon: data.nlon, step: data.step,
      terrain: terrainArr || decodeTerrain(data.terrain || ''),
      deltaArr: new Float64Array(101)
    };
    for (var i = 0; i <= 100; i++) {
      var key = (1 - 0.01 * i).toFixed(2);
      var v = data.deltas[key];
      if (v === undefined) throw new Error('缺少 delta[' + key + ']');
      S.deltaArr[i] = v;
    }
    return api;
  }

  var api = {
    R_MEAN: R_MEAN, A_COEF_KM: A_COEF_KM, J2: J2, F_WGS: F_WGS, A_EQ: A_EQ,
    M_EFF: M_EFF,
    init: init,
    decodeTerrain: decodeTerrain,
    latOfRow: latOfRow, rowOfLat: rowOfLat, colOfLon: colOfLon,
    rowArea: rowArea, deltaAt: deltaAt, seaLevelM: seaLevelM,
    elevAt: elevAt, statusAt: statusAt, scanStats: scanStats, profileAt: profileAt,
    state: function () { return S; }
  };
  return api;
});
