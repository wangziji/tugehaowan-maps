/* 《岔路 · THE FORF》交互层
 * 依赖：TMap GL（map.qq.com/api/gljs）、data.js（window.DATA）、model.js（window.Model）
 * 自启动：DOM 已 complete 直接跑，否则挂 load —— 不许只挂函数不调用。
 */
(function () {
  'use strict';

  var D = window.DATA, M = window.Model;
  var state = { ci: 0, oi: 0, cand: true, mono: true, fork: true, hi: -1 };
  var map = null, layers = null, ready = false;
  var CAND_COLOR = '#9db8e0';

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt !== undefined) e.textContent = txt;
    return e;
  }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

  /* ---------- 自启动 ---------- */
  function boot() {
    try {
      buildControls();
      initMap();
      render();
      ready = true;
      if (window.__fork_booted) window.__fork_booted();
    } catch (e) {
      showErr('初始化失败：' + (e && e.message ? e.message : e));
      throw e;
    }
  }
  function autostart() {
    if (document.readyState === 'complete' || document.readyState === 'interactive') boot();
    else window.addEventListener('load', boot);
  }

  function showErr(msg) {
    var e = $('err');
    if (!e) return;
    e.style.display = 'block';
    e.textContent = String(msg);
  }

  /* ---------- 控件（监听器只挂一次，容器重建不重复绑） ---------- */
  var _bound = false;
  function buildControls() {
    var cc = $('cityChips');
    cc.innerHTML = '';
    D.cities.forEach(function (c, i) {
      var b = el('button', 'chip' + (i === state.ci ? ' on' : ''), c.name);
      b.setAttribute('data-i', String(i));
      b.setAttribute('data-role', 'city');
      cc.appendChild(b);
    });
    buildOdChips();

    if (!_bound) {
      $('cityChips').addEventListener('click', function (ev) {
        var t = ev.target.closest ? ev.target.closest('[data-role=city]') : null;
        if (!t) return;
        state.ci = Number(t.getAttribute('data-i'));
        state.oi = 0; state.hi = -1;
        buildControls(); render();
      });
      $('odChips').addEventListener('click', function (ev) {
        var t = ev.target.closest ? ev.target.closest('[data-role=od]') : null;
        if (!t) return;
        state.oi = Number(t.getAttribute('data-i'));
        state.hi = -1;
        buildOdChips(); render();
      });
      $('list').addEventListener('click', function (ev) {
        var t = ev.target.closest ? ev.target.closest('[data-role=cand]') : null;
        if (!t) return;
        var k = Number(t.getAttribute('data-i'));
        state.hi = (state.hi === k) ? -1 : k;
        render();
      });
      ['tgCand', 'tgMono', 'tgFork'].forEach(function (id) {
        $(id).addEventListener('change', function () {
          state.cand = $('tgCand').checked;
          state.mono = $('tgMono').checked;
          state.fork = $('tgFork').checked;
          render();
        });
      });
      _bound = true;
    }
  }

  function buildOdChips() {
    var oc = $('odChips');
    oc.innerHTML = '';
    D.cities[state.ci].ods.forEach(function (o, j) {
      var b = el('button', 'chip' + (j === state.oi ? ' on' : ''), o.name);
      b.setAttribute('data-i', String(j));
      b.setAttribute('data-role', 'od');
      oc.appendChild(b);
    });
  }

  function cur() { return D.cities[state.ci].ods[state.oi]; }

  /* ---------- 地图 ---------- */
  function LL(p) { return new window.TMap.LatLng(p[0], p[1]); }
  function paths(pts) { return pts.map(LL); }

  function svgIcon(fill, ring, label) {
    var s = '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28">' +
      '<circle cx="14" cy="14" r="9" fill="' + fill + '" stroke="' + ring + '" stroke-width="3"/>' +
      (label ? '<text x="14" y="18.5" font-size="11" font-family="sans-serif" font-weight="700" ' +
        'text-anchor="middle" fill="#ffffff">' + label + '</text>' : '') + '</svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
  }

  function initMap() {
    if (typeof window.TMap === 'undefined') {
      showErr('地图 SDK 没加载出来，页面上的数字仍然可用。');
      return;
    }
    var c = D.cities[state.ci];
    map = new window.TMap.Map($('map'), {
      center: new window.TMap.LatLng(c.center[0], c.center[1]),
      zoom: 11, pitch: 0, showControl: false
    });
    /* 图层按创建顺序叠（后建在上）：绕法 → 基准 → 绕不开段 → 岔口 → 起终点 */
    layers = {};
    layers.cand = new window.TMap.MultiPolyline({
      map: map,
      styles: {
        c: new window.TMap.PolylineStyle({ color: CAND_COLOR, width: 4, borderWidth: 0, lineCap: 'round' }),
        h: new window.TMap.PolylineStyle({ color: '#1f6feb', width: 7, borderWidth: 0, lineCap: 'round' })
      },
      geometries: []
    });
    layers.base = new window.TMap.MultiPolyline({
      map: map,
      styles: { b: new window.TMap.PolylineStyle({ color: '#4a5464', width: 6, borderWidth: 0, lineCap: 'round' }) },
      geometries: []
    });
    layers.mono = new window.TMap.MultiPolyline({
      map: map,
      styles: { m: new window.TMap.PolylineStyle({ color: '#c0392b', width: 9, borderWidth: 0, lineCap: 'round' }) },
      geometries: []
    });
    layers.fork = new window.TMap.MultiMarker({
      map: map,
      styles: { f: new window.TMap.MarkerStyle({ width: 26, height: 26, src: svgIcon('#f08b24', '#ffffff', ''), anchor: { x: 13, y: 13 } }) },
      geometries: []
    });
    layers.end = new window.TMap.MultiMarker({
      map: map,
      styles: {
        a: new window.TMap.MarkerStyle({ width: 28, height: 28, src: svgIcon('#2e7d32', '#ffffff', 'A'), anchor: { x: 14, y: 14 } }),
        b: new window.TMap.MarkerStyle({ width: 28, height: 28, src: svgIcon('#c0392b', '#ffffff', 'B'), anchor: { x: 14, y: 14 } })
      },
      geometries: []
    });
  }

  /* 自己按 Web Mercator 解 zoom —— fitBounds 只挪中心不改 zoom */
  function fitZoom(pts, wPx, hPx) {
    var latMin = 90, latMax = -90, lngMin = 180, lngMax = -180;
    pts.forEach(function (p) {
      latMin = Math.min(latMin, p[0]); latMax = Math.max(latMax, p[0]);
      lngMin = Math.min(lngMin, p[1]); lngMax = Math.max(lngMax, p[1]);
    });
    var W = Math.pow(2, 0);
    function x(lng, z) { return (lng + 180) / 360 * 256 * Math.pow(2, z); }
    function y(lat, z) {
      var s = Math.sin(lat * Math.PI / 180);
      return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * Math.pow(2, z);
    }
    var z = 15;
    for (; z > 3; z--) {
      var dx = Math.abs(x(lngMax, z) - x(lngMin, z));
      var dy = Math.abs(y(latMin, z) - y(latMax, z));
      if (dx <= wPx - 60 && dy <= hPx - 60) break;
    }
    var cx = (latMin + latMax) / 2, cl = (lngMin + lngMax) / 2;
    map.setCenter(new window.TMap.LatLng(cx, cl));
    map.setZoom(z);
    return z;
  }

  function drawMap(o) {
    if (!map || !layers) return 0;
    var hEl = $('map');
    var w = hEl.clientWidth || 640, h = hEl.clientHeight || 470;

    var candsGeo = [];
    if (state.cand) {
      o.cands.forEach(function (c, k) {
        candsGeo.push({ id: 'c' + k, styleId: (k === state.hi ? 'h' : 'c'), paths: paths(c.poly) });
      });
    }
    layers.cand.setGeometries(candsGeo);
    layers.base.setGeometries([{ id: 'b', styleId: 'b', paths: paths(o.poly) }]);
    layers.mono.setGeometries(state.mono
      ? o.mono.map(function (s, k) { return { id: 'm' + k, styleId: 'm', paths: paths(s) }; })
      : []);

    /* 岔口：按沿程弧长在基准折线上取点 */
    var fGeo = [];
    if (state.fork) {
      var L = o.base_len_m || 1;
      o.fork_pos.forEach(function (s, k) {
        var p = pointAt(o.poly, Math.min(1, Math.max(0, s / L)));
        if (p) fGeo.push({ id: 'f' + k, styleId: 'f', position: LL(p) });
      });
    }
    layers.fork.setGeometries(fGeo);
    layers.end.setGeometries([
      { id: 'a', styleId: 'a', position: LL(o.fr) },
      { id: 'b', styleId: 'b', position: LL(o.to) }
    ]);

    var pts = [o.fr, o.to].concat(o.poly);
    if (state.cand) o.cands.forEach(function (c) { pts = pts.concat(c.poly); });
    return fitZoom(pts, w, h);
  }

  /* 按弧长比例在折线上取点（相邻点路径长累加，不是起点到当前点弦长） */
  function pointAt(poly, t) {
    if (!poly || poly.length < 2) return null;
    var segs = [], total = 0;
    for (var i = 1; i < poly.length; i++) {
      var d = M.hav(poly[i - 1][0], poly[i - 1][1], poly[i][0], poly[i][1]);
      segs.push(d); total += d;
    }
    if (!(total > 0)) return poly[0];
    var want = total * t, acc = 0;
    for (var j = 0; j < segs.length; j++) {
      if (acc + segs[j] >= want) {
        var f = segs[j] > 0 ? (want - acc) / segs[j] : 0;
        return [poly[j][0] + (poly[j + 1][0] - poly[j][0]) * f,
                poly[j][1] + (poly[j + 1][1] - poly[j][1]) * f];
      }
      acc += segs[j];
    }
    return poly[poly.length - 1];
  }

  /* ---------- 拉直示意条 ---------- */
  function drawRibbon(o) {
    var svg = $('ribbon');
    if (!svg) return;
    var W = 640, H = 64, barY = 22, barH = 16;
    var L = Math.max(1, o.base_len_m);
    var s = '';
    s += '<rect x="0" y="' + barY + '" width="' + W + '" height="' + barH + '" rx="4" fill="#dfe4ea"/>';
    (o.mono_pos || []).forEach(function (rg) {
      var x0 = rg[0] / L * W, x1 = rg[1] / L * W;
      s += '<rect x="' + x0.toFixed(1) + '" y="' + barY + '" width="' + Math.max(1, x1 - x0).toFixed(1) +
        '" height="' + barH + '" fill="#c0392b"/>';
    });
    (o.fork_pos || []).forEach(function (p) {
      var x = p / L * W;
      s += '<rect x="' + (x - 2).toFixed(1) + '" y="' + (barY - 6) + '" width="4" height="' + (barH + 12) +
        '" fill="#f08b24"/>';
    });
    s += '<text x="0" y="14" font-size="11" fill="#8892a0">A</text>';
    s += '<text x="' + W + '" y="14" font-size="11" fill="#8892a0" text-anchor="end">B</text>';
    svg.innerHTML = s;
  }

  /* ---------- 渲染 ---------- */
  function render() {
    var o = cur();
    var b = M.bestSwap(o);
    var v = M.verdict(o);
    var monoKm = o.mono_m / 1000;

    $('odV').innerHTML = esc(D.cities[state.ci].name + ' · ' + o.name) +
      '<span class="d">' + o.base_dur + ' 分钟 · ' + (o.base_dist / 1000).toFixed(1) + ' 公里</span>';

    $('kMono').innerHTML = M.pct(o.M50) + '<small>%</small>';
    $('kKm').innerHTML = monoKm.toFixed(1) + '<small>km</small>';
    $('kFork').innerHTML = o.F + '<small>个</small>';
    $('kBest').innerHTML = (b === null ? '—' : Math.max(0, b.dt)) + '<small>分钟</small>';
    $('kpiMeta').textContent = '9 条路线 · 8 种绕法';

    var bd = $('vBadge');
    bd.className = 'badge ' + v.level;
    bd.textContent = v.label;
    $('vWhy').innerHTML = v.why.replace(/(\d+)%/g, '<b>$1%</b>');
    $('vAct').innerHTML = v.act.replace(/(\d+\s*分钟)/g, '<b>$1</b>');

    /* 列表 */
    var list = $('list');
    list.innerHTML = '';
    o.cands.forEach(function (c, k) {
      var gap = M.gapRate(c);
      var row = el('div', 'item' + (k === state.hi ? ' on' : ''));
      row.setAttribute('data-role', 'cand');
      row.setAttribute('data-i', String(k));
      var sw = el('span', 'sw');
      sw.style.background = (k === state.hi) ? '#1f6feb' : CAND_COLOR;
      row.appendChild(sw);
      row.appendChild(el('span', 'nm', '绕法 ' + (k + 1) + '　' + c.tag));
      var rr = el('span', 'rr');
      var fill = el('i');
      fill.style.width = Math.round(gap * 100) + '%';
      rr.appendChild(fill);
      row.appendChild(rr);
      var mt = el('span', 'mt');
      var cls = c.dt <= 0 ? 'neg' : '';
      mt.innerHTML = '<b class="' + cls + '">' + (c.dt > 0 ? '+' : '') + c.dt + ' 分钟</b>　换掉 ' +
        Math.round(gap * 100) + '%';
      row.appendChild(mt);
      list.appendChild(row);
    });

    /* 拉直条 */
    $('ribT').innerHTML = '红色 ' + M.pct(o.M50) + '% 绕不开，' + o.F + ' 个橙色岔口';
    drawRibbon(o);

    /* 地图 */
    var z = 0;
    try { z = drawMap(o); } catch (e) { showErr('地图绘制失败：' + (e && e.message ? e.message : e)); }
    $('mapMeta').textContent = (o.cands.length + 1) + ' 条路线 · zoom ' + (z || '-');

    /* 八城对比 */
    var rank = M.stats().rank;
    var bars = $('bars');
    bars.innerHTML = '';
    rank.forEach(function (r) {
      var row = el('div', 'bar' + (r.name === D.cities[state.ci].name ? ' me' : ''));
      row.appendChild(el('span', 'nm', r.name));
      var tr = el('span', 'tr');
      var fl = el('span', 'fl');
      fl.style.width = Math.round(r.m50 * 100) + '%';
      tr.appendChild(fl);
      row.appendChild(tr);
      row.appendChild(el('span', 'vv', Math.round(r.m50 * 100) + '%'));
      bars.appendChild(row);
    });

    /* 对照对 */
    var ct = M.contrast();
    var duo = $('duo');
    duo.innerHTML = '';
    if (ct) {
      $('duoCh').textContent = ct.city + ' · 同一对端点，方向一换（' + ct.ratio.toFixed(1) + ' 倍）';
      [[ct.hi, 'a'], [ct.lo, 'b']].forEach(function (pair) {
        var oo = pair[0], cls = pair[1];
        var one = el('div', 'one ' + cls);
        one.appendChild(el('div', 't', ct.city + ' · ' + oo.name));
        var big = el('div', 'big');
        big.innerHTML = M.pct(oo.M50) + '<small>% 绕不开</small>';
        one.appendChild(big);
        var bb = M.bestSwap(oo);
        one.appendChild(el('div', 'd',
          oo.base_dur + ' 分钟 / ' + (oo.base_dist / 1000).toFixed(1) + ' km · ' + oo.F + ' 个岔口 · ' +
          (bb === null ? '没有划算的换法' : '最划算的换路 ' + Math.max(0, bb.dt) + ' 分钟')));
        duo.appendChild(one);
      });
    }

    renderReadout(o, b, v);
  }

  function renderReadout(o, b, v) {
    var st = M.stats(), ph = M.phantom(), ct = M.contrast();
    $('roMain').innerHTML =
      '这条路 <span class="cnt">' + M.pct(o.M50) + '%</span> 的路段，八种绕法里有半数以上都得走；' +
      '全程只有 <span class="cnt">' + o.F + '</span> 个地方能真正岔开，' +
      (b === null ? '连一次划算的换路都没有。'
        : '最划算的一次要付 <span class="cnt">' + Math.max(0, b.dt) + '</span> 分钟，换掉 ' +
          M.pct(b.gap) + '% 的路。');

    var li = [];
    li.push('全场 ' + st.n_od + ' 段行程，半垄断度中位 <b>' + M.pct(st.m50_med) + '%</b>，' +
      '从 <b>' + M.pct(st.m50_min) + '%</b>（' + st.m50_min_od + '）到 <b>' +
      M.pct(st.m50_max) + '%</b>（' + st.m50_max_od + '）——差距不是误差，是路网形状。');
    if (ct) {
      li.push('最干净的一组对照在<b>' + ct.city + '</b>：同一对端点，' + ct.hi.name + ' 有 ' +
        M.pct(ct.hi.M50) + '% 绕不开，反过来 ' + ct.lo.name + ' 只有 ' + M.pct(ct.lo.M50) +
        '%（<b>' + ct.ratio.toFixed(1) + ' 倍</b>）。方向一换，路网从独木桥变成处处可绕。');
    }
    li.push('八座城里 <b>' + st.rank[0].name + '</b> 最难绕（' + M.pct(st.rank[0].m50) +
      '%），<b>' + st.rank[7].name + '</b> 最好绕（' + M.pct(st.rank[7].m50) + '%），差 ' +
      (st.rank[0].m50 / st.rank[7].m50).toFixed(1) + ' 倍。');
    if (ph.length) {
      li.push('最尴尬的一类：<b>' + ph.length + '</b> 条绕法在几何上和原来那条重合超过 95%，' +
        '却要慢 <b>' + ph[0].dt + '</b> 分钟——你从主路挪到了辅路，地图上看换了，时间上没换。');
    }
    if (st.neg.length) {
      li.push('还有 ' + st.neg.length + ' 段行程出现了「绕开反而更快」，最多快 3 分钟：' +
        '默认给的那条未必是最快的（如实记录，不写成结论）。');
    }
    var ul = $('roList');
    ul.innerHTML = '';
    li.forEach(function (t) { var e = el('li'); e.innerHTML = t; ul.appendChild(e); });

    $('fCount').textContent = String(st.n_route);
    $('fDate').textContent = (D.meta && D.meta.collected_at ? D.meta.collected_at : '—');
  }

  /* ---------- 导出给冒烟/浏览器测试 ---------- */
  window.__fork = {
    state: state,
    render: render,
    boot: boot,
    ready: function () { return ready; },
    zoomOf: function () {
      var t = $('mapMeta') ? $('mapMeta').textContent : '';
      var m = t.match(/zoom\s+(\d+)/);
      return m ? Number(m[1]) : null;
    },
    cur: cur
  };

  autostart();
})();
