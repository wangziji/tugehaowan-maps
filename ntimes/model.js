/* =====================================================================
 * 《还剩几回 · HOW MANY TIMES LEFT》 模型层
 *
 * 核心命题：把「以后再说」换算成一个数字 —— 这件事你这辈子还会发生几次，
 * 以及这些次数加起来值多少个小时。
 *
 * 数学内核有三层，逐层变严：
 *   1) 单人剩余期望寿命 e(a)：由中国分性别生命表积分得到
 *   2) 两人「都还在世」的期望年数 = ∫ S1(t)·S2(t) dt
 *      —— 不是 min(e1, e2)。因为你也可能会先走。这是本作品最容易被算错的地方。
 *   3) 把年数 × 频次变成「次数」，再变成「小时」，再扣掉路上的小时
 *      —— 决定「值不值」的净数字。
 *
 * 全部计算本地化，对任何 WebService 零依赖。
 * ===================================================================== */

/* ---------------------------------------------------------------
 * 一、原始分年龄死亡率（‰）
 * 来源：China age-specific mortality forecast, 2020 列
 * （Forecasting China's Mortality, Table 2, uc3m e-archivo）
 * 年龄组：0, 1-4, 5-9, 10-14, …, 95-99, 100+
 * --------------------------------------------------------------- */
const RAW_QX = {
  male: [14.61, 0.63, 0.24, 0.20, 0.40, 1.00, 1.38, 1.94, 2.46, 3.22,
         4.17, 5.77, 8.62, 12.94, 20.31, 37.57, 69.31, 177.05, 159.79,
         230.96, 251.81, 422.95],
  female: [24.45, 0.41, 0.14, 0.06, 0.09, 0.20, 0.37, 0.86, 1.54, 2.38,
           3.19, 4.21, 6.43, 6.85, 13.24, 28.10, 52.74, 90.02, 130.08,
           216.81, 225.59, 335.87]
};

// 年龄组的 [起始年龄, 组内年数]
const AGE_GROUPS = [
  [0, 1], [1, 4], [5, 5], [10, 5], [15, 5], [20, 5], [25, 5], [30, 5],
  [35, 5], [40, 5], [45, 5], [50, 5], [55, 5], [60, 5], [65, 5], [70, 5],
  [75, 5], [80, 5], [85, 5], [90, 5], [95, 5], [100, 1]
];

/* ---------------------------------------------------------------
 * 二、标定
 *
 * 原始预报表的死亡率整体停留在 2010 年前后的水平
 * （它积分出的 e(0) 为男 72.75 / 女 76.55，对应六普口径），
 * 而 2020 年七普口径为男 75.37 / 女 80.88。两步修正：
 *
 *  (a) 低龄段直接换成 2020 年实测值 —— 预报表的婴儿死亡率 14.61‰
 *      远高于中国 2020 年实际的 5.4‰，这一项单独就压低 e(0) 约 0.6 岁。
 *  (b) 其余年龄做「年龄平移」：q_new(a) = q_raw(a − δ)。
 *      这是人口学里标准的死亡改善建模方式。
 *      注意不能用「qx 整体乘一个系数」：为凑够 e(0) 需要把死亡率压到 0.29 倍，
 *      结果是 e(65) 被抬到 24 岁（真实值约 16），整条曲线失真。
 *      年龄平移在命中 e(0) 的同时，e(65) 落在 16.1 / 19.9 —— 与真实量级吻合。
 *
 * 低龄死亡率取值：2020 年中国婴儿死亡率 5.4‰（国家卫健委），
 * 按男 : 女 ≈ 1.2 : 1 拆为男 5.9‰ / 女 4.9‰；1–4 岁取 0.5‰ / 0.45‰。
 * --------------------------------------------------------------- */
export const TARGET_E0 = { male: 75.37, female: 80.88 };
export const YOUNG_QX = { male: { q0: 5.9, q14: 0.50 }, female: { q0: 4.9, q14: 0.45 } };

const OMEGA = 101; // 年龄 0..100，100+ 为开口组
const SHIFT_FROM = 5; // 平移只作用于 5 岁及以上

