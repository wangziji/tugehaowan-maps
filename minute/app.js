/* 《时间价签 · PRICE OF A MINUTE》交互层 */
(function () {
  'use strict';

  var M = window.MinuteModel;
  var DATA = window.MINUTE_DATA;
  var COLOR = { taxi: '#ffd166', transit: '#3aa0ff', bike: '#4dd4ac' };
  var LABEL = { taxi: '打车', transit: '公交地铁', bike: '骑行' };
  var ORDER = ['taxi', 'transit', 'bike'];   // 快 -> 慢

  var state = { ci: 0, oi: 0, hourly: 60 };
  var map = null, lineLayer = null, markLayer = null, ready = false;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) {
    return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'; }); }
  function fmt(n, d) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    var p = Math.pow(10, d === undefined ? 0 : d);
    return (Math.round(n * p) / p).toFixed(d === undefined ? 0 : d);
  }

  /* ---------- 选择器 ---------- */
  function buildChips() {
    var box = $('cityChips');
    box.innerHTML = '';
    DATA.cities.forEach(function (c, i) {
      var b = document.createElement('button');
      b.className = 'chip' + (i === state.ci ? ' on' : '');
      b.textContent = c.city;
      b.setAttribute('data-c', String(i));
      b.onclick = function () { state.ci = i; state.oi = 0; buildChips(); buildOd(); render(); };
      box.appendChild(b);
    });
  }

  function buildOd() {
    var sel = $('odSel'), c = DATA.cities[state.ci];
    sel.innerHTML = '';
    c.ods.forEach(function (od, i) {
      var o = document.createElement('option');
      o.value = String(i);
      o.textContent = od.from + ' → ' + od.to + '（' + fmt(od.straight / 1000, 1) + ' km 直线）';
      sel.appendChild(o);
    });
    sel.value = String(Math.min(state.oi, c.ods.length - 1));
    state.oi = parseInt(sel.value, 10) || 0;
    sel.onchange = function () {
      state.oi = parseInt(sel.value, 10) || 0;
      render();
    };
  }

  /* ---------- 计算 ---------- */
  function current() {
    var c = DATA.cities[state.ci];
    var od = c.ods[state.oi];
    var pf = M.profile(od, c.fare);
    return { city: c, od: od, pf: pf };
  }

  function allThresholds() {
    // 全城每条 OD 的两组临界时薪，用于八城排行
    return DATA.cities.map(function (c) {
      var up = [], bk = [];
      c.ods.forEach(function (od) {
        var pf = M.profile(od, c.fare);
        var a = M.stepThreshold(pf, 'transit', 'taxi'); if (a !== null) up.push(a);
        var b = M.stepThreshold(pf, 'bike', 'transit'); if (b !== null) bk.push(b);
      });
      return { city: c.city, up: M.median(up), bk: M.median(bk), nUp: up.length, nBk: bk.length };
    });
  }

  /* ---------- 渲染：KPI / 决策 / 成本条 ---------- */
  function render() {
    var cur = current();
    var pf = cur.pf, R = state.hourly;
    var best = M.best(pf.all, R);

    $('hourlyVal').textContent = fmt(R, 0);

    $('kBest').textContent = best ? best.label : '—';
    $('kTotal').innerHTML = best ? fmt(M.totalCost(best, R), 0) + '<span class="u">元</span>' : '—';
    $('kMoney').innerHTML = best ? fmt(best.cost, 0) + '<span class="u">元</span>' : '—';
    $('kTime').innerHTML = best ? fmt(R * M.toHour(best.time), 0) + '<span class="u">元</span>' : '—';

    /* 决策句：数字与文字必须成对刷新 */
    var other = pf.frontier.filter(function (o) { return o.key !== best.key; });
    var txt;
    if (!best) {
      txt = '这段路没有可用方案。';
    } else if (R === 0) {
      txt = '你把时间算作不值钱，那就选最便宜的：<b>' + esc(best.label) + '</b>。';
    } else {
      var slowest = pf.frontier[pf.frontier.length - 1];
      var fastest = pf.frontier[0];
      var isFastest = best.key === fastest.key;
      var isSlowest = best.key === slowest.key;
      if (isFastest && pf.frontier.length > 1) {
        var Rf = null;
        for (var i = 0; i < pf.steps.length; i++) {
          if (pf.steps[i].to === fastest.key) { Rf = pf.steps[i].threshold; break; }
        }
        txt = '你的时薪 <b>' + fmt(R, 0) + '</b> 元/小时，比换到最快一档的门槛（'
          + (Rf === null ? '不适用' : fmt(Rf, 0)) + ' 元/小时）更高 —— 直接上 <b>' + esc(best.label) + '</b>。';
      } else if (isSlowest && pf.frontier.length > 1) {
        txt = '你的时薪 <b>' + fmt(R, 0) + '</b> 元/小时还不够贵，快出来的那几分钟不值那个差价 —— <b>'
          + esc(best.label) + '</b> 最划算。';
      } else {
        txt = '你卡在中间档：<b>' + esc(best.label) + '</b>。再快一档不值，再慢一档省的钱不够。';
      }
    }
    var alt = other.map(function (o) {
      return esc(o.label) + ' 总成本 ' + fmt(M.totalCost(o, R), 0) + ' 元（多 '
        + fmt(M.totalCost(o, R) - M.totalCost(best, R), 0) + ' 元）';
    }).join('　·　');
    /* 一年账：把单程差额放大到「一年」，让这个决定有量级 */
    var year = 0;
    if (best) {
      other.forEach(function (o) {
        year = Math.max(year, M.totalCost(o, R) - M.totalCost(best, R));
      });
      year = Math.round(year * 2 * 250);
    }
    $('decision').innerHTML = txt + (alt ? '<span class="alt">' + alt + '</span>' : '');
    $('kYear').textContent = fmt(year, 0);

    /* 成本条 */
    var maxTotal = 0;
    pf.all.forEach(function (o) { maxTotal = Math.max(maxTotal, M.totalCost(o, R)); });
    var scale = maxTotal > 0 ? maxTotal : 1;
    var html = '';
    ORDER.forEach(function (k) {
      var o = null;
      pf.all.forEach(function (x) { if (x.key === k) o = x; });
      if (!o) return;
      var onFrontier = pf.frontier.indexOf(o) >= 0;
      var total = M.totalCost(o, R);
      var moneyW = total > 0 ? (o.cost / total) * 100 : 0;
      var timeW = total > 0 ? 100 - moneyW : 0;
      var isBest = best && o.key === best.key;
      html += '<div class="bar' + (isBest ? ' best' : '') + (onFrontier ? '' : ' gone') + '" data-k="' + k + '">'
        + '<div class="hd"><span class="nm">' + LABEL[k]
        + '<i>' + fmt(M.toKm(o.dist), 1) + ' km · ' + fmt(o.time, 0) + ' 分钟</i></span>'
        + '<span class="tt">钱 <b>' + fmt(o.cost, 0) + '</b> + 时间 <b>' + fmt(R * M.toHour(o.time), 0)
        + '</b> ＝ <b>' + fmt(total, 0) + '</b> 元</span></div>'
        + '<div class="track"><div class="seg money" style="width:' + moneyW.toFixed(2) + '%">'
        + (moneyW > 16 ? fmt(o.cost, 0) : '') + '</div>'
        + '<div class="seg time" style="width:' + timeW.toFixed(2) + '%">'
        + (timeW > 16 ? fmt(R * M.toHour(o.time), 0) : '') + '</div></div>'
        + '<div class="note">' + (onFrontier
          ? (isBest ? '★ 当前时薪下总成本最低' : '在可选前沿上，但不是当前最优')
          : '被支配：更慢而且不更便宜 —— 任何时薪下都不会选它')
        + '</div></div>';
    });
    $('bars').innerHTML = html;

    renderRank();
    renderFindings();
    drawMap(cur);
  }

  /* ---------- 渲染：八城排行 ---------- */
  function renderRank() {
    var rows = allThresholds();
    rows.sort(function (a, b) { return (b.up || 0) - (a.up || 0); });
    var tb = $('rank').querySelector('tbody');
    var html = '';
    rows.forEach(function (r, i) {
      var ratio = (r.up && r.bk) ? r.up / r.bk : null;
      html += '<tr><td class="rk">' + (i + 1) + '. ' + esc(r.city) + '</td>'
        + '<td>' + (r.bk === null ? '—' : fmt(r.bk, 1)) + '</td>'
        + '<td>' + (r.up === null ? '—' : fmt(r.up, 0)) + '</td>'
        + '<td>' + (ratio === null ? '—' : '×' + fmt(ratio, 0)) + '</td></tr>';
    });
    tb.innerHTML = html;
    var ups = rows.map(function (r) { return r.up; }).filter(function (x) { return x !== null; });
    var bks = rows.map(function (r) { return r.bk; }).filter(function (x) { return x !== null; });
    $('rankNote').textContent = '八城「公交 → 打车」门槛中位 ' + fmt(M.median(ups), 0)
      + ' 元/小时，「骑行 → 公交」门槛中位 ' + fmt(M.median(bks), 1)
      + ' 元/小时 —— 同为「给自己一小时定价」，两者相差约 '
      + fmt(M.median(ups) / M.median(bks), 0) + ' 倍。表中取各城全部通勤的中位数。';
  }

  /* ---------- 渲染：反常识结论 ---------- */
  function renderFindings() {
    var cur = current(), pf = cur.pf, R = state.hourly;
    var all = [];
    DATA.cities.forEach(function (c) {
      c.ods.forEach(function (od) { all.push({ city: c.city, od: od, pf: M.profile(od, c.fare) }); });
    });
    var nDom = 0, nTranFast = 0;
    all.forEach(function (a) {
      var tx = null, tr = null;
      a.pf.all.forEach(function (o) { if (o.key === 'taxi') tx = o; if (o.key === 'transit') tr = o; });
      if (tx && tr && tr.time < tx.time) nTranFast++;
      if (a.pf.dropped.some(function (d) { return d.key === 'taxi'; })) nDom++;
    });
    var ups = [], bks = [];
    all.forEach(function (a) {
      var x = M.stepThreshold(a.pf, 'transit', 'taxi'); if (x !== null) ups.push(x);
      var y = M.stepThreshold(a.pf, 'bike', 'transit'); if (y !== null) bks.push(y);
    });
    var thisUp = M.stepThreshold(pf, 'transit', 'taxi');
    var thisBk = M.stepThreshold(pf, 'bike', 'transit');

    var items = [];
    items.push('① <b>同一个「一小时」，往上买和往下卖差 ' + fmt(M.median(ups) / M.median(bks), 0) + ' 倍。</b>'
      + '升到打车，你为一小时付中位 ' + fmt(M.median(ups), 0) + ' 元；'
      + '为了省几块钱去骑车，你把自己一小时只卖 ' + fmt(M.median(bks), 1) + ' 元。'
      + '两个数字都叫「你时间的价」，却根本不在同一个量级上。');
    items.push('② <b>' + nTranFast + ' / ' + all.length + ' 条通勤里，公交地铁比打车还快。</b>'
      + '加上「快不了几分钟」的情况，共 ' + nDom + ' 条通勤里打车被彻底支配 —— 又慢又贵，任何时薪下都不该选。'
      + '打车不是默认最快，它只是默认最贵。');
    /* 同城跨度：把「该不该打车」从城市属性拉回路线属性，用真实数据说话 */
    var spreadCity = null, spreadR = 1;
    DATA.cities.forEach(function (c) {
      var a = [];
      c.ods.forEach(function (od) {
        var x = M.stepThreshold(M.profile(od, c.fare), 'transit', 'taxi');
        if (x !== null) a.push(x);
      });
      if (a.length >= 4) {
        var r = Math.max.apply(null, a) / Math.min.apply(null, a);
        if (r > spreadR) { spreadR = r; spreadCity = { city: c.city, lo: Math.min.apply(null, a), hi: Math.max.apply(null, a), n: a.length }; }
      }
    });
    if (spreadCity) {
      items.push('③ <b>「该不该打车」不是城市的属性，是这条路线的属性。</b>'
        + spreadCity.city + ' ' + spreadCity.n + ' 条通勤里，同一座城的门槛从 '
        + fmt(spreadCity.lo, 0) + ' 元/小时到 ' + fmt(spreadCity.hi, 0) + ' 元/小时，差 '
        + fmt(spreadR, 1) + ' 倍。所以「我们这儿打车贵 / 便宜」这句话本身没有意义 —— 要看你走的是哪一段。');
    }
    items.push('④ <b>本段通勤：</b>公交 → 打车的门槛是 '
      + (thisUp === null ? '不适用（省时不足 5 分钟或打车不占优）' : fmt(thisUp, 0) + ' 元/小时')
      + '，骑行 → 公交的门槛是 '
      + (thisBk === null ? '不适用' : fmt(thisBk, 1) + ' 元/小时')
      + '。你现在的时薪是 ' + fmt(R, 0) + ' 元/小时。');
    $('findings').innerHTML = items.map(function (s) {
      return '<div style="margin-bottom:9px;line-height:1.75">' + s + '</div>';
    }).join('');
  }

  /* ---------- 地图 ---------- */
  function decode(pl) {
    if (!Array.isArray(pl) || pl.length < 4) return [];
    var out = [], lat = pl[0], lng = pl[1];
    out.push([lat, lng]);
    for (var i = 2; i + 1 < pl.length; i += 2) {
      lat += pl[i] / 1e6; lng += pl[i + 1] / 1e6;
      out.push([lat, lng]);
    }
    return out;
  }

  function fitMap(pts) {
    if (!map || !pts.length) return;
    var la1 = 90, la2 = -90, lo1 = 180, lo2 = -180;
    pts.forEach(function (p) {
      la1 = Math.min(la1, p[0]); la2 = Math.max(la2, p[0]);
      lo1 = Math.min(lo1, p[1]); lo2 = Math.max(lo2, p[1]);
    });
    var el = document.getElementById('map');
    var W = el.clientWidth || 800, H = el.clientHeight || 400;
    var cx = (la1 + la2) / 2, cy = (lo1 + lo2) / 2;
    // 本版 fitBounds 只挪中心不改 zoom，自己按 Web Mercator 解
    function mercY(lat) { return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)); }
    var dx = Math.max((lo2 - lo1) / 360, 1e-6);
    var dy = Math.max(Math.abs(mercY(la2) - mercY(la1)) / (2 * Math.PI), 1e-6);
    var z = Math.min(Math.log2(W / (256 * dx)), Math.log2(H / (256 * dy))) - 0.35;
    z = Math.max(3, Math.min(16, Math.floor(z * 10) / 10));
    map.setCenter(new window.TMap.LatLng(cx, cy));
    map.setZoom(z);
  }

  function drawMap(cur) {
    if (!ready || !window.TMap) return;
    var od = cur.od;
    var msg = $('mapmsg');
    try {
      var geos = [], pts = [];
      ['drive', 'transit', 'bike'].forEach(function (f) {
        var key = f === 'drive' ? 'taxi' : (f === 'transit' ? 'transit' : 'bike');
        var pl = od[f] && od[f].p;
        if (!pl) return;
        var arr = decode(pl);
        if (arr.length < 2) return;
        arr.forEach(function (p) { pts.push(p); });
        geos.push({
          styleId: key,
          paths: arr.map(function (p) { return new window.TMap.LatLng(p[0], p[1]); })
        });
      });
      pts.push([od.a[0], od.a[1]]);
      pts.push([od.b[0], od.b[1]]);

      if (!lineLayer) {
        lineLayer = new window.TMap.MultiPolyline({
          map: map,
          styles: {
            taxi: new window.TMap.PolylineStyle({ color: 'rgb(255,209,102)', width: 6, borderWidth: 1, borderColor: 'rgb(60,48,16)', lineCap: 'round' }),
            transit: new window.TMap.PolylineStyle({ color: 'rgb(58,160,255)', width: 5, borderWidth: 1, borderColor: 'rgb(12,42,74)', lineCap: 'round' }),
            bike: new window.TMap.PolylineStyle({ color: 'rgb(77,212,172)', width: 4, borderWidth: 1, borderColor: 'rgb(14,50,40)', lineCap: 'round' })
          },
          geometries: []
        });
      }
      lineLayer.setGeometries(geos.length ? geos : []);

      var svgA = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26"><circle cx="13" cy="13" r="10" fill="#0b1017" stroke="#93a7bd" stroke-width="2"/><circle cx="13" cy="13" r="4" fill="#93a7bd"/></svg>');
      var svgB = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26"><circle cx="13" cy="13" r="10" fill="#241d0e" stroke="#ffd166" stroke-width="2"/><circle cx="13" cy="13" r="4.5" fill="#ffd166"/></svg>');
      if (!markLayer) {
        markLayer = new window.TMap.MultiMarker({
          map: map,
          styles: {
            a: new window.TMap.MarkerStyle({ width: 26, height: 26, anchor: { x: 13, y: 13 }, src: svgA }),
            b: new window.TMap.MarkerStyle({ width: 26, height: 26, anchor: { x: 13, y: 13 }, src: svgB })
          },
          geometries: []
        });
      }
      markLayer.setGeometries([
        { id: 'a', styleId: 'a', position: new window.TMap.LatLng(od.a[0], od.a[1]) },
        { id: 'b', styleId: 'b', position: new window.TMap.LatLng(od.b[0], od.b[1]) }
      ]);

      fitMap(pts);
      msg.textContent = '起：' + od.from + '　终：' + od.to
        + '　（三条线分别是三种走法实测经过的路，不是示意图）';
    } catch (e) {
      msg.textContent = '地图绘制失败：' + (e && e.message ? e.message : e);
    }
  }

  function initMap() {
    if (!window.TMap) { $('mapmsg').textContent = '地图 SDK 未加载'; return; }
    try {
      var c = DATA.cities[state.ci], od = c.ods[state.oi];
      map = new window.TMap.Map(document.getElementById('map'), {
        center: new window.TMap.LatLng(od.a[0], od.a[1]),
        zoom: 11,
        pitch: 0,
        baseMap: { type: 'vector' }
      });
      ready = true;
      drawMap(current());
    } catch (e) {
      $('mapmsg').textContent = '地图初始化失败：' + (e && e.message ? e.message : e);
    }
  }

  /* ---------- 启动 ---------- */
  function renderHeadline() {
    var ups = [], bks = [];
    DATA.cities.forEach(function (c) {
      c.ods.forEach(function (od) {
        var pf = M.profile(od, c.fare);
        var a = M.stepThreshold(pf, 'transit', 'taxi'); if (a !== null) ups.push(a);
        var b = M.stepThreshold(pf, 'bike', 'transit'); if (b !== null) bks.push(b);
      });
    });
    var up = M.median(ups), bk = M.median(bks);
    var n = DATA.cities.reduce(function (s, c) { return s + c.ods.length; }, 0);
    $('headline').innerHTML = '8 座城市 ' + n + ' 条真实通勤：往上买一小时，中位 <b>' + fmt(up, 0)
      + ' 元</b>；往下卖一小时，中位 <b>' + fmt(bk, 1) + ' 元</b> —— 同一个「你」，差 '
      + fmt(up / bk, 0) + ' 倍。';
  }

  function boot() {
    buildChips();
    buildOd();
    renderHeadline();
    var sl = $('hourly');
    sl.value = String(state.hourly);
    sl.addEventListener('input', function () {
      state.hourly = M.num(sl.value, 0, 400, 60);
      render();
    });
    render();
    initMap();
    var rt = null;
    window.addEventListener('resize', function () {
      if (rt) clearTimeout(rt);
      rt = setTimeout(function () { drawMap(current()); }, 220);
    });
  }

  function autostart() { try { boot(); } catch (e) { $('mapmsg').textContent = '启动失败：' + e.message; } }
  if (document.readyState === 'complete') autostart();
  else window.addEventListener('load', autostart);

  window.__minute_boot = boot;
  window.__minute_state = state;
})();
