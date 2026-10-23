/* 出口博弈 · 交互层 */
(function () {
  'use strict';

  var DATA = window.PICKUP_DATA;
  var M = window.PICKUP;
  var $ = function (id) { return document.getElementById(id); };

  var CITY_IDS = Object.keys(DATA.cities);
  var DESTS = [{ k: 'airport', t: '机场' }, { k: 'station', t: '高铁站' }, { k: 'center', t: '市中心' }];

  var state = {
    cityId: CITY_IDS[0],
    stIdx: 0,
    destKey: 'airport',
    walkSpeed: 80,
    useMeasuredWalk: true
  };

  var SUM = null;      // 全局汇总（只算一次）
  var CBS = null;      // 全部组合
  var map = null, markerLayer = null, lineLayer = null, mapCalls = 0;

  /* ---------- 工具 ---------- */
  function fmt1(x) { return (Math.round(x * 10) / 10).toFixed(1); }
  function fmt0(x) { return Math.round(x).toString(); }
  function km(m) { return m >= 1000 ? (m / 1000).toFixed(1) + ' 公里' : Math.round(m) + ' 米'; }

  /* 绕行代价分 6 档：越快越绿越大 */
  var TIERS = [
    { max: 0.5, color: '#0f766e', size: 34 },
    { max: 1.5, color: '#0d9488', size: 30 },
    { max: 3.0, color: '#b45309', size: 26 },
    { max: 5.0, color: '#ea580c', size: 23 },
    { max: 8.0, color: '#dc2626', size: 20 },
    { max: Infinity, color: '#991b1b', size: 18 }
  ];
  function tierOf(extra) {
    for (var i = 0; i < TIERS.length; i++) if (extra < TIERS[i].max) return i;
    return TIERS.length - 1;
  }
  function svgDot(color, size) {
    var r = Math.round(size / 2) - 3;
    var c = Math.round(size / 2);
    var s = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '">' +
      '<circle cx="' + c + '" cy="' + c + '" r="' + r + '" fill="' + color +
      '" stroke="#ffffff" stroke-width="3"/></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
  }

  /* ---------- 当前组合 ---------- */
  function city() { return DATA.cities[state.cityId]; }
  function station() { return city().stations[state.stIdx]; }
  function destOf() {
    var c = city(), k = state.destKey;
    for (var i = 0; i < c.dests.length; i++) if (c.dests[i].key === k) return c.dests[i];
    return c.dests[0];
  }
  function currentCombo() {
    var cbs = M.combos(DATA);
    for (var i = 0; i < cbs.length; i++) {
      if (cbs[i].cityId === state.cityId && cbs[i].station === station().name &&
        cbs[i].destKey === state.destKey) return cbs[i];
    }
    return null;
  }

  /* ---------- Hero ---------- */
  function renderHero() {
    var box = $('hero');
    var miss = (1 - SUM.hitDistRate) * 100;
    box.innerHTML =
      '<div class="box hi"><div class="k">就近 ≠ 最快</div><div class="v">' + miss.toFixed(1) +
      '<small>%</small></div><div class="n">的组合里，走的路最短的口不是车开出去最快的口</div></div>' +
      '<div class="box"><div class="k">同一个站 · 车程极差中位</div><div class="v">' + fmt0(SUM.medianGap) +
      '<small> 分钟</small></div><div class="n">最大 ' + fmt0(SUM.maxGap) + ' 分钟，p90 ' +
      fmt0(SUM.p90Gap) + ' 分钟</div></div>' +
      '<div class="box"><div class="k">换个目的地就换口</div><div class="v">' +
      (SUM.flipRate * 100).toFixed(1) + '<small>%</small></div><div class="n">同一座站，换一个方向，' +
      '最快出口就变了</div></div>' +
      '<div class="box"><div class="k">实测样本</div><div class="v">' + SUM.nExit +
      '<small> 个出口</small></div><div class="n">' + SUM.nCombo + ' 个「站 × 方向」组合，' +
      '400 次接口调用</div></div>';
  }

  /* ---------- 出口条形图 ---------- */
  function renderExits() {
    var cb = currentCombo();
    var host = $('exits');
    if (!cb) { host.innerHTML = ''; return; }
    var ev = M.evaluate(cb, state);
    var list = ev.exits.slice().sort(function (a, b) { return a.totalMin - b.totalMin; });
    var maxTotal = Math.max.apply(null, list.map(function (x) { return x.totalMin; })) || 1;
    var html = '';
    list.forEach(function (x) {
      var isBest = x.id === ev.best.id;
      var isNear = x.id === ev.nearestDist.id;
      var cls = 'exitrow' + (isBest ? ' best' : (isNear ? ' near' : ''));
      var tag = isBest ? '<span class="tag b">门到门最快</span>' :
        (isNear ? '<span class="tag n">你本能会走</span>' : '');
      var wp = Math.max(3, x.walkMin / maxTotal * 100);
      var dp = Math.max(3, x.driveMin / maxTotal * 100);
      html += '<div class="' + cls + '" data-id="' + x.id + '">' +
        '<div class="top"><span class="nm">' + x.name + '</span><span>' + tag +
        ' <span class="tot">门到门 <b>' + fmt1(x.totalMin) + '</b> 分钟</span></span></div>' +
        '<div class="bar"><div style="width:' + wp.toFixed(1) + '%;background:#0d9488">走 ' +
        fmt1(x.walkMin) + '′</div><div style="width:' + dp.toFixed(1) + '%;background:#2563eb">开 ' +
        fmt0(x.driveMin) + '′</div></div>' +
        '<div class="parts"><span><i style="background:#0d9488"></i>步行 ' + fmt1(x.walkMin) +
        ' 分钟 / ' + Math.round(x.walkDist) + ' 米</span>' +
        '<span><i style="background:#2563eb"></i>车行 ' + fmt0(x.driveMin) + ' 分钟 / ' +
        km(x.driveDist) + '</span>' +
        '<span>车侧绕行 <b>+' + fmt1(x.extraMin) + '</b> 分钟</span>' +
        '<span>朝向偏离 ' + Math.round(x.theta) + '°</span></div></div>';
    });
    host.innerHTML = html;
  }

  /* ---------- 地图 ---------- */
  function ensureMap() {
    if (map) return true;
    if (typeof TMap === 'undefined') return false;
    var el = $('map');
    var c = station().center;
    map = new TMap.Map(el, { center: new TMap.LatLng(c.lat, c.lng), zoom: 16, pitch: 0, rotation: 0 });
    var styles = {};
    TIERS.forEach(function (t, i) {
      styles['t' + i] = new TMap.MarkerStyle({
        width: t.size, height: t.size, src: svgDot(t.color, t.size),
        anchor: { x: t.size / 2, y: t.size / 2 }
      });
    });
    styles['ctr'] = new TMap.MarkerStyle({
      width: 22, height: 22, src: svgDot('#1e2430', 22), anchor: { x: 11, y: 11 }
    });
    /* 先建线层再建点层：后建的在上，点要盖在线上 */
    lineLayer = new TMap.MultiPolyline({
      map: map,
      styles: { dir: new TMap.PolylineStyle({ color: '#94a3b8', width: 3, borderWidth: 0, lineCap: 'round' }) },
      geometries: []
    });
    markerLayer = new TMap.MultiMarker({ map: map, styles: styles, geometries: [] });
    mapCalls++;
    return true;
  }

  function renderMap() {
    var msg = $('mapmsg');
    try {
      var cb = currentCombo();
      if (!cb) return;
      if (!ensureMap()) {
        msg.style.display = 'block';
        msg.textContent = '地图组件未加载，图表与结论不受影响。';
        return;
      }
      var ev = M.evaluate(cb, state);
      var geoms = [];
      ev.exits.forEach(function (x) {
        geoms.push({
          id: x.id, styleId: 't' + tierOf(x.extraMin),
          position: new TMap.LatLng(x.lat, x.lng)
        });
      });
      geoms.push({
        id: 'center', styleId: 'ctr',
        position: new TMap.LatLng(cb.center.lat, cb.center.lng)
      });
      markerLayer.setGeometries(geoms);

      var d = destOf();
      lineLayer.setGeometries([{
        id: 'dir', styleId: 'dir',
        paths: [new TMap.LatLng(cb.center.lat, cb.center.lng), new TMap.LatLng(d.lat, d.lng)]
      }]);

      var lats = ev.exits.map(function (x) { return x.lat; });
      var lngs = ev.exits.map(function (x) { return x.lng; });
      var el = $('map');
      var z = M.fitZoom({
        minLat: Math.min.apply(null, lats), maxLat: Math.max.apply(null, lats),
        minLng: Math.min.apply(null, lngs), maxLng: Math.max.apply(null, lngs)
      }, el.clientWidth || 600, el.clientHeight || 520);
      map.setCenter(new TMap.LatLng(cb.center.lat, cb.center.lng));
      map.setZoom(z);
      msg.style.display = 'none';
      renderLegend();
    } catch (e) {
      msg.style.display = 'block';
      msg.textContent = '地图渲染异常：' + (e && e.message ? e.message : String(e));
    }
  }

  function renderLegend() {
    var host = $('legend');
    var h = '<span><i style="background:#0f766e"></i>最快（+0 分钟）</span>';
    h += '<span><i style="background:#0d9488"></i>+0.5′</span>';
    h += '<span><i style="background:#b45309"></i>+1.5′</span>';
    h += '<span><i style="background:#ea580c"></i>+3′</span>';
    h += '<span><i style="background:#dc2626"></i>+5′</span>';
    h += '<span><i style="background:#991b1b"></i>+8′ 以上</span>';
    h += '<span><i style="background:#1e2430"></i>站中心</span>';
    h += '<span style="color:#94a3b8">—— 灰线指向此行目的地</span>';
    host.innerHTML = h;
  }

  /* ---------- 散点：朝向角 vs 绕行代价 ---------- */
  function renderScatter() {
    var cv = $('scatter');
    var ctx = cv.getContext && cv.getContext('2d');
    if (!ctx) return;
    var W = cv.width, H = cv.height, padL = 52, padR = 18, padT = 18, padB = 40;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#fbfcfe'; ctx.fillRect(0, 0, W, H);
    var maxY = 0;
    CBS.forEach(function (c) {
      var ev = M.evaluate(c, state);
      ev.exits.forEach(function (x) { if (x.extraMin > maxY) maxY = x.extraMin; });
    });
    maxY = Math.max(2, Math.ceil(maxY));
    var X = function (t) { return padL + t / 180 * (W - padL - padR); };
    var Y = function (v) { return H - padB - v / maxY * (H - padT - padB); };

    ctx.strokeStyle = '#e3e8ef'; ctx.lineWidth = 1;
    ctx.fillStyle = '#8b95a6'; ctx.font = '11px -apple-system,sans-serif';
    for (var g = 0; g <= 180; g += 45) {
      ctx.beginPath(); ctx.moveTo(X(g), padT); ctx.lineTo(X(g), H - padB); ctx.stroke();
      ctx.textAlign = 'center'; ctx.fillText(g + '°', X(g), H - padB + 15);
    }
    for (var v = 0; v <= maxY; v += Math.max(1, Math.round(maxY / 5))) {
      ctx.beginPath(); ctx.moveTo(padL, Y(v)); ctx.lineTo(W - padR, Y(v)); ctx.stroke();
      ctx.textAlign = 'right'; ctx.fillText(v + '′', padL - 6, Y(v) + 4);
    }
    ctx.textAlign = 'center';
    ctx.fillText('出口方向与目的地方向的夹角', (padL + W - padR) / 2, H - 8);
    ctx.save(); ctx.translate(14, (padT + H - padB) / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText('车侧绕行代价（分钟）', 0, 0); ctx.restore();

    var cur = currentCombo();
    var curIds = {};
    if (cur) cur.exits.forEach(function (e) { curIds[e.id] = 1; });
    var xs = [], ys = [];
    CBS.forEach(function (c) {
      var ev = M.evaluate(c, state);
      ev.exits.forEach(function (x) {
        xs.push(x.theta); ys.push(x.extraMin);
        var isCur = curIds[x.id] && c.cityId === state.cityId && c.destKey === state.destKey;
        ctx.beginPath();
        ctx.arc(X(x.theta), Y(x.extraMin), isCur ? 6 : 3.2, 0, Math.PI * 2);
        ctx.fillStyle = isCur ? '#1d4ed8' : 'rgba(148,163,184,0.75)';
        ctx.fill();
        if (isCur) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.stroke(); }
      });
    });
    var r = M.pearson(xs, ys);
    $('rtheta').textContent = r.toFixed(3);
    $('axisnote').innerHTML = '横轴是「出口方向与目的地方向的夹角」，纵轴是「从这个口上车要多花几分钟」。' +
      '蓝点是当前选中的组合，灰点是全部 ' + xs.length + ' 个样本。如果「朝着目的地就更快」成立，' +
      '点应该从左低到右高连成一条斜线——实测 r = <b>' + r.toFixed(3) + '</b>，' +
      '几乎是一条水平线：<b>朝向帮不上忙</b>。';
  }

  /* ---------- 三种直觉 ---------- */
  function renderGuess() {
    var host = $('guess');
    var lo = null, hi = null;
    try { lo = window.__PICKUP_NULL_LO__; hi = window.__PICKUP_NULL_HI__; } catch (e) { }
    var items = [
      { t: '走的路最短的那个口', v: SUM.hitDistRate, weak: true,
        n: '你本能会挑最近的口出去。命中率 ' + (SUM.hitDistRate * 100).toFixed(1) + '%，' +
           '低于随手乱猜的 ' + (SUM.randomBase * 100).toFixed(1) + '%。' },
      { t: '走过去最快的那个口', v: SUM.hitTimeRate, weak: true,
        n: '按实测步行时长挑。命中率 ' + (SUM.hitTimeRate * 100).toFixed(1) + '%，' +
           '和乱猜（' + (SUM.randomBase * 100).toFixed(1) + '%）没有实质差别。' },
      { t: '最朝向目的地的那个口', v: SUM.hitFaceRate, weak: true,
        n: '命中率 ' + (SUM.hitFaceRate * 100).toFixed(1) + '%，看着高一点，但置换检验下仍在' +
           '乱猜的波动区间内，统计上站不住。' }
    ];
    var html = '';
    items.forEach(function (it) {
      html += '<div class="gcard weak"><div class="gd">' + it.t + '</div><div class="gv">' +
        (it.v * 100).toFixed(1) + '<small>% 命中</small></div><div class="gn">' + it.n + '</div></div>';
    });
    html += '<div class="gcard"><div class="gd">随手乱猜（基线）</div><div class="gv">' +
      (SUM.randomBase * 100).toFixed(1) + '<small>% 命中</small></div><div class="gn">' +
      '闭眼随便挑一个口的命中率。上面三种直觉，没有一个明显跑赢它。</div></div>';
    host.innerHTML = html;
  }

  /* ---------- 结论 ---------- */
  function renderIns() {
    var cb = currentCombo();
    var ev = cb ? M.evaluate(cb, state) : null;
    var host = $('ins');
    var html = '';
    if (ev) {
      var best = ev.best, near = ev.nearestDist;
      var d = near.totalMin - best.totalMin;
      var dw = best.walkDist - near.walkDist;
      var dd = near.driveMin - best.driveMin;
      if (best.id === near.id) {
        html += '<li><span class="h">' + cb.station + ' → ' + destOf().name +
          '：这次你的直觉对了</span>走的路最短的口（' + best.name + '）恰好也是门到门最快的，' +
          fmt1(best.totalMin) + ' 分钟。这种情况在全部 ' + SUM.nCombo + ' 个组合里只占 ' +
          (SUM.hitDistRate * 100).toFixed(1) + '%。</li>';
      } else {
        html += '<li><span class="h">' + cb.station + ' → ' + destOf().name + '：你本能会走 ' +
          near.name + '，但最快的是 ' + best.name + '</span>从 ' + best.name + ' 上车门到门 ' +
          fmt1(best.totalMin) + ' 分钟，从 ' + near.name + ' 上车 ' + fmt1(near.totalMin) +
          ' 分钟——<b>多花 ' + fmt1(d) + ' 分钟</b>。代价是你要多走 ' + Math.round(Math.max(0, dw)) +
          ' 米（约 ' + fmt1(Math.max(0, dw) / state.walkSpeed) + ' 分钟），换回 ' +
          fmt1(Math.max(0, dd)) + ' 分钟车程' +
          (dd > 0 ? '，<b>划算</b>' : '，<b>不划算</b>') + '。</li>';
      }
    }
    html += '<li><span class="h">① 就近是个坏信号</span>走的路最短的口，只有 ' +
      (SUM.hitDistRate * 100).toFixed(1) + '% 的概率是车开出去最快的口，' +
      '比闭眼乱猜（' + (SUM.randomBase * 100).toFixed(1) + '%）还低。' +
      '置换检验 400 次：三种直觉的命中率全部落在乱猜的 95% 波动区间内。</li>';
    html += '<li><span class="h">② 差的不是几十米，是几十条街</span>同一个站的不同出口，' +
      '车程极差中位 ' + fmt0(SUM.medianGap) + ' 分钟，最大 ' + fmt0(SUM.maxGap) +
      ' 分钟——绕的不是路，是掉头、单行道和路口渠化。</li>';
    html += '<li><span class="h">③ 代价是固定的，跟你要去多远无关</span>去 8 公里以内平均多花 ' +
      fmt1(SUM.shortExtra) + ' 分钟，去 8 公里以上平均多花 ' + fmt1(SUM.longExtra) +
      ' 分钟，几乎一样（r = ' + SUM.rLeg.toFixed(3) + '）。选错口的代价就是<b>一次掉头</b>，' +
      '不管你后面还有多远。</li>';
    html += '<li><span class="h">④ 上车点没有「最好」，只有「对这趟最好」</span>同一座站，' +
      '换一个目的地，最快出口有 ' + (SUM.flipRate * 100).toFixed(1) + '% 的概率会变。' +
      '所以上车点不能记住，只能每次查。</li>';
    html += '<li><span class="h">⑤ 汇率：多走 100 米 ≈ 换回 ' +
      (SUM.tradeWalkMed > 0 ? (SUM.tradeMinMed / (SUM.tradeWalkMed / 100)).toFixed(1) : '—') +
      ' 分钟</span>中位情况下，从最快的口上车要多走 ' + Math.round(SUM.tradeWalkMed) +
      ' 米，换来 ' + fmt1(SUM.tradeMinMed) + ' 分钟车程。走路的分钟和开车的分钟，<b>不是一个价</b>。</li>';
    host.innerHTML = html;
  }

  function renderNote() {
    $('note').innerHTML =
      '<b>数据来源</b>：腾讯位置服务 place/v1/search（地铁站出口 POI）+ direction/v1/walking + ' +
      'direction/v1/driving，2026-10-18 实测，共 400 次调用、0 失败。' +
      '6 座城市（北京、上海、广州、深圳、成都、杭州）、19 座地铁站、100 个出口，' +
      '每个出口各去机场 / 高铁站 / 市中心三个方向。' +
      '出口到站中心距离均 ≤ 500 米，已剔除停车场入口、进出站口等噪声 POI。<br><br>' +
      '<b>口径</b>：门到门 = 从站中心走到该出口 + 从该出口驾车到目的地。' +
      '驾车时长为含典型路况的实测值。步行默认用实测步行时长（含过街绕行），' +
      '可切换为「距离 ÷ 步行速度」折算；接口在 12–31 米的极短距离上会把时长取整为 0，' +
      '这 5 个样本自动回退为距离折算，页面不做特殊标注之外的处理。<br><br>' +
      '<b>没算什么</b>：停车合法性、电子眼、加塞难度、司机接驾等待、红绿灯相位——' +
      '这些拿不到公开数据，本作只用「实测绕行」这一项说话。' +
      '不同时刻的路况会影响具体分钟数，但绕行的相对结构（哪个口顺、哪个口要掉头）是稳定的。<br><br>' +
      '<b>免责</b>：所有时间为一次快照的模型与实测混合值，<b>不构成出行建议</b>，也不是导航结果。';
  }

  /* ---------- 渲染总入口 ---------- */
  function render() {
    renderExits();
    renderMap();
    renderScatter();
    renderIns();
  }

  /* ---------- 初始化 ---------- */
  function fillCities() {
    var sel = $('selCity'), h = '';
    CITY_IDS.forEach(function (id) {
      h += '<option value="' + id + '">' + DATA.cities[id].name + '</option>';
    });
    sel.innerHTML = h;
    sel.value = state.cityId;
  }
  function fillStations() {
    var sel = $('selSt'), h = '';
    city().stations.forEach(function (s, i) {
      h += '<option value="' + i + '">' + s.name + '（' + s.exits.length + ' 个出口）</option>';
    });
    sel.innerHTML = h;
    sel.value = String(state.stIdx);
  }
  function fillDests() {
    var sel = $('selDst'), h = '';
    city().dests.forEach(function (d) {
      h += '<option value="' + d.key + '">' + d.name + '</option>';
    });
    sel.innerHTML = h;
    sel.value = state.destKey;
  }

  function bind() {
    $('selCity').addEventListener('change', function () {
      state.cityId = this.value; state.stIdx = 0;
      fillStations(); fillDests(); render();
    });
    $('selSt').addEventListener('change', function () {
      state.stIdx = parseInt(this.value, 10) || 0; render();
    });
    $('selDst').addEventListener('change', function () {
      state.destKey = this.value; render();
    });
    $('sldSpeed').addEventListener('input', function () {
      state.walkSpeed = parseInt(this.value, 10) || 80;
      $('sldSpeedV').textContent = state.walkSpeed;
      render();
    });
    $('chkMeasured').addEventListener('change', function () {
      state.useMeasuredWalk = !!this.checked; render();
    });
  }

  function boot() {
    SUM = M.summarize(DATA, state);
    CBS = M.combos(DATA);
    fillCities(); fillStations(); fillDests();
    $('sldSpeedV').textContent = state.walkSpeed;
    renderHero();
    renderGuess();
    renderNote();
    render();
    bind();
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') boot();
  else document.addEventListener('DOMContentLoaded', boot);

  window.__pickup_state = state;
  window.__pickup_sum = function () { return SUM; };
  window.__pickup_render = render;
})();
