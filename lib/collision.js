// ============================================================================
// 多桌宠碰撞物理核心（移植自参考实现 dsh-pet-indesktop / pet/collision.py）
// ============================================================================
// 纯函数，无 Electron / DOM 依赖 —— 和 physics.py 的移植一样，可以单独对拍。
//
// 参考实现是多进程架构（每只桌宠一个进程 + 一个碰撞宿主进程走 IPC）；
// 本项目所有桌宠都在**同一个 Electron 主进程**里，所以**不需要 IPC 那一层**，
// 只把物理核心照搬过来即可（collision_ipc.py / collision_client.py / codec 不移植）。
//
// 六条设计（照抄 collision.py 的 docstring，改动前先想清楚）：
//   1. 圆链/椭圆碰撞检测（Broad-phase AABB + Narrow-phase）
//   2. 质量计算（面积加权 clamp 0.5~2.5，无基准按 scale² fallback）
//   3. 冲量求解（恢复系数 0.82、切向摩擦 0.08、库仑上限、每质量 9000px/s）
//   4. 位置分离（逆质量分摊、每次最多 60% 重叠、min 1px / max 12px、
//      0.5px slop、连续 3 tick 强制完整分离）
//   5. 稳定重合方向（两 ID 稳定哈希，**禁用随机**）
//   6. 多体碰撞冲量合并与迭代分离
import crypto from 'node:crypto'

// ---- 默认物理常量 ----
const DEFAULT_RESTITUTION = 0.82        // 默认恢复系数
const DEFAULT_FRICTION = 0.08           // 默认切向摩擦系数
const DEFAULT_MASS_SCALE = 1.0          // 默认质量倍率
const DEFAULT_IMPULSE_CAP = 9000.0      // 每单位质量等效冲量上限 (px/s)
const IMPULSE_MIN_APPROACH_SPEED = 80.0 // 低于此接近速度只做位置分离 (px/s)
const DEFAULT_BASE_SCALE = 0.72         // 基准缩放

// ---- 状态 Flags 位定义 ----
const FLAG_VISIBLE = 1 << 0
const FLAG_THROWN = 1 << 1              // 正在抛掷中
const FLAG_DRAGGING = 1 << 2            // 正在拖拽中（无限质量）
const FLAG_SLINGSHOT_AIMING = 1 << 3    // 弹弓蓄力中
const FLAG_LOCK_POSITION = 1 << 4       // 锁定位置（无限质量）
const FLAG_NO_MOVE = 1 << 5
const FLAG_MOUSE_THROUGH = 1 << 6
const FLAG_AUTO_CURSOR_HIDDEN = 1 << 7
const FLAG_PAUSED = 1 << 8
const FLAG_COLLISION_ENABLED = 1 << 9
const FLAG_PREDICTED_BOUNCE = 1 << 10
const FLAG_STATIC = 1 << 11             // 静态布景（无限质量但保留弹性）

// 静态布景专用恢复系数：>1 = 撞岛被"加速弹开"（果冻墙/弹床）。
const STATIC_RESTITUTION = 1.3

// 位置分离参数（plan4 §4.2）
const SEP_OVERLAP_RATIO = 0.6
const SEP_MIN = 1.0
const SEP_MAX = 12.0
const SEP_SLOP = 0.5
// 连续这么多 tick 还分不开 → 强制完整分离
const FORCE_FULL_TICKS = 3

// ---------------------------------------------------------------------------
// 成员状态
// ---------------------------------------------------------------------------
function makeMember(id, opts) {
  opts = opts || {}
  return {
    id: String(id),
    x: num(opts.x), y: num(opts.y),
    vx: num(opts.vx), vy: num(opts.vy),
    width: num(opts.width), height: num(opts.height),
    mass: opts.mass == null ? 1 : num(opts.mass),
    flags: opts.flags == null ? 0 : (opts.flags | 0),
    infiniteMass: typeof opts.infiniteMass === 'boolean' ? opts.infiniteMass : undefined,
    // 圆链（三个内切圆）。没给就按矩形算。
    circles: Array.isArray(opts.circles) ? opts.circles : null,
    prevX: opts.prevX == null ? num(opts.x) : num(opts.prevX),
    prevY: opts.prevY == null ? num(opts.y) : num(opts.prevY),
  }
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0 }

// 无限质量：拖拽中 / 锁定位置 / 静态布景 —— 撞不动，但**别人撞它照样被挡**
function isInfiniteMass(m) {
  // ⚠️ 参考实现里 is_infinite_mass 是**独立字段**（不一定和 flags 一致），
  //    这里两者都认：显式给了就用显式的，否则按 flags 推。
  if (typeof m.infiniteMass === 'boolean') return m.infiniteMass
  return !!(m.flags & (FLAG_DRAGGING | FLAG_LOCK_POSITION | FLAG_STATIC))
}
function hasFlag(m, f) { return !!(m.flags & f) }

