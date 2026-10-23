/* 《路过 · PASSING BY》模型层：纯函数，无 DOM / 无 SDK 依赖，Node 与浏览器共用。
   核心事实：你每天通勤路过的地方，比你一年真正进去的地方多两个数量级。 */
(function (root) {
  'use strict';

  /* 分类三分法。强目的地 = 你会为了它专门出门的地方；弱目的地 = 你会进去但不会为它出门；
     背景 = 你路过它但它不是"地方"，是城市的填充物。这个分法是本作唯一的口径假设，
     页面上明示，且断言里锁死「三类互斥且穷尽」。 */
  var DEST_STRONG = ['美食', '娱乐休闲', '旅游景点', '购物', '运动健身', '文化场馆', '文化传媒'];
  var DEST_WEAK = ['生活服务', '医疗保健', '教育学校', '教育培训', '银行金融', '机构团体',
    '酒店宾馆', '政府机构及社会团体', '政府机构', '社会团体', '金融保险'];
  var BACKGROUND = ['房产小区', '交通设施', '公司企业', '出入口', '道路附属', '自然地物',
    '地名地址', '基础设施', '汽车', '其它', '室内及附属设施'];

  var WORKDAYS = 250;        // 一年通勤天数（法定工作日约 250）
  var TRIPS_PER_DAY = 2;     // 一天两趟
  var HONGLOU_CHARS = 731017; // 《红楼梦》庚辰本约 73.1 万字，用作荒诞换算的标尺
  var RAD_DEFAULT = 350;     // 采样半径（米），与采集脚本一致

  // 距离分层（米）：贴脸 / 抬头 / 拐个弯
  var BANDS = [
    { id: 'side', name: '就在路边', lo: 0, hi: 60, desc: '推门就进' },
    { id: 'near', name: '抬头可见', lo: 60, hi: 180, desc: '要过条马路' },
    { id: 'far', name: '拐个弯', lo: 180, hi: 1e9, desc: '得绕一下' }
  ];

  function num(v, lo, hi, dft) {
    var x = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(x)) return dft;
    return Math.max(lo, Math.min(hi, x));
  }

  function level1(cat) {
    var s = String(cat || '');
    var i = s.indexOf(':');
    return i < 0 ? (s || '其它') : s.slice(0, i);
  }

  function level2(cat) {
    var s = String(cat || '');
    var p = s.split(':');
    if (p.length >= 2) return p[1];
    return s || '其它';
  }

  function poiClass(cat) {
    var s = String(cat || '');
    for (var i = 0; i < DEST_STRONG.length; i++) if (s.indexOf(DEST_STRONG[i]) === 0) return 'strong';
    for (var j = 0; j < DEST_WEAK.length; j++) if (s.indexOf(DEST_WEAK[j]) === 0) return 'weak';
    for (var k = 0; k < BACKGROUND.length; k++) if (s.indexOf(BACKGROUND[k]) === 0) return 'bg';
    return 'bg';   // 未知分类一律落背景，宁可低估"有意思"，不可虚高
  }

  /* 香农熵（bits）。counts 为各类计数数组；全为 0 时返回 0。 */
  function shannon(counts) {
    var tot = 0, i;
    for (i = 0; i < counts.length; i++) tot += counts[i];
    if (tot <= 0) return 0;
    var h = 0;
    for (i = 0; i < counts.length; i++) {
      if (counts[i] <= 0) continue;
      var p = counts[i] / tot;
      h -= p * Math.log2(p);
    }
    return h;
  }

  /* 单条路线的统计。route = {k, d, t, p, ns, poi:[[id,title,cat,lat,lng,d2r,s],...]} */
  function routeStats(route) {
    var pois = (route && route.poi) || [];
    var nAll = pois.length, nStrong = 0, nWeak = 0, nBg = 0;
    var l1 = {}, l2s = {}, bands = { side: 0, near: 0, far: 0 };
    var chars = 0;
    for (var i = 0; i < pois.length; i++) {
      var p = pois[i];
      var c = poiClass(p[2]);
      if (c === 'strong') nStrong++; else if (c === 'weak') nWeak++; else nBg++;
      var k1 = level1(p[2]);
      l1[k1] = (l1[k1] || 0) + 1;
      if (c === 'strong') {
        var k2 = level2(p[2]);
        l2s[k2] = (l2s[k2] || 0) + 1;
      }
      var dd = num(p[5], 0, 1e7, RAD_DEFAULT);
      if (dd < BANDS[0].hi) bands.side++;
      else if (dd < BANDS[1].hi) bands.near++;
      else bands.far++;
      chars += String(p[1] || '').length;
    }
    var keys = [], i2;
    for (i2 in l2s) if (Object.prototype.hasOwnProperty.call(l2s, i2)) keys.push(l2s[i2]);
    var distKm = Math.max(0.001, num(route.d, 0, 1e7, 0) / 1000.0);
    return {
      k: route.k, d: route.d, t: route.t,
      nAll: nAll, nStrong: nStrong, nWeak: nWeak, nBg: nBg,
      dens: nStrong / distKm,                 // 每公里强目的地数
      H: shannon(keys),                       // 强目的地二级分类多样性（bits）
      bands: bands,
      chars: chars,
      l1: l1, l2s: l2s
    };
  }

  function sortedCats(obj, topN) {
    var arr = [], k;
    for (k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) arr.push([k, obj[k]]);
    arr.sort(function (a, b) { return b[1] - a[1]; });
    return topN ? arr.slice(0, topN) : arr;
  }

  /* 绕行的边际收益：按额外耗时排序，逐条算「比直达多出来的强目的地 / 多花的分钟」。
     返回按 t 升序的路线序列，每条带 dt、dStrong、perMin。 */
  function ladder(routes) {
    if (!routes || !routes.length) return [];
    var arr = routes.slice().sort(function (a, b) { return a.t - b.t; });
    var base = null;
    for (var i = 0; i < arr.length; i++) if (arr[i].k === 0) base = arr[i];
    if (!base) base = arr[0];
    var b = routeStats(base);
    return arr.map(function (r) {
      var s = routeStats(r);
      // WebService 的 duration 单位就是分钟，不要再除 60（踩过：除过一次，perMin 被放大 60 倍还不报错）
      var dt = Math.max(0, r.t - base.t);
      var dStrong = Math.max(0, s.nStrong - b.nStrong);   // 绕行不可能让"目的地"变少（集合只增不减的近似，UI 说清）
      return {
        k: r.k, t: r.t, d: r.d,
        dt: dt, dStrong: dStrong,
        perMin: dt <= 0.0 ? 0 : dStrong / dt,
        st: s
      };
    });
  }

  /* 推荐：在所有「每分钟至少多路过 RATE_MIN 个目的地」的绕行里，取内容收益最大的那条；
     一条都不满足就走直达。返回路线对象与其在阶梯中的序号。 */
  var RATE_MIN = 0.8;
  function recommend(routes, rateMin) {
    var rm = (rateMin === undefined) ? RATE_MIN : num(rateMin, 0, 100, RATE_MIN);
    var ld = ladder(routes);
    if (!ld.length) return { pick: null, idx: -1, ladder: ld, reason: 'no-route' };
    var best = null, bi = -1;
    for (var i = 0; i < ld.length; i++) {
      if (ld[i].dt <= 0.5) continue;                     // 不花时间的不算绕行
      if (ld[i].perMin < rm) continue;
      if (best === null || ld[i].dStrong > best.dStrong) { best = ld[i]; bi = i; }
    }
    if (best === null) {
      var j = 0;
      for (var m = 0; m < ld.length; m++) if (ld[m].dt <= 0.5) j = m;
      return { pick: ld[j], idx: j, ladder: ld, reason: 'no-worth-detour' };
    }
    return { pick: best, idx: bi, ladder: ld, reason: 'detour' };
  }

  /* 一年账：一趟 N 个强目的地，一年 W 天 × T 趟。 */
  function annual(nStrong, workdays, trips) {
    var w = num(workdays, 1, 365, WORKDAYS);
    var tp = num(trips, 1, 10, TRIPS_PER_DAY);
    var perYear = num(nStrong, 0, 1e7, 0) * w * tp;
    return { perTrip: nStrong, workdays: w, trips: tp, perYear: perYear };
  }

  /* 荒诞换算：把一年路过的所有地方的名字连起来，相当于几部《红楼梦》。 */
  function nameScale(charsPerTrip, workdays, trips) {
    var a = annual(charsPerTrip, workdays, trips);
    return { chars: a.perYear, honglou: a.perYear / HONGLOU_CHARS };
  }

  /* 陌生率：用户勾选"我进去过"的 k 个，剩下的就是天天见面从不认识。 */
  function strangerRate(nStrong, known) {
    var n = num(nStrong, 0, 1e7, 0);
    var kk = num(known, 0, n, 0);
    if (n <= 0) return { n: 0, known: 0, unknown: 0, rate: 0 };
    return { n: n, known: kk, unknown: n - kk, rate: (n - kk) / n };
  }

  /* 沿程剖面：把路线按里程分 B 段，统计每段的强目的地数。 */
  function profile(route, segs) {
    var B = Math.round(num(segs, 2, 200, 24));
    var st = routeStats(route);
    var pois = (route && route.poi) || [];
    var d = Math.max(1, num(route.d, 1, 1e7, 1));
    var out = [];
    for (var i = 0; i < B; i++) out.push(0);
    for (var j = 0; j < pois.length; j++) {
      if (poiClass(pois[j][2]) !== 'strong') continue;
      var s = num(pois[j][6], 0, d, 0);
      var b = Math.min(B - 1, Math.floor(s / d * B));
      out[b]++;
    }
    return { bins: out, segs: B, total: st.nStrong };
  }

  var API = {
    DEST_STRONG: DEST_STRONG, DEST_WEAK: DEST_WEAK, BACKGROUND: BACKGROUND,
    WORKDAYS: WORKDAYS, TRIPS_PER_DAY: TRIPS_PER_DAY, HONGLOU_CHARS: HONGLOU_CHARS,
    BANDS: BANDS, RATE_MIN: RATE_MIN,
    num: num, level1: level1, level2: level2, poiClass: poiClass, shannon: shannon,
    routeStats: routeStats, sortedCats: sortedCats, ladder: ladder, recommend: recommend,
    annual: annual, nameScale: nameScale, strangerRate: strangerRate, profile: profile
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.PASSBY = API;
  if (root && root.window && root.window !== root) root.window.PASSBY = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
