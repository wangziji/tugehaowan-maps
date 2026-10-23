/* 地球鼓包 · THE BULGE —— 交互与渲染
 * 几何全部来自 model.js；本文件只负责把数字画出来。
 */
(function () {
  'use strict';

  var BM = window.BM;
  var KEY = 'CVIBZ-RDZCD-J3B4T-HGLIP-V7Z2F-EQB5N';

  var CITIES = {
    '北京': [39.9042, 116.4074], '天津': [39.0842, 117.2009], '上海': [31.2304, 121.4737],
    '广州': [23.1291, 113.2644], '哈尔滨': [45.8038, 126.5349], '乌鲁木齐': [43.8256, 87.6168],
    '喀什': [39.4704, 75.9898], '抚远': [48.3717, 134.2894], '拉萨': [29.6520, 91.1721],
    '三亚': [18.2528, 109.5119], '成都': [30.5728, 104.0668], '深圳': [22.5431, 114.0579]
  };

  var PRESETS = [
    { t: '北京 ↔ 天津', a: '北京', b: '天津' },
    { t: '北京 ↔ 上海', a: '北京', b: '上海' },
    { t: '上海 ↔ 乌鲁木齐', a: '上海', b: '乌鲁木齐' },
    { t: '广州 ↔ 哈尔滨', a: '广州', b: '哈尔滨' },
    { t: '喀什 ↔ 抚远（中国东西跨度）', a: '喀什', b: '抚远' },
    { t: '北京 ↔ 它的对跖点', a: '北京', b: null, antipode: true }
  ];

  var REF = [
    { n: '一层楼', m: 3 }, { n: '埃菲尔铁塔', m: 330 }, { n: '上海中心', m: 632 },
    { n: '哈利法塔', m: 828 }, { n: '珠穆朗玛峰', m: 8848.86 },
    { n: '民航巡航高度', m: 10600 }, { n: '国际空间站', m: 420000 }
  ];

  var S = {
    A: { name: '北京', lat: 39.9042, lng: 116.4074 },
    B: { name: '上海', lat: 31.2304, lng: 121.4737 },
    refr: false,
    hKm: 0.05,
    pick: 'A'
  };

  var map = null, markerLayer = null, lineLayer = null, circleLayer = null, mapOK = false;

  /* ---------- 格式化 ---------- */
  function fmtNum(x, dp) {
    if (!isFinite(x)) return '∞';
    var s = Number(x).toFixed(dp === undefined ? 0 : dp);
    var p = s.split('.');
    p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return p.join('.');
  }
  function fmtM(m) {
    if (!isFinite(m)) return '无论多高都看不见';
    if (m < 0.01) return (m * 1000).toFixed(2) + ' 毫米';
    if (m < 1) return (m * 100).toFixed(1) + ' 厘米';
    if (m < 1000) return m.toFixed(m < 10 ? 2 : 1) + ' 米';
    if (m < 1000000) return fmtNum(m / 1000, m < 10000 ? 2 : 1) + ' 公里';
    return fmtNum(m / 1000, 0) + ' 公里';
  }
  function fmtKm(km) {
    if (!isFinite(km)) return '∞';
    if (km < 1) return fmtNum(km * 1000, 0) + ' 米';
    return fmtNum(km, km < 100 ? 1 : 0) + ' 公里';
  }
  function fmtArea(a) {
    if (a < 1) return (a * 1e6).toFixed(0) + ' 平方米';
    if (a < 10000) return fmtNum(a, a < 100 ? 1 : 0) + ' 平方公里';
    if (a < 1e6) return fmtNum(a / 1e4, 2) + ' 万平方公里';
    return fmtNum(a / 1e4, 0) + ' 万平方公里';
  }
  function scaleUp(m) {              // 把米换成人类能想象的东西
    if (!isFinite(m)) return '∞';
    var best = null, ratio = 0;
    for (var i = 0; i < REF.length; i++) {
      var r = m / REF[i].m;
      if (r >= 0.9 && (best === null || Math.abs(Math.log(r)) < Math.abs(Math.log(ratio)))) {
        best = REF[i]; ratio = r;
      }
    }
    if (best && ratio < 1000) return '约 ' + ratio.toFixed(ratio < 10 ? 1 : 0) + ' 个' + best.n;
    if (m >= 1000) return fmtNum(m / 8848.86, 1) + ' 座珠峰';
    return fmtNum(m / 3, 0) + ' 层楼';
  }

  /* ---------- 错误必须可见 ---------- */
  var errEl = null;
  function showErr(msg) {
    if (!errEl) errEl = document.getElementById('err');
    if (!errEl) return;
    errEl.style.display = 'block';
    errEl.innerHTML = msg;
  }
  function clearErr() { if (errEl) { errEl.style.display = 'none'; errEl.innerHTML = ''; } }

  /* ---------- 地图 ---------- */
  /* 用内联 SVG 做标记：外链 demo 图片会 404，控制台会报错，且 A/B 两个点会退化成同样的图标 */
  function pinSVG(color) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="34" viewBox="0 0 26 34">' +
      '<path d="M13 0C5.82 0 0 5.82 0 13c0 9.5 13 21 13 21s13-11.5 13-21C26 5.82 20.18 0 13 0z" ' +
      'fill="' + color + '" stroke="#0b1220" stroke-width="1.6"/>' +
      '<circle cx="13" cy="13" r="4.6" fill="#0b1220"/></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function initMap() {
    var el = document.getElementById('tmap');
    if (!el || typeof TMap === 'undefined') throw new Error('TMap 未定义');
    map = new TMap.Map(el, {
      center: new TMap.LatLng(35.5, 108),
      zoom: 4.2,
      pitch: 0,
      showControl: true
    });
    markerLayer = new TMap.MultiMarker({ map: map, styles: {
      a: new TMap.MarkerStyle({ width: 26, height: 34, anchor: { x: 13, y: 34 }, src: pinSVG('#3ad6f5') }),
      b: new TMap.MarkerStyle({ width: 26, height: 34, anchor: { x: 13, y: 34 }, src: pinSVG('#ff5fb0') })
    }, geometries: [] });
    lineLayer = new TMap.MultiPolyline({ map: map, styles: {
      chord: new TMap.PolylineStyle({ color: '#ff5fb0', width: 3, borderWidth: 1,
        borderColor: '#ff5fb0', lineCap: 'round', dashArray: [8, 6] })
    }, geometries: [] });
    circleLayer = new TMap.MultiCircle({ map: map, styles: {
      sight: new TMap.CircleStyle({ color: 'rgba(58,214,245,0.18)', showBorder: true,
        borderColor: '#3ad6f5', borderWidth: 2 })
    }, geometries: [] });
    map.on('click', onMapClick);
    mapOK = true;
  }

  function onMapClick(evt) {
    var p = { lat: evt.latLng.getLat(), lng: evt.latLng.getLng() };
    p.name = '自选点（' + p.lat.toFixed(3) + ', ' + p.lng.toFixed(3) + '）';
    setPoint(S.pick, p);
    S.pick = (S.pick === 'A') ? 'B' : 'A';
    updatePickHint();
    render();
  }

  function setPoint(which, p) { S[which] = p; }

  function updatePickHint() {
    var el = document.getElementById('pickhint');
    if (el) el.innerHTML = '当前正在设置：<b style="color:var(--cyan)">' + S.pick + ' 点</b>。' +
      '直接点地图任意位置即可；再次点击会设为 ' + (S.pick === 'A' ? 'B' : 'A') + ' 点，之后轮流切换。';
  }

  /* 视野圈半径的安全上限（腾讯地图 GL 把圆采样成多边形，经纬度越界会静默不画） */
  function safeRadiusKm(lat) {
    return (83 - Math.abs(lat)) * 0.90 * 111.19;
  }

  function drawMap(s, view) {
    if (!mapOK) return;
    var gMark = [
      { id: 'A', styleId: 'a', position: new TMap.LatLng(S.A.lat, S.A.lng) },
      { id: 'B', styleId: 'b', position: new TMap.LatLng(S.B.lat, S.B.lng) }
    ];
    markerLayer.setGeometries(gMark);

    lineLayer.setGeometries([{
      id: 'chord',
      styleId: 'chord',
      paths: [new TMap.LatLng(S.A.lat, S.A.lng), new TMap.LatLng(S.B.lat, S.B.lng)]
    }]);

    // 视野圈：以 A 为圆心，半径 = 视距；超安全上限则钳制并在界面上明说
    var want = view.horizonKm;
    var limit = safeRadiusKm(S.A.lat);
    var used = Math.min(want, limit);
    var clamped = want > limit + 0.5;
    try {
      circleLayer.setGeometries([{
        id: 'sight', styleId: 'sight',
        center: new TMap.LatLng(S.A.lat, S.A.lng),
        radius: Math.max(used * 1000, 50)
      }]);
    } catch (e) {
      showErr('视野圈绘制失败（已保留其余结果）：' + e.message);
    }
    if (clamped) {
      showErr('当前高度的视距 ' + fmtKm(want) + ' 超出地图可绘制范围，' +
        '圆已按 ' + fmtKm(used) + ' 绘制，面板中的数字仍是完整值。');
    } else {
      clearErr();
    }

    var bounds = new TMap.LatLngBounds();
    bounds.extend(new TMap.LatLng(S.A.lat, S.A.lng));
    bounds.extend(new TMap.LatLng(S.B.lat, S.B.lng));
    map.fitBounds(bounds, { padding: { top: 70, bottom: 70, left: 70, right: 70 } });
  }

  /* ---------- 剖面示意图 ---------- */
  function drawXS(s) {
    var svg = document.getElementById('xsSvg');
    var info = document.getElementById('xsInfo');
    var note = document.getElementById('xsNote');
    if (!svg) return;

    var X0 = 22, X1 = 238, Y = 150, SPAN = X1 - X0;
    var bulgeM = s.sagittaM;
    var towerFinite = isFinite(s.oneSidedM);
    var towerM = towerFinite ? s.oneSidedM : 0;
    var maxM = Math.max(bulgeM, towerM, 1e-6);
    var E = 95 / maxM;                       // px per meter，同一 E 施加于所有元素
    var bulgePx = Math.max(bulgeM * E, 1.5);
    var towerPx = towerFinite ? towerM * E : 0;

    var theta = s.d / s.R;
    var cosHalf = Math.cos(theta / 2);
    var pts = [];
    for (var i = 0; i <= 60; i++) {
      var u = i / 60;
      var a = (u - 0.5) * theta;
      var hM = Math.max(s.R * (Math.cos(a) - cosHalf) * 1000, 0);
      pts.push((X0 + u * SPAN).toFixed(1) + ',' + (Y - hM * E).toFixed(1));
    }

    var sight = towerFinite && s.d > 0
      ? '<line x1="' + X0 + '" y1="' + (Y - towerPx).toFixed(1) + '" x2="' + X1 +
        '" y2="' + Y + '" stroke="#ff5fb0" stroke-width="1.6" stroke-dasharray="6 4"/>'
      : '';
    var tower = towerFinite && towerPx > 2
      ? '<rect x="' + (X0 - 2.5) + '" y="' + (Y - towerPx).toFixed(1) + '" width="5" height="' +
        towerPx.toFixed(1) + '" fill="#ffc861" opacity=".85"/>'
      : '';

    svg.innerHTML =
      '<defs><linearGradient id="bg1" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#3ad6f5" stop-opacity=".35"/>' +
      '<stop offset="1" stop-color="#3ad6f5" stop-opacity=".05"/></linearGradient></defs>' +
      '<line x1="' + X0 + '" y1="' + Y + '" x2="' + X1 + '" y2="' + Y +
        '" stroke="#61758f" stroke-width="1.4" stroke-dasharray="5 4"/>' +
      '<polygon points="' + pts.join(' ') + ' ' + X1 + ',' + Y + ' ' + X0 + ',' + Y +
        '" fill="url(#bg1)"/>' +
      '<polyline points="' + pts.join(' ') + '" fill="none" stroke="#3ad6f5" stroke-width="2.4"/>' +
      tower + sight +
      '<line x1="130" y1="' + Y + '" x2="130" y2="' + (Y - bulgePx).toFixed(1) +
        '" stroke="#ffc861" stroke-width="2"/>' +
      '<text x="136" y="' + (Y - bulgePx / 2).toFixed(1) + '" fill="#ffc861" font-size="11" ' +
        'font-weight="700">' + fmtM(bulgeM) + '</text>' +
      '<text x="' + X0 + '" y="' + (Y + 16) + '" fill="#8fa3c0" font-size="11">A</text>' +
      '<text x="' + X1 + '" y="' + (Y + 16) + '" fill="#8fa3c0" font-size="11" text-anchor="end">B</text>' +
      '<text x="' + (X0 + 2) + '" y="' + (Y + 32) + '" fill="#61758f" font-size="10">直线（弦）</text>';

    if (info) {
      info.innerHTML =
        '<b>弦长</b>（穿过地下的直线） ' + fmtKm(s.chordKm) + '<br>' +
        '<b>弧长</b>（地表实际距离） ' + fmtKm(s.d) + '<br>' +
        '<b>鼓包</b> ' + fmtM(bulgeM) + '<br>' +
        '<b>单侧需高</b> ' + (towerFinite ? fmtM(s.oneSidedM) : '不可能') + '<br>' +
        '<b>各需高</b> ' + fmtM(s.eachM);
    }
    if (note) {
      var exagg = (E * SPAN / s.d * 1).toFixed(0);
      note.innerHTML = '垂直方向相对水平方向放大约 ' + fmtNum(Number(exagg) * 1000, 0) +
        ' 倍（水平 ' + fmtKm(s.d) + ' 被压成 ' + SPAN + ' px，垂直按同一倍数放大）。' +
        '球面几何是自相似的——这张图的<b>形状</b>在任何距离下几乎一致，真正随距离变化的是刻度上的数字。';
    }
  }

  /* ---------- 主渲染 ---------- */
  function compute() {
    var d = BM.haversine(S.A.lat, S.A.lng, S.B.lat, S.B.lng);
    var s = BM.solve(d, S.refr);
    var v = BM.view(S.hKm, S.refr);
    return { d: d, s: s, v: v };
  }

  function render() {
    var r = compute();
    var s = r.s, v = r.v;

    var big = document.getElementById('bigSag');
    var sub = document.getElementById('bigSagSub');
    if (big) big.textContent = fmtM(s.sagittaM);
    if (sub) {
      sub.innerHTML = S.A.name + ' 到 ' + S.B.name + '，地表距离 <b style="color:var(--txt)">' +
        fmtKm(s.d) + '</b>。<br>两点连线（直线）之下的地面，比这条直线最高处高出这么多。';
    }

    var towerOK = isFinite(s.oneSidedM);
    var rows = [
      ['地表距离', fmtKm(s.d) + '　（直线距离 ' + fmtKm(s.chordKm) + '）'],
      ['中间隆起', '<b>' + fmtM(s.sagittaM) + '</b>　' + scaleUp(s.sagittaM)],
      ['两人各爬多高<br>就能对望', '<b>' + fmtM(s.eachM) + '</b>' +
        (s.d > 0 && Math.abs(s.eachM - s.sagittaM) / s.eachM < 0.01
          ? '　<span style="color:var(--gold)">≈ 鼓包高度</span>' : '')],
      ['只有一人爬<br>需要多高', towerOK ? '<b>' + fmtM(s.oneSidedM) + '</b>' :
        '<b style="color:var(--warn)">无论多高都不可能</b>（需无穷高）'],
      ['平地近似 d²/(8R)', fmtM(s.flatApproxM) + '　<span style="color:var(--dim2)">（精确值 ' +
        fmtM(s.sagittaM) + '）</span>']
    ];
    setKV('kvMain', rows);

    var note = document.getElementById('scaleNote');
    if (note) {
      note.innerHTML = '球面几何有一条反直觉的性质：' +
        (Math.abs(s.eachM - s.sagittaM) / Math.max(s.eachM, 1e-9) < 0.01
          ? '在这个距离上，<b>「两人各爬的高度」几乎正好等于「中间隆起的高度」</b>——两个看起来毫不相干的量，是同一个数。'
          : '距离越大，「各爬高度」与「中间隆起高度」的相等关系越不成立（此处相差 ' +
            (Math.abs(s.eachM - s.sagittaM) / s.eachM * 100).toFixed(1) + '%），页面显示的是各自的精确值。') +
        '　地球按半径 ' + fmtNum(s.R, 0) + ' 公里的正球计算' + (S.refr ? '，已计入大气折射（等效半径 ' +
        fmtNum(s.R, 0) + ' 公里）' : '') + '。';
    }

    var hEl = document.getElementById('hVal');
    if (hEl) hEl.textContent = fmtM(S.hKm * 1000);
    var vrows = [
      ['地平线距离', '<b>' + fmtKm(v.horizonKm) + '</b>'],
      ['能看到的地表', '<b>' + fmtArea(v.areaKm2) + '</b>'],
      ['占地球表面', '<b>' + (v.fraction * 100).toExponential(2) + '%</b>'],
      ['相当于', fmtNum(v.areaKm2 / 16410, 2) + ' 个北京市　' + fmtNum(v.areaKm2 / 9.6e6, 3) + ' 个中国'],
      ['绕赤道人链', '相邻两人都能对望，需要 <b>' + fmtNum(v.people, 0) + '</b> 人']
    ];
    setKV('kvView', vrows);

    drawXS(s);
    drawMap(s, v);
  }

  function setKV(id, rows) {
    var el = document.getElementById(id);
    if (!el) return;
    var html = '';
    for (var i = 0; i < rows.length; i++) {
      html += '<dt>' + rows[i][0] + '</dt><dd>' + rows[i][1] + '</dd>';
    }
    el.innerHTML = html;
  }

  /* ---------- 对照表 ---------- */
  function buildTable() {
    var t = document.getElementById('cmpTable');
    if (!t) return;
    var cases = [
      ['街对面', 0.05], ['1 公里', 1], ['10 公里', 10], ['一场马拉松', 42.195],
      ['北京 ↔ 天津', null, '天津'], ['北京 ↔ 上海', null, '上海'],
      ['北京 ↔ 广州', null, '广州'], ['中国东西跨度（喀什 ↔ 抚远）', null, '抚远', '喀什'],
      ['对跖点（半个地球）', Math.PI * BM.R]
    ];
    var html = '<tr><th>两点之间</th><th>地表距离</th><th>中间隆起</th><th>两人各需爬</th>' +
      '<th>一人需爬</th></tr>';
    for (var i = 0; i < cases.length; i++) {
      var c = cases[i], d;
      if (c[1] !== null && c[1] !== undefined) d = c[1];
      else {
        var a = c[3] ? CITIES[c[3]] : CITIES['北京'];
        var b = CITIES[c[2]];
        d = BM.haversine(a[0], a[1], b[0], b[1]);
      }
      var s = BM.solve(d, false);
      var hi = (i === 5) ? ' class="hi"' : '';
      html += '<tr' + hi + '><td>' + c[0] + '</td><td>' + fmtKm(d) + '</td><td>' +
        fmtM(s.sagittaM) + '</td><td>' + fmtM(s.eachM) + '</td><td>' +
        (isFinite(s.oneSidedM) ? fmtM(s.oneSidedM) : '不可能') + '</td></tr>';
    }
    t.innerHTML = html;
  }

  function buildWow() {
    var el = document.getElementById('wow');
    if (!el) return;
    var s100 = BM.solve(100, false);
    var sBJ_SH = BM.solve(BM.haversine(39.9042, 116.4074, 31.2304, 121.4737), false);
    var sSpan = BM.solve(5200, false);
    var sAnti = BM.solve(Math.PI * BM.R, false);
    var vGround = BM.view(0.0017, false);
    var li = [
      '<b>你和 100 公里外的人之间，地面隆起了 ' + fmtM(s100.sagittaM) + '。</b>' +
      '而你们俩只要各自爬到 ' + fmtM(s100.eachM) + '，就能互相看见——这两个数字是同一个数，' +
      '因为球面上的「弦的矢高」和「两人的视线高度」恰好是同一个公式的两面。',
      '<b>北京到上海 ' + fmtKm(sBJ_SH.d) + '，中间地面隆起 ' + fmtM(sBJ_SH.sagittaM) +
      '，是珠穆朗玛峰的 ' + (sBJ_SH.sagittaM / 8848.86).toFixed(1) + ' 倍。</b>' +
      '你以为两地之间是一马平川，其实中间杵着两座半珠峰厚度的实心地面。',
      '<b>站在平地上，你穷尽目力能看到的地表只有 ' + fmtNum(vGround.areaKm2, 0) + ' 平方公里</b>，' +
      '不到北京朝阳区（约 455 平方公里）的六分之一，占地球总表面积的 ' +
      (vGround.fraction * 100).toExponential(2) + '%。剩下的 99.99999% 全被地球自己的后背挡着。',
      '<b>想从中国最西端一眼望见最东端（约 5200 公里），你得升到 ' + fmtM(sSpan.oneSidedM) + ' 高</b>，' +
      '相当于 ' + fmtNum(sSpan.oneSidedM / 420000, 1) + ' 个国际空间站轨道高度。' +
      '注意：这里用「地表弧长」反解，若误用弦长公式会得到 ' +
      fmtM((Math.sqrt(BM.R * BM.R + 5200 * 5200) - BM.R) * 1000) + '，差出 37%。',
      '<b>你和地球正对面的人之间，隔着 ' + fmtM(sAnti.sagittaM) + ' 的实心地面</b>——那正好是一个地球半径。' +
      '而且无论你爬多高都看不见他：对跖点在数学上需要无穷高的视线。',
      '<b>要让 4301 个人手拉手绕赤道站成一圈、且相邻两人恰好能互相看见</b>，' +
      '每个人的眼睛得离地 1.7 米——这是「地球是圆的」最直观的人数刻度。'
    ];
    var html = '';
    for (var i = 0; i < li.length; i++) html += '<li>' + li[i] + '</li>';
    el.innerHTML = html;
  }

  /* ---------- 地点检索（JSONP，失败必须可见） ---------- */
  function geocode(addr, cb) {
    var cbName = '__bggeo_' + Math.floor(Math.random() * 1e9);
    var done = false;
    var script = document.createElement('script');
    var timer = setTimeout(function () {
      if (!done) { done = true; cleanup(); cb(new Error('地点检索超时，请稍后重试')); }
    }, 8000);
    function cleanup() {
      clearTimeout(timer);
      try { delete window[cbName]; } catch (e) { window[cbName] = undefined; }
      if (script.parentNode) script.parentNode.removeChild(script);
    }
    window[cbName] = function (res) {
      if (done) return; done = true; cleanup();
      if (!res || res.status !== 0 || !res.result || !res.result.location) {
        cb(new Error((res && res.message) ? res.message : '没有检索到这个地点'));
        return;
      }
      cb(null, { lat: res.result.location.lat, lng: res.result.location.lng,
                 name: res.result.title || addr });
    };
    script.onerror = function () {
      if (done) return; done = true; cleanup();
      cb(new Error('地点检索请求失败（可能是网络或 Key 配额）'));
    };
    script.src = 'https://apis.map.qq.com/ws/geocoder/v1/?address=' + encodeURIComponent(addr) +
      '&key=' + KEY + '&output=jsonp&callback=' + cbName;
    document.body.appendChild(script);
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    var pres = document.getElementById('presets');
    if (pres) {
      var html = '';
      for (var i = 0; i < PRESETS.length; i++) {
        html += '<button data-preset="' + i + '">' + PRESETS[i].t + '</button>';
      }
      pres.innerHTML = html;
      pres.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('button[data-preset]') : null;
        if (!b) return;
        var p = PRESETS[Number(b.getAttribute('data-preset'))];
        if (p.antipode) {
          var a = CITIES[p.a];
          S.A = { name: p.a, lat: a[0], lng: a[1] };
          S.B = { name: p.a + '的对跖点', lat: -a[0], lng: a[1] >= 0 ? a[1] - 180 : a[1] + 180 };
        } else {
          var ca = CITIES[p.a], cb2 = CITIES[p.b];
          S.A = { name: p.a, lat: ca[0], lng: ca[1] };
          S.B = { name: p.b, lat: cb2[0], lng: cb2[1] };
        }
        clearErr();
        render();
      });
    }

    var swap = document.getElementById('btnSwap');
    if (swap) swap.addEventListener('click', function () {
      var t = S.A; S.A = S.B; S.B = t; render();
    });

    var refr = document.getElementById('btnRefr');
    if (refr) refr.addEventListener('click', function () {
      S.refr = !S.refr;
      refr.classList.toggle('on', S.refr);
      refr.textContent = S.refr ? '已计入大气折射' : '计入大气折射';
      render();
    });

    var bs = document.getElementById('btnSearch');
    var q = document.getElementById('q');
    function doSearch() {
      var addr = (q && q.value || '').trim();
      if (!addr) { showErr('请先输入一个地点名。'); return; }
      showErr('正在检索「' + addr + '」…');
      geocode(addr, function (err2, p) {
        if (err2) { showErr('检索失败：' + err2.message + '。可改用直接点地图或下方预设。'); return; }
        setPoint(S.pick, p);
        S.pick = (S.pick === 'A') ? 'B' : 'A';
        updatePickHint();
        clearErr();
        render();
      });
    }
    if (bs) bs.addEventListener('click', doSearch);
    if (q) q.addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(); });

    var hr = document.getElementById('hRange');
    if (hr) {
      hr.addEventListener('input', function () {
        // 对数刻度：1 m → 400 km
        var t = Number(hr.value) / 1000;
        S.hKm = Math.pow(10, -3 + t * (Math.log10(400) + 3));
        render();
      });
    }
    var hp = document.querySelectorAll('button[data-h]');
    for (var j = 0; j < hp.length; j++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          S.hKm = Number(btn.getAttribute('data-h'));
          var r2 = document.getElementById('hRange');
          if (r2) r2.value = Math.round((Math.log10(S.hKm) + 3) / (Math.log10(400) + 3) * 1000);
          render();
        });
      })(hp[j]);
    }
  }

  /* ---------- 启动 ---------- */
  function boot() {
    buildTable();
    buildWow();
    bind();
    updatePickHint();
    var hr = document.getElementById('hRange');
    if (hr) hr.value = Math.round((Math.log10(S.hKm) + 3) / (Math.log10(400) + 3) * 1000);
    try {
      initMap();
    } catch (e) {
      // 地图挂了不能让整页静默：明确告诉用户，其余功能照常
      mapOK = false;
      var mf = document.getElementById('mapfail');
      if (mf) mf.style.display = 'block';
      showErr('地图底图初始化失败：' + e.message);
    }
    render();
    return true;
  }

  function autostart() {
    try { boot(); } catch (e) {
      var mf = document.getElementById('mapfail');
      if (mf) mf.style.display = 'block';
      showErr('页面初始化失败：' + (e && e.message ? e.message : String(e)));
      throw e;
    }
  }

  window.__bg_boot = boot;
  window.__bg_state = S;
  window.__bg_compute = compute;

  if (document.readyState === 'complete') autostart();
  else window.addEventListener('load', autostart);
})();
