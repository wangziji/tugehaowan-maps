/* 祖先洪流 · ANCESTOR FLOOD —— 交互层 */
(function () {
  'use strict';

  var DEFAULT_CENTER = { lat: 39.9087, lng: 116.3975 };   // 北京
  var R_LAND_KM = Math.sqrt(AF.LAND_KM2 / Math.PI);       // 占满全部陆地的等效半径 ≈ 6884 km

  var S = { center: DEFAULT_CENTER, n: 0, genLen: 30, region: 'world', playing: false };
  var map = null, circles = null, marker = null, timer = null;

  function $(id) { return document.getElementById(id); }

  var PIN = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34">' +
    '<circle cx="17" cy="17" r="11" fill="rgba(255,138,76,0.28)"/>' +
    '<circle cx="17" cy="17" r="6.5" fill="#ff8a4c" stroke="#ffffff" stroke-width="2.5"/>' +
    '</svg>');

  /* ---------- 地图 ---------- */
  function initMap() {
    if (typeof TMap === 'undefined') {
      $('map').innerHTML = '<div style="padding:40px;text-align:center;color:#8fa3b8;font-size:13px;' +
        'line-height:2">腾讯地图 JSAPI 未能加载（可能网络受限）。<br>' +
        '下方世代滑块与全部数字计算仍然可用。</div>';
      return false;
    }
    try {
      map = new TMap.Map('map', {
        center: new TMap.LatLng(S.center.lat, S.center.lng),
        zoom: 12, pitch: 0, rotation: 0,
        baseMap: { type: 'vector', features: ['base', 'building2d', 'point', 'label'] }
      });

      circles = new TMap.MultiCircle({
        map: map,
        styles: {
          ghost: new TMap.CircleStyle({
            color: 'rgba(58,160,255,0.55)', showBorder: true,
            borderColor: '#3aa0ff', borderWidth: 1, fillColor: 'rgba(58,160,255,0.05)'
          }),
          now: new TMap.CircleStyle({
            color: '#ff8a4c', showBorder: true,
            borderColor: '#ff8a4c', borderWidth: 2, fillColor: 'rgba(255,138,76,0.15)'
          }),
          land: new TMap.CircleStyle({
            color: '#ff4d5e', showBorder: true,
            borderColor: '#ff4d5e', borderWidth: 3, fillColor: 'rgba(255,45,66,0.22)'
          }),
          /* 半径真实值超过 SDK 可绘制上限时的样式：更重的填充，提示「已经顶到边了」 */
          capped: new TMap.CircleStyle({
            color: '#ff8a4c', showBorder: true,
            borderColor: '#fff0e0', borderWidth: 2, fillColor: 'rgba(255,138,76,0.42)'
          }),
          /* 既溢出（名额超过人口）又顶到绘制上限 */
          landCapped: new TMap.CircleStyle({
            color: '#ff4d5e', showBorder: true,
            borderColor: '#ffd9dd', borderWidth: 2, fillColor: 'rgba(255,45,66,0.40)'
          })
        },
        geometries: []
      });

      marker = new TMap.MultiMarker({
        map: map,
        styles: { me: new TMap.MarkerStyle({ width: 34, height: 34, anchor: { x: 17, y: 17 }, src: PIN }) },
        geometries: []
      });

      map.on('click', function (evt) {
        if (!evt || !evt.latLng) return;
        S.center = { lat: evt.latLng.getLat(), lng: evt.latLng.getLng() };
        render();
      });
      return true;
    } catch (e) {
      console.warn('地图初始化失败', e);
      return false;
    }
  }

  /** 当前中心纬度下，MultiCircle 能安全绘制的半径上限（km）。
      腾讯 GL 的圆是内部采样成多边形实现的：圆越大、越靠近极点，
      采样点的经度越容易越界，构造时会直接抛错 —— 表现为圆静默消失。
      实测（v1.8.2.3）：北京 39.9N 半径 5000km 可画、5729km 抛错；广州 23.1N 6885km 才抛错。
      这里按纬度给出保守上限，留 10% 余量。 */
  function safeRadiusKm(lat) {
    var dMaxDeg = Math.max(0, 83 - Math.abs(lat)) * 0.90;
    return Math.max(400, dMaxDeg * 111.19);
  }

  /** 让圆恰好装进视口的缩放级别 */
  function fitZoom(rKm) {
    var el = $('map');
    var w = (el && el.clientWidth) || window.innerWidth || 900;
    var h = (el && el.clientHeight) || (window.innerHeight * 0.6) || 600;
    var px = Math.min(w, h) * 0.82;
    if (!(rKm > 0)) return 13;
    var mpp = (2 * rKm * 1000) / px;                       // 需要的 米/像素
    var z = Math.log2(156543.03392 * Math.cos(S.center.lat * Math.PI / 180) / mpp);
    return Math.max(3, Math.min(15, z));
  }

  /** 把半径压到可绘制上限；返回实际绘制用的半径与是否被截断 */
  function clampRadius(rKm) {
    var cap = safeRadiusKm(S.center.lat);
    return { rKm: Math.min(rKm, cap), capped: rKm > cap + 0.5, cap: cap };
  }

  function drawMap(c) {
    if (!map || !circles) return;

    // 想要画多大（真实语义半径）vs 实际能画多大（SDK 上限）
    var want = c.overflow ? R_LAND_KM : c.rKm;
    var cl = clampRadius(want);
    var rKm = S.n > 0 ? cl.rKm : 0;

    var geo = [];
    // 上一代的幽灵圆（对比膨胀速度）
    if (S.n >= 2) {
      var p = AF.compute(S.n - 1, S.genLen, S.region);
      if (!p.overflow && p.rKm > 0) {
        geo.push({ styleId: 'ghost', center: new TMap.LatLng(S.center.lat, S.center.lng),
                   radius: clampRadius(p.rKm).rKm * 1000 });
      }
    }
    // 样式的两个维度互相独立：溢出=红、被 SDK 截断=重填充+白描边，所以是四态
    var styleId = c.overflow ? (cl.capped ? 'landCapped' : 'land') : (cl.capped ? 'capped' : 'now');
    if (S.n > 0) {
      geo.push({ styleId: styleId, center: new TMap.LatLng(S.center.lat, S.center.lng), radius: rKm * 1000 });
    }

    var issueMsg = '';
    try { circles.setGeometries(geo); } catch (e) {
      // 不再静默吞掉：半径减半重试一次，仍失败就明确报在界面上
      try {
        circles.setGeometries(geo.map(function (g) { g.radius = g.radius / 2; return g; }));
        issueMsg = '圆形超出地图可表达范围，已按一半半径绘制';
      } catch (e2) {
        issueMsg = '圆形渲染失败：' + (e2 && e2.message ? e2.message : e2);
      }
    }
    markMapIssue(issueMsg || (cl.capped ? '圆形已超出地图可表达范围，边界在屏幕之外' : ''));

    try { marker.setGeometries([{ id: 'me', styleId: 'me', position: new TMap.LatLng(S.center.lat, S.center.lng) }]); } catch (e) { console.warn(e); }
    try {
      map.setCenter(new TMap.LatLng(S.center.lat, S.center.lng));
      map.setZoom(Math.round(fitZoom(rKm) * 10) / 10);   // rKm=0（第 0 代）由 fitZoom 给默认城市视角
    } catch (e) { console.warn(e); }
  }

  /* 把地图层的降级情况显示给用户，而不是只留一条 console.warn */
  function markMapIssue(msg) {
    var el = $('mapNote');
    if (!el) return;
    if (msg) { el.textContent = '⚠ ' + msg; el.style.display = 'block'; }
    else { el.textContent = ''; el.style.display = 'none'; }
  }

  /* ---------- 渲染 ---------- */
  function fmtEarth(e) {
    if (e < 0.01) return '< 0.01 个';
    if (e < 1) return e.toFixed(3) + ' 个';
    if (e < 100) return e.toFixed(2) + ' 个';
    return Math.round(e).toLocaleString('en-US') + ' 个';
  }

  function render() {
    var c = AF.compute(S.n, S.genLen, S.region);
    var isWorld = S.region === 'world';

    $('genN').innerHTML = S.n + ' <small>代</small>';
    $('genShow').textContent = S.n;
    $('genYear').textContent = AF.fmtYear(c.year);
    $('genEra').textContent = c.era;
    $('genRange').value = S.n;

    $('slotNum').textContent = S.n === 0 ? '1' : AF.fmtCN(c.slots);
    $('slotEq').textContent = S.n === 0 ? '2⁰ = 你自己'
      : '2' + sup(S.n) + ' = ' + (c.slots < 1e15 ? Math.round(c.slots).toLocaleString('en-US') : AF.fmtSci(c.slots));

    // 对比条：名额与人口共用一条对数刻度
    var lo = 0, hi = Math.log10(Math.max(c.slots, c.pop) * 1.35);
    function pct(v) { return Math.max(1, Math.min(100, ((Math.log10(v) - lo) / hi) * 100)); }
    $('cmpA').textContent = AF.fmtCN(c.slots);
    $('cmpB').textContent = (isWorld ? '全球 ' : '中国 ') + AF.fmtCN(c.pop) + ' 人';
    $('barA').style.width = pct(c.slots) + '%';
    $('barB').style.width = pct(c.pop) + '%';
    $('ratioTxt').textContent = c.ratio >= 1
      ? ('名额是人口的 ' + (c.ratio < 100 ? c.ratio.toFixed(1) : AF.fmtSci(c.ratio)) + ' 倍')
      : ('1 : ' + AF.fmtSci(c.pop / c.slots).replace(' × 10^', 'e'));
    $('scaleL').textContent = '对数刻度 · 当时人口密度 ' + c.density.toFixed(2) + ' 人/km²';

    // 状态
    var box = $('stateBox');
    if (S.n === 0) {
      box.className = 'state ok';
      box.innerHTML = '这是<b>你</b>。往回一代是父母 2 人，再往回每一代名额翻倍 —— 拖动滑块看它什么时候爆。';
    } else if (!c.overflow) {
      box.className = 'state ok';
      box.innerHTML = '第 <b>' + S.n + '</b> 代要 <b>' + AF.fmtCN(c.slots) + '</b> 个名额，' +
        '当时' + (isWorld ? '全球' : '中国') + '有 <b>' + AF.fmtCN(c.pop) + '</b> 人 —— 还装得下，' +
        '理论上每个人都可以是互不相同的人。';
    } else {
      box.className = 'state bad';
      box.innerHTML = '第 <b>' + S.n + '</b> 代要 <b>' + AF.fmtCN(c.slots) + '</b> 个名额，' +
        '当时' + (isWorld ? '全球' : '中国') + '只有 <b>' + AF.fmtCN(c.pop) + '</b> 人 —— ' +
        '超出 <b>' + (c.ratio < 100 ? c.ratio.toFixed(1) : AF.fmtSci(c.ratio)) + '</b> 倍。<br>' +
        '从这一代起，族谱里必然有人被数了不止一次：<b>它不再是树，是一张网。</b>';
    }

    // 四个格子
    $('radiusV').textContent = S.n === 0 ? '—' : (c.overflow ? '≥ ' + AF.fmtKm(R_LAND_KM) : AF.fmtKm(c.rKm));
    $('areaV').textContent = S.n === 0 ? '—' : AF.fmtArea(c.areaKm2);
    $('densV').textContent = c.density < 0.01 ? c.density.toFixed(4) : c.density.toFixed(2) + ' 人/km²';
    $('earthV').textContent = S.n === 0 ? '—' : fmtEarth(c.areaKm2 / AF.LAND_KM2);

    // 溢出特效
    var on = c.overflow && S.n > 0;
    $('boom').className = on ? 'on' : '';
    $('boomTxt').className = on ? 'on' : '';
    if (on) $('boomBig').textContent = '名额超过' + (isWorld ? '全人类' : '全中国');

    // 炸点标记 & 结论①（随参数联动）
    var wall = AF.wallGeneration(S.genLen, S.region);
    var wc = AF.compute(wall, S.genLen, S.region);
    $('wallTick').textContent = wall + ' · 炸点';
    $('f1n').textContent = wall;
    $('f1a').textContent = AF.fmtCN(wc.slots);
    $('f1b').textContent = AF.fmtCN(wc.pop);

    drawMap(c);
  }

  var SUPS = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
  function sup(n) { return String(n).split('').map(function (d) { return SUPS[d] || d; }).join(''); }

  /* ---------- 交互 ---------- */
  function boot() {
    initMap();
    render();

    $('genRange').addEventListener('input', function (e) {
      S.n = parseInt(e.target.value, 10) || 0;
      stopPlay();
      render();
    });

    $('btnPlay').addEventListener('click', function () {
      if (S.playing) { stopPlay(); return; }
      S.playing = true;
      $('btnPlay').textContent = '⏸ 暂停';
      if (S.n >= 40) S.n = 0;
      timer = setInterval(function () {
        S.n++;
        if (S.n > 40) { stopPlay(); return; }
        render();
      }, 420);
    });

    $('btnHere').addEventListener('click', function () { render(); });

    // 预设锚点（坐标来自腾讯位置服务地址解析，已静态化）
    var chips = $('cityChips');
    if (chips && typeof AF_CITIES !== 'undefined') {
      chips.innerHTML = '';                      // 幂等：重复 boot 不重复堆按钮
      AF_CITIES.forEach(function (ct) {
        var b = document.createElement('button');
        b.textContent = ct.name;
        b.addEventListener('click', function () {
          S.center = { lat: ct.lat, lng: ct.lng };
          render();
        });
        chips.appendChild(b);
      });
    }

    $('btnWorld').addEventListener('click', function () { setRegion('world'); });
    $('btnCN').addEventListener('click', function () { setRegion('cn'); });

    Array.prototype.forEach.call(document.querySelectorAll('[data-gen]'), function (b) {
      b.addEventListener('click', function () {
        S.genLen = parseInt(b.getAttribute('data-gen'), 10);
        Array.prototype.forEach.call(document.querySelectorAll('[data-gen]'), function (x) {
          x.className = (x.getAttribute('data-gen') === String(S.genLen)) ? 'on' : '';
        });
        render();
      });
    });

    window.addEventListener('resize', function () { if (map) render(); });
  }

  function setRegion(r) {
    S.region = r;
    $('btnWorld').className = r === 'world' ? 'on' : '';
    $('btnCN').className = r === 'cn' ? 'on' : '';
    render();
  }

  function stopPlay() {
    S.playing = false;
    if (timer) { clearInterval(timer); timer = null; }
    var b = $('btnPlay');
    if (b) b.textContent = '▶ 播放洪流';
  }

  window.__af_boot = boot;
  window.__af_state = S;

  /* 自启动：必须真的调用，不能只挂到 window 上等人来按。
     （曾经只挂不调 —— 冒烟脚本自己调 boot 所以全绿，真实页面地图却是空白。） */
  function autostart() {
    try { boot(); }
    catch (e) { console.error('boot 失败', e); }
  }
  if (document.readyState === 'complete') autostart();
  else window.addEventListener('load', autostart);
})();