// ---------------------------------------------------------------------------
// 质量（plan4 §4.1）
// 面积加权并 clamp 到 0.5~2.5 —— 优先保证街机手感，不做真实物理。
// ---------------------------------------------------------------------------
function calculateMass(radiusX, radiusY, baseRadiusX, baseRadiusY, scale, collisionMassScale) {
  const sc = scale == null ? DEFAULT_BASE_SCALE : num(scale)
  const cms = collisionMassScale == null ? DEFAULT_MASS_SCALE : num(collisionMassScale)
  let raw
  if (baseRadiusX != null && baseRadiusY != null && baseRadiusX > 1e-4 && baseRadiusY > 1e-4) {
    raw = (num(radiusX) * num(radiusY)) / (num(baseRadiusX) * num(baseRadiusY)) * cms
  } else {
    const ratio = DEFAULT_BASE_SCALE > 0 ? sc / DEFAULT_BASE_SCALE : 1.0
    raw = cms * Math.pow(ratio, 2)
  }
  return Math.max(0.5, Math.min(2.5, raw))
}

// ---------------------------------------------------------------------------
// 稳定重合方向（plan4：**禁用随机**）
// 两中心完全重合时，用两个 id 的稳定哈希生成固定方向 ——
// 否则每帧方向都在变，两只叠在一起会"抖成一团"。
// 用排序后的组合算角度，保证**交换参数顺序得到的方向互为反向**。
// ---------------------------------------------------------------------------
function stableHashDirection(idA, idB) {
  const ordered = [String(idA), String(idB)].sort()
  const key = Buffer.from(ordered[0] + '--' + ordered[1], 'utf8')
  const digest = crypto.createHash('sha256').update(key).digest()
  const val = digest.readUInt32BE(0)
  const angle = (val % 360000) / 1000.0 * (Math.PI / 180.0)
  const ux = Math.cos(angle)
  const uy = Math.sin(angle)
  return String(idA) === ordered[0] ? [ux, uy] : [-ux, -uy]
}

// ---------------------------------------------------------------------------
// 碰撞体：矩形内切的**三个等圆**（三圆胶囊链）
// 长边排三个圆、短边决定半径 —— 比单个圆贴合"细长"的立绘，
// 也比整矩形更像"实体"（角上不会莫名其妙撞上）。
// ---------------------------------------------------------------------------
function circlesFromRect(left, top, width, height) {
  const l = num(left), t = num(top)
  const w = Math.max(0, num(width)), h = Math.max(0, num(height))
  const r = Math.min(w, h) / 2.0
  const cx = l + w / 2.0, cy = t + h / 2.0
  if (w >= h) {
    return [[l + r, cy, r], [cx, cy, r], [l + w - r, cy, r]]
  }
  // ⚠️ 第三个圆是 **top + height - radius**（不是 cy + h - r —— 对拍抓出来的）
  return [[cx, t + r, r], [cx, cy, r], [cx, t + h - r, r]]
}

function circlesOf(m) {
  if (m.circles && m.circles.length) return m.circles
  return circlesFromRect(m.x, m.y, m.width, m.height)
}

// ---------------------------------------------------------------------------
// 当前帧重叠检测：返回**最深**的那一对
// ---------------------------------------------------------------------------
function checkCollisionCircles(c1, c2, id1, id2) {
  let best = null
  for (const a of (c1 || [])) {
    for (const b of (c2 || [])) {
      if (!a || !b || a.length < 3 || b.length < 3) continue
      const x1 = num(a[0]), y1 = num(a[1]), r1 = Math.max(1e-4, num(a[2]))
      const x2 = num(b[0]), y2 = num(b[1]), r2 = Math.max(1e-4, num(b[2]))
      const dx = x2 - x1, dy = y2 - y1
      const dist = Math.hypot(dx, dy)
      if (dist >= r1 + r2) continue
      let nx, ny
      if (dist < 1e-6) { const d = stableHashDirection(id1 || '', id2 || ''); nx = d[0]; ny = d[1] }
      else { nx = dx / dist; ny = dy / dist }
      const overlap = r1 + r2 - dist
      const contactX = (x1 + nx * r1 + x2 - nx * r2) / 2.0
      const contactY = (y1 + ny * r1 + y2 - ny * r2) / 2.0
      if (best === null || overlap > best[0]) best = [overlap, nx, ny, contactX, contactY]
    }
  }
  if (best === null) return [false, 0, 0, 0, 0, 0]
  return [true, best[1], best[2], best[0], best[3], best[4]]
}