/** 展开成单岁 qx；40 岁以后强制单调不减（修正原始表 80–84 岁的反常回落） */
function expandQx(rates) {
  const q = new Array(OMEGA).fill(NaN);
  AGE_GROUPS.forEach(([start, span], i) => {
    for (let k = 0; k < span; k++) q[start + k] = rates[i] / 1000;
  });
  for (let a = 40; a < OMEGA; a++) {
    if (!isFinite(q[a]) || q[a] < q[a - 1]) q[a] = q[a - 1];
  }
  for (let a = 1; a < 40; a++) if (!isFinite(q[a])) q[a] = q[a - 1];
  return q;
}

/** 由单岁 qx 造生命表，返回 { lx, ex }，ex[a] 为该年龄的期望剩余寿命 */
function makeLifeTable(qx) {
  const lx = new Array(OMEGA + 1).fill(1);
  for (let a = 0; a < OMEGA; a++) lx[a + 1] = lx[a] * (1 - qx[a]);
  // Lx 用梯形近似（年中死亡），因此 ex 自动包含 0.5 年的修正
  const Lx = new Array(OMEGA);
  for (let a = 0; a < OMEGA; a++) Lx[a] = (lx[a] + lx[a + 1]) / 2;
  const Tx = new Array(OMEGA + 1).fill(0);
  for (let a = OMEGA - 1; a >= 0; a--) Tx[a] = Tx[a + 1] + Lx[a];
  const ex = new Array(OMEGA);
  for (let a = 0; a < OMEGA; a++) ex[a] = lx[a] > 0 ? Tx[a] / lx[a] : 0;
  return { lx, ex };
}

/** 按平移量 δ 造一版 qx（δ 允许小数，用线性插值取平移后的死亡率） */
function qxAtShift(sex, delta) {
  const base = expandQx(RAW_QX[sex]);
  const y = YOUNG_QX[sex];
  const rawAt = (x) => base[Math.max(SHIFT_FROM, Math.min(OMEGA - 1, x))];
  const q = new Array(OMEGA);
  q[0] = y.q0 / 1000;
  for (let a = 1; a <= 4; a++) q[a] = y.q14 / 1000;
  for (let a = SHIFT_FROM; a < OMEGA; a++) {
    const x = a - delta;
    const lo = Math.floor(x), hi = lo + 1, f = x - lo;
    q[a] = rawAt(lo) * (1 - f) + rawAt(hi) * f;
  }
  return q;
}

/** 二分求平移量 δ：使积分出的 e(0) 命中官方值 */
function calibrate(sex) {
  const target = TARGET_E0[sex];
  const e0at = (d) => makeLifeTable(qxAtShift(sex, d)).ex[0];
  let lo = 0, hi = 12; // δ 越大越长寿（e0 单调递增）
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (e0at(mid) < target) lo = mid; else hi = mid;
  }
  const delta = (lo + hi) / 2;
  const qx = qxAtShift(sex, delta);
  return { qx, delta, table: makeLifeTable(qx) };
}

export const LIFE = {
  male: calibrate('male'),
  female: calibrate('female')
};

export const CALIB_DELTA = { male: LIFE.male.delta, female: LIFE.female.delta };

/** 把可疑输入收进合法域：未知性别按男性处理，非有限年龄按 0 处理 */
export function normSex(sex) {
  return LIFE[sex] ? sex : 'male';
}
export function normAge(age) {
  const a = Number(age);
  if (!Number.isFinite(a)) return 0;
  return Math.max(0, Math.min(OMEGA - 1, Math.floor(a)));
}

/** 生存函数：从当前年龄 a0 起，再活 t 年的概率（整数 t，线性插值到实数） */
export function survival(sex, age0, t) {
  const { qx } = LIFE[normSex(sex)];
  const a0 = normAge(age0);
  const tt = Number.isFinite(t) ? Math.max(0, t) : 0;
  const k = Math.floor(tt);
  let s = 1;
  for (let i = 0; i < k; i++) {
    const a = a0 + i;
    if (a >= OMEGA - 1) { s *= (1 - qx[OMEGA - 1]); continue; }
    s *= (1 - qx[a]);
  }
  const frac = tt - k;
  if (frac > 0 && a0 + k < OMEGA - 1) s *= (1 - frac * qx[a0 + k]);
  return Number.isFinite(s) ? Math.max(0, s) : 1;
}

