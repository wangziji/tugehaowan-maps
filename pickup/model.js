/* 上车点博弈 · 模型层
   数据口径：walking / driving 的 duration 单位 = 分钟，distance 单位 = 米（腾讯位置服务实测）。
   门到门 = 你从站中心走到该出口 + 从该出口开车到目的地。 */
(function (root) {
  'use strict';

  var R = 6371.0088;

  function num(v, lo, hi, dft) {
    var x = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(x)) return dft;
    if (typeof lo === 'number' && x < lo) return lo;
    if (typeof hi === 'number' && x > hi) return hi;
    return x;
  }

  /* 两点球面距离（米） */
  function hv(lat1, lng1, lat2, lng2) {
    var la1 = lat1 * Math.PI / 180, la2 = lat2 * Math.PI / 180;
    var dLa = (lat2 - lat1) * Math.PI / 180, dLo = (lng2 - lng1) * Math.PI / 180;
    var a = Math.sin(dLa / 2) * Math.sin(dLa / 2) +
      Math.cos(la1) * Math.cos(la2) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a))) * 1000;
  }

  /* 方位角（度，0=正北，顺时针） */
  function bear(lat1, lng1, lat2, lng2) {
    var la1 = lat1 * Math.PI / 180, la2 = lat2 * Math.PI / 180;
    var dLo = (lng2 - lng1) * Math.PI / 180;
    var y = Math.sin(dLo) * Math.cos(la2);
    var x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLo);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  /* 夹角：出口相对站中心的方位 与 站中心到目的地方位 的差，取 0..180 */
  function angleDelta(a, b) {
    var d = Math.abs(((a - b + 180) % 360 + 360) % 360 - 180);
    return d;
  }

  function pearson(xs, ys) {
    var n = xs.length;
    if (n < 3) return 0;
    var mx = 0, my = 0, i;
    for (i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    var sxy = 0, sxx = 0, syy = 0;
    for (i = 0; i < n; i++) {
      var dx = xs[i] - mx, dy = ys[i] - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    if (sxx <= 0 || syy <= 0) return 0;
    return sxy / Math.sqrt(sxx * syy);
  }

  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (p, q) { return p - q; });
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function quantile(arr, q) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (p, q) { return p - q; });
    var i = Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))));
    return a[i];
  }

  var DEF = { walkSpeed: 80, useMeasuredWalk: true };

  function params(o) {
    o = o || {};
    return {
      walkSpeed: num(o.walkSpeed, 20, 200, DEF.walkSpeed),
      useMeasuredWalk: o.useMeasuredWalk === undefined ? DEF.useMeasuredWalk : !!o.useMeasuredWalk
    };
  }

  /* 展开成 (城市, 站, 目的地) 组合；每个组合带若干出口候选 */
  function combos(data) {
    var out = [];
    var cityIds = Object.keys(data.cities);
    cityIds.forEach(function (cid) {
      var c = data.cities[cid];
      c.stations.forEach(function (s) {
        c.dests.forEach(function (dst) {
          var exits = [];
          s.exits.forEach(function (e) {
            var dr = e.drive && e.drive[dst.key];
            if (!e.walk || !dr) return;
            var straightToDest = hv(e.lat, e.lng, dst.lat, dst.lng);
            exits.push({
              id: s.name + '-' + e.name,
              name: e.name,
              lat: e.lat, lng: e.lng,
              walkDist: e.walk.dist,
              walkDur: e.walk.dur,
              driveDist: dr.dist,
              driveDur: dr.dur,
              exitToCenter: hv(e.lat, e.lng, s.center.lat, s.center.lng),
              straightToDest: straightToDest,
              theta: angleDelta(bear(s.center.lat, s.center.lng, e.lat, e.lng),
                bear(s.center.lat, s.center.lng, dst.lat, dst.lng))
            });
          });
          if (exits.length >= 3) {
            out.push({
              cityId: cid, city: c.name, station: s.name,
              destKey: dst.key, dest: dst.name,
              center: s.center, destLat: dst.lat, destLng: dst.lng,
              legStraight: hv(s.center.lat, s.center.lng, dst.lat, dst.lng),
              exits: exits
            });
          }
        });
      });
    });
    return out;
  }

  /* 单个组合的评价：每个出口的步行/车行/门到门，以及谁最快、谁最近、谁最朝向 */
  function evaluate(cb, p) {
    p = params(p);
    var list = cb.exits.map(function (e) {
      /* 实测步行时长在 12–31 m 的极短距离上会被接口取整成 0 分钟；
         这类样本显式回退到「距离 ÷ 步行速度」，并打上 walkSrc 标记，不静默处理。 */
      var walkMin, walkSrc;
      if (p.useMeasuredWalk && num(e.walkDur, 0, 120, 0) > 0) {
        walkMin = num(e.walkDur, 0, 120, 0);
        walkSrc = 'measured';
      } else {
        walkMin = num(e.walkDist, 0, 20000, 0) / p.walkSpeed;
        walkSrc = 'fallback';
      }
      var driveMin = num(e.driveDur, 0, 600, 0);
      return {
        id: e.id, name: e.name, lat: e.lat, lng: e.lng,
        walkMin: walkMin, walkSrc: walkSrc, driveMin: driveMin,
        totalMin: walkMin + driveMin,
        walkDist: e.walkDist, driveDist: e.driveDist,
        theta: e.theta, straightToDest: e.straightToDest,
        exitToCenter: e.exitToCenter
      };
    });
    if (!list.length) return { exits: [], best: null, nearestDist: null, nearestTime: null, facing: null };
    var baseDrive = Infinity, baseStraight = Infinity;
    list.forEach(function (x) {
      if (x.driveMin < baseDrive) baseDrive = x.driveMin;
      if (x.straightToDest < baseStraight) baseStraight = x.straightToDest;
    });
    list.forEach(function (x) {
      x.extraMin = x.driveMin - baseDrive;          // 车侧绕行代价
      x.straightDelta = x.straightToDest - baseStraight;
    });
    var best = list[0], nearD = list[0], nearT = list[0], face = list[0];
    list.forEach(function (x) {
      if (x.totalMin < best.totalMin) best = x;
      if (x.walkDist < nearD.walkDist) nearD = x;
      if (x.walkMin < nearT.walkMin) nearT = x;
      if (x.theta < face.theta) face = x;
    });
    var fastestDrive = list[0];
    list.forEach(function (x) { if (x.driveMin < fastestDrive.driveMin) fastestDrive = x; });
    var driveGap = Math.max.apply(null, list.map(function (x) { return x.driveMin; })) -
      Math.min.apply(null, list.map(function (x) { return x.driveMin; }));
    return {
      exits: list, best: best, nearestDist: nearD, nearestTime: nearT,
      facing: face, fastestDrive: fastestDrive, driveGap: driveGap,
      worstExtra: Math.max.apply(null, list.map(function (x) { return x.extraMin; }))
    };
  }

  /* 全局汇总指标 */
  function summarize(data, p) {
    p = params(p);
    var cbs = combos(data);
    var evs = cbs.map(function (cb) { return evaluate(cb, p); });
    var n = cbs.length;

    var hitDist = 0, hitTime = 0, hitFace = 0, baseRandom = 0;
    var gaps = [], extras = [];
    var theta = [], extraAll = [], straightDelta = [], legLen = [];
    var tradeWalk = [], tradeMin = [];

    for (var i = 0; i < n; i++) {
      var cb = cbs[i], ev = evs[i];
      if (ev.nearestDist.id === ev.fastestDrive.id) hitDist++;
      if (ev.nearestTime.id === ev.fastestDrive.id) hitTime++;
      if (ev.facing.id === ev.fastestDrive.id) hitFace++;
      baseRandom += 1 / cb.exits.length;
      gaps.push(ev.driveGap);
      ev.exits.forEach(function (x) {
        extras.push(x.extraMin);
        theta.push(x.theta);
        extraAll.push(x.extraMin);
        straightDelta.push(x.straightDelta);
        legLen.push(cb.legStraight);
      });
      if (ev.nearestDist.id !== ev.fastestDrive.id) {
        tradeWalk.push(ev.fastestDrive.walkDist - ev.nearestDist.walkDist);
        tradeMin.push(ev.nearestDist.driveMin - ev.fastestDrive.driveMin);
      }
    }

    // 翻转：同一站换目的地，车侧最快口是否变了
    var byStation = {};
    cbs.forEach(function (cb, i) {
      var k = cb.city + '|' + cb.station;
      byStation[k] = byStation[k] || {};
      byStation[k][cb.destKey] = evs[i].fastestDrive.id;
    });
    var flip = 0, flipTot = 0;
    Object.keys(byStation).forEach(function (k) {
      var keys = Object.keys(byStation[k]);
      for (var a = 0; a < keys.length; a++)
        for (var b = a + 1; b < keys.length; b++) {
          flipTot++;
          if (byStation[k][keys[a]] !== byStation[k][keys[b]]) flip++;
        }
    });

    var shortEx = [], longEx = [];
    for (var j = 0; j < legLen.length; j++) {
      (legLen[j] < 8000 ? shortEx : longEx).push(extraAll[j]);
    }
    var mean = function (a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : 0; };

    return {
      nCombo: n,
      nExit: extras.length,
      hitDistRate: n ? hitDist / n : 0,
      hitTimeRate: n ? hitTime / n : 0,
      hitFaceRate: n ? hitFace / n : 0,
      randomBase: n ? baseRandom / n : 0,
      medianGap: median(gaps),
      p90Gap: quantile(gaps, 0.9),
      maxGap: gaps.length ? Math.max.apply(null, gaps) : 0,
      meanExtra: mean(extras),
      flipRate: flipTot ? flip / flipTot : 0,
      rTheta: pearson(theta, extraAll),
      rControl: pearson(theta, straightDelta),
      rLeg: pearson(legLen, extraAll),
      shortExtra: mean(shortEx),
      longExtra: mean(longEx),
      tradeWalkMed: median(tradeWalk),
      tradeMinMed: median(tradeMin)
    };
  }

  /* 蒙特卡洛随机基线：随手乱挑一个口命中车侧最优的概率 */
  function randomBase(data, seed, iters) {
    var cbs = combos(data);
    var s = seed || 7;
    var rnd = function () { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    var hit = 0, tot = 0;
    iters = iters || 200;
    cbs.forEach(function (cb) {
      var ev = evaluate(cb);
      for (var k = 0; k < iters; k++) {
        tot++;
        if (cb.exits[Math.floor(rnd() * cb.exits.length) % cb.exits.length].name === ev.fastestDrive.name) hit++;
      }
    });
    return tot ? hit / tot : 0;
  }

  /* 按 Web Mercator 自己解 zoom（本版 fitBounds 只挪中心、不改 zoom） */
  function mercY(lat) {
    var p = Math.max(-85, Math.min(85, num(lat, -90, 90, 0)));
    return Math.log(Math.tan(Math.PI / 4 + p * Math.PI / 360));
  }
  function fitZoom(bounds, w, h, pad) {
    w = num(w, 1, 100000, 600);
    h = num(h, 1, 100000, 400);
    pad = num(pad, 0.1, 1, 0.72);
    var dx = Math.abs(num(bounds.maxLng, -180, 180, 0) - num(bounds.minLng, -180, 180, 0)) / 360;
    var dy = Math.abs(mercY(bounds.maxLat) - mercY(bounds.minLat)) / (2 * Math.PI);
    if (dx <= 0 && dy <= 0) return 16;
    var zx = dx > 0 ? Math.log(w * pad / (256 * dx)) / Math.LN2 : Infinity;
    var zy = dy > 0 ? Math.log(h * pad / (256 * dy)) / Math.LN2 : Infinity;
    var z = Math.min(zx, zy);
    if (!isFinite(z)) z = 16;
    return Math.max(13, Math.min(18, Math.floor(z)));
  }

  root.PICKUP = {
    hv: hv, bear: bear, angleDelta: angleDelta, pearson: pearson,
    median: median, quantile: quantile, num: num, mercY: mercY, fitZoom: fitZoom,
    combos: combos, evaluate: evaluate, summarize: summarize,
    randomBase: randomBase, params: params, DEF: DEF
  };
})(typeof window !== 'undefined' ? window : global);
