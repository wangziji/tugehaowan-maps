/* 静坐时速 · STILL SPEED
   全部天文/物理计算本地化：运行时零接口依赖，腾讯地图 JSAPI GL 只负责底图与取点。
   数值模型为科普级简化（圆轨道、固定银心速度、忽略岁差二阶项），页面已标注。 */
(function () {
  'use strict';

  var DEG = Math.PI / 180, RAD = 180 / Math.PI;
  var KEY = 'CVIBZ-RDZCD-J3B4T-HGLIP-V7Z2F-EQB5N';

  /* ---------- 物理常数 ---------- */
  var R_EARTH = 6378137;                 // m
  var OMEGA = 7.2921159e-5;              // rad/s
  var V_ROT_EQ = OMEGA * R_EARTH;        // 465.10 m/s = 1674.4 km/h（赤道）
  var V_ORBIT = 29.78e3;                 // m/s 地球公转平均
  var V_GAL = 220e3;                     // m/s 太阳系绕银心
  var V_CMB = 369e3;                     // m/s 太阳系相对宇宙微波背景
  var AU = 1.495978707e11;               // m
  var LY = 9.4607304725808e15;           // m

  /* 银道 (l=90,b=0) —— 太阳系绕银心运动方向 */
  var RA_NGP = 192.85948, DE_NGP = 27.12825, L_NCP = 122.93192;
  function galacticToEq(l, b) {
    var lr = l * DEG, br = b * DEG;
    var dN = DE_NGP * DEG;
    var sinD = Math.sin(dN) * Math.sin(br) + Math.cos(dN) * Math.cos(br) * Math.cos((L_NCP - l) * DEG);
    var dec = Math.asin(Math.max(-1, Math.min(1, sinD)));
    var y = Math.cos(br) * Math.sin((L_NCP - l) * DEG);
    var x = Math.cos(dN) * Math.sin(br) - Math.sin(dN) * Math.cos(br) * Math.cos((L_NCP - l) * DEG);
    var ra = RA_NGP + Math.atan2(y, x) * RAD;
    return { ra: ((ra % 360) + 360) % 360, dec: dec * RAD };
  }
  var GAL_EQ = galacticToEq(90, 0);      // ≈ RA 318°, Dec +48.3°（天鹅座方向）
  var CMB_EQ = { ra: 167.9, dec: -6.9 }; // CMB 偶极顶点

  /* ---------- 时间 / 天文 ---------- */
  function jdOf(date) { return date.getTime() / 86400000 + 2440587.5; }
  function lstDeg(date, lng) {
    var d = jdOf(date) - 2451545.0;
    var g = 280.46061837 + 360.98564736629 * d;
    return (((g + lng) % 360) + 360) % 360;
  }
  function sunEclLonDeg(date) {
    var d = jdOf(date) - 2451545.0;
    var L = 280.460 + 0.9856474 * d;
    var g = (357.528 + 0.9856003 * d) * DEG;
    return L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g);
  }
  function eclToEq(lamDeg) {   // 黄纬 0
    var eps = 23.439291 * DEG, l = lamDeg * DEG;
    return {
      ra: ((Math.atan2(Math.sin(l) * Math.cos(eps), Math.cos(l)) * RAD) % 360 + 360) % 360,
      dec: Math.asin(Math.sin(l) * Math.sin(eps)) * RAD
    };
  }

  /* ---------- 坐标变换 ---------- */
  function eqToEnu(raDeg, decDeg, latDeg, lst) {
    var H = (lst - raDeg) * DEG, d = decDeg * DEG, p = latDeg * DEG;
    return {
      E: -Math.cos(d) * Math.sin(H),
      N: Math.sin(d) * Math.cos(p) - Math.cos(d) * Math.sin(p) * Math.cos(H),
      U: Math.sin(d) * Math.sin(p) + Math.cos(d) * Math.cos(p) * Math.cos(H)
    };
  }
  function enuToEq(v, latDeg, lst) {
    var m = Math.hypot(v.E, v.N, v.U) || 1;
    var E = v.E / m, N = v.N / m, U = v.U / m, p = latDeg * DEG;
    var dec = Math.asin(Math.max(-1, Math.min(1, U * Math.sin(p) + N * Math.cos(p))));
    var H = Math.atan2(-E, U * Math.cos(p) - N * Math.sin(p));
    return { ra: (((lst - H * RAD) % 360) + 360) % 360, dec: dec * RAD };
  }

  /* ---------- 速度分解 ---------- */
  // 返回每一层的 ENU 矢量（m/s）
  function layers(lat, lng, date) {
    var lst = lstDeg(date, lng);
    var orbitEq = eclToEq(sunEclLonDeg(date) - 90); // 公转速度方向：日心黄经 +90°
    var vRot = V_ROT_EQ * Math.cos(lat * DEG);
    var out = [
      { id: 'rot', name: '地球自转', sub: '脚下的地带着你向东甩', v: vRot, u: { E: 1, N: 0, U: 0 }, color: '#4dd4ac' },
      { id: 'orbit', name: '绕日公转', sub: '地球沿着黄道跑', v: V_ORBIT, u: eqToEnu(orbitEq.ra, orbitEq.dec, lat, lst), color: '#3aa0ff' },
      { id: 'gal', name: '绕银河系中心', sub: '太阳系 2.3 亿年转一圈', v: V_GAL, u: eqToEnu(GAL_EQ.ra, GAL_EQ.dec, lat, lst), color: '#ff5fb0' }
    ];
    if (state.cmb) out.push({
      id: 'cmb', name: '相对宇宙微波背景', sub: '离谱模式：把宇宙本身当参照物',
      v: V_CMB, u: eqToEnu(CMB_EQ.ra, CMB_EQ.dec, lat, lst), color: '#ffd166'
    });
    return out;
  }
  function totalOf(ls) {
    var v = { E: 0, N: 0, U: 0 };
    for (var i = 0; i < ls.length; i++) {
      v.E += ls[i].v * ls[i].u.E; v.N += ls[i].v * ls[i].u.N; v.U += ls[i].v * ls[i].u.U;
    }
    v.mag = Math.hypot(v.E, v.N, v.U);
    return v;
  }

  /* ---------- 亮星表（中文名 / 星座 / 赤经° / 赤纬°） ---------- */
  var STARS = [
    ['天狼星', '大犬座', 101.287, -16.716], ['老人星', '船底座', 95.988, -52.696],
    ['大角星', '牧夫座', 213.915, 19.182], ['织女星', '天琴座', 279.234, 38.784],
    ['五车二', '御夫座', 79.172, 45.998], ['参宿七', '猎户座', 78.634, -8.202],
    ['南门二', '半人马座', 219.902, -60.834], ['河鼓二（牛郎星）', '天鹰座', 297.696, 8.868],
    ['参宿四', '猎户座', 88.793, 7.407], ['毕宿五', '金牛座', 68.980, 16.509],
    ['心宿二', '天蝎座', 247.352, -26.432], ['角宿一', '室女座', 201.298, -11.161],
    ['北落师门', '南鱼座', 344.413, -29.622], ['天津四', '天鹅座', 310.358, 45.280],
    ['轩辕十四', '狮子座', 152.093, 11.967], ['十字架二', '南十字座', 186.650, -63.099],
    ['北河三', '双子座', 116.329, 28.026], ['水委一', '波江座', 24.429, -57.237],
    ['星宿一', '长蛇座', 141.897, -8.659], ['辇道增七', '天鹅座', 292.680, 27.960],
    ['天津一', '天鹅座', 305.557, 40.257], ['天枢（北斗一）', '大熊座', 165.932, 61.751],
    ['北极星', '小熊座', 37.955, 89.264], ['南河三', '小犬座', 114.825, 5.225],
    ['尾宿八', '天蝎座', 262.663, -37.296], ['马腹一', '半人马座', 210.956, -60.373],
    ['娄宿三', '白羊座', 31.793, 23.463], ['土司空', '鲸鱼座', 10.897, -18.996],
    ['五帝座一', '狮子座', 177.265, 14.572], ['轸宿一', '乌鸦座', 183.952, -17.542]
  ];
  function angDist(ra1, d1, ra2, d2) {
    var s = Math.sin(d1 * DEG) * Math.sin(d2 * DEG) + Math.cos(d1 * DEG) * Math.cos(d2 * DEG) * Math.cos((ra1 - ra2) * DEG);
    return Math.acos(Math.max(-1, Math.min(1, s))) * RAD;
  }
  function nearestStar(ra, dec) {
    var best = null, bd = 1e9;
    for (var i = 0; i < STARS.length; i++) {
      var d = angDist(ra, dec, STARS[i][2], STARS[i][3]);
      if (d < bd) { bd = d; best = STARS[i]; }
    }
    return { name: best[0], con: best[1], dist: bd };
  }

  /* ---------- 预设城市（坐标来自腾讯位置服务 geocoder，GCJ-02） ---------- */
  var CITIES = [
    { k: 'mohe', n: '漠河·北极村', lat: 53.339422, lng: 122.211235 },
    { k: 'urumqi', n: '乌鲁木齐', lat: 43.795220, lng: 87.624200 },
    { k: 'beijing', n: '北京', lat: 39.908823, lng: 116.397470 },
    { k: 'lhasa', n: '拉萨', lat: 29.655278, lng: 91.118320 },
    { k: 'shanghai', n: '上海', lat: 31.234969, lng: 121.487634 },
    { k: 'shenzhen', n: '深圳', lat: 22.522807, lng: 113.935338 },
    { k: 'sanya', n: '三亚', lat: 18.228707, lng: 109.644680 },
    { k: 'sansha', n: '三沙·永兴岛', lat: 16.834372, lng: 112.346961 }
  ];

  /* ---------- 状态 ---------- */
  var state = { lat: 39.908823, lng: 116.397470, city: 'beijing', cmb: false, hour: 12, doy: null };
  (function initTime() {
    var now = new Date();
    state.hour = now.getHours() + now.getMinutes() / 60;
    var start = new Date(now.getFullYear(), 0, 0);
    state.doy = Math.floor((now - start) / 86400000);
    state.year = now.getFullYear();
  })();

  function currentDate() {
    var y = state.year;
    var d = new Date(Date.UTC(y, 0, 1, 0, 0, 0));
    d.setUTCDate(d.getUTCDate() + (state.doy - 1));
    // 用「地方平太阳时」近似：UTC 时刻 = 本地时刻 - 经度/15 小时
    var h = state.hour - state.lng / 15;
    d = new Date(d.getTime() + h * 3600000);
    return d;
  }
  function fmtDate(d) {
    return (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日';
  }

  /* ---------- 格式化 ---------- */
  function grp(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function kmh(ms) { return ms * 3.6; }
  function wan(n) { return (n / 10000).toFixed(n / 10000 >= 100 ? 1 : 2); }

  /* ---------- 计算一次 ---------- */
  function compute(lat, lng, date) {
    var ls = layers(lat, lng, date);
    var v = totalOf(ls);
    var eq = enuToEq(v, lat, lstDeg(date, lng));
    var az = (Math.atan2(v.E, v.N) * RAD + 360) % 360;
    var alt = Math.asin(v.U / (v.mag || 1)) * RAD;
    var star = nearestStar(eq.ra, eq.dec);
    return { ls: ls, v: v, mag: v.mag, az: az, alt: alt, eq: eq, star: star, date: date };
  }

  // 只看「自转 + 公转」的太阳参考系合速度（不叠银河系）
  function solarMag(ls) {
    var E = 0, N = 0, U = 0;
    for (var i = 0; i < ls.length; i++) {
      if (ls[i].id === 'gal' || ls[i].id === 'cmb') continue;
      E += ls[i].v * ls[i].u.E; N += ls[i].v * ls[i].u.N; U += ls[i].v * ls[i].u.U;
    }
    return Math.hypot(E, N, U);
  }

  function scanDay(lat, lng) {
    var g = { max: -1, min: 1e18, maxH: 0, minH: 0 };
    var s = { max: -1, min: 1e18, maxH: 0, minH: 0 };
    var saveH = state.hour, saveD = state.doy;
    for (var i = 0; i < 288; i++) {
      var h = i * 5 / 60;
      state.hour = h;
      var r = compute(lat, lng, currentDate());
      if (r.mag > g.max) { g.max = r.mag; g.maxH = h; }
      if (r.mag < g.min) { g.min = r.mag; g.minH = h; }
      var sm = solarMag(r.ls);
      if (sm > s.max) { s.max = sm; s.maxH = h; }
      if (sm < s.min) { s.min = sm; s.minH = h; }
    }
    state.hour = saveH; state.doy = saveD;
    return { gal: g, solar: s };
  }

  function scanYear(lat, lng) {
    var g = { max: -1, min: 1e18, maxD: 0, minD: 0 };
    var saveH = state.hour, saveD = state.doy;
    state.hour = 12;
    for (var d = 1; d <= 365; d++) {
      state.doy = d;
      var r = compute(lat, lng, currentDate());
      if (r.mag > g.max) { g.max = r.mag; g.maxD = d; }
      if (r.mag < g.min) { g.min = r.mag; g.minD = d; }
    }
    state.hour = saveH; state.doy = saveD;
    return g;
  }

  function doyText(d) {
    var t = new Date(Date.UTC(state.year, 0, 1));
    t.setUTCDate(t.getUTCDate() + (d - 1));
    return (t.getUTCMonth() + 1) + '月' + t.getUTCDate() + '日';
  }

  /* ---------- DOM ---------- */
  function $(id) { return document.getElementById(id); }
  function hhmm(h) {
    var m = Math.round(h * 60); var hh = Math.floor(m / 60) % 24, mm = m % 60;
    return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
  }
  function compassName(az) {
    var names = ['正北', '东北', '正东', '东南', '正南', '西南', '正西', '西北'];
    return names[Math.round(((az % 360) + 360) % 360 / 45) % 8];
  }

  var map = null, marker = null, bands = null;

  function render() {
    var lat = state.lat, lng = state.lng, d = currentDate();
    var r = compute(lat, lng, d);
    var totalKmh = kmh(r.mag);
    var ex = scanDay(lat, lng);
    var ey = scanYear(lat, lng);

    $('speed').textContent = grp(totalKmh);
    $('speedWan').textContent = wan(totalKmh) + ' 万 km/h';
    $('speedMs').textContent = (r.mag / 1000).toFixed(1) + ' km/s';
    $('when').textContent = fmtDate(d) + ' ' + hhmm(state.hour) + '（地方时）';
    $('at').textContent = lat.toFixed(3) + '°N, ' + lng.toFixed(3) + '°E';

    // 分量条
    var maxV = 0;
    for (var i = 0; i < r.ls.length; i++) maxV = Math.max(maxV, r.ls[i].v);
    var html = '';
    for (var j = 0; j < r.ls.length; j++) {
      var L = r.ls[j];
      var pct = (L.v / V_CMB * 100).toFixed(1);
      html += '<div class="bar-row">' +
        '<div class="bar-top"><span class="dot" style="background:' + L.color + '"></span>' +
        '<span class="bname">' + L.name + '</span>' +
        '<span class="bval">' + grp(kmh(L.v)) + ' km/h</span></div>' +
        '<div class="bar"><i style="width:' + pct + '%;background:' + L.color + '"></i></div>' +
        '<div class="bsub">' + L.sub + '</div></div>';
    }
    $('bars').innerHTML = html;

    // 朝向
    $('dirCon').textContent = r.star.con + ' · ' + r.star.name;
    $('dirDist').textContent = '偏离该星 ' + r.star.dist.toFixed(1) + '°';
    $('dirAz').textContent = compassName(r.az) + ' ' + r.az.toFixed(0) + '°';
    var altTxt = r.alt >= 0 ? '抬头 ' + r.alt.toFixed(0) + '°' : '地平线下 ' + (-r.alt).toFixed(0) + '°';
    $('dirAlt').textContent = altTxt;
    $('dirAltNote').textContent = r.alt >= 0
      ? '此刻你正朝着头顶偏' + compassName(r.az) + '的天空飞'
      : '此刻你正朝着脚下那片天空飞 —— 也就是说，地球正把你「按」向相反的方向';
    drawCompass(r.az, r.alt);

    // 今日 / 全年极值
    $('soMax').textContent = grp(kmh(ex.solar.max));
    $('soMin').textContent = grp(kmh(ex.solar.min));
    $('soDiff').textContent = grp(kmh(ex.solar.max - ex.solar.min));
    $('soTime').textContent = hhmm(ex.solar.maxH) + ' 最快 / ' + hhmm(ex.solar.minH) + ' 最慢';

    $('gaMax').textContent = grp(kmh(ex.gal.max));
    $('gaMin').textContent = grp(kmh(ex.gal.min));
    $('gaDiff').textContent = grp(kmh(ex.gal.max - ex.gal.min));
    $('gaTime').textContent = hhmm(ex.gal.maxH) + ' 最快 / ' + hhmm(ex.gal.minH) + ' 最慢';

    $('yrMax').textContent = grp(kmh(ey.max));
    $('yrMin').textContent = grp(kmh(ey.min));
    $('yrDiff').textContent = grp(kmh(ey.max - ey.min));
    $('yrTime').textContent = doyText(ey.maxD) + ' 最快 / ' + doyText(ey.minD) + ' 最慢';

    // 一生里程
    var years = 80;
    var distM = r.mag * years * 365.25 * 86400;
    $('lifeLy').textContent = (distM / LY).toFixed(3);
    $('lifeAu').textContent = grp(distM / AU);

    updateMarker(lat, lng);
  }

  function drawCompass(az, alt) {
    var cx = 62, cy = 62, R = 46;
    var a = az * DEG;
    var len = R * Math.max(0.25, Math.cos(alt * DEG));
    var x = cx + Math.sin(a) * len, y = cy - Math.cos(a) * len;
    var tx = cx + Math.sin(a) * (len - 9), ty = cy - Math.cos(a) * (len - 9);
    var nx = -Math.cos(a) * 5, ny = -Math.sin(a) * 5;
    $('compass').innerHTML =
      '<circle cx="62" cy="62" r="52" fill="#0e1520" stroke="#243141" stroke-width="1"/>' +
      '<circle cx="62" cy="62" r="34" fill="none" stroke="#1b2634" stroke-width="1"/>' +
      '<text x="62" y="17" fill="#61738a" font-size="10" text-anchor="middle">北</text>' +
      '<text x="62" y="113" fill="#61738a" font-size="10" text-anchor="middle">南</text>' +
      '<text x="110" y="66" fill="#61738a" font-size="10" text-anchor="middle">东</text>' +
      '<text x="14" y="66" fill="#61738a" font-size="10" text-anchor="middle">西</text>' +
      '<line x1="62" y1="62" x2="' + x.toFixed(1) + '" y2="' + y.toFixed(1) + '" stroke="#ffd166" stroke-width="3" stroke-linecap="round"/>' +
      '<polygon points="' + (x + Math.sin(a) * 7).toFixed(1) + ',' + (y - Math.cos(a) * 7).toFixed(1) + ' ' +
      (tx + nx).toFixed(1) + ',' + (ty + ny).toFixed(1) + ' ' +
      (tx - nx).toFixed(1) + ',' + (ty - ny).toFixed(1) + '" fill="#ffd166"/>' +
      '<circle cx="62" cy="62" r="3.5" fill="#ffd166"/>';
  }

  /* ---------- 地图 ---------- */
  function bandColors() {
    var out = [];
    for (var i = 0; i < 16; i++) {
      var latC = -75 + i * 10;                 // -75 … +75
      var t = Math.cos(latC * DEG);            // 0 → 1
      var r = Math.round(58 + t * 197), g = Math.round(160 + t * 49), b = Math.round(255 - t * 153);
      out.push({ lat: latC, color: 'rgba(' + r + ',' + g + ',' + b + ',' + (0.07 + t * 0.26).toFixed(3) + ')' });
    }
    return out;
  }
  function initMap() {
    if (typeof TMap === 'undefined') { $('mapfail').style.display = 'block'; $('mapwrap').style.display = 'none'; return; }
    map = new TMap.Map($('map'), {
      center: new TMap.LatLng(30, 105), zoom: 3.2, pitch: 0, rotation: 0,
      baseMap: { type: 'vector', features: ['base', 'building2d', 'point', 'label'] }
    });

    var styles = {}, geos = [], cs = bandColors();
    for (var i = 0; i < cs.length; i++) {
      var o = { color: cs[i].color, showBorder: false, borderWidth: 0 };
      styles['b' + i] = (typeof TMap.PolygonStyle === 'function') ? new TMap.PolygonStyle(o) : o;
      var p = [];
      for (var L = -180; L <= 180; L += 10) p.push(new TMap.LatLng(cs[i].lat - 5, L));
      for (var L2 = 180; L2 >= -180; L2 -= 10) p.push(new TMap.LatLng(cs[i].lat + 5, L2));
      geos.push({ id: 'b' + i, styleId: 'b' + i, paths: p });
    }
    bands = new TMap.MultiPolygon({ id: 'bands', map: map, styles: styles, geometries: geos });

    marker = new TMap.MultiMarker({
      id: 'mk', map: map,
      styles: { s: new TMap.MarkerStyle({ width: 26, height: 34, anchor: { x: 13, y: 34 }, src: pin() }) },
      geometries: [{ id: 'o', styleId: 's', position: new TMap.LatLng(state.lat, state.lng) }]
    });

    map.on('click', function (e) {
      state.lat = e.latLng.getLat(); state.lng = e.latLng.getLng();
      state.city = null; markCity();
      render();
    });
  }
  function pin() {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="34" viewBox="0 0 26 34">' +
      '<path d="M13 0C5.8 0 0 5.8 0 13c0 9.2 13 21 13 21s13-11.8 13-21C26 5.8 20.2 0 13 0z" fill="#ffd166"/>' +
      '<circle cx="13" cy="13" r="5" fill="#0b1017"/></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  function updateMarker(lat, lng) {
    if (!marker) return;
    marker.setGeometries([{ id: 'o', styleId: 's', position: new TMap.LatLng(lat, lng) }]);
  }
  function markCity() {
    var els = document.querySelectorAll('.chip');
    for (var i = 0; i < els.length; i++) els[i].classList.toggle('on', els[i].dataset.k === state.city);
  }

  /* ---------- 交互 ---------- */
  function buildChips() {
    var wrap = $('chips'), html = '';
    for (var i = 0; i < CITIES.length; i++) {
      html += '<button class="chip' + (CITIES[i].k === state.city ? ' on' : '') + '" data-k="' + CITIES[i].k + '">' + CITIES[i].n + '</button>';
    }
    wrap.innerHTML = html;
    var els = wrap.querySelectorAll('.chip');
    for (var j = 0; j < els.length; j++) {
      els[j].onclick = function () {
        var k = this.dataset.k, c = null;
        for (var m = 0; m < CITIES.length; m++) if (CITIES[m].k === k) c = CITIES[m];
        state.lat = c.lat; state.lng = c.lng; state.city = k;
        markCity();
        try { map.panTo(new TMap.LatLng(c.lat, c.lng)); } catch (e) { }
        render();
      };
    }
  }

  function boot() {
    buildChips();
    $('hour').value = Math.round(state.hour * 60);
    $('doy').value = state.doy;
    $('hourTxt').textContent = hhmm(state.hour);
    $('doyTxt').textContent = fmtDate(currentDate());

    $('hour').oninput = function () {
      state.hour = (+this.value) / 60;
      $('hourTxt').textContent = hhmm(state.hour);
      render();
    };
    $('doy').oninput = function () {
      state.doy = +this.value;
      $('doyTxt').textContent = fmtDate(currentDate());
      render();
    };
    $('cmb').onchange = function () { state.cmb = this.checked; render(); };
    $('now').onclick = function () {
      var n = new Date();
      state.hour = n.getHours() + n.getMinutes() / 60;
      var s = new Date(n.getFullYear(), 0, 0);
      state.doy = Math.floor((n - s) / 86400000);
      $('hour').value = Math.round(state.hour * 60);
      $('doy').value = state.doy;
      $('hourTxt').textContent = hhmm(state.hour);
      $('doyTxt').textContent = fmtDate(currentDate());
      render();
    };

    initMap();
    render();
  }

  window.__stillspeed_boot = boot;
})();