/**
 * 单人：期望还能活多少年
 * 用与生命表一致的梯形积分，保证与 ex 表严格自洽
 * 循环硬上限 OMEGA+2 次 —— 防止非有限输入把这里变成死循环
 * （断言脚本 I 组「NaN 输入」正是靠这条拦住的）
 */
export function remainingYears(sex, age) {
  const { qx } = LIFE[normSex(sex)];
  const a0 = normAge(age);
  let s = 1, acc = 0;
  for (let k = 0; k < OMEGA + 2; k++) {
    const a = a0 + k;
    const q = a >= OMEGA - 1 ? qx[OMEGA - 1] : qx[a];
    const sNext = s * (1 - q);
    acc += (s + sNext) / 2;
    s = sNext;
    if (a0 + k >= OMEGA - 1 || s < 1e-9) break;
  }
  return Number.isFinite(acc) ? acc : 0;
}

/**
 * 两人「都还在世」的期望年数 = ∫ S1(t)·S2(t) dt
 *
 * 关键：这不等于 min(e1, e2)。你自己也可能会先走，
 * 而 min 法忽略了这件事，会系统性高估。
 */
export function jointRemainingYears(sexA, ageA, sexB, ageB) {
  const STEP = 0.25; // 四分之一年步长做数值积分
  let acc = 0;
  const HORIZON = 130;
  for (let t = 0; t < HORIZON; t += STEP) {
    const s1 = survival(sexA, ageA, t);
    const s2 = survival(sexB, ageB, t);
    const s1n = survival(sexA, ageA, t + STEP);
    const s2n = survival(sexB, ageB, t + STEP);
    acc += ((s1 * s2) + (s1n * s2n)) / 2 * STEP;
    if (s1 * s2 < 1e-10) break;
  }
  return acc;
}

/* ---------------------------------------------------------------
 * 三、球面距离（Haversine）—— 本地计算，不依赖任何接口
 * --------------------------------------------------------------- */
const R_EARTH = 6371.0088;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

/* ---------------------------------------------------------------
 * 四、主计算
 * --------------------------------------------------------------- */

/**
 * @param {Object} o
 *   youAge, youSex                 你的年龄 / 性别
 *   withPerson                     是否涉及另一个人
 *   otherAge, otherSex             对方年龄 / 性别
 *   perYear                        每年发生几次
 *   hoursEach                      每次真正相处多少小时
 *   travelHoursOneWay              单程路上多少小时
 *   distanceKm                     单程公里数（由地图求得，可为 0）
 * @returns 完整结果对象
 */
/** 取非负值；NaN / 非数字一律归 0，绝不让脏输入穿透到结果里 */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

export function compute(o) {
  const perYear = num(o.perYear);
  const hoursEach = num(o.hoursEach);
  const travelH = num(o.travelHoursOneWay);
  const distKm = num(o.distanceKm);

  // 期望还能发生的年数
  const eYou = remainingYears(o.youSex, o.youAge);
  let years, eOther = null, naiveMin = null;
  if (o.withPerson) {
    eOther = remainingYears(o.otherSex, o.otherAge);
    years = jointRemainingYears(o.youSex, o.youAge, o.otherSex, o.otherAge);
    naiveMin = Math.min(eYou, eOther);
  } else {
    years = eYou;
  }

  // 次数：期望年数 × 年频次
  const times = years * perYear;

  // 相处总小时
  const hoursTogether = times * hoursEach;

  // 路上总小时（每次往返）
  const hoursTravel = times * travelH * 2;

  // 净相处：把路上的时间从「相处」里扣掉
  // 注意语义：路上时间原本就不算相处，这里衡量的是「为了这些相处，你要额外付出多少」
  const hoursNet = hoursTogether - hoursTravel;

  // 频次弹性：每年多一次，能多换多少小时（以及要付出多少路上时间）
  const marginalGainHours = years * hoursEach;
  const marginalCostHours = years * travelH * 2;

  // 累计里程
  const totalKm = times * distKm * 2;

  return {
    years,
    times,
    hoursTogether,
    hoursTravel,
    hoursNet,
    totalKm,
    eYou,
    eOther,
    naiveMin,
    // 天真算法（取 min）会高估多少
    naiveTimes: naiveMin == null ? times : naiveMin * perYear,
    marginalGainHours,
    marginalCostHours,
    // 换算
    daysTogether: hoursTogether / 24,
    daysNet: hoursNet / 24,
    // 「每次多待一小时」vs「每年多回一次」哪个划算
    gainPerExtraHourEach: years * perYear,     // 每次+1h 的总增量
    gainPerExtraTripYear: years * hoursEach    // 每年+1次 的总增量
  };
}

