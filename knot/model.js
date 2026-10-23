/* 《绳结 · THE KNOT》模型层 —— 纯函数，Node 与浏览器共用
   数据 schema: {cities:[{city, sets:[{anchor, pts:[5×{name,kind,lat,lng}], legs:{"i-j":{d,t,p}}}]}]}
   d = 米, t = 分钟, p = 腾讯压缩 polyline */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KnotModel = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var R = 6371000;

  function num(v, lo, hi, dft) {
    var x = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(x)) return dft;
    if (typeof lo === 'number' && x < lo) return lo;
    if (typeof hi === 'number' && x > hi) return hi;
    return x;
  }

  /* 腾讯 polyline: [lat0(度), lng0(度), dlat(1e-6度), dlng(1e-6度), ...] */
  function decode(pl) {
    if (!Array.isArray(pl) || pl.length < 4) return [];
    var out = [];
    var lat = num(pl[0], -90, 90, 0), lng = num(pl[1], -180, 180, 0);
    out.push([lat, lng]);
    for (var i = 2; i + 1 < pl.length; i += 2) {
      lat += pl[i] / 1e6;
      lng += pl[i + 1] / 1e6;
      out.push([lat, lng]);
    }
    return out;
  }

  function haversine(a1, o1, a2, o2) {
    var p1 = a1 * Math.PI / 180, p2 = a2 * Math.PI / 180;
    var dp = p2 - p1, dl = (o2 - o1) * Math.PI / 180;
    var h = Math.sin(dp / 2) * Math.sin(dp / 2) +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function permute(arr) {
    if (arr.length <= 1) return [arr.slice()];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var rest = arr.slice(0, i).concat(arr.slice(i + 1));
      var sub = permute(rest);
      for (var j = 0; j < sub.length; j++) out.push([arr[i]].concat(sub[j]));
    }
    return out;
  }

  /* 段代价：metric='time' 取分钟，'dist' 取米；缺失段返回 Infinity */
  function leg(legs, i, j, metric) {
    var k = i + '-' + j;
    var e = legs ? legs[k] : null;
    if (!e) return Infinity;
    return metric === 'dist' ? num(e.d, 0, 1e7, Infinity) : num(e.t, 0, 1e4, Infinity);
  }

  /* 一条顺序的总代价。order 为待办下标序列，closed=true 时最后回起点 */
  function pathCost(legs, order, start, closed, metric) {
    var c = 0, cur = start;
    for (var i = 0; i < order.length; i++) {
      var v = leg(legs, cur, order[i], metric);
      if (!isFinite(v)) return Infinity;
      c += v;
      cur = order[i];
    }
    if (closed) {
      var back = leg(legs, cur, start, metric);
      if (!isFinite(back)) return Infinity;
      c += back;
    }
    return c;
  }

  /* 就近贪心：每一步走到当前未访问的最近点 */
  function greedyOrder(legs, start, ids, metric) {
    var left = ids.slice(), cur = start, out = [];
    var guard = 0;
    while (left.length && guard++ < 64) {
      var bi = 0, bv = Infinity;
      for (var i = 0; i < left.length; i++) {
        var v = leg(legs, cur, left[i], metric);
        if (v < bv) { bv = v; bi = i; }
      }
      if (!isFinite(bv)) break;
      out.push(left[bi]);
      cur = left[bi];
      left.splice(bi, 1);
    }
    return out;
  }

  /* 由近到远 / 由远到近（按相对起点距离排序） */
  function radialOrder(legs, start, ids, metric, desc) {
    var arr = ids.slice();
    arr.sort(function (a, b) {
      var va = leg(legs, start, a, metric), vb = leg(legs, start, b, metric);
      return desc ? vb - va : va - vb;
    });
    return arr;
  }

  function rankOf(sorted, order) {
    for (var i = 0; i < sorted.length; i++) {
      if (sorted[i].order.join(',') === order.join(',')) return i;
    }
    return -1;
  }

  /* 单个任务集的完整分析
     sel: 选中的待办下标数组（相对 pts 的下标，不含起点）
     closed: 是否回起点
     metric: 'time' | 'dist' */
  function analyze(set, sel, closed, metric) {
    metric = metric || 'time';
    var start = 0;
    var ids = sel.slice();
    var perms = permute(ids);
    var rows = [];
    for (var i = 0; i < perms.length; i++) {
      var c = pathCost(set.legs, perms[i], start, closed, metric);
      rows.push({ order: perms[i], cost: c });
    }
    rows.sort(function (a, b) { return a.cost - b.cost; });
    var best = rows[0], worst = rows[rows.length - 1];
    var greedy = greedyOrder(set.legs, start, ids, metric);
    var nearFirst = radialOrder(set.legs, start, ids, metric, false);
    var farFirst = radialOrder(set.legs, start, ids, metric, true);
    var gCost = pathCost(set.legs, greedy, start, closed, metric);
    var nfCost = pathCost(set.legs, nearFirst, start, closed, metric);
    var ffCost = pathCost(set.legs, farFirst, start, closed, metric);
    var sum = 0, finiteN = 0;
    for (var j = 0; j < rows.length; j++) if (isFinite(rows[j].cost)) { sum += rows[j].cost; finiteN++; }
    var mean = finiteN ? sum / finiteN : Infinity;

    /* 最优顺序里「离起点最远的那件事」排在第几位 */
    var farId = ids[0], fv = -1;
    for (var k = 0; k < ids.length; k++) {
      var v = leg(set.legs, start, ids[k], metric);
      if (v > fv) { fv = v; farId = ids[k]; }
    }
    var farPos = best.order.indexOf(farId);   // 0-based
    var nearId = ids[0]; var nv = Infinity;
    for (var k2 = 0; k2 < ids.length; k2++) {
      var v2 = leg(set.legs, start, ids[k2], metric);
      if (v2 < nv) { nv = v2; nearId = ids[k2]; }
    }
    var nearPos = best.order.indexOf(nearId);

    return {
      rows: rows,
      best: best, worst: worst,
      greedy: { order: greedy, cost: gCost },
      nearFirst: { order: nearFirst, cost: nfCost },
      farFirst: { order: farFirst, cost: ffCost },
      mean: mean,
      spread: best.cost > 0 ? (worst.cost - best.cost) / best.cost : 0,
      greedyGap: best.cost > 0 ? (gCost - best.cost) / best.cost : 0,
      nfGap: best.cost > 0 ? (nfCost - best.cost) / best.cost : 0,
      ffGap: best.cost > 0 ? (ffCost - best.cost) / best.cost : 0,
      meanGap: best.cost > 0 ? (mean - best.cost) / best.cost : 0,
      greedyRank: rankOf(rows, greedy),
      greedyIsBest: greedy.join(',') === best.order.join(','),
      farPos: farPos, nearPos: nearPos,
      farLast: farPos === ids.length - 1,
      farFirstPos: farPos === 0
    };
  }

  /* 一条顺序的几何：把各段 polyline 首尾相接 */
  function orderGeom(set, order, start, closed) {
    var cur = start, pts = [];
    for (var i = 0; i < order.length; i++) {
      var e = set.legs[cur + '-' + order[i]];
      var seg = e ? decode(e.p) : [];
      for (var j = 0; j < seg.length; j++) {
        if (!pts.length || pts[pts.length - 1][0] !== seg[j][0] || pts[pts.length - 1][1] !== seg[j][1]) {
          pts.push(seg[j]);
        }
      }
      cur = order[i];
    }
    if (closed) {
      var eb = set.legs[cur + '-' + start];
      var sb = eb ? decode(eb.p) : [];
      for (var m = 0; m < sb.length; m++) {
        if (!pts.length || pts[pts.length - 1][0] !== sb[m][0] || pts[pts.length - 1][1] !== sb[m][1]) {
          pts.push(sb[m]);
        }
      }
    }
    return pts;
  }

  /* 紧凑 schema（前端 data.js）-> 分析用 schema
     pts: [name, kind, lat, lng] ; legs: {'i-j': [d, t, p]} */
  function normalizeSet(cs) {
    var pts = [];
    for (var i = 0; i < cs.pts.length; i++) {
      pts.push({ name: cs.pts[i][0], kind: cs.pts[i][1], lat: cs.pts[i][2], lng: cs.pts[i][3] });
    }
    var legs = {};
    var keys = Object.keys(cs.legs || {});
    for (var j = 0; j < keys.length; j++) {
      var v = cs.legs[keys[j]];
      legs[keys[j]] = { d: v[0], t: v[1], p: v[2] };
    }
    return { anchor: cs.anchor, pts: pts, legs: legs };
  }

  /* 折线自交（打结）次数：不相邻线段的真相交数 */
  function segCross(a, b, c, d) {
    var s1 = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    var s2 = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]);
    var s3 = (d[0] - c[0]) * (a[1] - c[1]) - (d[1] - c[1]) * (a[0] - c[0]);
    var s4 = (d[0] - c[0]) * (b[1] - c[1]) - (d[1] - c[1]) * (b[0] - c[0]);
    return ((s1 > 0) !== (s2 > 0)) && ((s3 > 0) !== (s4 > 0));
  }

  function knotCount(set, order, start, closed) {
    var idx = [start].concat(order);
    if (closed) idx.push(start);
    var q = [];
    for (var i = 0; i < idx.length; i++) q.push([set.pts[idx[i]].lng, set.pts[idx[i]].lat]);
    var n = 0;
    for (var a = 0; a + 1 < q.length; a++) {
      for (var b = a + 2; b + 1 < q.length; b++) {
        if (a === 0 && b + 1 === q.length - 1 && closed) continue; // 首尾段相邻
        if (segCross(q[a], q[a + 1], q[b], q[b + 1])) n++;
      }
    }
    return n;
  }

  return {
    num: num, decode: decode, haversine: haversine, permute: permute,
    leg: leg, pathCost: pathCost, greedyOrder: greedyOrder, radialOrder: radialOrder,
    analyze: analyze, orderGeom: orderGeom, rankOf: rankOf,
    normalizeSet: normalizeSet, knotCount: knotCount, segCross: segCross
  };
});
