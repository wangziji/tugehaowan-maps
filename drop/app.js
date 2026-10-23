/* 《落点 · THE DROP》交互层 */
(function () {
  'use strict';

  var M = window.DropModel;
  var DATA = window.DROP_DATA;
  var GOOD = '#4dd4ac', MID = '#ffd166', BAD = '#ff6b6b', ORIGIN = '#ffffff', LINE = '#5b6b80', EMPTY = '#3aa0ff';

  var state = { ci: 0, p: 0, q: -1, k: 1.0 };
  var map = null, markerLayer = null, lineLayer = null, circleLayer = null, ready = false;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>';
    });
  }
  function fmt(n, d) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    var p = Math.pow(10, d === undefined ? 0 : d);
    return (Math.round(n * p) / p).toFixed(d === undefined ? 0 : d);
  }
  function pname(p) {
    var a = (p.district || '').replace(/[市区县]$/, '');
    var b = p.name || '';
    return (a ? a + '·' : '') + b;
  }

  /* ---------- 计算 ---------- */
  var SUM = null;
  function summaryOf(i) {
    if (!SUM) SUM = [];
    if (!SUM[i]) SUM[i] = M.citySummary(DATA.cities[i].name, DATA.cities[i], { demandMode: 'sum' });
    return SUM[i];
  }
  function rateOf(o) { return M.rateAt(o, state.k); }

  /* ---------- 选择器 ---------- */
  function buildChips() {
    var box = $('cityChips');
    if (!box) return;
    box.innerHTML = '';
    DATA.cities.forEach(function (c, i) {
      var b = document.createElement('button');
      b.className = 'chip' + (i === state.ci ? ' on' : '');
      b.textContent = c.name;
      b.setAttribute('data-c', String(i));
      b.onclick = function () {
        state.ci = i; state.p = 0; state.q = -1;
        buildChips(); buildOrigin(); render();
      };
      box.appendChild(b);
    });
  }

  function buildOrigin() {
    var sel = $('originSel');
    if (!sel) return;
    var c = DATA.cities[state.ci];
    sel.innerHTML = '';
    c.points.forEach(function (p, i) {
      var o = document.createElement('option');
      o.value = String(i);
      o.textContent = pname(p) + '（' + p.bname + ' ' + fmt(c.radii[p.ring], 1) + ' km 圈）';
      sel.appendChild(o);
    });
    sel.value = String(Math.min(state.p, c.points.length - 1));
    state.p = parseInt(sel.value, 10) || 0;
    sel.onchange = function () {
      state.p = parseInt(sel.value, 10) || 0;
      state.q = -1;
      render();
    };
  }

  /* ---------- KPI ---------- */
  function renderKpi(s, list) {
    var allRate = [], allRate0 = [], allSpread = [], emptyShares = [];
    DATA.cities.forEach(function (c, i) {
      var si = summaryOf(i);
      si.list.forEach(function (o) { allRate.push(o.rate); allRate0.push(o.rate0); });
      allSpread.push(si.spread.median);
      emptyShares.push(si.emptyShare);
    });
    $('kNom').innerHTML = fmt(M.median(allRate0), 0) + '<span class="u">元/h</span>';
    $('kReal').innerHTML = fmt(M.median(allRate), 0) + '<span class="u">元/h</span>';
    $('kSpread').innerHTML = fmt(M.median(allSpread), 2) + '<span class="u">倍</span>';
    $('kEmpty').innerHTML = fmt(M.median(emptyShares) * 100, 0) + '<span class="u">%</span>';

    var c = DATA.cities[state.ci];
    var pairNow = M.contrastPair(list, 0.06);
    var cur = list.slice().sort(function (a, b) { return rateOf(b) - rateOf(a); });
    if (!pairNow) {
      var hi0 = cur[0], lo0 = cur[cur.length - 1];
      $('headline').innerHTML =
        '在' + esc(c.name) + '，从<b>' + esc(pname(c.points[state.p])) + '</b>出发：' +
        '送到<b>' + esc(pname(c.points[hi0.q])) + '</b>，司机时薪 <b>' + fmt(rateOf(hi0), 0) + '</b> 元；' +
        '送到<b>' + esc(pname(c.points[lo0.q])) + '</b>，只有 <b>' + fmt(rateOf(lo0), 0) + '</b> 元。';
      return;
    }
    var hi = pairNow.hi, lo = pairNow.lo;
    $('headline').innerHTML =
      '在' + esc(c.name) + '，从<b>' + esc(pname(c.points[state.p])) + '</b>出发，两单车费几乎一样（' +
      fmt(hi.fare, 0) + ' 元 / ' + fmt(lo.fare, 0) + ' 元，差 ' + fmt(pairNow.fareGap, 1) + ' 元）：<br>' +
      '送到<b>' + esc(pname(c.points[hi.q])) + '</b>，司机一小时挣 <b>' + fmt(rateOf(hi), 0) + '</b> 元；' +
      '送到<b>' + esc(pname(c.points[lo.q])) + '</b>，只有 <b>' + fmt(rateOf(lo), 0) + '</b> 元 —— ' +
      '同样多的钱，<b>' + fmt(pairNow.ratio, 1) + ' 倍</b>的差别。';
  }

  /* ---------- 落点条 ---------- */
  function renderBars(s, list) {
    var box = $('bars');
    if (!box) return;
    var cur = list.slice().sort(function (a, b) { return rateOf(b) - rateOf(a); });
    var maxR = Math.max.apply(null, cur.map(function (o) { return o.rate0; }));
    var med = M.median(cur.map(function (o) { return rateOf(o); }));
    var c = DATA.cities[state.ci];
    if (state.q < 0 || state.q === state.p) state.q = cur[0].q;
    box.innerHTML = '';
    cur.forEach(function (o) {
      var el = document.createElement('div');
      var cls = 'bar';
      if (o.q === cur[0].q) cls += ' best';
      if (o.q === cur[cur.length - 1].q) cls += ' worst';
      if (o.q === state.q) cls += ' on';
      el.className = cls;
      el.setAttribute('data-q', String(o.q));
      var lost = (1 - rateOf(o) / Math.max(o.rate0, 1e-6)) * 100;
      el.innerHTML =
        '<div class="hd"><span class="nm">' + esc(pname(c.points[o.q])) +
        '<i>' + esc(c.points[o.q].bname) + ' ' + fmt(o.km, 1) + 'km</i></span>' +
        '<span class="tt">车费 ' + fmt(o.fare, 0) + ' 元 · 空驶 <b>' + fmt(o.tEmpty, 1) + '</b> 分 · ' +
        '<b>' + fmt(rateOf(o), 0) + '</b> 元/h</span></div>' +
        '<div class="track">' +
        '<div class="seg nom" style="width:' + (o.rate0 / maxR * 100).toFixed(1) + '%"></div>' +
        '<div class="seg real" style="width:' + (rateOf(o) / maxR * 100).toFixed(1) + '%"></div>' +
        '<div class="tick" style="left:' + (med / maxR * 100).toFixed(1) + '%"></div>' +
        '</div>' +
        '<div class="note">计价器上这单是 ' + fmt(o.rate0, 0) + ' 元/h，算上空驶只剩 ' +
        fmt(rateOf(o), 0) + ' 元/h（少了 ' + fmt(lost, 0) + '%）</div>';
      el.onclick = function () {
        state.q = o.q;
        render();
      };
      box.appendChild(el);
    });
    $('barsNote').textContent = '红刻度 = 这一城所有落点的真实时薪中位（' + fmt(med, 0) +
      ' 元/h）。深色条是计价器给你的答案，亮色条才是司机拿到的答案；两者之间的缺口就是空驶。';
  }

  /* ---------- 散点 ---------- */
  function renderScatter(s, list) {
    var svg = $('scatter');
    if (!svg) return;
    var W = 860, H = 320, L = 52, R = 14, T = 14, B = 34;
    var xs = list.map(function (o) { return o.fare; });
    var ys = list.map(function (o) { return rateOf(o); });
    var x0 = 0, x1 = Math.max.apply(null, xs) * 1.02;
    var y0 = 0, y1 = Math.max.apply(null, ys) * 1.08;
    var ex = [], ey = [];
    list.forEach(function (o) { ex.push(o.tEmpty); });
    var e0 = Math.min.apply(null, ex), e1 = Math.max.apply(null, ex);
    function X(v) { return L + (v - x0) / (x1 - x0) * (W - L - R); }
    function Y(v) { return H - B - (v - y0) / (y1 - y0) * (H - T - B); }
    function col(o) {
      var t = (o.tEmpty - e0) / Math.max(e1 - e0, 1e-6);
      if (t < 0.34) return GOOD;
      if (t < 0.67) return MID;
      return BAD;
    }
    var g = '';
    // 轴
    g += '<line x1="' + L + '" y1="' + (H - B) + '" x2="' + (W - R) + '" y2="' + (H - B) + '" stroke="#243141"/>';
    g += '<line x1="' + L + '" y1="' + T + '" x2="' + L + '" y2="' + (H - B) + '" stroke="#243141"/>';
    for (var v = 0; v <= x1; v += 50) {
      g += '<text class="axis" x="' + X(v).toFixed(0) + '" y="' + (H - B + 16) + '" text-anchor="middle">' + v + '</text>';
    }
    for (var yy = 0; yy <= y1; yy += 50) {
      g += '<text class="axis" x="' + (L - 6) + '" y="' + (Y(yy) + 4).toFixed(0) + '" text-anchor="end">' + yy + '</text>';
    }
    g += '<text class="axis" x="' + ((L + W - R) / 2) + '" y="' + (H - 4) + '" text-anchor="middle">车费（元，估算）</text>';
    g += '<text class="axis" x="14" y="' + ((T + H - B) / 2) + '" text-anchor="middle" transform="rotate(-90 14 ' +
      ((T + H - B) / 2) + ')">真实时薪（元/h）</text>';
    list.forEach(function (o) {
      var r = o.p === state.p ? 4.6 : 3.0;
      var op = o.p === state.p ? 1 : 0.42;
      g += '<circle cx="' + X(o.fare).toFixed(1) + '" cy="' + Y(rateOf(o)).toFixed(1) + '" r="' + r +
        '" fill="' + col(o) + '" opacity="' + op + '"/>';
    });
    // 同车费档的竖直带，标出最悬殊的一档
    var best = null;
    s.spread.detail.forEach(function (d) { if (!best || d.ratio > best.ratio) best = d; });
    if (best) {
      var bx0 = X(best.bin * M.FARE_BIN), bx1 = X(best.bin * M.FARE_BIN + M.FARE_BIN);
      g += '<rect x="' + bx0.toFixed(1) + '" y="' + T + '" width="' + (bx1 - bx0).toFixed(1) +
        '" height="' + (H - T - B) + '" fill="#ffd166" opacity="0.08"/>';
      g += '<text class="axis" x="' + ((bx0 + bx1) / 2).toFixed(0) + '" y="' + (T + 12) +
        '" text-anchor="middle" fill="#ffd166">' + (best.bin * M.FARE_BIN) + '~' +
        (best.bin * M.FARE_BIN + M.FARE_BIN) + ' 元档：差 ' + best.ratio.toFixed(2) + ' 倍</text>';
    }
    svg.innerHTML = g;
  }

  /* ---------- 城市对比表 ---------- */
  function renderTable() {
    var t = $('cityTable');
    if (!t) return;
    var h = '<tr><th>城市</th><th>空驶中位</th><th>最好落点</th><th>最差落点</th><th>好坏差</th>' +
      '<th>空驶税</th><th>空驶占比</th><th>真实时薪</th><th>计价器时薪</th></tr>';
    DATA.cities.forEach(function (c, i) {
      var s = summaryOf(i);
      h += '<tr><td>' + esc(c.name) + '</td>' +
        '<td>' + fmt(s.atMedian, 1) + ' min</td>' +
        '<td>' + fmt(s.best.at, 1) + '</td>' +
        '<td>' + fmt(s.worst.at, 1) + '</td>' +
        '<td class="rk">' + fmt(s.atRatio, 2) + '×</td>' +
        '<td>' + fmt(s.taxMedian * 100, 0) + '%</td>' +
        '<td>' + fmt(s.emptyShare * 100, 0) + '%</td>' +
        '<td>' + fmt(s.rateMedian, 0) + '</td>' +
        '<td>' + fmt(s.rate0Median, 0) + '</td></tr>';
    });
    t.innerHTML = h;
  }

  /* ---------- 结论 ---------- */
  function renderConcl(s, list) {
    var cur = list.slice().sort(function (a, b) { return rateOf(b) - rateOf(a); });
    var hi = cur[0], lo = cur[cur.length - 1];
    var allSpread = [];
    DATA.cities.forEach(function (c, i) { allSpread.push(summaryOf(i).spread.median); });
    var c = DATA.cities[state.ci];
    $('concl').innerHTML =
      '抢单前先看<b>把你放到哪儿</b>，而不是看多少钱、多少公里。' +
      '在' + esc(c.name) + '这一城，最好和最差的落点让司机接下来的平均空驶差 ' +
      '<b>' + fmt(s.worst.at - s.best.at, 1) + ' 分钟</b>（' + fmt(s.atRatio, 1) + ' 倍）；' +
      '六城平均，同样车费的两单真实时薪能差 <b>' + fmt(M.median(allSpread), 2) + ' 倍</b>。' +
      '<span class="alt">反过来说：你觉得「这个地方怎么叫不到车」，往往不是因为远，' +
      '而是因为司机把你送到那儿之后，得空着车开很久才能接到下一单 —— 加价买的就是这段空驶。</span>';
  }

  /* ---------- 地图 ---------- */
  function markerIcon(color, r) {
    var s = '<svg xmlns="http://www.w3.org/2000/svg" width="' + (r * 2 + 6) + '" height="' + (r * 2 + 6) + '">' +
      '<circle cx="' + (r + 3) + '" cy="' + (r + 3) + '" r="' + r + '" fill="' + color +
      '" stroke="#0b1017" stroke-width="2"/></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
  }

  function fitZoom(c) {
    var el = $('map');
    var W = (el && el.clientWidth) ? el.clientWidth : 860;
    var H = 420;
    var r = Math.max(c.radii[0], c.radii[1]) * 1000 * 2.5;  // 直径 + 边距
    var lat = c.center[0];
    var mpp = 156543.03392 * Math.cos(lat * Math.PI / 180);
    var z = Math.log(W * mpp / r) / Math.LN2;
    return Math.max(3, Math.min(16, z));
  }

  function initMap() {
    var c = DATA.cities[state.ci];
    if (!map) {
      map = new TMap.Map('map', {
        center: new TMap.LatLng(c.center[0], c.center[1]),
        zoom: fitZoom(c),
        pitch: 0,
        baseMap: { type: 'vector' }
      });
      ready = true;
    }
  }

  function renderMap(s, list) {
    if (!window.TMap || !$('map')) { $('mapmsg').textContent = '地图组件未加载。'; return; }
    try {
      initMap();
      var c = DATA.cities[state.ci];
      var cur = list.slice().sort(function (a, b) { return rateOf(b) - rateOf(a); });
      if (state.q < 0 || state.q === state.p) state.q = cur[0].q;
      var rates = cur.map(function (o) { return rateOf(o); });
      var rlo = Math.min.apply(null, rates), rhi = Math.max.apply(null, rates);

      // 图层顺序：先圆（在下），再线，再点（在上）
      var q = state.q;
      var ad = (s.A[q] && isFinite(s.A[q].ad)) ? s.A[q].ad : 0;
      var lat = c.points[q].lat;
      var safeR = Math.min(ad, (83 - Math.abs(lat)) * 0.90 * 111.19);
      var clipped = ad > safeR + 0.01;
      if (!circleLayer) {
        circleLayer = new TMap.MultiCircle({
          map: map,
          styles: {
            empty: new TMap.CircleStyle({
              color: 'rgba(58,160,255,0.10)', borderColor: EMPTY, borderWidth: 1, showCenter: false
            })
          },
          geometries: []
        });
      }
      circleLayer.setGeometries(ad > 0.05 ? [{
        id: 'empty', styleId: 'empty',
        center: new TMap.LatLng(lat, c.points[q].lng),
        radius: safeR * 1000
      }] : []);

      if (!lineLayer) {
        lineLayer = new TMap.MultiPolyline({
          map: map,
          styles: {
            ln: new TMap.PolylineStyle({ color: LINE, width: 2, borderWidth: 0, lineCap: 'round' })
          },
          geometries: []
        });
      }
      lineLayer.setGeometries([{
        id: 'ln', styleId: 'ln',
        paths: [new TMap.LatLng(c.points[state.p].lat, c.points[state.p].lng),
        new TMap.LatLng(lat, c.points[q].lng)]
      }]);

      var styles = {}, geos = [];
      ['g0', 'g1', 'g2', 'g3', 'g4'].forEach(function (id, i) {
        var t = i / 4;
        var col = t < 0.5 ? BAD : (t < 0.75 ? MID : GOOD);
        styles[id] = new TMap.MarkerStyle({
          width: 20, height: 20, anchor: { x: 10, y: 10 },
          src: markerIcon(col, 7)
        });
      });
      styles['og'] = new TMap.MarkerStyle({
        width: 30, height: 30, anchor: { x: 15, y: 15 },
        src: markerIcon(ORIGIN, 11)
      });
      cur.forEach(function (o) {
        var t = (rateOf(o) - rlo) / Math.max(rhi - rlo, 1e-6);
        var id = 'g' + Math.max(0, Math.min(4, Math.round(t * 4)));
        geos.push({
          id: 'm' + o.q, styleId: id,
          position: new TMap.LatLng(c.points[o.q].lat, c.points[o.q].lng)
        });
      });
      geos.push({
        id: 'mo', styleId: 'og',
        position: new TMap.LatLng(c.points[state.p].lat, c.points[state.p].lng)
      });
      if (markerLayer) markerLayer.setMap(null);
      markerLayer = new TMap.MultiMarker({ map: map, styles: styles, geometries: geos });

      map.setCenter(new TMap.LatLng(c.center[0], c.center[1]));
      map.setZoom(fitZoom(c));
      $('mapmsg').innerHTML = '白点 = 你所在的位置（' + esc(pname(c.points[state.p])) + '）；' +
        '蓝圈 = 送到 <b>' + esc(pname(c.points[q])) + '</b> 之后，他平均要空驶 <b>' +
        fmt(s.A[q].at, 1) + ' 分钟 / ' + fmt(ad, 1) + ' km</b> 才能接到下一单' +
        (clipped ? '（半径已按纬度上限截断显示）' : '') + '。灰线只是直线示意，不是实际路线。';
    } catch (e) {
      $('mapmsg').textContent = '地图渲染失败：' + (e && e.message ? e.message : e);
    }
  }

  /* ---------- 主渲染 ---------- */
  function render() {
    var s = summaryOf(state.ci);
    var fp = M.fromPoint(DATA.cities[state.ci].name, DATA.cities[state.ci], state.p, { demandMode: 'sum' });
    renderKpi(s, fp.list);
    renderBars(s, fp.list);
    renderScatter(s, s.list);
    renderTable();
    renderConcl(s, fp.list);
    renderMap(s, fp.list);
  }

  function boot() {
    var kr = $('kRange');
    if (kr) {
      kr.oninput = function () {
        state.k = (parseInt(kr.value, 10) || 0) / 100;
        $('kVal').textContent = String(parseInt(kr.value, 10) || 0);
        render();
      };
    }
    buildChips();
    buildOrigin();
    render();
  }

  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot);

  window.__drop = {
    state: state, boot: boot, render: render, summaryOf: summaryOf, rateOf: rateOf, pname: pname
  };
})();