/**
 * 反解：想再攒够 targetHours 小时的「相处」，每年得发生几次？
 * 口径为毛相处时间（不含路上）。用户想的是「我想再陪 500 小时」，
 * 不是「我想再净赚 500 小时」，所以默认用毛口径。
 */
export function tripsNeededFor(o, targetHours) {
  const perYear = num(o.perYear);
  const hoursEach = num(o.hoursEach);
  const target = Number.isFinite(targetHours) ? Math.max(0, targetHours) : 0;
  const years = o.withPerson
    ? jointRemainingYears(o.youSex, o.youAge, o.otherSex, o.otherAge)
    : remainingYears(o.youSex, o.youAge);
  if (hoursEach <= 0 || years <= 0) return { trips: Infinity, delta: Infinity };
  const n = target / (years * hoursEach);
  return { trips: n, delta: n - perYear };
}

/**
 * 反解（净口径）：想「净赚」targetHours 小时，即把路上的时间扣掉后还剩这么多。
 * 当每次往返耗时 ≥ 每次相处时长时，这件事永远做不到 —— 此时返回 Infinity，
 * 绝不返回一个负数让页面一本正经地显示「你每年得回 −3.2 次」。
 */
export function tripsNeededForNet(o, targetHours) {
  const perYear = num(o.perYear);
  const hoursEach = num(o.hoursEach);
  const travelH = num(o.travelHoursOneWay);
  const target = Number.isFinite(targetHours) ? Math.max(0, targetHours) : 0;
  const years = o.withPerson
    ? jointRemainingYears(o.youSex, o.youAge, o.otherSex, o.otherAge)
    : remainingYears(o.youSex, o.youAge);
  if (hoursEach <= 0 || years <= 0) return { trips: Infinity, delta: Infinity };
  const netPerTrip = hoursEach - travelH * 2;
  if (netPerTrip <= 0) return { trips: Infinity, delta: Infinity };
  const n = target / (years * netPerTrip);
  return { trips: n, delta: n - perYear };
}

/* 常用中文城市经纬度（geocoder 不可用时的降级底表） */
export const CITY_FALLBACK = {
  '北京': [39.9042, 116.4074], '上海': [31.2304, 121.4737],
  '广州': [23.1291, 113.2644], '深圳': [22.5431, 114.0579],
  '成都': [30.5728, 104.0668], '重庆': [29.5630, 106.5516],
  '杭州': [30.2741, 120.1551], '南京': [32.0603, 118.7969],
  '武汉': [30.5928, 114.3055], '西安': [34.3416, 108.9398],
  '天津': [39.3434, 117.3616], '苏州': [31.2989, 120.5853],
  '长沙': [28.2282, 112.9388], '郑州': [34.7466, 113.6254],
  '青岛': [36.0671, 120.3826], '沈阳': [41.8057, 123.4315],
  '哈尔滨': [45.8038, 126.5349], '长春': [43.8171, 125.3235],
  '济南': [36.6512, 117.1201], '合肥': [31.8206, 117.2272],
  '福州': [26.0745, 119.2965], '厦门': [24.4798, 118.0894],
  '昆明': [25.0389, 102.7183], '贵阳': [26.6470, 106.6302],
  '南宁': [22.8170, 108.3665], '太原': [37.8706, 112.5489],
  '石家庄': [38.0428, 114.5149], '兰州': [36.0611, 103.8343],
  '南昌': [28.6820, 115.8579], '无锡': [31.4912, 120.3119],
  '宁波': [29.8683, 121.5440], '温州': [27.9945, 120.6994],
  '东莞': [23.0207, 113.7518], '佛山': [23.0215, 113.1215],
  '香港': [22.3193, 114.1694], '台北': [25.0330, 121.5654]
};