// ---------------------------------------------------------------------------
// 扫掠检测（防高速隧穿）—— 返回首次接触时刻 t
// ⚠️⚠️ **必须解二次方程求最早接触，不能用"线段最近接近点"。**
//    匀速穿过时，最近点的法线恰好垂直于运动方向 → vn≈0 →
//    会被最小接近速度阈值过滤掉 → 表现为**高速直接穿过去**。
//    TOI 时刻的法线沿两圆心连线，与相对速度的反向分量必然为负，冲量判定必成立。
// 做法：把 B 的位移从 A 里减掉（B 相对静止），解 |start + t*delta| = r1+r2 在 [0,1] 的最早根。
// ---------------------------------------------------------------------------
function sweptCircleChainCollisionAtT(aPrev, aCurr, bPrev, bCurr) {
  let best = null // [t, nx, ny, contactX, contactY]
  const n = Math.min((aPrev || []).length, (aCurr || []).length)
  const m = Math.min((bPrev || []).length, (bCurr || []).length)
  for (let i = 0; i < n; i++) {
    const ap = aPrev[i], ac = aCurr[i]
    if (!ap || !ac || ap.length < 3 || ac.length < 3) continue
    const ax0 = num(ap[0]), ay0 = num(ap[1])
    const ax1 = num(ac[0]), ay1 = num(ac[1])
    const r1 = Math.max(1e-4, num(ac[2]))
    for (let j = 0; j < m; j++) {
      const bp = bPrev[j], bc = bCurr[j]
      if (!bp || !bc || bp.length < 3 || bc.length < 3) continue
      const bx0 = num(bp[0]), by0 = num(bp[1])
      const bx1 = num(bc[0]), by1 = num(bc[1])
      const r2 = Math.max(1e-4, num(bc[2]))
      const startX = ax0 - bx0, startY = ay0 - by0
      const deltaX = (ax1 - ax0) - (bx1 - bx0)
      const deltaY = (ay1 - ay0) - (by1 - by0)
      const radiusSum = r1 + r2
      const aCoef = deltaX * deltaX + deltaY * deltaY
      if (aCoef <= 1e-12) continue            // 相对静止：交给当前帧检测
      const bCoef = 2.0 * (startX * deltaX + startY * deltaY)
      const cCoef = startX * startX + startY * startY - radiusSum * radiusSum
      if (cCoef <= 0.0) continue              // 帧首已重叠：交给当前帧检测
      const disc = bCoef * bCoef - 4.0 * aCoef * cCoef
      if (disc < 0.0) continue                // 轨迹没碰到
      const t = (-bCoef - Math.sqrt(disc)) / (2.0 * aCoef)
      if (t < 0.0 || t > 1.0) continue
      const relX = startX + deltaX * t
      const relY = startY + deltaY * t
      const dist = Math.hypot(relX, relY)
      let nx, ny
      if (dist > 1e-6) {
        // rel = A − B，法线取"从 A 指向 B" = −rel/dist
        nx = -relX / dist; ny = -relY / dist
      } else {
        const dl = Math.sqrt(aCoef) || 1
        nx = deltaX / dl; ny = deltaY / dl
      }
      const contactX = ax0 + (ax1 - ax0) * t
      const contactY = ay0 + (ay1 - ay0) * t
      if (best === null || t < best[0]) best = [t, nx, ny, contactX, contactY]
    }
  }
  if (best === null) return [false, 0, 0, 0, 0, 0, 0]
  return [true, best[0], best[1], best[2], 1.0, best[3], best[4]]
}

function sweptCircleChainCollision(aPrev, aCurr, bPrev, bCurr) {
  const r = sweptCircleChainCollisionAtT(aPrev, aCurr, bPrev, bCurr)
  if (!r[0]) return [false, 0, 0, 0, 0, 0]
  return [true, r[2], r[3], r[4], r[5], r[6]]
}

