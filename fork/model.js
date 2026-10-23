/* 《岔路 · THE FORK》模型层
 * 命题：你换的那条路，其实还是原来那条。
 * 所有函数纯函数，输入输出明确，不碰 DOM。
 */
(function (root) {
  'use strict';

  var R_EARTH = 6371000;

  function num(v, lo, hi, dflt) {
    var x = Number(v);
    if (!isFinite(x)) return dflt;
    if (typeof lo === 'number' && x < lo) return lo;
    if (typeof hi === 'number' && x > hi) return hi;
    return x;
  }

  function hav(lat1, lng1, lat2, lng2) {
    var p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
    var dLat = p2 - p1, dLng = (lng2 - lng1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function median(arr) {
    if (!arr || !arr.length) return null;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function mean(arr) {
    if (!arr || !arr.length) return null;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  function pct(x) { return Math.round(num(x, 0, 1, 0) * 100); }

  /* ---------- 单条 OD 的派生量 ---------- */

  /* 换路率：某条候选里有多少比例是「新路」 */
  function gapRate(c) { return 1 - num(c.ov, 0, 1, 0); }

  /* 有效换路：10 分钟以内、且至少换掉 30% 的路 */
  function isGood(c) { return c.dt <= 10 && gapRate(c) >= 0.30; }

  /* 最划算的一次真正换路（分钟）；没有则返回 null（定义域声明，不返回负数冒充） */
  function bestSwap(od) {
    var best = null;
    for (var i = 0; i < od.cands.length; i++) {
      var c = od.cands[i];
      if (gapRate(c) < 0.30) continue;
      if (best === null || c.dt < best.dt) best = c;
    }
    if (best === null) return null;
    return { dt: best.dt, gap: gapRate(best), tag: best.tag };
  }

  /* 换路效率：每分钟买到多少「新路」（%/分钟）。dt<=0 时无定义，返回 null */
  function swapEff(od) {
    var b = bestSwap(od);
    if (b === null || b.dt <= 0) return null;
    return b.gap / b.dt;
  }

  /* 结论：堵在这儿，换路还是等 */
  function verdict(od) {
    var m = num(od.M50, 0, 1, 0);
    var b = bestSwap(od);
    var f = num(od.F, 0, 99, 0);
    if (m >= 0.70) {
      return {
        level: 'wait', label: '等',
        why: '这条路 ' + pct(m) + '% 的路段，八种绕法里有半数以上都得走 —— 你换不出去了',
        act: '堵在这儿换路基本是白换，代价最小的那次也要 ' +
          (b === null ? '不可达' : Math.max(0, b.dt) + ' 分钟') + '，而且只换掉 ' +
          (b === null ? '0' : pct(b.gap)) + '% 的路'
      };
    }
    if (m <= 0.20 && b !== null && b.dt <= 10) {
      return {
        level: 'go', label: '换',
        why: '这条路只有 ' + pct(m) + '% 绕不开，全程有 ' + f + ' 个地方能真正岔开',
        act: '最划算的一次换路只要 ' + Math.max(0, b.dt) + ' 分钟，就能换掉 ' + pct(b.gap) + '% 的路'
      };
    }
    return {
      level: 'mid', label: '看代价',
      why: '这条路 ' + pct(m) + '% 绕不开，有 ' + f + ' 个岔口',
      act: b === null
        ? '八种绕法里没有一种能在 10 分钟内换掉三成以上的路 —— 只能等'
        : '换路要付 ' + Math.max(0, b.dt) + ' 分钟，换掉 ' + pct(b.gap) + '% 的路，自己掂量'
    };
  }

  /* ---------- 汇总 ---------- */

  function allOds() {
    var out = [];
    var cs = root.DATA.cities;
    for (var i = 0; i < cs.length; i++) {
      for (var j = 0; j < cs[i].ods.length; j++) {
        out.push({ city: cs[i].name, ci: i, oi: j, od: cs[i].ods[j] });
      }
    }
    return out;
  }

  /* 城市排名：按半垄断度均值降序 */
  function cityRank() {
    var cs = root.DATA.cities, out = [];
    for (var i = 0; i < cs.length; i++) {
      var ms = [], fs = [], bs = [];
      for (var j = 0; j < cs[i].ods.length; j++) {
        ms.push(num(cs[i].ods[j].M50, 0, 1, 0));
        fs.push(num(cs[i].ods[j].F, 0, 99, 0));
        var b = bestSwap(cs[i].ods[j]);
        if (b !== null) bs.push(b.dt);
      }
      out.push({ name: cs[i].name, m50: mean(ms), f: mean(fs),
                 best: bs.length ? median(bs) : null });
    }
    out.sort(function (a, b) { return b.m50 - a.m50; });
    return out;
  }

  /* 对照对：同一座城、同一对端点、方向相反，半垄断度差最大的那一组。
     首屏不比极值（极值会被读成「长途更难绕」），要比自变量几乎相同的对照。 */
  function contrast() {
    var cs = root.DATA.cities, best = null;
    for (var i = 0; i < cs.length; i++) {
      var ods = cs[i].ods;
      for (var a = 0; a < ods.length; a++) {
        for (var b = a + 1; b < ods.length; b++) {
          var oa = ods[a], ob = ods[b];
          /* 同一对端点（起点终点互换）才算对照 */
          var same = hav(oa.fr[0], oa.fr[1], ob.to[0], ob.to[1]) < 1200 &&
            hav(oa.to[0], oa.to[1], ob.fr[0], ob.fr[1]) < 1200;
          if (!same) continue;
          var ma = num(oa.M50, 0, 1, 0), mb = num(ob.M50, 0, 1, 0);
          var ratio = Math.max(ma, mb) / Math.max(Math.min(ma, mb), 0.01);
          if (best === null || ratio > best.ratio) {
            best = { city: cs[i].name, ratio: ratio,
                     hi: ma >= mb ? oa : ob, lo: ma >= mb ? ob : oa };
          }
        }
      }
    }
    return best;
  }

  /* 「换了个寂寞」：几何上几乎完全重合（≥95% 是原来那条），却明显更慢（≥3 分钟） */
  function phantom() {
    var out = [];
    var all = allOds();
    for (var k = 0; k < all.length; k++) {
      var od = all[k].od;
      for (var i = 0; i < od.cands.length; i++) {
        var c = od.cands[i];
        if (c.share >= 0.95 && c.dt >= 3) {
          out.push({ city: all[k].city, od: od.name, share: c.share, dt: c.dt, tag: c.tag });
        }
      }
    }
    out.sort(function (a, b) { return b.dt - a.dt; });
    return out;
  }

  /* 全场统计 */
  function stats() {
    var all = allOds();
    var ms = [], fs = [], bs = [], neg = [];
    for (var k = 0; k < all.length; k++) {
      var od = all[k].od;
      ms.push(num(od.M50, 0, 1, 0));
      fs.push(num(od.F, 0, 99, 0));
      var b = bestSwap(od);
      if (b !== null) bs.push(b.dt);
      if (od.dt_min <= 0) neg.push(all[k].city + '·' + od.name + '(' + od.dt_min + ')');
    }
    var mmin = Math.min.apply(null, ms), mmax = Math.max.apply(null, ms);
    var imin = ms.indexOf(mmin), imax = ms.indexOf(mmax);
    return {
      n_city: root.DATA.cities.length,
      n_od: all.length,
      n_route: all.reduce(function (s, x) { return s + x.od.cands.length + 1; }, 0),
      m50_med: median(ms), m50_min: mmin, m50_max: mmax,
      m50_min_od: all[imin].city + '·' + all[imin].od.name,
      m50_max_od: all[imax].city + '·' + all[imax].od.name,
      f_med: median(fs), f_min: Math.min.apply(null, fs), f_max: Math.max.apply(null, fs),
      best_med: bs.length ? median(bs) : null,
      neg: neg,
      rank: cityRank()
    };
  }

  root.Model = {
    num: num, hav: hav, median: median, mean: mean, pct: pct,
    gapRate: gapRate, isGood: isGood, bestSwap: bestSwap, swapEff: swapEff,
    verdict: verdict, allOds: allOds, cityRank: cityRank,
    contrast: contrast, phantom: phantom, stats: stats
  };
})(typeof window !== 'undefined' ? window : global);
