// ============================================================================
// 拖动物理 —— 移植自 dsh-pet 的 pet/physics.py（webm 桌宠那一套，不是挂件那套）
// ============================================================================
// 行为（与 dsh-pet 的 v1.0.7 一致）：
//   开启后拖动她，她**以过阻尼弹簧跟随鼠标**（K=200 / C=30），有轻微滞后与回弹；
//   松手按**拖拽轨迹估算初速**抛出：重力 1400、撞墙反弹 0.78、地面摩擦衰减，
//   静止后**留在落点**；释放速度低于 500px/s 不抛，原地放下（避免手一抖就飞）。
//
// 常量与纯函数**逐个照搬** physics.py，连注释里的取值依据一起搬过来 ——
// 这样以后对着原程序调参时，两边是同一个坐标系。
//
// ── 为什么需要"接管"而不是"叠加" ──────────────────────────────────────────
//   挂件自己有一套拖拽：它把位置写进**行内** `style.left/top`（express()），
//   松手还会按"吸附区"把她吸到边上。物理模式下这两件事都要让位：
//     · 弹簧跟随  → 位置必须由我们逐帧写
//     · 松手抛掷  → 不能让她先吸边再飞
//   所以物理开启时：挂件的 pointermove **被拦下**（capture 阶段，我们注册得更早），
//   pointerup 也拦下、并补发一个 pointercancel 让它自己把拖拽状态清干净；
//   位置则由一个带 `!important` 的类接管（行内样式打不过 !important）。
//   **pointerdown 不拦** —— 点击弹气泡、按压音效都挂在它上面，拦了就废了。
(function () {
  'use strict'

  var api = window.petApi || {}
  function log(msg) { try { if (api.log) api.log('[物理] ' + msg) } catch (e) {} }

  // ---------------------------------------------------------------- 常量 ----
  // 全部来自 dsh-pet pet/physics.py，注释里的依据也照搬
  var SPRING_K = 200            // 弹簧刚度
  var SPRING_C = 30             // 阻尼（过阻尼：不会来回荡）
  var TRAIL_KEEP_SEC = 0.15     // 轨迹只留这么久
  var RELEASE_WINDOW_SEC = 0.12 // 估算初速时只看最后这么长的一段
  var RELEASE_STALE_SEC = 0.15  // 松手前停顿超过它 = 原地放下
  var MIN_SPAN_SEC = 0.02
  var SEG_MIN_DT = 0.008
  var DEAD_ZONE_SPEED = 500     // 低于它不抛（手抖/慢拖不该飞出去）
  // 甩出速度上限。⚠️ 现在是**按档位取值**（见 THROW_STRENGTH_CAPS），
  //    这个只是"还没读到档位时"的兜底。
  //    参考实现（dsh-pet-indesktop / physics.py）默认档是 standard。
  var MAX_THROW_SPEED = 4800
  // 单步位移上限（px）：超过它就切子步。8px 远小于立绘尺寸，
  // 所以"穿过同伴/穿过墙"这件事在单步内不可能发生。
  var SUBSTEP_MAX_PX = 8

  // ---- 甩出力度档位（移植自 physics.py 的 THROW_STRENGTH_CAPS）----
  // 四档都是"软上限"：不是硬钳，而是 softClampSpeed 的渐近值，
  // 所以同档位里甩得越快仍然越快（不会"甩多快都一样"）。
  var THROW_STRENGTH_CAPS = {
    gentle: 3600,
    standard: 4800,
    strong: 7200,
    crazy: 9000,
  }
  var THROW_STRENGTH_DEFAULT = 'standard'
  function normalizeThrowStrength(v) {
    var k = String(v == null ? '' : v).trim().toLowerCase()
    return Object.prototype.hasOwnProperty.call(THROW_STRENGTH_CAPS, k) ? k : THROW_STRENGTH_DEFAULT
  }
  function throwSpeedCap(strength) {
    return THROW_STRENGTH_CAPS[normalizeThrowStrength(strength)]
  }

  // ---- 弹弓（移植自 physics.py 的 SLINGSHOT_*）----
  // 左键拖拽中按住右键进入蓄力；拉开越远，松左键时射得越快。
  var SLINGSHOT_MIN_DISTANCE = 24      // 拉这么远才开始算蓄力
  var SLINGSHOT_MAX_DISTANCE = 160     // 拉这么远就吃满
  var SLINGSHOT_BASE_SPEED = 900       // 刚过门槛时的速度
  var SLINGSHOT_MAX_DEFORMATION = 1.3  // 方向性形变的最大倍率
  var PEAK_WEIGHT = 0.5         // 端点均速 vs 峰值分段速度的权重
  var ACCEL_REF = 8000
  var ACCEL_GAIN_MAX = 0.6
  var GRAVITY = 1400
  var RESTITUTION = 0.78        // 撞墙能量保留
  var GROUND_FRICTION = 2.5
  var REST_VY = 40
  var REST_VX = 15
  // ⚠️ 这里**故意不加**空气阻力之类的额外衰减 —— 与 dsh-pet 保持逐参数一致。
  //    实测过原程序的 pet/physics.py：一次硬甩（v=3200,-2400）它自己也要 **10.6 秒**
  //    才停，全程在屏幕上弹。这是它的原始行为，不是 bug。
  //    下面这个只是**兜底**：正常情况永远触发不到（自然静止约 10.6s），
  //    只在极端参数下防止"永远弹下去"。
  var MAX_FLIGHT_MS = 12000
  var TICK_MS = 16              // dsh-pet 的 _physics_timer.setInterval(16)
  var DT = 0.016
  var CLICK_SQ = 9              // 与挂件一致的"点击 vs 拖动"阈值（3px）
  // 连点防误甩：松手时**总位移**小于这个值的，哪怕手抖滑得飞快（瞬时速度远超
  // DEAD_ZONE_SPEED）也一律不进抛掷。用户报"连点她到生气的同时，她像被甩出去一样
  // 弹来弹去"—— 根因正是连点时手指在按下期间滑了几像素～十几像素，位移虽小、
  // 时间更短，estimateReleaseVelocity 算出的速度轻易越过死区，于是每次抬起都是一发
  // 抛掷。真甩出去的拖拽位移远大于这个值（100px 起），不受影响。
  var CLICK_THROW_GUARD_PX = 24

  var STORE_KEY = 'dshpet-drag-physics'      // 开关（本插件自己的键，加前缀）
  var POS_KEY = 'dshw-pos'                   // 位置：沿用挂件的格式，重启能恢复

  // ------------------------------------------------------------ 纯函数 ----
  // 软上限：cap*(1-e^(-s/cap))。硬钳会把所有快甩压成同一个速度（"甩多快都一样"），
  // 软膝曲线保证任意力度下速度仍单调可区分，同时渐近不超过 cap。
  function softClampSpeed(speed, cap) {
    if (!(speed > 0)) return 0
    return cap * (1 - Math.exp(-speed / cap))
  }
  // 过阻尼弹簧单轴速度步进（调用方随后 x += v*dt）
  function springVelocity(v, x, target, dt, k, c) {
    return v + ((target - x) * k - v * c) * dt
  }
  function windowSlice(trail, now, span) {
    var cutoff = now - span
    var out = []
    for (var i = 0; i < trail.length; i++) if (trail[i][0] >= cutoff) out.push(trail[i])
    return out
  }
  // 由拖拽轨迹估算松手初速 (vx, vy)
  // 方向：窗口首末端点位移方向（抗抖）
  // 大小：端点平均速度与窗口内峰值分段速度按 PEAK_WEIGHT 加权 ——
  //       弥补纯端点平均对"快甩"的低估（快甩的位移集中在窗口内一小段）
  // 增益：末段仍在加速时按加速度占 ACCEL_REF 的比例放大，最多 ACCEL_GAIN_MAX
  function estimateReleaseVelocity(trail, now, cap) {
    if (!(cap > 0)) cap = MAX_THROW_SPEED
    if (!trail || !trail.length) return [0, 0]
    if (now - trail[trail.length - 1][0] > RELEASE_STALE_SEC) return [0, 0]
    var win = windowSlice(trail, now, RELEASE_WINDOW_SEC)
    if (win.length < 2) return [0, 0]
    var t0 = win[0][0], x0 = win[0][1], y0 = win[0][2]
    var last = win[win.length - 1]
    var t1 = last[0], x1 = last[1], y1 = last[2]
    var span = t1 - t0
    if (span < MIN_SPAN_SEC) return [0, 0]
    var dx = x1 - x0, dy = y1 - y0
    var baseVx = dx / span, baseVy = dy / span
    var baseSpeed = Math.hypot(baseVx, baseVy)
    // 分段速度
    var segs = []
    var pt = t0, px = x0, py = y0
    for (var i = 1; i < win.length; i++) {
      var t = win[i][0], x = win[i][1], y = win[i][2]
      var dt = t - pt
      if (dt >= SEG_MIN_DT) {
        segs.push([Math.hypot(x - px, y - py) / dt, t])
        pt = t; px = x; py = y
      }
    }
    var peakSpeed = baseSpeed
    for (var j = 0; j < segs.length; j++) if (segs[j][0] > peakSpeed) peakSpeed = segs[j][0]
    var accel = 0
    if (segs.length >= 2) {
      accel = (segs[segs.length - 1][0] - segs[0][0]) /
              Math.max(segs[segs.length - 1][1] - segs[0][1], MIN_SPAN_SEC)
    }
    var speed = (1 - PEAK_WEIGHT) * baseSpeed + PEAK_WEIGHT * peakSpeed
    var gain = 1 + Math.min(Math.max(accel, 0) / ACCEL_REF, 1) * ACCEL_GAIN_MAX
    speed = softClampSpeed(speed * gain, cap)
    if (baseSpeed < 1e-6) return [0, speed]
    return [(baseVx / baseSpeed) * speed, (baseVy / baseSpeed) * speed]
  }
  // 抛掷单步积分 + 边界反弹。返回 [px, py, vx, vy, bounced]
  function throwStep(px, py, vx, vy, dt, left, top, right, bottom, gravity) {
    vy += gravity * dt
    px += vx * dt
    py += vy * dt
    var bounced = false
    if (px < left) { bounced = true; vx = Math.abs(vx) * RESTITUTION; px = left }
    else if (px > right) { bounced = true; vx = -Math.abs(vx) * RESTITUTION; px = right }
    if (py < top) { bounced = true; vy = Math.abs(vy) * RESTITUTION; py = top }
    else if (py >= bottom) {
      py = bottom
      vx *= Math.max(0, 1 - GROUND_FRICTION * dt)
      if (Math.abs(vy) < REST_VY) vy = 0
      else vy = -Math.abs(vy) * RESTITUTION
      bounced = true
    }
    return [px, py, vx, vy, bounced]
  }
  // ---- 飞行期动画倍率（移植自 physics.py 的 flight_anim_speed）----
  // 素材 24fps：1400px/s 飞行时每帧位移 ~58px，肉眼就是"频闪/帧数低"。
  // 倍率随速度线性升到 1.75×（等效 ~42fps，每帧位移缩到 ~33px），
  // 静止/低速保持 1× 不变速 —— 被扔出去时"扑腾感"反而更自然。
  function flightAnimSpeed(speedPxS) {
    var v = Math.max(0, Number(speedPxS) || 0)
    return 1 + Math.min(v / GRAVITY, 1) * 0.75
  }

  // ---- 弹弓 ----
  // 方向性形变：把"拉伸/压缩"投影到轴上，所以**换拉拽角度不会在两个不连续的
  // 分支之间跳变**（参考实现特意这么做的）。返回 [scaleX, scaleY]。
  function slingshotDeformation(pullX, pullY, progress, maximum) {
    var prog = Math.max(0, Math.min(1, Number(progress) || 0))
    var maxd = Math.max(1, Number(maximum) || SLINGSHOT_MAX_DEFORMATION)
    var dist = Math.hypot(Number(pullX) || 0, Number(pullY) || 0)
    if (dist <= 1e-6 || prog <= 0) return [1, 1]
    var ux = pullX / dist, uy = pullY / dist
    var stretch = 1 + (maxd - 1) * prog
    var squeeze = 1 - (1 - 1 / maxd) * prog
    return [Math.hypot(stretch * ux, squeeze * uy), Math.hypot(stretch * uy, squeeze * ux)]
  }

  // 拉拽距离 → 发射速度：先 ease-out 到接近 3×cap，再过软上限。
  // 门槛以内返回 0（等于没蓄力，不会误射）。
  function slingshotSpeed(distance, minimum, maximum, cap) {
    var d = Number(distance) || 0
    var lo = (minimum == null) ? SLINGSHOT_MIN_DISTANCE : minimum
    var hi = (maximum == null) ? SLINGSHOT_MAX_DISTANCE : maximum
    var c = (cap > 0) ? cap : MAX_THROW_SPEED
    if (d < lo || hi <= lo || !(c > 0)) return 0
    var u = Math.max(0, Math.min(1, (d - lo) / (hi - lo)))
    var eased = 1 - (1 - u) * (1 - u)
    var raw = SLINGSHOT_BASE_SPEED + (3 * c - SLINGSHOT_BASE_SPEED) * eased
    return softClampSpeed(raw, c)
  }

  // 抛物线预测点（相对发射点的偏移），给"预测轨迹"画线用。
  function slingshotTrajectory(vx, vy, duration, points, gravity) {
    var dur = (duration == null) ? 0.8 : duration
    var n = (points == null) ? 12 : points
    var g = (gravity == null) ? GRAVITY : gravity
    if (!(dur > 0) || n <= 0) return []
    if (n === 1) return [[0, 0]]
    var step = dur / (n - 1)
    var out = []
    for (var i = 0; i < n; i++) {
      var t = i * step
      out.push([vx * t, vy * t + 0.5 * g * t * t])
    }
    return out
  }

  function isAtRest(py, vx, vy, bottom, bounced, speed) {
    if (py >= bottom - 1 && Math.abs(vy) < 1 && Math.abs(vx) < REST_VX) return true
    return !!(bounced && speed < REST_VY && Math.abs(vy) < 1)
  }

  // ---- 甩出力度档位（持久化）----
  // 键名带项目前缀，不和挂件/别的插件撞。
  var THROW_STRENGTH_KEY = 'dshpet-throw-strength'
  function getThrowStrength() {
    try { return normalizeThrowStrength(localStorage.getItem(THROW_STRENGTH_KEY)) } catch (e) { return THROW_STRENGTH_DEFAULT }
  }
  function setThrowStrength(v) {
    var k = normalizeThrowStrength(v)
    try { localStorage.setItem(THROW_STRENGTH_KEY, k) } catch (e) {}
    log('甩出力度档位 → ' + k + '（上限 ' + throwSpeedCap(k) + ' px/s）')
    return k
  }

  // ------------------------------------------------------------ 状态 ----
  var enabled = true
  var root = null
  var drag = null            // { startX, startY, origLeft, origTop, moved, w, h }
  var trail = []             // [t, x, y]
  var physPos = [0, 0]
  var physVel = [0, 0]
  var mode = null            // null | 'drag' | 'throw'
  var timer = null
  var dragTarget = [0, 0]
  var throwElapsed = 0       // 本次抛掷已经飞了多久（配合 MAX_FLIGHT_MS 兜底）
  var suppressCancel = false // 我们自己补发的 pointercancel 不要再被当成用户的

  function readEnabled() {
    try {
      var v = localStorage.getItem(STORE_KEY)
      return v === null ? true : v === '1'    // 默认开
    } catch (e) { return true }
  }
  function writeEnabled(v) {
    try { localStorage.setItem(STORE_KEY, v ? '1' : '0') } catch (e) {}
  }

  // 位置接管。
  //
  // ⚠️⚠️ **绝不能走 CSS 自定义属性（--xxx）—— 那是"拖动一卡一卡"的真正原因。**
  //
  //    CSS 自定义属性是**继承**的：在 .dshwv-root 上改一个 --dshpet-px，
  //    浏览器必须让**整棵子树**的样式失效重算。鲸鱼的 DOM 有几百个节点
  //    （气泡 SVG、菜单、面板、角色列表…），于是每帧都在做一次全子树重算 ——
  //    鼠标事件一秒几十上百个，就是明显的掉帧。
  //
  //    挂件原生拖动是 `root.style.left = ...`，**只写根节点自己的 left**，
  //    重算范围小得多 —— 所以"原来好好的"。
  //
  //    正确写法：`style.setProperty('left', 值, 'important')`
  //    —— 行内 + !important。既和挂件一样只动 left，又不会被挂件的 express()
  //    （它写的是行内、非 important）盖掉。
  function ensureOverrideCss() {
    if (document.getElementById('dshpet-phys-css')) return
    var st = document.createElement('style')
    st.id = 'dshpet-phys-css'
    st.textContent = [
      // 只保留"掐掉 left/top 过渡"这一条 —— 位置本身由行内 !important 负责，
      // 不在这里写 left/top，避免多一层样式来源。
      '.dshwv-root.dshpet-phys{transition:transform .3s ease !important}',
      '.dshpet-phys-row{display:flex;align-items:center;gap:6px;margin:5px 0;color:#203170;font-size:12px;white-space:nowrap}',
      '.dshpet-phys-row input{width:16px;height:16px;accent-color:#203170;cursor:pointer;flex:0 0 auto}',
      '.dshpet-phys-hint{color:#9fb0d9;font-size:11px}',
    ].join('')
    document.head.appendChild(st)
  }

  // --------------------------------------------------------------------------
  // 实体约束：她**不能和别的桌宠有任何重合**
  // --------------------------------------------------------------------------
  // 用户的要求：桌宠是有实体的，不能穿过另一只；边缘一碰到就弹开；
  // 任何时刻都不许有重合部分。
  //
  // ⚠️⚠️ **为什么必须是"事前拦住"而不是"事后推开"：**
  //    事后推开（主进程每 30ms 把所有重叠对分开）永远会**先叠上**再被分开 ——
  //    拖动一快，一次上报间隔就能叠进去几十像素，用户看到的就是"重合之后才弹开"。
  //    所以这里做在**位置写入的唯一出口**（applyOverride）上：
  //    任何一条路（拖拽 / 抛掷 / 被推 / 采纳挂件位置 / 落座）算出来的新位置，
  //    只要会和同伴重叠，就**当场被挡住** —— 于是"重合"这件事根本不会发生。
  //
  // 挡住的方式是"按上一帧我在同伴的哪一侧，把这一侧贴回去"（而不是取最短分离轴）：
  //    取最短分离轴在**穿过去**的时候会把你推到另一侧（看起来就是穿模了），
  //    按上一帧的方位贴回去则永远不会穿过去。
  var SOLID_GAP = 1          // 实体之间保留的缝（像素）。1px 肉眼看不出来，但保证"不重合"
  var lastSolidPos = null    // 上一次**已确认不和任何人重叠**的位置
  var solidBlocked = false   // 这一帧有没有被同伴挡住（给"碰上了"的反馈用）
  function solidPeers() {
    var a = window.__dshpetPeers
    return (a && a.length) ? a : null
  }
  function rectOf(pos, a) {
    return { l: pos[0] + a.dx, t: pos[1] + a.dy, r: pos[0] + a.dx + a.w, b: pos[1] + a.dy + a.h }
  }
  function overlapsAny(m, ps) {
    for (var i = 0; i < ps.length; i++) {
      var q = ps[i]
      if (!q || !(q.w > 0) || !(q.h > 0)) continue
      if (m.l < q.x + q.w && q.x < m.r && m.t < q.y + q.h && q.y < m.b) return true
    }
    return false
  }
  // 把一个和同伴重叠的矩形推到"贴着同伴但不重叠"的位置。
  // 四个方向各算一个候选，然后按 **① 优先"上一帧所在的那一侧" ② 其次"推得最少"
  // ③ 必须落在工作区内** 来挑 —— 三个条件缺一不可：
  //   · 只看"上一帧在哪一侧" → 被顶到屏幕边上时会让不开（被推到界外）
  //   · 只看"推得最少" → 一次跳很远时会从**对面**出来（穿模）
  //   · 不看工作区 → 她会被同伴顶出屏幕
  function pushOut(m, ref, p, ab) {
    var pl = p.x - SOLID_GAP, pt = p.y - SOLID_GAP
    var prr = p.x + p.w + SOLID_GAP, pb = p.y + p.h + SOLID_GAP
    var w = m.r - m.l, h = m.b - m.t
    // 上一帧在同伴的哪一侧（没有上一帧就四个都算"不是那一侧"）
    var refLeft = !!ref && ref.r <= pl + 0.01
    var refRight = !!ref && ref.l >= prr - 0.01
    var refUp = !!ref && ref.b <= pt + 0.01
    var refDown = !!ref && ref.t >= pb - 0.01
    var cands = [
      { m: { l: pl - w, t: m.t, r: pl, b: m.b }, d: Math.abs(m.l - (pl - w)), pref: refLeft },
      { m: { l: prr, t: m.t, r: prr + w, b: m.b }, d: Math.abs(prr - m.l), pref: refRight },
      { m: { l: m.l, t: pt - h, r: m.r, b: pt }, d: Math.abs(m.t - (pt - h)), pref: refUp },
      { m: { l: m.l, t: pb, r: m.r, b: pb + h }, d: Math.abs(pb - m.t), pref: refDown },
    ]
    var ok = [], any = []
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i]
      any.push(c)
      var r = c.m
      if (r.l >= ab.l - 0.5 && r.r <= ab.r + 0.5 && r.t >= ab.t - 0.5 && r.b <= ab.b + 0.5) ok.push(c)
    }
    var pool = ok.length ? ok : any          // 一个都不在界内 → 只好退而求其次
    pool.sort(function (x, y) {
      if (x.pref !== y.pref) return x.pref ? -1 : 1
      return x.d - y.d
    })
    return pool[0].m
  }
  function resolveSolid(pos) {
    solidBlocked = false
    // ⚠️⚠️ **第一只桌宠"撞不动"。**
    //    用户要求："第一个桌宠不能被弹走，保持在右下角"。
    //    别人撞过来时，让开的是**别人**（它的 resolveSolid 会把自己挡开）；
    //    她这一侧直接放行，位置一点不动。
    //    例外：**用户正在拖她** —— 那是你在移动她，该被同伴挡住还是要挡
    //    （不然就能拖着她穿过别人了）。
    //    isExtra 由 pet-collide 问主进程拿到后挂到 window 上；还没拿到时按
    //    "可以推"处理 —— 启动那几十毫秒里本来也还没有同伴。
    if (window.__dshpetIsExtra === false && !drag) return pos
    var ps = solidPeers()
    // ⚠️ 同伴列表还没有的时候**不能把当前位置记成"上次合法位置"** ——
    //    启动那会儿列表本来就是空的（主进程要等两只都报过尺寸才广播），
    //    而那时新开的那只还停在默认位置、和第一只**完全重合**。
    //    记下去的话，等列表到了以后"退回上一帧"就永远退到一个重叠位置，
    //    表现为"怎么都不分开"（实测就是这个：两只叠着 135px 不动）。
    if (!ps) { lastSolidPos = null; return pos }
    var a = artOffset()
    if (!a || !a.w || !a.h) { lastSolidPos = null; return pos }
    var m = rectOf(pos, a)
    var prev = lastSolidPos
    var pr = prev ? rectOf(prev, a) : null
    // 工作区换算到**立绘**坐标：四个方向都要拿它判断"推过去会不会出界"
    var bb = bounds()
    var ab = { l: bb.left + a.dx, r: bb.right + a.dx, t: bb.top + a.dy, b: bb.bottom + a.dy }
    for (var pass = 0; pass < 3; pass++) {
      var moved = false
      for (var i = 0; i < ps.length; i++) {
        var p = ps[i]
        if (!p || !(p.w > 0) || !(p.h > 0)) continue
        var pl = p.x - SOLID_GAP, pt = p.y - SOLID_GAP
        var prr = p.x + p.w + SOLID_GAP, pb = p.y + p.h + SOLID_GAP
        if (!(m.l < prr && pl < m.r && m.t < pb && pt < m.b)) continue
        m = pushOut(m, pr || null, p, ab)
        moved = true
        solidBlocked = true
      }
      if (!moved) break
    }
    // 兜底：**万一还是重叠**（比如被夹在墙和同伴中间，怎么让都让不开），
    //       就退回上一帧那个已确认合法的位置 —— 宁可这一帧不动，也绝不出现重合。
    if (overlapsAny(m, ps)) {
      solidBlocked = true
      if (prev && !overlapsAny(rectOf(prev, a), ps)) return [prev[0], prev[1]]
      // 连"上一帧"都不可用 → 至少别往重叠里走：原地不动
      return prev ? [prev[0], prev[1]] : pos
    }
    var out = [m.l - a.dx, m.t - a.dy]
    lastSolidPos = [out[0], out[1]]
    return out
  }

  function applyOverride() {
    if (!root) return
    // 防御：NaN / Infinity 写进 CSS 会让整条声明失效，她会瞬间跳回挂件记的位置。
    if (!isFinite(physPos[0]) || !isFinite(physPos[1])) {
      log('位置出现非法值，已忽略该帧：' + physPos[0] + ',' + physPos[1])
      return
    }
    root.classList.add('dshpet-phys')
    // ⚠️ **写之前无条件再夹一次。** 这是"她跑到任务栏下面"的最后一道闸：
    //    physPos 可能来自好几条路（拖拽 / 抛掷 / 采纳挂件的值 / 启动时的摆放），
    //    任何一条路上出现异常值（比如立绘还没量到尺寸、bounds 退化成整块工作区），
    //    都会让她越界。夹在这里，就**无论从哪条路来都越不过去**。
    var cb = clampToBounds(physPos)
    physPos = [cb[0], cb[1]]
    // ⚠️ 再夹一次"不许和同伴重合"。夹完可能又被推出工作区（比如被同伴顶到边上），
    //    所以这两步要来回几轮才收敛。
    for (var k = 0; k < 3; k++) {
      var before = [physPos[0], physPos[1]]
      physPos = resolveSolid(physPos)
      physPos = clampToBounds(physPos)
      if (Math.abs(physPos[0] - before[0]) < 0.01 && Math.abs(physPos[1] - before[1]) < 0.01) break
    }
    physPos = resolveSolid(physPos)
    // 行内 !important：范围最小（只动 left/top），优先级最高（压得住挂件的 express）
    root.style.setProperty('left', Math.round(physPos[0]) + 'px', 'important')
    root.style.setProperty('top', Math.round(physPos[1]) + 'px', 'important')
  }
  function releaseOverride() {
    if (!root) return
    root.classList.remove('dshpet-phys')
    root.style.removeProperty('left')
    root.style.removeProperty('top')
  }

  // 读她现在在哪（首次接管时用；之后由 physPos 说了算）
  function syncFromDom() {
    if (!root) return false
    var r = root.getBoundingClientRect()
    if (!r || !r.width) return false
    physPos = [r.left, r.top]
    return true
  }

  // 把落点写回挂件的位置存储（它重启时按"锚点 + 离边距离"恢复）
  function persistPosition() {
    try {
      // ⚠️⚠️ **多开出来的桌宠不许写这个键。**
      //    `dshw-pos` 是**挂件自己**在启动时读的（读的那头在挂件里，我们这边只有写）——
      //    多开的每一只都写同一个键的话，**互相覆盖**，重启后第一只会跑到
      //    最后一只的位置上。这正是参考实现里"槽位系统"要解决的
      //    "多开不再互相覆盖位置"（slot_manager.py）。
      //    多开的那些位置由主进程每次挑空位落座（见 spawnPet / pickSpawnSpot），
      //    本来就不需要持久化。
      if (window.__dshpetIsExtra === true) return
      var r = root.getBoundingClientRect()
      if (!r || !r.width) return
      var vw = window.innerWidth, vh = window.innerHeight
      var leftDist = r.left, rightDist = Math.max(0, vw - (r.left + r.width))
      var topDist = r.top, bottomDist = Math.max(0, vh - (r.top + r.height))
      var hAnchor = leftDist <= rightDist ? 'left' : 'right'
      var vAnchor = topDist <= bottomDist ? 'top' : 'bottom'
      localStorage.setItem(POS_KEY, JSON.stringify({
        v: 2,
        hAnchor: hAnchor,
        hDist: Math.max(0, Math.round(Math.min(leftDist, rightDist))),
        vAnchor: vAnchor,
        vDist: Math.max(0, Math.round(Math.min(topDist, bottomDist))),
      }))
    } catch (e) {}
  }

  // ---------------------------------------------------------- 步进 ----
  // 立绘相对盒子左上角的偏移与尺寸。
  // ⚠️ 这个偏移是"盒子比立绘大一圈"造成的：.dshwv-img 只占盒子的右下 59.45%，
  //    盒子的左上方整整多出约 152px 的空区（用于放气泡/菜单）。
  //    挂件自己按**盒子**夹取位置，所以立绘顶端永远够不到屏幕顶部 —— 顶上有一条死区。
  //    我们按**立绘**夹取，死区就没了。
  // ⚠️ **必须缓存**。getBoundingClientRect() 会强制重排（layout），
  //    而拖动时我们每个 pointermove 都要算一次夹取 —— 每次都强制重排的话
  //    就是典型的 layout thrashing，表现是**拖动一卡一卡**。
  //    立绘相对盒子的偏移只跟"尺寸/角色"有关，跟位置无关，所以缓存是安全的：
  //    尺寸变化走 resize / 角色切换，那时再失效重算。
  var styleObs = null        // 盯 .dshwv-root 的 style（见 start() 里的说明）
  var classObs = null        // 盯 .dshwv-root 的 class（朝向变了要重算偏移 + 重夹）
  var lastFlipped = null     // 上一次看到的朝向（只认"朝向变化"，见 classObs 的说明）
  var artCache = null
  var artCacheFlipped = null // 缓存是"哪个朝向"算出来的（见下面 artOffset 的说明）
  var artSize = null         // 立绘的**布局**尺寸（和 transform 无关）
  function invalidateArt() { artCache = null; artCacheFlipped = null }
  // 根节点这会儿是不是正处在"翻转过渡"中间（scaleX 既不是 1 也不是 -1）。
  // 过渡中间态会把立绘压扁（实测宽度能掉到 74px），拿它量尺寸是错的。
  function rootMidFlip() {
    try {
      if (!root) return false
      var t = getComputedStyle(root).transform
      if (!t || t === 'none') return false
      var m = /matrix\(([^)]*)\)/.exec(t)
      if (!m) return false
      var a = parseFloat(String(m[1]).split(',')[0])
      return isFinite(a) && Math.abs(Math.abs(a) - 1) > 0.02
    } catch (e) { return false }
  }
  // 把 img 到 root 之间所有**行内** transform 暂时摘掉再量。
  // ⚠️ 为什么必须摘：`getBoundingClientRect` **是含 transform 的**，而
  //    "点她"/"被砸到头"/"撞开"都会给立绘挂一个 squash（scale(1.10,.88)），
  //    甚至挂在外层包装节点上。带着它量出来的偏移和尺寸全是错的 ——
  //    实测 dx 会从 152 变成 **1.13**，于是实体约束拿着一块**错位 151px 的矩形**
  //    去判重叠：她早就压进对方身体里了，约束却一点没察觉（这就是"能穿过去"的根因）。
  //    只摘**行内**的：根节点那个翻转来自 class，不能动，否则朝向会算错。
  function measureArtRaw() {
    var img = document.querySelector('img.dshwv-img')
    if (!img || !root) return null
    var saved = []
    var el = img
    while (el && el !== root && el.style) {
      if (el.style.transform) {
        // ⚠️⚠️ **必须连 transition 一起摘掉。**
        //    这些 squash 动画都带 `transition: transform .28s` ——
        //    只把 transform 设成 none 的话，它会被**过渡**过去：量到的是
        //    过渡中间那一帧（实测高度量到过 202、196 这种值），照样是错的。
        //    摘掉 transition 才会立刻生效。
        saved.push([el, el.style.transform, el.style.transition])
        el.style.transition = 'none'
        el.style.transform = 'none'
      }
      el = el.parentNode
    }
    var r = null, ir = null
    try {
      r = root.getBoundingClientRect()
      ir = img.getBoundingClientRect()
    } catch (e) {}
    for (var i = 0; i < saved.length; i++) {
      try {
        saved[i][0].style.transform = saved[i][1]
        saved[i][0].style.transition = saved[i][2]
      } catch (e) {}
    }
    if (!r || !r.width || !ir || !ir.width) return null
    return { r: r, ir: ir }
  }
  function artOffset() {
    // ⚠️⚠️ **偏移和"朝向"有关，所以缓存必须带上朝向。**
    //    实测踩到的坑（用户报的"拖到左边一翻转就跑到桌面外面"）：
    //      artOffset 只按"尺寸/角色"缓存，翻转时**没有失效** ——
    //      于是翻转后最多 3 秒（下一次 invalidateArt）里，夹取用的还是**旧朝向**的偏移，
    //      她就正好能越出左边 152px。
    //    所以这里记下"这份缓存是哪个朝向算的"，朝向一变立刻重算。
    //
    // ⚠️⚠️ **偏移不再"量"出来，而是按几何算出来：**
    //    立绘是贴盒子**右下角**的（翻转后镜像成左下角），所以
    //        未翻转 dx = 盒子宽 - 立绘宽；已翻转 dx = 0；两种朝向 dy = 盒子高 - 立绘高。
    //    为什么不量：翻转是根节点上的 `transform:scaleX(-1)`，而且带 .3s 过渡 ——
    //    过渡中间态（比如 scaleX(-0.3)）会把立绘压扁，量出来的偏移和尺寸全是错的。
    //    按几何算就完全不受过渡影响（尺寸从缓存的布局尺寸来）。
    var flippedNow = !!(root && root.classList.contains('dshwv-left'))
    if (artCache && artCacheFlipped === flippedNow) return artCache
    if (!root) return { dx: 0, dy: 0, w: 0, h: 0 }
    var rw = root.offsetWidth, rh = root.offsetHeight
    if (!rw || !rh) {
      var rr0 = root.getBoundingClientRect()
      rw = rw || rr0.width
      rh = rh || rr0.height
    }
    // 尺寸：**每次都重量**（量的时候已经把所有行内 transform 摘掉了，是安全的），
    // ⚠️ 不能缓存着不放：不同贴图渲染出来的尺寸不一样（默认 223×223，
    //    "抚摸"那张 234×196）。缓存住的话换了贴图 dy 还是旧的 ——
    //    实测就是夹取按 196 算、真实是 223，她能被拖到屏幕上面 -23px 去。
    // 唯一的例外是**翻转过渡中间态**：那时根节点的 scaleX 会把立绘压扁，
    // 量出来是错的，只能沿用上一次的（翻转本身不改变尺寸）。
    if (!rootMidFlip()) {
      var raw = measureArtRaw()
      if (raw) {
        artSize = { w: raw.ir.width, h: raw.ir.height }
        if (raw.r.width > rw) rw = raw.r.width
        if (raw.r.height > rh) rh = raw.r.height
      }
    }
    if (!artSize) return { dx: 0, dy: 0, w: rw, h: rh }
    artCache = {
      dx: flippedNow ? 0 : (rw - artSize.w),
      dy: rh - artSize.h,
      w: artSize.w, h: artSize.h,
    }
    artCacheFlipped = flippedNow
    return artCache
  }

  // 屏幕尺寸。**用 screen.width/height 而不是 window.innerWidth/Height** ——
  // 窗口会被 Windows 钳到"工作区"（本例 2048×1104，任务栏占掉底部 48px），
  // 于是页面视口比屏幕小一圈，她就永远到不了那块区域（用户报的"有一块拖不到"）。
  // 主进程那边已经把窗口改成覆盖整屏，这里用整屏尺寸做夹取，两边口径一致。
  // 可用区域（**工作区**，不含任务栏）。
  //
  // ⚠️ 这里必须用 avail* 而不是 screen.width/height。
  //    用整屏尺寸的话，右下角的落点会落在**任务栏上** ——
  //    初始位置正好盖住任务栏，拖动也能拖到任务栏下面去。
  //    实测这台机器：screen 2048×1152，avail 2048×1104（任务栏占底部 48px）。
  //    availTop/availLeft 也一起用上：任务栏在顶部或左侧时同样要避让。
  function screenSize() {
    var sc = window.screen || {}
    var aw = Number(sc.availWidth) || Number(sc.width) || 0
    var ah = Number(sc.availHeight) || Number(sc.height) || 0
    return {
      w: Math.max(aw || 0, 0),
      h: Math.max(ah || 0, 0),
      x: Number(sc.availLeft) || 0,
      y: Number(sc.availTop) || 0,
    }
  }

  // 让**立绘**完整留在**可用区域**（工作区）内的盒子位置范围。
  // sc.x / sc.y 是工作区左上角（任务栏在顶部/左侧时不为 0）。
  function bounds() {
    var a = artOffset()
    var sc = screenSize()
    // 立绘还没量到尺寸时的兜底：**按盒子算**（盒子底边 == 立绘底边，因为立绘贴盒子右下）。
    // ⚠️ 这里**不能直接返回整块工作区** —— 那等于"不夹取"，
    //    她的盒子能跑到 1104，而立绘在盒子右下角，视觉上就冲到 1104+152 去了
    //    （用户报的"第一次拖动依旧能拖到任务栏下面"，就是这么来的）。
    if (!a.w) {
      var r = root ? root.getBoundingClientRect() : null
      var bw = (r && r.width) || 0
      var bh = (r && r.height) || 0
      return {
        left: sc.x, top: sc.y,
        right: sc.x + sc.w - bw, bottom: sc.y + sc.h - bh,
      }
    }
    return {
      left: sc.x - a.dx,                        // 立绘左边缘贴工作区左
      top: sc.y - a.dy,                         // 立绘上边缘贴工作区顶（盒子会是负值，正常）
      right: sc.x + sc.w - a.w - a.dx,          // 立绘右边缘贴工作区右
      bottom: sc.y + sc.h - a.h - a.dy,         // 立绘下边缘贴**任务栏上沿**
    }
  }

  function clampToBounds(p) {
    var b = bounds()
    return [
      Math.min(Math.max(p[0], b.left), Math.max(b.left, b.right)),
      Math.min(Math.max(p[1], b.top), Math.max(b.top, b.bottom)),
    ]
  }

  function stopPhysics() {
    mode = null
    dragTarget = null
    throwElapsed = 0
    if (timer !== null) { clearInterval(timer); timer = null }
  }

  function tick() {
    if (!root || !mode) return
    if (mode === 'throw') {
      var b = bounds()
      // ⚠️⚠️ **子步积分**（移植自参考实现的"物理计时器改为真实 dt + 子步积分"）。
      //    一帧 DT≈16ms，疯狂档 9000px/s 时单步位移 ~150px ——
      //    一步就跨过了墙、跨过了同伴，表现为**瞬移/穿透**。
      //    所以按"单步位移不超过 SUBSTEP_MAX_PX"把这一帧切成若干子步，
      //    每步都做边界判定。上限 8 步，免得极端速度下把帧率拖垮。
      var stepSpeed = Math.hypot(physVel[0], physVel[1])
      var subN = Math.max(1, Math.min(8, Math.ceil((stepSpeed * DT) / SUBSTEP_MAX_PX)))
      var subDt = DT / subN
      var bounced = false
      for (var si = 0; si < subN; si++) {
        var out = throwStep(physPos[0], physPos[1], physVel[0], physVel[1], subDt,
          b.left, b.top, b.right, b.bottom, GRAVITY)
        physPos = [out[0], out[1]]
        physVel = [out[2], out[3]]
        if (out[4]) bounced = true
        if (!isFinite(physPos[0]) || !isFinite(physPos[1]) || !isFinite(physVel[0]) || !isFinite(physVel[1])) {
          log('抛掷步进出现非法值，已停止物理')
          stopPhysics()
          persistPosition()
          return
        }
      }
      throwElapsed += TICK_MS
      applyOverride()
      var speed = Math.hypot(physVel[0], physVel[1])
      if (isAtRest(physPos[1], physVel[0], physVel[1], b.bottom, bounced, speed) ||
          throwElapsed >= MAX_FLIGHT_MS) {
        if (throwElapsed >= MAX_FLIGHT_MS && !isAtRest(physPos[1], physVel[0], physVel[1], b.bottom, bounced, speed)) {
          log('飞行超时，强制落定')
          // 直接贴地停住，别留一个"半空中静止"的怪状态
          physPos[1] = b.bottom
        }
        stopPhysics()
        updateFacing()
        persistPosition()
        log('静止于 ' + Math.round(physPos[0]) + ',' + Math.round(physPos[1]))
      }
    }
  }

  // 落定后按"她在屏幕左半边还是右半边"更新朝向。
  // 挂件原本是在吸附/拖拽结束时做这件事（refreshFlip/snapCheck），
  // 而物理模式下吸附让位了 —— 不补这一步，她飞到左半边也不会转身。
  // 用立绘中心与屏幕中线比较（挂件自己的翻转线就是 50%）。
  function updateFacing() {
    try {
      if (!root) return
      var img = document.querySelector('img.dshwv-img')
      var r = (img || root).getBoundingClientRect()
      if (!r || !r.width) return
      var centerX = r.left + r.width / 2
      var wantLeft = centerX < window.innerWidth / 2
      if (wantLeft === root.classList.contains('dshwv-left')) return
      root.classList.toggle('dshwv-left', wantLeft)
      // ⚠️ 翻转会改变"立绘相对盒子的真实偏移"（152 ↔ 0），所以：
      //    ① 立刻让偏移缓存失效（否则夹取还在用旧朝向的范围 —— 就是出界的根因）
      //    ② 立刻按新朝向重新夹一次。翻转本身会让她视觉上横移一个偏移量，
      //       贴着左边时如果不夹，她就会直接露到屏幕外面去。
      invalidateArt()
      physPos = clampToBounds(physPos)
      applyOverride()
    } catch (e) {}
  }

  // 边缘吸附：物理**关闭**时用，对齐挂件默认的吸附区
  // （ratio: L=10% T=0% R=10% B=15%，F=50 是翻转线）。
  // 接管位置之后挂件自己的吸附不会跑了，这里补上，免得关掉物理就丢了"自动贴边"。
  function snapIfNear() {
    try {
      var a = artOffset()
      if (!a.w) return
      // 用**工作区**（不含任务栏）—— 不然吸附会把她的底边贴到任务栏下面去
      var sc = screenSize()
      var vw = sc.w, vh = sc.h, ox = sc.x, oy = sc.y
      var artLeft = physPos[0] + a.dx
      var artTop = physPos[1] + a.dy
      var zoneL = vw * 0.10, zoneR = vw * 0.10, zoneB = vh * 0.15
      if (artLeft <= ox + zoneL) physPos[0] = ox - a.dx
      else if ((ox + vw) - (artLeft + a.w) <= zoneR) physPos[0] = ox + vw - a.w - a.dx
      if ((oy + vh) - (artTop + a.h) <= zoneB) physPos[1] = oy + vh - a.h - a.dy
    } catch (e) {}
  }

  // 挂件自己也可能改位置（它 ☰ 菜单里的「回到右下角」、改吸附/大小等会调 express()）。
  // 怎么判断"是它写的"：**看行内 left 的优先级**。
  //   我们用 setProperty('left', 值, 'important') 写，优先级是 'important'；
  //   挂件写的是 root.style.left = ...，**同属性赋值会把优先级清掉** ——
  //   所以优先级不再是 'important' 就说明它动过。
  //
  // ⚠️ 但要排除一个陷阱：我们拖拽结束时会给它补发 pointercancel，
  //    它内部会走 endDrag → settle → express()，而此时它的 state 是**拖动前**的旧值 ——
  //    采纳它就会把她拽回拖动前的位置。所以刚拖完的一小段时间里只重写、不采纳。
  var ignoreWidgetPosUntil = 0
  function syncBackFromWidget() {
    if (!root || drag || mode) return
    // 朝向也要定期重新应用：挂件会按它**过期的** state.flip 把 dshwv-left 改回去。
    // 不补这一步，她拖到左半边也不会转身。
    updateFacing()
    if (root.style.getPropertyPriority('left') === 'important') return   // 还是我们写的
    if (Date.now() < ignoreWidgetPosUntil) { applyOverride(); return }   // 刚拖完，它的值是旧的
    var l = parseFloat(root.style.left)
    var t = parseFloat(root.style.top)
    if (!isFinite(l) || !isFinite(t)) { applyOverride(); return }
    // ⚠️ **采纳也要夹取。** 挂件的基础样式是 right:0/bottom:0（相对窗口），
    //    而窗口是整屏高度 —— 它自己 express() 一次就会把她放到任务栏下面。
    //    不夹的话，"采纳"就等于"把越界位置合法化"。
    physPos = clampToBounds([l, t])
    applyOverride()
    log('采纳挂件的位置 ' + Math.round(physPos[0]) + ',' + Math.round(physPos[1]))
  }

  function startTimer() {
    if (timer !== null) return
    timer = setInterval(tick, TICK_MS)
  }

  // ------------------------------------------------------- 事件接管 ----
  // 我们的监听器在挂件之前注册（shell.js 先跑、动态载入 widget.js），
  // 所以同样是 document 上的 capture 阶段，我们一定先执行。
  // ==========================================================================
  // 弹弓（移植自参考实现的 window.py 弹弓段 + physics.py 的三个纯函数）
  // ==========================================================================
  // 交互：**左键拖拽中按住右键**进入蓄力 → 鼠标往反方向拉 → **松左键发射**。
  //   · 拉拽向量 = 按下右键那一刻的鼠标位置 − 当前鼠标位置
  //     （所以"往回拉、往前射"，和真弹弓一致）
  //   · 松右键 → 退回普通拖拽（不发射）
  //   · ESC / 失焦 / 隐藏 → 取消并回到锚点（不发射）
  //   · 拉不到门槛（24px）就松左键 → 同样回锚点，不会误射
  //
  // 与"鼠标穿透"天然互斥：整窗穿透时窗口根本收不到事件（见 shell.js 的 evaluate）。
  var SLINGSHOT_KEY = 'dshpet-slingshot'
  var sling = null            // { anchorPos:[l,t], anchorMouse:{x,y}, mouse:{x,y}, pull:{x,y} }
  var slingSuppressClick = false

  function slingshotEnabled() {
    try {
      var v = localStorage.getItem(SLINGSHOT_KEY)
      return v === null ? true : v === '1'
    } catch (e) { return true }
  }
  function setSlingshotEnabled(on) {
    try { localStorage.setItem(SLINGSHOT_KEY, on ? '1' : '0') } catch (e) {}
    if (!on) cancelSlingToAnchor()
    log('弹弓 ' + (on ? '开' : '关'))
    return !!on
  }

  // 蓄力进度：拉拽距离 / 上限，钳到 0~1
  function slingProgress() {
    if (!sling) return 0
    var d = Math.min(Math.hypot(sling.pull.x, sling.pull.y), SLINGSHOT_MAX_DISTANCE)
    return Math.max(0, Math.min(1, d / Math.max(1, SLINGSHOT_MAX_DISTANCE)))
  }

  function enterSlingshot(gx, gy) {
    if (!root) return false
    // 进入前把最后一次跟手位置落定 —— 锚点就是"她此刻在哪"
    if (dragTarget) physPos = clampToBounds([dragTarget[0], dragTarget[1]])
    applyOverride()
    sling = {
      anchorPos: [physPos[0], physPos[1]],
      anchorMouse: { x: gx, y: gy },
      mouse: { x: gx, y: gy },
      pull: { x: 0, y: 0 },
    }
    stopPhysics()                 // 蓄力期间不跑物理
    mode = null
    log('进入弹弓蓄力（锚点 ' + Math.round(physPos[0]) + ',' + Math.round(physPos[1]) + '）')
    applySlingVisual()
    return true
  }

  function updateSlingAim(gx, gy) {
    if (!sling) return
    var px = sling.anchorMouse.x - gx
    var py = sling.anchorMouse.y - gy
    // 超出上限就按比例缩回来（不是硬钳方向，方向保持不变）
    var len = Math.hypot(px, py)
    if (len > SLINGSHOT_MAX_DISTANCE && len > 0) {
      var ratio = SLINGSHOT_MAX_DISTANCE / len
      px *= ratio; py *= ratio
    }
    sling.mouse = { x: gx, y: gy }
    sling.pull = { x: px, y: py }
    applySlingVisual()
  }

  function clearSling() {
    sling = null
    clearSlingVisual()
  }

  // 松右键：退回普通拖拽。她保持不动，把拖拽基准重新对齐到当前位置，
  // 否则会"跳"回按下左键时的抓取点。
  function cancelSlingToDrag() {
    if (!sling) return
    var keep = [physPos[0], physPos[1]]
    clearSling()
    if (drag) {
      // 重新算抓取点：让接下来的拖拽从"她此刻的位置"继续
      var a = artOffset()
      var rr = root ? root.getBoundingClientRect() : null
      if (rr) {
        drag.origLeft = rr.left
        drag.origTop = rr.top
        drag.startX = rr.left + (a.w ? a.w / 2 : 0)
        drag.startY = rr.top + (a.h ? a.h / 2 : 0)
      }
    }
    physPos = clampToBounds(keep)
    applyOverride()
    log('松右键 → 退回普通拖拽')
  }

  // 取消并回到锚点（ESC / 失焦 / 隐藏 / 没拉够就松左键）
  function cancelSlingToAnchor() {
    if (!sling) return
    var home = [sling.anchorPos[0], sling.anchorPos[1]]
    clearSling()
    physPos = clampToBounds(home)
    applyOverride()
    if (mode === null) { try { persistPosition() } catch (e) {} }
    log('弹弓已取消 → 回到锚点')
  }

  // 松左键：发射
  function launchSlingshot() {
    if (!sling) return false
    var distance = Math.hypot(sling.pull.x, sling.pull.y)
    var home = [sling.anchorPos[0], sling.anchorPos[1]]
    var pull = { x: sling.pull.x, y: sling.pull.y }
    // 没拉够门槛 → 当作取消，别误射
    if (distance < SLINGSHOT_MIN_DISTANCE) {
      log('拉力只有 ' + Math.round(distance) + 'px，不到门槛 ' + SLINGSHOT_MIN_DISTANCE +
        'px → 当作取消（要拉得更远一点）')
      cancelSlingToAnchor()
      return false
    }
    var cap = throwSpeedCap(getThrowStrength())
    var speed = slingshotSpeed(distance, SLINGSHOT_MIN_DISTANCE, SLINGSHOT_MAX_DISTANCE, cap)
    var len = Math.hypot(pull.x, pull.y) || 1
    clearSling()
    // ⚠️⚠️ **必须把拖拽状态清掉。**
    //    发射发生在松左键那一刻，但这里 return 得早（见 onPointerUp 的 sling 分支），
    //    后面那段清 drag 的代码走不到 —— 不清的话下一帧 pointermove 会看到
    //    drag 还在、sling 已经没了，于是**继续按鼠标移动她**，
    //    刚射出去就被拖回来（表现为发射没反应）。
    drag = null
    dragTarget = null
    trail = []
    physPos = clampToBounds(home)
    physVel = [pull.x / len * speed, pull.y / len * speed]
    mode = 'throw'
    throwElapsed = 0
    slingSuppressClick = true
    setTimeout(function () { slingSuppressClick = false }, 400)
    applyOverride()
    startTimer()
    log('弹弓发射 v=(' + Math.round(physVel[0]) + ',' + Math.round(physVel[1]) +
      ') 拉力=' + Math.round(distance) + 'px 档位=' + getThrowStrength())
    return true
  }

  // ---- 弹弓的可视化：方向性形变 + 橡皮筋拉带 + 抛物线预测 ----
  // ⚠️ 形变只加在**立绘的 transform** 上。artOffset 量尺寸时会先把行内 transform
  //    摘掉（measureArtRaw），所以不会污染夹取/实体几何。
  var slingSvg = null
  function ensureSlingSvg() {
    if (slingSvg && slingSvg.parentNode) return slingSvg
    slingSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    slingSvg.setAttribute('id', 'dshpet-sling-svg')
    slingSvg.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;' +
      'pointer-events:none;z-index:9998;overflow:visible'
    var band = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    band.setAttribute('id', 'dshpet-sling-band')
    band.setAttribute('stroke', 'rgba(32,49,112,.55)')
    band.setAttribute('stroke-width', '2')
    band.setAttribute('stroke-dasharray', '5 4')
    var traj = document.createElementNS('http://www.w3.org/2000/svg', 'polyline')
    traj.setAttribute('id', 'dshpet-sling-traj')
    traj.setAttribute('fill', 'none')
    traj.setAttribute('stroke', 'rgba(32,49,112,.75)')
    traj.setAttribute('stroke-width', '2')
    traj.setAttribute('stroke-dasharray', '2 5')
    slingSvg.appendChild(band)
    slingSvg.appendChild(traj)
    document.body.appendChild(slingSvg)
    return slingSvg
  }
  function clearSlingVisual() {
    // 只清"弹弓"那一路，别把点击Q弹/回旋一起清了（它们由合成器分别持有）
    var X = window.__dshpetSpriteXform
    if (X) X.clear('sling')
    else {
      var im = document.querySelector('img.dshwv-img')
      if (im) { try { im.style.transform = '' } catch (e) {} }
    }
    var svg = document.getElementById('dshpet-sling-svg')
    if (svg && svg.parentNode) svg.parentNode.removeChild(svg)
    slingSvg = null
  }
  function applySlingVisual() {
    if (!sling) { clearSlingVisual(); return }
    var img = document.querySelector('img.dshwv-img')
    var prog = slingProgress()
    // 方向性形变：拉伸/压缩投影到轴上，换角度不跳变
    if (img) {
      var sc = slingshotDeformation(sling.pull.x, sling.pull.y, prog)
      try {
        img.style.transformOrigin = '50% 50%'
        // 走合成器（和点击Q弹、黄金回旋共用一条 transform）
        var X = window.__dshpetSpriteXform
        var frag = (prog > 0.001) ? X ? X.scale(sc[0], sc[1]) : ('scale(' + sc[0].toFixed(3) + ',' + sc[1].toFixed(3) + ')') : ''
        if (X) X.set('sling', frag)
        else img.style.transform = frag
      } catch (e) {}
    }
    var svg = ensureSlingSvg()
    if (!svg) return
    var band = document.getElementById('dshpet-sling-band')
    var traj = document.getElementById('dshpet-sling-traj')
    if (!band || !traj) return
    // 拉带：从她身上连到鼠标（"橡皮筋"）
    var a = artOffset()
    var rr = root ? root.getBoundingClientRect() : null
    if (!rr) return
    var cx = rr.left + (a.w ? a.w / 2 : 0)
    var cy = rr.top + (a.h ? a.h / 2 : 0)
    band.setAttribute('x1', String(Math.round(cx)))
    band.setAttribute('y1', String(Math.round(cy)))
    band.setAttribute('x2', String(Math.round(sling.mouse.x)))
    band.setAttribute('y2', String(Math.round(sling.mouse.y)))
    // 抛物线预测：沿拉拽方向（= 发射方向）
    var dist = Math.hypot(sling.pull.x, sling.pull.y)
    var cap = throwSpeedCap(getThrowStrength())
    var speed = slingshotSpeed(dist, SLINGSHOT_MIN_DISTANCE, SLINGSHOT_MAX_DISTANCE, cap)
    if (speed > 0) {
      var len = dist || 1
      var pts = slingshotTrajectory(sling.pull.x / len * speed, sling.pull.y / len * speed, 0.8, 12, GRAVITY)
      var out = []
      for (var i = 0; i < pts.length; i++) {
        out.push(Math.round(cx + pts[i][0]) + ',' + Math.round(cy + pts[i][1]))
      }
      traj.setAttribute('points', out.join(' '))
      traj.setAttribute('opacity', '1')
    } else {
      traj.setAttribute('points', '')
      traj.setAttribute('opacity', '0')
    }
  }

  function onSlingKeydown(e) {
    if (e.key === 'Escape' && sling) {
      try { e.stopPropagation() } catch (err) {}
      cancelSlingToAnchor()
    }
  }
  function onSlingBlur() { if (sling) cancelSlingToAnchor() }

  function onPointerDown(e) {
    // ⚠️ **不能写 `if (!enabled)`。** 这个开关只管"松手要不要抛"，
    //    拖拽本身**两种模式都必须由我们接管** —— 否则物理关闭时是挂件在自己拖，
    //    而挂件按 `window.innerHeight`（整屏）夹取，她就**能拖到任务栏下面**。
    //    （这个 bug 之前一直没被发现，因为自检总是强制"物理开启"再跑，
    //      关闭的那条路径从来没被测过。）
    if (!root) return
    // 右键：**左键拖拽中按住右键** → 进入弹弓蓄力（见上面的弹弓段）
    // ⚠️⚠️ **不要用 e.pointerType 做门槛。**
    //    上一版写的是 e.button === 2 && e.pointerType === 'mouse' ——
    //    而 Electron 经 setIgnoreMouseEvents 转发过来的指针事件**字段不全**
    //    （同一份代码里早就记过：buttons 恒为 0）。pointerType 缺失时
    //    这个分支会被整条跳过，表现就是"弹弓完全没反应"。
    //    改成同时认 button / buttons 两个来源，谁有值用谁。
    var isRight = (e.button === 2) || ((e.buttons & 2) === 2)
    if (isRight) {
      log('右键按下：button=' + e.button + ' buttons=' + e.buttons +
        ' pointerType=' + JSON.stringify(e.pointerType) +
        ' drag=' + !!drag + ' sling=' + !!sling + ' enabled=' + slingshotEnabled())
      if (drag && slingshotEnabled() && !sling) {
        try { e.stopImmediatePropagation() } catch (err) {}
        try { e.preventDefault() } catch (err) {}
        enterSlingshot(e.clientX, e.clientY)
      } else if (!drag) {
        log('右键时左键没按住（drag 为空）→ 不进弹弓。弹弓要先按住左键拖，再按右键')
      }
      return
    }
    if (e.button !== 0 && e.pointerType === 'mouse') return
    // ⚠️⚠️ **这里不能看 `e.target`。**
    //    实测：鲸鱼自己的 DOM 是 `pointer-events:none`（它就是靠这个让鼠标穿透的），
    //    所以 `elementFromPoint` / `e.target` 在她身上**返回的也是 <body>** ——
    //    按 target 判断"是不是按在她身上"永远不可靠（试过，直接把拖拽废掉了）。
    //
    // 所以改成**按坐标矩形**判断：
    //   ① 先排除那些"浮在她上面的面板"的矩形 —— 按在面板里的一律放行。
    //      这一步是必须的：面板和她的立绘会重叠，而 whaleHit 只看立绘几何，
    //      重叠时会把"面板上的点击"误判成"拖她"，后果是
    //        · pointerup 里 stopImmediatePropagation → 面板上的 click 永不触发（点了没反应）
    //        · 按下+移动被当成拖拽手势 → 面板的"点外面关闭"判定触发 → 面板关闭
    //        · 她真的被挪了一点点 → 往下瞬移
    //      三个症状一起出现，就是这里。
    //   ② 再用挂件的逐像素命中图确认"按在她身上"
    var px = e.clientX, py = e.clientY
    // ⚠️⚠️ **米粒面板开着的时候，一律不接管。**
    //    这是最硬的一条保护：面板和她的立绘会重叠，只要有一次判断失误，
    //    面板上的点击就会被我们的 pointerup stopImmediatePropagation 吞掉
    //    （用户报的"点了相关功能没反应 + 菜单直接关闭 + 她往下瞬移一下"）。
    //    面板本来就"点外面就关"，开着的时候不能拖她 —— 这个代价可以接受，
    //    换的是"面板里的功能一定点得动"。
    try { if (document.querySelector('.dshrice-menu.dshrice-open')) return } catch (err) {}
    // ⚠️ 「形象与互动」面板开着时同样一律不接管 —— 理由和上面米粒面板那条完全一样：
    //    它也是 position:fixed 挂在 body 上、也会和她的立绘重叠，
    //    一旦判断失误，面板上的点击就会被我们的 pointerup stopImmediatePropagation 吞掉。
    try {
      var epn = document.querySelector('.dshpet-exp-panel')
      if (epn && getComputedStyle(epn).display !== 'none') return
    } catch (err) {}
    var panels = ['.dshrice-chip', '.dshpet-phys-row', '.dshpet-rice-row',
                  '.dshpet-openweb-row', '.dshpet-openweb-btn',
                  '.dshpet-exp-row-wrap', '.dshpet-exp-btn']
    for (var pi = 0; pi < panels.length; pi++) {
      var pel = document.querySelector(panels[pi])
      if (!pel) continue
      // ⚠️ 可见性要**沿着祖先一路看**：鲸鱼菜单关闭时是 `opacity:0`（不是 display:none），
      //    而里面的行自己的 computed opacity 是 1 —— 只看自己会把"收起菜单里的行"
      //    当成可见的，于是它的矩形会莫名其妙挡住拖拽。
      var vis = true
      var node = pel
      while (node && node !== document.body) {
        var ncs = getComputedStyle(node)
        if (ncs.display === 'none' || ncs.visibility === 'hidden' || ncs.opacity === '0') { vis = false; break }
        node = node.parentElement
      }
      if (!vis) continue
      var prr = pel.getBoundingClientRect()
      if (!prr.width || !prr.height) continue
      if (px >= prr.left && px <= prr.right && py >= prr.top && py <= prr.bottom) return
    }
    // 鲸鱼自己的菜单/弹窗里也一律放行（按 class 排除，这些确实在它自己 DOM 内）
    if (e.target && e.target.closest) {
      if (e.target.closest('.dshwv-menu') || e.target.closest('.dshwv-menu-btn') ||
          e.target.closest('.dshwv-pop') || e.target.closest('.dshwv-rolelist') ||
          e.target.closest('.dshwv-audiolist') || e.target.closest('.dshwv-cropmask') ||
          e.target.closest('.dshwv-confirmmask') || e.target.closest('.dshwv-snapmask') ||
          e.target.closest('.dshwv-bubmask') || e.target.closest('.dshwv-usagepanel') ||
          e.target.closest('.dshwv-usage-mask') || e.target.closest('.dshwv-resmask') ||
          e.target.closest('.dshwv-custmenu') || e.target.closest('.dshwv-custbtn') ||
          e.target.closest('.dshpet-phys-row')) return
    }
    // 用挂件自己的逐像素命中图判断"是不是按在她身上"
    var hit = false
    try { hit = typeof window.__petWhaleHit === 'function' && window.__petWhaleHit(e.clientX, e.clientY) } catch (err) {}
    if (!hit) return

    // ⚠️ 不拦 pointerdown：点击弹气泡、按压音效都挂在挂件那一条链上。
    //    这里只记录起点，真正的接管发生在 pointermove / pointerup。
    var r = root.getBoundingClientRect()
    if (!r || !r.width) return
    drag = {
      startX: e.clientX, startY: e.clientY,
      origLeft: r.left, origTop: r.top,
      w: r.width, h: r.height, moved: false,
    }
    trail = [[nowSec(), e.clientX, e.clientY]]
    startDragFlush()
  }

  // --------------------------------------------------------------------------
  // 拖拽合帧（移植自参考实现的 _schedule_drag_move / _flush_drag_move）
  // --------------------------------------------------------------------------
  // ⚠️⚠️ **为什么必须合帧**：`pointermove` 的回报率能到 1000Hz（高刷鼠标），
  //    而每个事件我们都写一次 `left/top` + 跑一遍夹取/实体约束 ——
  //    那里面有 getBoundingClientRect / getComputedStyle（**强制重排**）。
  //    一秒上千次重排，页面直接变幻灯片，点击也跟着不可靠。
  //
  // 做法：`onPointerMove` **只记最新目标**（不碰 DOM），
  //       一个 8ms 定时器来消费 —— 最多约 120Hz，和参考实现一致。
  //       8ms 也是物理里 `SEG_MIN_DT` 的值，两者对齐。
  var DRAG_FLUSH_MS = 8
  var dragFlushTimer = null
  var dragDirty = false

  function flushDragMove() {
    // ⚠️ **不要要求 drag 非空** —— 松手时是先 drag=null 再收尾的，
    //    要求非空的话最后一次位置会被丢掉（表现为松手瞬间回弹一像素）。
    if (!dragDirty || !dragTarget) return
    dragDirty = false
    physPos = [dragTarget[0], dragTarget[1]]
    window.__dshpetDragging = true      // 让 shell.js 的交互判定让路（别抢布局）
    applyOverride()
  }
  function startDragFlush() {
    if (dragFlushTimer !== null) return
    dragFlushTimer = setInterval(flushDragMove, DRAG_FLUSH_MS)
  }
  function stopDragFlush() {
    if (dragFlushTimer !== null) { clearInterval(dragFlushTimer); dragFlushTimer = null }
    // 收尾：把最后一次目标落定，别丢掉最后那几像素
    if (dragDirty) flushDragMove()
    dragDirty = false
  }

  function onPointerMove(e) {
    // 蓄力中：只更新瞄准，不跟着鼠标移动她（弹弓的核心语义）
    if (sling) {
      try { e.stopImmediatePropagation() } catch (err) {}
      updateSlingAim(e.clientX, e.clientY)
      return
    }
    // 同样不能看 enabled —— 两种模式的拖动都是我们接管（只有松手行为不同）
    if (!drag) return
    // ⚠️ 这里**曾经**有一句 `if (e.buttons === 0) { 取消拖拽 }`，是个致命 bug，已删除。
    //    原因：Electron 的 setIgnoreMouseEvents(true, {forward:true}) 转发过来的指针事件
    //    **不带按键状态**（buttons 恒为 0）。于是拖拽一开始就被自己取消 ——
    //    表现是"开了拖动物理之后完全没反应"。指针丢失改用 pointercancel / blur 兜底。
    var dx = e.clientX - drag.startX
    var dy = e.clientY - drag.startY
    if (dx * dx + dy * dy >= CLICK_SQ) drag.moved = true
    if (!drag.moved) return

    // 拦下挂件的 pointermove —— 否则它会同时按 1:1 写位置，跟我们打架
    try { e.stopImmediatePropagation() } catch (err) {}

    var now = nowSec()
    trail.push([now, e.clientX, e.clientY])
    var cutoff = now - TRAIL_KEEP_SEC
    while (trail.length && trail[0][0] < cutoff) trail.shift()

    // 抓取点：按下时指针在她身上的相对位置，拖动时保持这个相对关系
    var grabX = drag.startX - drag.origLeft
    var grabY = drag.startY - drag.origTop
    // 夹取：不让**立绘**跑出屏幕（挂件自己按盒子夹，会让立绘够不到屏幕顶/左）
    dragTarget = clampToBounds([e.clientX - grabX, e.clientY - grabY])

    // ⚠️ **拖动一律 1:1 跟手，两种模式完全一致。**
    //    这里以前在"物理开启"时走弹簧跟随，结果是：弹簧会过冲 → 拖到边角时被夹取
    //    一拽就"瞬移"；而且两条代码路径手感不同、要各修一遍 bug。
    //    用户明确要求"拖动跟关闭时一致" —— 现在拖动只有这一条路径，
    //    物理模式**只影响松手之后**（抛掷），不影响拖动本身。
    // ⚠️ **这里不直接写 DOM** —— 只标脏，交给 8ms 定时器消费（见上面的合帧说明）。
    //    高刷鼠标一秒上千个 pointermove，每个都写一次位置 + 强制重排会把页面拖垮。
    dragDirty = true
  }

  function onPointerUp(e) {
    // 蓄力中：松右键 → 退回普通拖拽；松左键 → 发射
    if (sling) {
      try { e.stopImmediatePropagation() } catch (err) {}
      // ⚠️⚠️ **这里什么都不做，只拦截。**
      //    原因：pointerup 的 e.button 在"右键还按着"时**不可信** ——
      //    它报的可能是"当前按着的键"(2) 而不是"刚松开的键"(0)。
      //    上一版按 button 分派，于是松左键时进了"取消"分支：
      //    拉满了一松手，sling 被清掉，后面 mouseup 也救不回来
      //    —— 表现就是**弹不出去**。
      //    mouseup 的 button 是可靠的，而且它**在 pointerup 之后**触发，
      //    所以统一交给下面的 mouseup 判，这里只管拦住挂件别收到。
      return
    }
    // 同上：松手处理两种模式都要走（enabled 只在下面决定"抛不抛"）
    if (!drag) return
    var d = drag
    drag = null
    stopDragFlush()
    window.__dshpetDragging = false       // 拖动结束，交互判定恢复工作
    // 接下来我们会给挂件补发 pointercancel，它会走 endDrag→settle→express()，
    // 而那时它的 state 还是**拖动前**的旧值 —— 这段时间里它的位置写入一律不采纳。
    ignoreWidgetPosUntil = Date.now() + 800
    if (!d.moved) return          // 点击：完全放行，让挂件走它自己的 whaleClick()

    // 真拖动：拦下挂件的 pointerup（它会把位置算成"光标位移"并做吸附），
    // 然后补发一个 pointercancel 让它自己把拖拽状态清干净。
    try { e.stopImmediatePropagation() } catch (err) {}
    try {
      suppressCancel = true
      document.dispatchEvent(new PointerEvent('pointercancel', {
        bubbles: true, cancelable: false, pointerType: e.pointerType || 'mouse',
      }))
    } catch (err) {} finally { suppressCancel = false }

    if (!enabled) {
      // 物理关闭：松手不抛；贴近屏幕边就吸附过去（对齐挂件原本的自动贴边）
      stopPhysics()
      snapIfNear()
      updateFacing()
      applyOverride()
      persistPosition()
      return
    }
    // 上限按**当前档位**取（轻柔/标准/强力/疯狂），不再写死
    var strengthCap = throwSpeedCap(getThrowStrength())
    // 连点防误甩：位移是"点击级"的（连点/手抖，< 24px）就不抛 —— 无论估算速度多大。
    var dxDrag = e.clientX - d.startX
    var dyDrag = e.clientY - d.startY
    if (Math.hypot(dxDrag, dyDrag) < CLICK_THROW_GUARD_PX) {
      stopPhysics()
      updateFacing()
      applyOverride()
      persistPosition()
      log('松手位移 ' + Math.round(Math.hypot(dxDrag, dyDrag)) + 'px < 点击阈值，不抛（防连点误甩）')
      return
    }
    var rv = estimateReleaseVelocity(trail, nowSec(), strengthCap)
    trail = []
    if (Math.hypot(rv[0], rv[1]) < DEAD_ZONE_SPEED) {
      // 慢放：原地落下，不抛（避免手一抖就飞出去）
      stopPhysics()
      updateFacing()
      applyOverride()
      persistPosition()
      return
    }
    physVel = [rv[0], rv[1]]
    mode = 'throw'
    throwElapsed = 0
    applyOverride()
    startTimer()
    log('抛出 v=(' + Math.round(rv[0]) + ',' + Math.round(rv[1]) + ') 档位=' + getThrowStrength())
  }

  function onPointerCancel() {
    if (suppressCancel) return     // 我们自己补发的，跳过
    drag = null
    stopDragFlush()
    trail = []
    window.__dshpetDragging = false
    if (mode === 'drag') { stopPhysics(); persistPosition() }
  }

  function nowSec() { return Date.now() / 1000 }

  // ------------------------------------------------------- 菜单开关 ----
  // 挂件的菜单是**一次性构建**的（menuBox.appendChild(row…) 在模块作用域里跑一遍），
  // 不会被重建 —— 所以往里插一行是安全的。
  function injectMenuRow() {
    if (!root) return false
    var menu = document.querySelector('.dshwv-menu')
    if (!menu) return false
    if (menu.querySelector('.dshpet-phys-row')) return true

    var row = document.createElement('div')
    row.className = 'dshpet-phys-row'
    var cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = enabled
    cb.title = '开启后拖她会以弹簧跟随鼠标，松手按甩出的速度抛出、撞边反弹，静止后留在落点'
    cb.addEventListener('change', function (ev) {
      ev.stopPropagation()
      setEnabled(cb.checked)
    })
    // 点文字也能切
    var label = document.createElement('span')
    label.textContent = '拖动物理'
    label.style.cursor = 'pointer'
    label.addEventListener('click', function (ev) {
      ev.stopPropagation()
      cb.checked = !cb.checked
      setEnabled(cb.checked)
    })
    row.appendChild(cb)
    row.appendChild(label)

    // 插在"大小"那一行后面，位置不突兀；找不到就追加到末尾
    var rows = menu.querySelectorAll('.dshwv-menu-row')
    if (rows.length) rows[0].parentNode.insertBefore(row, rows[0].nextSibling)
    else menu.appendChild(row)
    return true
  }

  // 甩出力度档位那一行（下拉选择）。
  // 插在「拖动物理」下面 —— 两者是一件事（物理开关 + 手感），放一起最自然。
  // ⚠️ 必须等「拖动物理」行先出现（它可能在菜单重建时被清掉），
  //    所以这里返回 false 让上层观察器继续重试。
  var STRENGTH_LABELS = [
    ['gentle', '轻柔'],
    ['standard', '标准'],
    ['strong', '强力'],
    ['crazy', '疯狂'],
  ]
  // 弹弓开关（插在「甩出力度」下面 —— 都是"甩出去"这一件事）
  function injectSlingshotRow() {
    var menu = document.querySelector('.dshwv-menu')
    if (!menu) return false
    if (menu.querySelector('.dshpet-sling-row')) return true
    var base = menu.querySelector('.dshpet-strength-row') || menu.querySelector('.dshpet-phys-row')
    if (!base || !base.parentNode) return false
    var row = document.createElement('div')
    row.className = 'dshpet-sling-row'
    var cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = slingshotEnabled()
    cb.title = '开着时：左键拖着她不放，再按住右键即可拉弹弓，松左键发射'
    cb.addEventListener('change', function (ev) {
      ev.stopPropagation()
      setSlingshotEnabled(cb.checked)
    })
    var label = document.createElement('span')
    label.textContent = '弹弓'
    label.style.cursor = 'pointer'
    label.addEventListener('click', function (ev) {
      ev.stopPropagation()
      cb.checked = !cb.checked
      setSlingshotEnabled(cb.checked)
    })
    row.appendChild(cb)
    row.appendChild(label)
    base.parentNode.insertBefore(row, base.nextSibling)
    return true
  }

  function injectStrengthRow() {
    var menu = document.querySelector('.dshwv-menu')
    if (!menu) return false
    if (menu.querySelector('.dshpet-strength-row')) return true
    var physRow = menu.querySelector('.dshpet-phys-row')
    if (!physRow || !physRow.parentNode) return false

    var row = document.createElement('div')
    row.className = 'dshpet-strength-row'
    var label = document.createElement('span')
    label.textContent = '甩出力度'
    var sel = document.createElement('select')
    sel.title = '松手甩出的速度上限（软上限：同档位里甩得越快仍然越快）'
    var cur = getThrowStrength()
    for (var i = 0; i < STRENGTH_LABELS.length; i++) {
      var opt = document.createElement('option')
      opt.value = STRENGTH_LABELS[i][0]
      opt.textContent = STRENGTH_LABELS[i][1] + '（' + throwSpeedCap(STRENGTH_LABELS[i][0]) + '）'
      if (STRENGTH_LABELS[i][0] === cur) opt.selected = true
      sel.appendChild(opt)
    }
    sel.addEventListener('change', function (ev) {
      ev.stopPropagation()
      setThrowStrength(sel.value)
    })
    // 点它别冒泡到菜单（否则菜单会关）
    sel.addEventListener('click', function (ev) { ev.stopPropagation() })
    row.appendChild(label)
    row.appendChild(sel)
    physRow.parentNode.insertBefore(row, physRow.nextSibling)
    return true
  }

  // ---------------------------------------------------------- 开关 ----
  function setEnabled(v) {
    v = !!v
    if (v === enabled) return
    enabled = v
    writeEnabled(v)
    // 就地生效，**不重载页面**。
    //
    // ⚠️ 这里曾经用 location.reload() 做"重新对齐"，那是个严重 bug：
    //    ① 渲染进程的 location.reload() 在本应用里**不工作** —— 它发起一次永远不提交的
    //       导航，页面卡在"正在导航"状态：图还在，但脚本全停。
    //       用户看到的就是"只剩一张贴图，怎么点都没反应"。
    //       （实测对照：location.reload() 无效、webContents.reload() 有效。）
    //    ② 而且这个重载**本来就多余** —— 位置接管现在两种模式都生效，
    //       "谁来接管"没有变，切换只需要改这个布尔值，没有任何状态需要重建。
    var cb = document.querySelector('.dshpet-phys-row input')
    if (cb) cb.checked = enabled
    log('拖动物理 ' + (v ? '开' : '关') + '（就地生效，不重载）')
  }

  // ------------------------------------------------------------------------
  // 位置兜底夹取：**不管是谁在动她**，都不许越出工作区
  // ------------------------------------------------------------------------
  // 用户报："打开或关闭拖动物理，拖动时都能移动到任务栏下面和屏幕外面。"
  //
  // 拖拽本身是夹取的（clampToBounds），但"夹取"只在**我们经手**的那几条路上生效：
  //   · onPointerMove（我们接管拖动时）
  //   · applyOverride（我们写位置时）
  //   · syncBackFromWidget（采纳挂件的位置时）
  // 只要有一条路绕过它们 —— 比如接管因为面板打开而**主动让路**、
  // 或者挂件自己按它那套"盒子 vs window.innerHeight(整屏)"的逻辑在挪她 ——
  // 她就能落到任务栏下面（本机：整屏 1152，工作区 1104，正好差一个任务栏 48px）。
  //
  // 所以这里加一道**与"谁在拖"无关**的兜底：直接量**渲染出来的真实位置**，
  // 越界就夹回来。它每 100ms 跑一次，代价是一次 getBoundingClientRect；
  // 位置本来就在界内时**一个字都不写**，所以不会和正常拖动打架。
  function clampRendered() {
    if (!root) return
    var r
    try { r = root.getBoundingClientRect() } catch (e) { return }
    if (!r || !r.width) return
    var b = bounds()
    // 和 clampToBounds 同一套口径（右/下界可能小于左/上界时取上界，避免反转）
    var maxX = Math.max(b.left, b.right)
    var maxY = Math.max(b.top, b.bottom)
    var cx = Math.min(Math.max(r.left, b.left), maxX)
    var cy = Math.min(Math.max(r.top, b.top), maxY)
    // 1px 容差：正好贴边时别来回微调（那会看出抖）
    if (Math.abs(cx - r.left) <= 1 && Math.abs(cy - r.top) <= 1) return
    physPos = [cx, cy]
    // 拖动中我们的 physPos 就是真值来源，写回它即可；没在拖时同样成立
    applyOverride()
    log('位置越界(' + Math.round(r.left) + ',' + Math.round(r.top) + ') → 已夹回工作区(' +
      Math.round(cx) + ',' + Math.round(cy) + ')')
  }

  function start() {
    root = document.querySelector('.dshwv-root')
    if (!root) return false
    enabled = readEnabled()
    ensureOverrideCss()
    // ⚠️ **两种模式都接管位置**。原因：挂件按"盒子"夹取，而立绘只占盒子右下 59.45%，
    //    盒子左上方多出约 152px 空区 —— 按盒子夹会让立绘永远够不到屏幕顶部/左侧
    //    （用户报的"上面有一整块地方拖不上去"）。接管之后改按**立绘**夹取，死区消失。
    if (!syncFromDom()) return false
    // 兜底：启动时把她摆到桌面右下角（**立绘**的右下角贴住屏幕右下角）。
    // shell.js 已经在加载挂件**之前**清掉了 dshw-pos，正常情况下挂件本来就落在右下角；
    // 这里再按"立绘对齐"算一次 —— 因为挂件是按**盒子**对齐的，和我们的夹取口径差 152px。
    var b0 = bounds()
    physPos = [b0.right, b0.bottom]
    applyOverride()
    persistPosition()        // 首次接管也把当前位置落盘
    // 注册顺序很重要：必须是 document + capture，且早于挂件
    document.addEventListener('pointerdown', onPointerDown, true)
    // ⚠️ **右键的兜底通道。** 有些 Electron 版本经 setIgnoreMouseEvents 转发过来的
    //    `pointerdown` 不带 `button`（一律 0），但同一次按下的 `mousedown` 带。
    //    两条通道都试，靠 onPointerDown 里的 `!sling` 保证不会重复进入。
    document.addEventListener('mousedown', function (e) {
      if (e.button !== 2) return
      if (!drag || sling || !slingshotEnabled()) return
      try { e.stopImmediatePropagation() } catch (err) {}
      try { e.preventDefault() } catch (err) {}
      log('mousedown 兜底通道命中右键 → 进入弹弓')
      enterSlingshot(e.clientX, e.clientY)
    }, true)
    // ⚠️ **松手的主通道。** mouseup 的 `button` 在 Electron 里是**可靠的**
    //    （pointerup 不一定，见上面的说明）。放在 pointerup 之后注册，
    //    靠 onPointerUp 里把 sling 清掉来保证不会重复触发。
    document.addEventListener('mouseup', function (e) {
      if (!sling) return
      try { e.stopImmediatePropagation() } catch (err) {}
      if (e.button === 0) {
        log('mouseup：松左键 → 发射')
        launchSlingshot()
      } else if (e.button === 2) {
        log('mouseup：松右键 → 退回拖拽')
        cancelSlingToDrag()
      }
    }, true)
    document.addEventListener('pointermove', onPointerMove, true)
    document.addEventListener('pointerup', onPointerUp, true)
    // 弹弓：ESC 取消、失焦取消、右键菜单不弹（右键是蓄力键）
    document.addEventListener('keydown', onSlingKeydown, true)
    window.addEventListener('blur', onSlingBlur)
    // 窗口被隐藏（托盘「显示/隐藏」）时同样取消 —— 看不见了还蓄着力没有意义
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && sling) cancelSlingToAnchor()
    })
    document.addEventListener('contextmenu', function (e) {
      if (sling) { try { e.preventDefault() } catch (err) {} }
    }, true)
    document.addEventListener('pointercancel', onPointerCancel, true)

    // ⚠️⚠️ **盯住她自己的 style：被挂件改掉就立刻改回来。**
    //
    // 这是「打开米粒菜单 → 点里面的功能没反应 + 菜单关闭 + 她往下瞬移一下又恢复」
    // **三个症状的同一个根因**：
    //   挂件的基础样式是 `.dshwv-root{right:0;bottom:0}` —— `bottom:0` 是相对**窗口**的，
    //   而我们的窗口是整屏高度（为了能覆盖整屏、拖到任务栏上面）。
    //   所以挂件一写这两个值，她就掉到任务栏下面。
    //   挂件每次 express() 都会先写一遍（菜单开合、拖拽收尾、尺寸变化…），
    //   写完再由它自己的 settle() 写回真实位置 —— 表现出来就是"往下瞬移一下又恢复"。
    //
    //   **为什么之前一直没发现**：物理**开启**时 applyOverride 每帧都在跑，会立刻盖回去，
    //   所以看不出来；物理**关闭**时 applyOverride 只在拖拽/收尾时跑 ——
    //   挂件那个中间值就**留在了屏幕上**。
    //   她一动，鼠标底下的目标就跟着变：点击落空（"没反应"）、
    //   点到面板外面（"菜单直接关闭"）—— 三个症状一次全解释通了。
    //
    // 只盯**这一个元素**的 style（不是整棵文档！），代价可以忽略；
    // 写回去的值和记录一致时浏览器不会再次派发变更，所以不会自激。
    try {
      if (styleObs) styleObs.disconnect()
      styleObs = new MutationObserver(function () {
        if (mode === 'drag') return          // 拖拽中让位给拖拽（那才是唯一该写位置的路径）
        if (!root) return
        var curL = root.style.getPropertyValue('left')
        var curT = root.style.getPropertyValue('top')
        var wantL = Math.round(physPos[0]) + 'px'
        var wantT = Math.round(physPos[1]) + 'px'
        if (curL === wantL && curT === wantT) return   // 就是我们要的值，别自己喂自己
        // 留一条日志：万一还有"她瞬移"的情况，日志里能直接看到是挂件写的、我们改回来了
        log('挂件改了位置(' + curL + ',' + curT + ') → 已改回(' + wantL + ',' + wantT + ')')
        applyOverride()
      })
      styleObs.observe(root, { attributes: true, attributeFilter: ['style'] })
    } catch (err) {}

    // ⚠️ **也要盯住朝向（class）**：挂件自己也会翻她（refreshFlip/settle）。
    //    翻转会改变立绘相对盒子的真实偏移，紧跟着就得重新夹一次 ——
    //    不然贴左边时她会短暂露到屏幕外面（虽然 clampRendered 100ms 内也会补上，
    //    但那样能看见"闪一下"）。
    //
    // ⚠️⚠️ **回调必须只认"朝向真的变了"这一件事。**
    //    第一版写的是"class 一变就 applyOverride"，而 applyOverride 自己会
    //    `classList.add('dshpet-phys')` —— 虽然加已存在的类名不该产生变更记录，
    //    但那样写等于把"class 变化"和"重写位置"绑在一起，一旦挂件那边也在改 class，
    //    就会互相喂（实测直接把渲染进程跑满 CPU 卡死）。
    //    现在先比朝向：没变朝向就直接返回，回调不可能再触发自己。
    try {
      if (classObs) classObs.disconnect()
      lastFlipped = root.classList.contains('dshwv-left')
      classObs = new MutationObserver(function () {
        if (!root) return
        var f = root.classList.contains('dshwv-left')
        if (f === lastFlipped) return      // 不是朝向变化 → 不关我们的事
        lastFlipped = f
        if (drag || mode) return
        invalidateArt()
        physPos = clampToBounds(physPos)
        applyOverride()
      })
      classObs.observe(root, { attributes: true, attributeFilter: ['class'] })
    } catch (err) {}

    window.addEventListener('resize', function () {
      invalidateArt()               // 尺寸变了，立绘偏移要重算
      if (drag || mode) return
      syncFromDom()
      applyOverride()
    })
    // 定期让缓存失效一次（成本极低：一次 getBoundingClientRect）
    setInterval(invalidateArt, 3000)
    // ⚠️⚠️ **拖动标记的看门狗。**
    //    `__dshpetDragging` 是"让 shell.js 的命中判定让路"用的：置位在拖动里，
    //    清除在 pointerup。但 pointerup **可能丢**（窗口失焦、交互状态中途翻转、
    //    指针移出窗口…）。一旦丢了，这个标记就**永远卡在 true** ——
    //    于是 shell.js 的 evaluate() 一直跳过命中判定，
    //    窗口的可交互性再也不会被重新算 → **点什么都没反应**，
    //    而且菜单会因为穿透状态错乱而"自己关掉"。
    //    这就是"关闭物理拖动下点菜单里的功能没反应 + 菜单直接关闭"最可能的来源：
    //    物理关闭时没有 tick 循环兜底，丢了就是丢了。
    //    这里每 400ms 自检一次：**没有正在进行的拖拽却还立着标记 → 立刻清掉**。
    setInterval(function () {
      if (window.__dshpetDragging && !drag) {
        window.__dshpetDragging = false
        log('拖动标记自愈（pointerup 丢了）')
      }
    }, 400)
    // 窗口失焦也清一次 —— 失焦后 pointerup 通常不会再送到我们这里
    window.addEventListener('blur', function () {
      drag = null
      window.__dshpetDragging = false
    })
    // 定期看挂件有没有自己挪位置（见 syncBackFromWidget 的说明）
    setInterval(syncBackFromWidget, 400)
    // 位置兜底：不管谁在动她，都不许越出工作区（见 clampRendered 的说明）
    setInterval(clampRendered, 100)
    // 菜单一出现就立刻注入，之后菜单重建也会自动补
    //（原来只试一次 —— 菜单晚出来就永远没这个开关了）
    //（见 renderer/shell.js 的 __dshpetWatchRows 说明）
    if (window.__dshpetOnMenuReady) {
      window.__dshpetOnMenuReady(injectMenuRow)
      window.__dshpetOnMenuReady(injectStrengthRow)
      window.__dshpetOnMenuReady(injectSlingshotRow)
    } else {
      injectMenuRow()
      injectStrengthRow()
      injectSlingshotRow()
    }
    // 托盘里也有一个同样的开关（同一个值，两处都能改）
    if (api.onDragPhysics) {
      api.onDragPhysics(function (on) { setEnabled(on) })
    }
    log('已启用=' + enabled)
    return true
  }

  window.__dshpetPhysics = {
    start: start,
    injectMenuRow: injectMenuRow,
    injectStrengthRow: injectStrengthRow,
    getThrowStrength: getThrowStrength,
    setThrowStrength: setThrowStrength,
    throwSpeedCap: throwSpeedCap,
    _throwStrengthCaps: THROW_STRENGTH_CAPS,
    // 弹弓 / 飞行倍率（自检用；都是纯函数）
    slingshotDeformation: slingshotDeformation,
    slingshotSpeed: slingshotSpeed,
    slingshotTrajectory: slingshotTrajectory,
    flightAnimSpeed: flightAnimSpeed,
    _substepMaxPx: SUBSTEP_MAX_PX,
    _slingshot: {
      min: SLINGSHOT_MIN_DISTANCE, max: SLINGSHOT_MAX_DISTANCE,
      base: SLINGSHOT_BASE_SPEED, deform: SLINGSHOT_MAX_DEFORMATION,
    },
    setEnabled: setEnabled,
    isEnabled: function () { return enabled },
    // 给「多桌宠」用：她这会儿是不是正被拖着。
    // 被拖的那只位置由指针决定、推不动，只能靠对方让开（见 renderer/pet-collide.js）。
    isDragging: function () { return !!drag },
    // 给「多桌宠」用：把**立绘中心**放到屏幕坐标 (cx,cy)。
    // 新开一只时主进程会挑一个不和别人重叠的位置，用这个接口落位。
    // ⚠️⚠️ physPos 是**盒子**坐标，而立绘贴在盒子右下、偏移 (dx,dy) ——
    //    所以要把"立绘中心"换算成盒子左上角：
    //        立绘左上 = (cx - w/2, cy - h/2)
    //        盒子左上 = 立绘左上 - (dx,dy)
    //    （上一版写成 `cx + w/2` —— 连减号都反了，落座位置整个是错的。）
    setCenter: function (cx, cy) {
      if (!root) return false
      if (!isFinite(cx) || !isFinite(cy)) return false
      var a = artOffset()
      if (!a || !a.w || !a.h) return false
      physPos = clampToBounds([cx - a.w / 2 - a.dx, cy - a.h / 2 - a.dy])
      applyOverride()
      return true
    },
    // 给「多桌宠」用：这一帧有没有被同伴挡住（"碰上了"的反馈靠它）
    _solidBlocked: function () { return !!solidBlocked },
    // 给自检用：实体约束的内部状态
    _solid: function () {
      var p = solidPeers()
      return {
        gap: SOLID_GAP,
        last: lastSolidPos ? [Math.round(lastSolidPos[0]), Math.round(lastSolidPos[1])] : null,
        peers: p ? p.length : 0,
        blocked: !!solidBlocked,
      }
    },
    // 给自检用：把"约束看到的矩形"和"真实立绘矩形"摆在一起对比
    _solidDiag: function () {
      var a = artOffset()
      var r = root ? root.getBoundingClientRect() : null
      var sx = (typeof window.screenX === 'number') ? window.screenX : 0
      var sy = (typeof window.screenY === 'number') ? window.screenY : 0
      var img = document.querySelector('img.dshwv-img')
      var ir = img ? img.getBoundingClientRect() : null
      return {
        phys: [Math.round(physPos[0]), Math.round(physPos[1])],
        art: a ? { dx: a.dx, dy: a.dy, w: a.w, h: a.h } : null,
        computed: (a && r) ? { x: sx + r.left + a.dx, y: sy + r.top + a.dy, w: a.w, h: a.h } : null,
        real: ir ? { x: sx + ir.left, y: sy + ir.top, w: ir.width, h: ir.height } : null,
        flipped: !!(root && root.classList.contains('dshwv-left')),
        peers: solidPeers() || [],
      }
    },
    // 给「多桌宠」用：她这会儿的**立绘**矩形（屏幕坐标）。
    // 主进程要靠它算分离；渲染进程自己量比主进程拿 150ms 前的旧数据准。
    artRect: function () {
      var a = artOffset()
      var r = root ? root.getBoundingClientRect() : null
      if (!a || !r) return null
      var sx = (typeof window.screenX === 'number') ? window.screenX : 0
      var sy = (typeof window.screenY === 'number') ? window.screenY : 0
      return { x: sx + r.left + a.dx, y: sy + r.top + a.dy, w: a.w, h: a.h }
    },
    // 给「多桌宠」碰撞世界用：把冲量加到速度上。
    // ⚠️ 只有物理开关开着才吃速度增量 —— 关着的时候松手不抛是用户的明确选择，
    //    这时突然被撞飞会莫名其妙。位置分离（nudge）不受这个限制，照常生效。
    applyImpulse: function (dvx, dvy) {
      if (!isFinite(dvx) || !isFinite(dvy)) return false
      if (!enabled) return false
      physVel = [physVel[0] + dvx, physVel[1] + dvy]
      // 有速度就得进抛掷态 —— 否则 tick 不跑，速度白加了（她不会动）
      if (mode !== 'throw' && (Math.abs(physVel[0]) > 1 || Math.abs(physVel[1]) > 1)) {
        mode = 'throw'
        throwElapsed = 0
        startTimer()
      }
      return true
    },
    // 给「多桌宠」用：把她整体推开 (dx,dy)。
    // 走的是和拖拽/抛掷**同一套** physPos + applyOverride，
    // 所以照样过 clampToBounds —— 不会被推出工作区，也不会和兜底夹取打架。
    nudge: function (dx, dy) {
      if (!root) return false
      if (!isFinite(dx) || !isFinite(dy)) return false
      physPos = clampToBounds([physPos[0] + dx, physPos[1] + dy])
      applyOverride()
      return true
    },
    // 给自检用（带前缀，不污染全局）
    _phys: {
      softClampSpeed: softClampSpeed, springVelocity: springVelocity,
      estimateReleaseVelocity: estimateReleaseVelocity, throwStep: throwStep, isAtRest: isAtRest,
      // 本轮移植过来的（甩出力度档位 / 弹弓 / 飞行倍率 / 子步）
      throwSpeedCap: throwSpeedCap, normalizeThrowStrength: normalizeThrowStrength,
      slingshotSpeed: slingshotSpeed, slingshotDeformation: slingshotDeformation,
      slingshotTrajectory: slingshotTrajectory, flightAnimSpeed: flightAnimSpeed,
      getThrowStrength: getThrowStrength, setThrowStrength: setThrowStrength,
      _substepMaxPx: SUBSTEP_MAX_PX, _throwStrengthCaps: THROW_STRENGTH_CAPS,
    _dragFlushMs: DRAG_FLUSH_MS,
    _flushDragMove: flushDragMove,
    _dragState: function () { return { dirty: dragDirty, timerOn: dragFlushTimer !== null } },
    // 弹弓（自检用）
    slingshotEnabled: slingshotEnabled, setSlingshotEnabled: setSlingshotEnabled,
    _enterSlingshot: enterSlingshot, _updateSlingAim: updateSlingAim,
    _launchSlingshot: launchSlingshot, _cancelSlingToAnchor: cancelSlingToAnchor,
    _cancelSlingToDrag: cancelSlingToDrag, _slingProgress: slingProgress,
    _sling: function () { return sling ? { pull: [sling.pull.x, sling.pull.y], anchor: sling.anchorPos } : null },
    _injectSlingshotRow: injectSlingshotRow,
      _slingshot: { min: SLINGSHOT_MIN_DISTANCE, max: SLINGSHOT_MAX_DISTANCE,
                    base: SLINGSHOT_BASE_SPEED, deform: SLINGSHOT_MAX_DEFORMATION },
    },
    // 给自检用：立绘偏移与可达范围（用来验证"立绘能贴到屏幕四边"）
    _artOffset: function () { return artOffset() },
    _bounds: function () { return bounds() },
    _clamp: function (x, y) { return clampToBounds([x, y]) },
    // 给自检用：手动跑一次兜底夹取，并回报有没有真的夹到
    _clampRendered: function () { clampRendered(); return bounds() },
    _state: function () { return { enabled: enabled, mode: mode, pos: [Math.round(physPos[0]), Math.round(physPos[1])], vel: [Math.round(physVel[0]), Math.round(physVel[1])] } },
    // 给自检用：用一个已知初速真跑一次抛掷，用来验证"会不会飞出去 / 会不会停不下来"
    _testThrow: function (vx, vy) {
      if (!root) return false
      physVel = [vx, vy]
      mode = 'throw'
      throwElapsed = 0
      applyOverride()
      startTimer()
      return true
    },
    _constants: { SPRING_K: SPRING_K, SPRING_C: SPRING_C, GRAVITY: GRAVITY, RESTITUTION: RESTITUTION, DEAD_ZONE_SPEED: DEAD_ZONE_SPEED, GROUND_FRICTION: GROUND_FRICTION },
    // 给自检用：跑 N 步纯函数（不碰 DOM），用来和原程序 pet/physics.py 的数值逐个对拍
    _simulate: function (px, py, vx, vy, steps, L, T, R, B) {
      var bounced = false
      for (var i = 0; i < steps; i++) {
        var out = throwStep(px, py, vx, vy, DT, L, T, R, B, GRAVITY)
        px = out[0]; py = out[1]; vx = out[2]; vy = out[3]; bounced = out[4]
      }
      return { pos: [px, py], vel: [vx, vy], bounced: bounced }
    },
    _runUntilRest: function (px, py, vx, vy, L, T, R, B, maxSteps) {
      for (var i = 1; i <= maxSteps; i++) {
        var out = throwStep(px, py, vx, vy, DT, L, T, R, B, GRAVITY)
        px = out[0]; py = out[1]; vx = out[2]; vy = out[3]
        if (isAtRest(py, vx, vy, B, out[4], Math.hypot(vx, vy))) {
          return { step: i, pos: [px, py], vel: [vx, vy] }
        }
      }
      return { step: -1 }
    },
  }
})()