// ---------------------------------------------------------------------------
// 冲量求解（恢复系数 + 切向摩擦 + 库仑上限 + 每质量上限）
// nx,ny = 从 A 指向 B 的单位法线。返回 [jn, dvxA, dvyA, dvxB, dvyB]
// ---------------------------------------------------------------------------
function solveCollisionImpulse(a, b, nx, ny, restitution, friction, impulseCap) {
  const e0 = restitution == null ? DEFAULT_RESTITUTION : restitution
  const mu = friction == null ? DEFAULT_FRICTION : friction
  const cap = impulseCap == null ? DEFAULT_IMPULSE_CAP : impulseCap

  const infA = isInfiniteMass(a), infB = isInfiniteMass(b)
  const invMA = (infA || !(a.mass > 0)) ? 0.0 : 1.0 / a.mass
  const invMB = (infB || !(b.mass > 0)) ? 0.0 : 1.0 / b.mass
  if (invMA === 0.0 && invMB === 0.0) return [0, 0, 0, 0, 0]  // 两个都撞不动

  const vrx = b.vx - a.vx, vry = b.vy - a.vy
  const vn = vrx * nx + vry * ny
  if (vn >= 0.0) return [0, 0, 0, 0, 0]                       // 已经在分离

  let e = Math.max(0.0, Math.min(1.0, num(e0)))
  if (infA || infB) {
    // 无限质量体（拖拽/锁定中）吸能 e=0：被握着的一方不动，撞来的贴停不弹飞。
    // 但 FLAG_STATIC 静态布景用 STATIC_RESTITUTION 加速弹开（撞岛像撞弹床）。
    const staticInvolved =
      (infA && (a.flags & FLAG_STATIC)) || (infB && (b.flags & FLAG_STATIC))
    e = staticInvolved ? STATIC_RESTITUTION : 0.0
  }
  // 低速接触改**非弹性**（e=0，只挡不弹）：
  // 静置接触不抖动，但贴着时有"被挡住"的实体感，不再像空气。
  if (vn >= -IMPULSE_MIN_APPROACH_SPEED) e = 0.0

  const sumInvM = invMA + invMB
  let jn = -(1.0 + e) * vn / sumInvM
  const maxJ = Math.max(invMA, invMB) > 0 ? cap / Math.max(invMA, invMB) : cap
  jn = Math.min(jn, maxJ)

  const tx = -ny, ty = nx
  const vt = vrx * tx + vry * ty
  let jt = 0.0
  if (Math.abs(vt) > 1e-6 && mu > 0.0) {
    const jtIdeal = -vt / sumInvM
    const muMax = mu * Math.abs(jn)
    jt = Math.max(-muMax, Math.min(muMax, jtIdeal))
  }
  const jx = jn * nx + jt * tx
  const jy = jn * ny + jt * ty
  return [jn, -jx * invMA, -jy * invMA, jx * invMB, jy * invMB]
}

// ---------------------------------------------------------------------------
// 位置分离（plan4 §4.2）
// 返回 [sepDist, dxA, dyA, dxB, dyB]
// ---------------------------------------------------------------------------
function calculatePositionSeparation(overlap, nx, ny, invMA, invMB, forceFull) {
  const sumInvM = invMA + invMB
  if (sumInvM <= 0.0) return [0, 0, 0, 0, 0]
  const effOverlap = Math.max(0.0, overlap - SEP_SLOP)
  if (effOverlap <= 0.0 && !forceFull) return [0, 0, 0, 0, 0]

  let sepDist
  if (forceFull) {
    // 连续几 tick 还分不开 → 一次到位（上限 4×max，免得炸开）
    sepDist = Math.min(overlap, SEP_MAX * 4)
  } else {
    const target = effOverlap * SEP_OVERLAP_RATIO
    sepDist = Math.max(SEP_MIN, Math.min(SEP_MAX, target))
  }
  const fracA = invMA / sumInvM
  const fracB = invMB / sumInvM
  return [sepDist, -nx * sepDist * fracA, -ny * sepDist * fracA,
    nx * sepDist * fracB, ny * sepDist * fracB]
}

export {
  DEFAULT_RESTITUTION,
  DEFAULT_FRICTION,
  DEFAULT_MASS_SCALE,
  DEFAULT_IMPULSE_CAP,
  IMPULSE_MIN_APPROACH_SPEED,
  DEFAULT_BASE_SCALE,
  STATIC_RESTITUTION,
  FLAG_VISIBLE,
  FLAG_THROWN,
  FLAG_DRAGGING,
  FLAG_SLINGSHOT_AIMING,
  FLAG_LOCK_POSITION,
  FLAG_NO_MOVE,
  FLAG_MOUSE_THROUGH,
  FLAG_AUTO_CURSOR_HIDDEN,
  FLAG_PAUSED,
  FLAG_COLLISION_ENABLED,
  FLAG_PREDICTED_BOUNCE,
  FLAG_STATIC,
  SEP_OVERLAP_RATIO,
  SEP_MIN,
  SEP_MAX,
  SEP_SLOP,
  FORCE_FULL_TICKS,
  makeMember,
  isInfiniteMass,
  hasFlag,
  calculateMass,
  stableHashDirection,
  circlesFromRect,
  circlesOf,
  checkCollisionCircles,
  sweptCircleChainCollisionAtT,
  sweptCircleChainCollision,
  solveCollisionImpulse,
  calculatePositionSeparation,
}
