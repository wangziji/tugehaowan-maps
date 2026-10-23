/* 揉皱的城市 · CRUMPLED CITY —— 数学核心
 *
 * 唯一模型：真实步行距离 W 与直线距离 d 之间，是一条带截距的直线
 *     W(d) = rhoInf * d + C
 *   rhoInf —— 渐近揉皱系数（走很远时，每 1 米直线要走的米数）
 *   C      —— 绕行固定成本（米）：不管去多远，都要先付的「出街区税」
 *
 * 由此推出三条可验证的结论：
 *   1. 揉皱系数 rho(d) = W(d)/d = rhoInf + C/d —— 随距离单调下降，越短的路绕得越狠
 *   2. 走 r 米，只能从出发地挪开 D(r) = (r - C)/rhoInf 米（r > C）
 *   3. 体感放大：几何半径 R 的圆，在步行者体感里相当于半径 W(R) 的圆
 */
(function (root) {
  'use strict';

  // ---------- 基础量 ----------
  var R_EARTH = 6371000.0;
  var DEG_M = 111320.0; // 1 度纬度对应的米数（近似，用于局部平面换算）

  function haversine(lat1, lng1, lat2, lng2) {
    var la1 = lat1 * Math.PI / 180, la2 = lat2 * Math.PI / 180;
    var dLa = (lat2 - lat1) * Math.PI / 180, dLo = (lng2 - lng1) * Math.PI / 180;
    var a = Math.sin(dLa / 2) * Math.sin(dLa / 2) +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function num(v, lo, hi, dflt) {
    var x = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(x)) return dflt;
    return Math.max(lo, Math.min(hi, x));
  }

  /** 局部平面投影：以 (lat0,lng0) 为原点，返回米为单位的 x(东) / y(北) */
  function toXY(lat, lng, lat0, lng0) {
    return {
      x: (lng - lng0) * DEG_M * Math.cos(lat0 * Math.PI / 180),
      y: (lat - lat0) * DEG_M
    };
  }

  /** 由方位角（正北为 0，顺时针）与距离求终点经纬度 */
  function offsetLatLng(lat0, lng0, bearingDeg, distM) {
    var b = bearingDeg * Math.PI / 180;
    var dLat = distM * Math.cos(b) / DEG_M;
    var dLng = distM * Math.sin(b) / (DEG_M * Math.cos(lat0 * Math.PI / 180));
    return { lat: lat0 + dLat, lng: lng0 + dLng };
  }

  function polylineLength(pts) {
    var s = 0;
    for (var i = 1; i < pts.length; i++) {
      s += haversine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    }
    return s;
  }

  // ---------- 拟合 ----------
  /**
   * 最小二乘拟合 W = a*d + C。用绝对距离（米）作因变量，残差量纲是米，
   * 比拟合 rho = a + C/d 更稳（后者会把最短距离的噪声放大几百倍）。
   * @returns {{rhoInf:number, C:number, r2:number, n:number, rhoMean:number}}
   */
  function fitCity(routes) {
    var pts = (routes || []).filter(function (r) {
      return isFinite(r.sd) && isFinite(r.wd) && r.sd > 0 && r.wd > 0;
    });
    var n = pts.length;
    if (n === 0) return { rhoInf: 1, C: 0, r2: 0, n: 0, rhoMean: 1 };
    var sx = 0, sy = 0;
    for (var i = 0; i < n; i++) { sx += pts[i].sd; sy += pts[i].wd; }
    var mx = sx / n, my = sy / n;
    var sxx = 0, sxy = 0, syy = 0;
    for (i = 0; i < n; i++) {
      var dx = pts[i].sd - mx, dy = pts[i].wd - my;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    var a = sxx > 0 ? sxy / sxx : 1;
    var c = my - a * mx;
    // 物理约束：rhoInf 必须为正、C 不得为负（绕行不可能为负收益）
    a = Math.max(0.5, Math.min(3.0, a));
    c = Math.max(0, Math.min(5000, c));
    var r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
    var rhoSum = 0;
    for (i = 0; i < n; i++) rhoSum += pts[i].wd / pts[i].sd;
    return { rhoInf: a, C: c, r2: Math.max(0, Math.min(1, r2)), n: n, rhoMean: rhoSum / n };
  }

  // ---------- 模型三问 ----------
  /**
   * 模型的适用下限：实测样本只覆盖 600..3500 m。低于 D_LO 时线性式会算出
   * 「走 0 米直线要 364 米」这种不报错也不 NaN 的荒谬值，因此用一段二次过渡
   * 把 (0,0) 平滑接到衔接点 (D_LO, W(D_LO))，让 d→0 时 rho→1（两点在同一条街上）。
   */
  var D_LO = 600;

  function walkDist(fit, d) {
    d = num(d, 0, 1e7, 0);
    var wLo = fit.rhoInf * D_LO + fit.C;         // 衔接点
    if (d >= D_LO) return fit.rhoInf * d + fit.C;
    if (d <= 0) return 0;
    var K = wLo - D_LO;
    return d + K * (d / D_LO) * (d / D_LO);
  }

  /** 揉皱系数 rho(d) = W(d)/d。d 极小时发散，钳到 [1, 20] 并在 UI 层提示。 */
  function rhoAt(fit, d) {
    d = num(d, 1, 1e7, 1);
    return Math.max(1, Math.min(20, walkDist(fit, d) / d));
  }

  /**
   * 走 r 米，能从出发地挪开多远（直线米）。是 walkDist 的分段反函数：
   * 长段用线性式反解，短段解二次方程。绝不返回负数 —— 负数会被页面
   * 一本正经显示成「你倒退了 300 米」。
   */
  function reachDist(fit, r) {
    r = num(r, 0, 1e7, 0);
    var wLo = fit.rhoInf * D_LO + fit.C;
    if (r <= 0) return 0;
    if (r >= wLo) return (r - fit.C) / fit.rhoInf;
    // 短段：解 K*d²/D_LO² + d - r = 0
    var K = wLo - D_LO;
    if (K <= 0) return r;
    return D_LO * D_LO * (Math.sqrt(1 + 4 * K * r / (D_LO * D_LO)) - 1) / (2 * K);
  }

  /** 直线前进效率的补：走 r 米里，有多少比例是「没换来位移」的 */
  function wastedFrac(fit, r) {
    r = num(r, 1, 1e7, 1);
    var adv = reachDist(fit, r);
    return Math.max(0, Math.min(1, 1 - adv / r));
  }

  /** 体感放大：几何半径 R 的圆，在步行者体感里相当于半径 W(R)，面积放大 (W(R)/R)^2 */
  function sensibleScale(fit, R) {
    R = num(R, 1, 1e7, 1);
    return Math.pow(rhoAt(fit, R), 2);
  }

  /** 走 minutes 分钟（按该城实测速度）能覆盖的直线半径，用模型反解 */
  function walkSpeed(fit, routes) {
    var tot = 0, dur = 0;
    for (var i = 0; i < routes.length; i++) {
      tot += routes[i].wd; dur += routes[i].dur;
    }
    if (dur <= 0) return 4800 / 60; // 兜底 80 m/min
    return tot / dur; // 米/分钟
  }

  // ---------- 玫瑰图 ----------
  /** 取指定距离档上，各方向的揉皱系数。12 个方向，顺时针从正北起。 */
  function rose(city, dist) {
    var out = [];
    var routes = city.routes;
    for (var i = 0; i < routes.length; i++) {
      if (routes[i].d !== dist) continue;
      out.push({ b: routes[i].b, rho: routes[i].wd / routes[i].sd, sd: routes[i].sd, wd: routes[i].wd });
    }
    out.sort(function (a, b) { return a.b - b.b; });
    return out;
  }

  /** 玫瑰图的离散程度：最大值/最小值。反映「往哪个方向走差多少」。 */
  function roseSpread(roseArr) {
    var mx = -Infinity, mn = Infinity;
    for (var i = 0; i < roseArr.length; i++) {
      mx = Math.max(mx, roseArr[i].rho); mn = Math.min(mn, roseArr[i].rho);
    }
    if (!isFinite(mx) || !isFinite(mn) || mn <= 0) return 0;
    return mx / mn;
  }

  // ---------- 等时圈 ----------
  /**
   * 真实步行 T 分钟能到的边界：每个方向各取实测样本做 (dur -> sd) 插值/外推。
   * 返回的不是圆，是被路网揉皱出来的多边形。
   * @returns {Array<{b:number, sd:number, lat:number, lng:number}>}
   */
  function isochrone(city, minutes) {
    var T = num(minutes, 0.5, 240, 10);
    var byDir = {};
    var i;
    for (i = 0; i < city.routes.length; i++) {
      var r = city.routes[i];
      (byDir[r.b] = byDir[r.b] || []).push({ sd: r.sd, dur: r.dur });
    }
    var out = [];
    var keys = Object.keys(byDir).map(Number).sort(function (a, b) { return a - b; });
    for (i = 0; i < keys.length; i++) {
      var s = byDir[keys[i]].slice().sort(function (a, b) { return a.sd - b.sd; });
      var sd;
      if (T <= s[0].dur) {
        // 起点到第一个样本之间按匀速外推（含 0,0）
        sd = s[0].sd * (T / s[0].dur);
      } else if (T >= s[s.length - 1].dur) {
        // 超出最远样本：沿用最外侧一段的斜率线性外推
        var a = s[s.length - 2] || s[0], b = s[s.length - 1];
        var slope = (b.sd - a.sd) / Math.max(1e-6, b.dur - a.dur);
        sd = b.sd + (T - b.dur) * slope;
      } else {
        sd = s[s.length - 1].sd;
        for (var k = 1; k < s.length; k++) {
          if (T <= s[k].dur) {
            var t = (T - s[k - 1].dur) / Math.max(1e-6, s[k].dur - s[k - 1].dur);
            sd = s[k - 1].sd + t * (s[k].sd - s[k - 1].sd);
            break;
          }
        }
      }
      sd = Math.max(0, sd);
      var ll = offsetLatLng(city.lat, city.lng, keys[i], sd);
      out.push({ b: keys[i], sd: sd, lat: ll.lat, lng: ll.lng });
    }
    return out;
  }

  /** 多边形面积（球面近似为局部平面，鞋带公式），单位平方米 */
  function polygonArea(pts) {
    if (!pts || pts.length < 3) return 0;
    var lat0 = pts[0].lat, lng0 = pts[0].lng, s = 0, n = pts.length;
    var xy = pts.map(function (p) { return toXY(p.lat, p.lng, lat0, lng0); });
    for (var i = 0; i < n; i++) {
      var a = xy[i], b = xy[(i + 1) % n];
      s += a.x * b.y - b.x * a.y;
    }
    return Math.abs(s) / 2;
  }

  // ---------- 经验查表（运行时零 API 依赖，点地图现场验算用） ----------
  /**
   * 由 36 条实测样本张成的经验曲面，查「某方位角 + 某直线距离」的实测步行距离。
   * 先在距离方向线性插值，再在方位角方向插值（首尾方位角按 360° 环绕）。
   * @returns {{wd:number, dur:number, bLo:number, bHi:number}}
   */
  function lookup(city, bearingDeg, sd) {
    var b = num(bearingDeg, 0, 360, 0) % 360;
    if (b < 0) b += 360;
    var sdv = num(sd, 0, 1e6, 0);
    var bs = [];
    var seen = {};
    for (var i = 0; i < city.routes.length; i++) {
      var bb = city.routes[i].b;
      if (!seen[bb]) { seen[bb] = 1; bs.push(bb); }
    }
    bs.sort(function (x, y) { return x - y; });

    function at(bb, x) {
      var s = city.routes.filter(function (r) { return r.b === bb; })
        .map(function (r) { return { sd: r.sd, wd: r.wd, dur: r.dur }; })
        .sort(function (p, q) { return p.sd - q.sd; });
      if (x <= s[0].sd) {
        var t0 = s[0].sd > 0 ? x / s[0].sd : 0;
        return { wd: s[0].wd * t0, dur: s[0].dur * t0 };
      }
      var last = s[s.length - 1];
      if (x >= last.sd) {
        var a0 = s[s.length - 2] || s[0];
        var sl = (last.wd - a0.wd) / Math.max(1e-6, last.sd - a0.sd);
        var sl2 = (last.dur - a0.dur) / Math.max(1e-6, last.sd - a0.sd);
        return { wd: last.wd + (x - last.sd) * sl, dur: last.dur + (x - last.sd) * sl2 };
      }
      for (var k = 1; k < s.length; k++) {
        if (x <= s[k].sd) {
          var t = (x - s[k - 1].sd) / Math.max(1e-6, s[k].sd - s[k - 1].sd);
          return {
            wd: s[k - 1].wd + t * (s[k].wd - s[k - 1].wd),
            dur: s[k - 1].dur + t * (s[k].dur - s[k - 1].dur)
          };
        }
      }
      return { wd: last.wd, dur: last.dur };
    }

    var bLo = bs[bs.length - 1], bHi = bs[0];
    for (i = 0; i < bs.length; i++) {
      if (bs[i] <= b) { bLo = bs[i]; bHi = bs[(i + 1) % bs.length]; }
    }
    var span = (bHi - bLo + 360) % 360;
    var t = span > 0 ? (b - bLo) / span : 0;
    var lo = at(bLo, sdv), hi = at(bHi, sdv);
    return {
      wd: lo.wd + t * (hi.wd - lo.wd),
      dur: lo.dur + t * (hi.dur - lo.dur),
      bLo: bLo, bHi: bHi
    };
  }

  /** 找出与给定（方位角，距离）最接近的那条实测样本，用于在地图上高亮 */
  function nearestRoute(city, bearingDeg, sd) {
    var b = num(bearingDeg, 0, 360, 0), s = num(sd, 0, 1e6, 0);
    var best = city.routes[0], bestScore = Infinity;
    for (var i = 0; i < city.routes.length; i++) {
      var r = city.routes[i];
      // 角差标准式，结果已在 [0,180]；不要再拿 180 减它（会把「正对」判成「反向」）
      var db = Math.abs(((r.b - b + 540) % 360) - 180);
      var score = db / 30 + Math.abs(r.sd - s) / 400;
      if (score < bestScore) { bestScore = score; best = r; }
    }
    return best;
  }

  /** 方位角（正北为 0，顺时针） */
  function bearingOf(lat0, lng0, lat1, lng1) {
    var p = toXY(lat1, lng1, lat0, lng0);
    var a = Math.atan2(p.x, p.y) * 180 / Math.PI;
    return (a + 360) % 360;
  }

  // ---------- 城市级汇总 ----------
  function summarize(city) {
    var fit = fitCity(city.routes);
    var byDist = {};
    for (var i = 0; i < city.routes.length; i++) {
      var r = city.routes[i];
      (byDist[r.d] = byDist[r.d] || []).push(r.wd / r.sd);
    }
    var rhoByDist = {};
    Object.keys(byDist).map(Number).sort(function (a, b) { return a - b; }).forEach(function (d) {
      var arr = byDist[d], s = 0;
      for (var j = 0; j < arr.length; j++) s += arr[j];
      rhoByDist[d] = s / arr.length;
    });
    var v = walkSpeed(fit, city.routes);
    return {
      id: city.id, name: city.name, lat: city.lat, lng: city.lng,
      fit: fit, rhoByDist: rhoByDist, speed: v,
      rose1500: rose(city, 1500),
      spread1500: roseSpread(rose(city, 1500))
    };
  }

  var API = {
    R_EARTH: R_EARTH, DEG_M: DEG_M, D_LO: D_LO,
    haversine: haversine, toXY: toXY, offsetLatLng: offsetLatLng,
    polylineLength: polylineLength, num: num,
    fitCity: fitCity, walkDist: walkDist, rhoAt: rhoAt, reachDist: reachDist,
    wastedFrac: wastedFrac, sensibleScale: sensibleScale, walkSpeed: walkSpeed,
    rose: rose, roseSpread: roseSpread, isochrone: isochrone, polygonArea: polygonArea,
    lookup: lookup, nearestRoute: nearestRoute, bearingOf: bearingOf,
    summarize: summarize
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.CRUMPLE = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
