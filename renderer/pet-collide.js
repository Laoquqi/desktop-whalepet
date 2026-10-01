// ============================================================================
// 多桌宠：位置上报 + 相撞弹开 + 「退出桌宠」菜单项
// ============================================================================
// 分工：
//   · **渲染进程**每 150ms 把自己**立绘**在屏幕上的矩形报给主进程
//     （顺带报"有没有正在被拖"）。注意报的是**立绘**不是窗口 ——
//     窗口是整屏大小，用窗口矩形算的话所有桌宠永远都在"相撞"。
//   · **主进程**两两求交，碰上时通知双方（贴着期间每 500ms 再通知一次，
//     理由见 main.cjs 里 REFIRE_MS 的说明）。
//   · **渲染进程**收到通知 → 把自己**推开**（体积碰撞）+ "点她"同款动画 + 按压音效。
//
// 音效用的是挂件自己的按压音：`/dsh-whale/audio-fragment.wav?id=ya1`
// （挂件里 press=ya1、release=ya2，这就是"点击桌宠"的声音）。
// 直接播，不去模拟点击 —— 模拟点击会顺带触发挂件的泡泡逻辑，副作用太大。
(function () {
  'use strict'
  var api = window.petApi || {}

  // 上报间隔。
  // ⚠️ 从 150ms 降到 50ms：主进程现在是**每 30ms 无条件分离**，
  //    上报太慢的话它一直拿着旧数据推，会推过头或者推不动。
  //    每只 20 次/秒的小消息，开销可以忽略。
  var REPORT_MS = 50
  var SOUND_PRESS = '/dsh-whale/audio-fragment.wav?id=ya1'
  var SOUND_RELEASE = '/dsh-whale/audio-fragment.wav?id=ya2'
  // 推开之后再留一点缝，免得"刚好贴住"时下一拍又被判成相撞（会抖）
  var MARGIN = 6
  // 音效/动画的节流：比主进程的 500ms 冷却略短一点，保证每次通知都有反馈，
  // 但两只同时撞过来时不至于叠成两声。
  var POKE_MS = 380
  var lastPoke = 0
  var audioCache = {}
  // 诊断开关（排查"推开之后位置被拉回去"用；那个问题已经修好，平时关着）
  var DEBUG_REVERT = false

  function log(m) { try { if (api.log) api.log('[多桌宠] ' + m) } catch (e) {} }
  function whaleImg() { return document.querySelector('img.dshwv-img') }
  function phys() { return window.__dshpetPhysics }

  function playOnce(url) {
    try {
      var a = audioCache[url]
      if (!a) { a = new Audio(url); audioCache[url] = a }
      a.currentTime = 0
      var p = a.play()
      if (p && p.catch) p.catch(function () {})
    } catch (e) {}
  }

  // "点她"同款：一次 squash & stretch，配按压音
  function poke() {
    var img = whaleImg()
    if (img) {
      try {
        var X = window.__dshpetSpriteXform
        img.style.transformOrigin = '50% 100%'
        img.style.transition = 'none'
        // ⚠️ 走**合成器**，别直接写 img.style.transform ——
        //    不然会把弹弓形变/黄金回旋那两路覆盖掉（转了半圈突然弹回）。
        if (X) X.set('poke', X.scale(1.12, 0.86))
        else img.style.transform = 'scale(1.12,.86)'
        requestAnimationFrame(function () {
          img.style.transition = 'transform .28s cubic-bezier(.34,1.56,.64,1)'
          if (X) X.set('poke', X.scale(1, 1))
          else img.style.transform = 'scale(1,1)'
        })
      } catch (e) {}
    }
    // 点击动画结束 → 通知黄金回旋接一圈（常规点击触发模式用）。
    // .28s 过渡 + 一点余量，和 transform 的过渡时长对齐。
    setTimeout(function () {
      try {
        if (window.__dshpetGoldenSpin) window.__dshpetGoldenSpin.consumeClickFinished()
      } catch (e) {}
    }, 300)
    playOnce(SOUND_PRESS)
    // 松手音：稍后一点点播，和挂件"按一下"的听感一致
    setTimeout(function () { playOnce(SOUND_RELEASE) }, 90)
  }

  // 量自己**立绘**在屏幕上的矩形（窗口内坐标 + 窗口位置 = 屏幕坐标）
  // ⚠️ **不要在这里改 img 的样式去"摘掉动画"。**
  //    试过"量之前把 img.style.transform 临时设成 none、量完再放回去"，
  //    想让 squash 动画不影响重叠量 —— 结果**把别的功能弄坏了**：
  //    这个函数每 150ms 跑一次，等于每 150ms 往立绘上写一次 transform，
  //    会打断挂件自己的 transform 过渡，翻转那一下她就露到屏幕外
  //    （left-flip 探针立刻从 7/0 变成 5/2）。
  //    动画期间量得略不准无所谓：重叠量只用来决定"往哪边推多少"，
  //    下一次通知（500ms）就会用干净的数据重算。
  function myRect() {
    var img = whaleImg()
    if (!img) return null
    var r
    try { r = img.getBoundingClientRect() } catch (e) { return null }
    if (!r || r.width <= 0 || r.height <= 0) return null
    var sx = (typeof window.screenX === 'number') ? window.screenX : 0
    var sy = (typeof window.screenY === 'number') ? window.screenY : 0
    return { x: sx + r.left, y: sy + r.top, w: r.width, h: r.height }
  }

  // ⚠️ 上报现在有**两个**用途，所以**单只也要报**：
  //    ① 喂主进程的碰撞世界（它 2 只以上才工作）；
  //    ② 主进程的「即时接管」——指针进了立绘矩形就立刻让窗口可点，
  //      不依赖鼠标转发是否活着（单只时它正是唯一能救"点不动"的凭据）。
  //    代价：每 50ms 一次 getBoundingClientRect（强制重排）+ 一次 IPC。
  //    只数变化由主进程推给我们（见 pet:count-changed），不用自己轮询。
  var petCount = 1
  function report() {
    if (!api.reportRect) return
    var me = myRect()
    if (!me) return
    var p = phys()
    var st = (p && p._state) ? p._state() : null
    api.reportRect({
      x: Math.round(me.x), y: Math.round(me.y),
      w: Math.round(me.w), h: Math.round(me.h),
      dragging: !!(p && p.isDragging && p.isDragging()),
      // ⚠️ 速度也要报 —— 主进程的碰撞世界要用它算冲量（恢复系数/摩擦/质量分摊）。
      //    不报的话只能靠位置差分猜速度，精度差一截、还会被上报间隔抹平。
      vx: st ? st.vel[0] : 0,
      vy: st ? st.vel[1] : 0,
      // 弹弓蓄力中也算无限质量（那时她由锚点+鼠标决定，撞不动）
      aiming: !!(p && p._sling && p._sling()),
    })
  }

  // --------------------------------------------------------------------------
  // 体积碰撞：把自己推开
  // --------------------------------------------------------------------------
  // 先说**为什么不能只算一个方向就推**（这两个坑都是实测踩出来的）：
  //
  //  ① 两只初始位置是**完全重合**的（都出生在右下角），"谁在左边"根本分不出来 ——
  //     两边都会算成"往右下推"，于是两只朝**同一个方向**一起走，永远分不开。
  //     所以主进程给了 bias：同一对里 A 推 -1、B 推 +1，保证朝相反方向让开。
  //
  //  ② 就算方向对了，**可能被墙顶住**：她本来就贴着屏幕右下角，
  //     "往下推"会被 clampToBounds 原样夹回来 —— 位移为 0，看起来就是"没反应"，
  //     而且重叠量一点没变，主进程每 500ms 再通知一次也还是推不动。
  //     所以这里**不假设首选方向一定推得动**：挨个试候选方向，
  //     用"立绘真的动了没有"来判定，选第一个推得动的。
  //
  // 候选顺序：① 最短分开方向（首选）→ ② 换到另一根轴（按 bias 分左右/上下）
  //          → ③ 首选方向的反向（最后才用，那会从对方身上穿过去）
  function overlapOf(me, other) {
    var ox = Math.min(me.x + me.w, other.x + other.w) - Math.max(me.x, other.x)
    var oy = Math.min(me.y + me.h, other.y + other.h) - Math.max(me.y, other.y)
    if (ox <= 0 || oy <= 0) return null
    return { ox: ox, oy: oy }
  }

  // 试着推 (dx,dy)，返回 { moved, before, after }
  // ⚠️ "推动了没有"要看**物理位置**（physPos），不能看立绘矩形 ——
  //    矩形会被动画的 transform 影响，也会被夹取影响，用它判断会误判。
  function tryPush(p, dx, dy) {
    var s0 = p._state ? p._state() : null
    if (!s0) return null
    p.nudge(dx, dy)
    var s1 = p._state ? p._state() : null
    if (!s1) return null
    return {
      moved: (s1.pos[0] !== s0.pos[0] || s1.pos[1] !== s0.pos[1]),
      before: s0.pos, after: s1.pos,
    }
  }

  // —— 其它桌宠的立绘矩形（主进程广播）——
  // 交给 drag-physics 的实体约束用：它做在"位置写入的唯一出口"上，
  // 任何一次位置只要会和同伴重叠就当场被挡住 —— 所以"重合"根本不会发生。
  var peers = []
  function onPeers(list) {
    peers = Array.isArray(list) ? list : []
    window.__dshpetPeers = peers
    if (peers.length + 1 !== petCount) petCount = peers.length + 1
  }
  // 主进程在桌宠开/关时推只数（避免自己轮询）
  function onCount(n) {
    var v = Number(n)
    if (Number.isFinite(v) && v >= 1) petCount = v
  }

  // --------------------------------------------------------------------------
  // "碰上了"的反馈：动画 + 音效 + 弹开一点点
  // --------------------------------------------------------------------------
  // ⚠️ 反馈必须挂在**边缘接触**上，不能挂在"已经重叠"上 ——
  //    现在实体约束让重合根本不会发生，再等重叠就永远等不到，一点反馈都没有。
  //    所以这里每 60ms 自己量一次"和同伴的缝"，缝到 0（贴住）就算碰上。
  // ⚠️ 缝小于这个值就算"贴上了"。
  //    原来写 2.5 —— 太紧：实体约束留 1px 缝，而同伴数据是**主进程 40ms 前**的，
  //    拖动一快，两边一叠加经常量到 3~6px，于是**判不到接触** → 不弹开、只有动画。
  //    用户报的"被弹的那只只在原地做动画、没有反弹开"就是这个。
  //    放宽到 10px：判得到，而且"贴着"和"擦肩而过"的区别依然清楚。
  var CONTACT_EPS = 10
  // 弹开多少。原来 16px 太含蓄，看起来"只是抖了一下" —— 用户要的是明确的反弹。
  var BOUNCE_PX = 64
  var lastContact = []       // 上一拍各自贴没贴（按同伴的下标）
  var CONTACT_MS = 60
  function gapTo(p) {
    var me = myRect()
    if (!me || !p || !(p.w > 0) || !(p.h > 0)) return null
    var gx = Math.max(p.x - (me.x + me.w), me.x - (p.x + p.w))
    var gy = Math.max(p.y - (me.y + me.h), me.y - (p.y + p.h))
    return { gx: gx, gy: gy, touching: (gx <= CONTACT_EPS && gy <= CONTACT_EPS) }
  }
  function checkContact() {
    if (petCount < 2) { lastContact = []; return }
    if (!peers.length) { lastContact = []; return }
    var p = phys()
    var dragging = !!(p && p.isDragging && p.isDragging())
    var next = []
    for (var i = 0; i < peers.length; i++) {
      var g = gapTo(peers[i])
      var touch = !!(g && g.touching)
      next.push(touch)
      if (!touch || lastContact[i]) continue     // 只在"刚贴上"的那一下做反馈
      var now = Date.now()
      if (now - lastPoke >= POKE_MS) {
        lastPoke = now
        poke()
        log('和另一只贴上了（缝 ' + Math.round(g.gx) + ',' + Math.round(g.gy) + '）→ 点击动画 + 音效')
      }
      // —— 弹开**不在这里做了** ——
      // 之前这里自己 nudge(BOUNCE_PX) 一下，现在**弹开由主进程的碰撞世界负责**
      // （lib/collision.js 的冲量：恢复系数 0.82 + 切向摩擦 + 库仑上限 + 质量分摊）。
      // 两处都弹会**叠加**成双倍位移，所以这里只留"碰上了"的反馈（动画 + 音效，上面已做）。
      // ⚠️ 这个函数仍然要保留：它按**缝**判定"贴住"，而实体约束让"重合"根本不会发生，
      //    只靠主进程的"重叠/扫掠"判定的话，被拖到她身边贴着走时**一点反馈都没有**。
    }
    lastContact = next
  }

  // 同伴物理步进转发来的**碰撞反弹份额**（对方撞到我时，把我该得的那份
  // 冲量+位移经主进程转过来）。走 collisionBounce —— 不管物理开关如何，
  // 碰撞都是真实世界的反馈，双方要**互相往反方向弹开**。
  // （旧版"第一只撞不动"的特例已按新需求移除：现在对称弹开。）
  // 单条消息的幅度上限：数值再离谱也不会把桌宠打成火箭/瞬移。
  // 上限取 3200 —— 和真人甩出的速度同量级，碰撞反弹才不会"撞一下就停"。
  var MAX_IMPULSE_DV = 3200    // px/s：一次冲量最多改这么多速度
  var MAX_SEPARATE_PX = 48     // px：一次分离最多挪这么多距离
  function clampMag(v, max) {
    var m = Math.hypot(v[0], v[1])
    if (m <= max || m === 0) return v
    return [v[0] / m * max, v[1] / m * max]
  }
  function onImpulse(d) {
    if (!d) return
    var p = phys()
    if (!p) return
    // 被拖着 / 弹弓蓄力中：位置由指针（或锚点+鼠标）决定，推了下一帧就被覆盖，
    // 表现为抖 —— 整个跳过。对方会照常被弹开，看起来就是"撞上去被弹住了"。
    if (p.isDragging && p.isDragging()) return
    var dv = clampMag([d.dvx || 0, d.dvy || 0], MAX_IMPULSE_DV)
    var dp = clampMag([d.dx || 0, d.dy || 0], MAX_SEPARATE_PX)
    if (p.collisionBounce) {
      p.collisionBounce(dv[0], dv[1], dp[0], dp[1])
      report()
      return
    }
    // 旧渲染接口兜底（理论上到不了这里）
    if (p.nudge && (Math.abs(dp[0]) > 0.01 || Math.abs(dp[1]) > 0.01)) p.nudge(dp[0], dp[1])
    if (p.applyImpulse && (Math.abs(dv[0]) > 0.01 || Math.abs(dv[1]) > 0.01)) {
      p.applyImpulse(dv[0], dv[1])
    }
    report()
  }

  // 新桌宠的落座位置（主进程挑好的、不和任何已有桌宠重叠的点）。
  // ⚠️ 只认**开头几秒**的指令：主进程会重复发几次保证送达，
  //    但用户可能在这期间已经把她拖走了 —— 再听就等于是把她拽回去。
  var startAt = Date.now()
  var placed = false
  function onSetPos(d) {
    if (!d) return
    // ⚠️ 落成一次就够了。主进程会重发很多次保证送达，而**落成之后再听**
    //    就等于"用户拖走她之后又被拽回原地" —— 必须只认第一次。
    if (placed) return
    if (Date.now() - startAt > 12000) return
    var p = phys()
    if (!p || !p.setCenter) return
    if (p.isDragging && p.isDragging()) return
    if (p.setCenter(d.cx, d.cy)) {
      placed = true
      report()
      log('已按主进程挑的位置落座 (' + Math.round(d.cx) + ',' + Math.round(d.cy) + ')')
      // 落好座了 → 主进程可以显示这只窗口了（免得先和别人重合着出现）
      try { if (api.notifyPlaced) api.notifyPlaced() } catch (e) {}
    }
  }

  // --------------------------------------------------------------------------
  // 「退出桌宠」菜单项
  // --------------------------------------------------------------------------
  // 只给**多开出来的**那些（第一只不给：托盘/热键那些老入口都指着它）。
  // 用建窗时就定死的标记判断，不看"它在列表里的下标" —— 下标会随别的桌宠
  // 被关掉而变，"退出桌宠"就会时有时无。
  var isExtra = false
  var extraKnown = false
  function ensureCss() {
    if (document.getElementById('dshpet-quit-css')) return
    var st = document.createElement('style')
    st.id = 'dshpet-quit-css'
    st.textContent = [
      '.dshpet-quit-btn{display:inline-flex;align-items:center;gap:4px;',
      'font:11px/1.5 -apple-system,"Microsoft YaHei",system-ui,sans-serif;',
      'color:#7a2b2b;background:rgba(214,88,88,.14);border:1px solid rgba(214,88,88,.42);',
      'border-radius:7px;padding:2px 7px;cursor:pointer;white-space:nowrap}',
      '.dshpet-quit-btn:hover{background:rgba(214,88,88,.26)}',
      '.dshpet-quit-btn:active{background:rgba(214,88,88,.38)}',
    ].join('')
    document.head.appendChild(st)
  }
  function injectQuitRow() {
    if (!isExtra) return true
    var menu = document.querySelector('.dshwv-menu')
    if (!menu) return false
    if (menu.querySelector('.dshpet-quit-btn')) return true
    ensureCss()
    var b = document.createElement('button')
    b.type = 'button'
    b.className = 'dshpet-quit-btn'
    b.textContent = '🚪 退出桌宠'
    b.title = '关掉这一只桌宠（其它的不受影响）'
    b.addEventListener('click', function (e) {
      e.stopPropagation()
      if (!api.closeSelf) { log('主进程没有 closeSelf 接口'); return }
      b.disabled = true
      b.textContent = '⏳ 正在退出…'
      api.closeSelf().then(function (r) {
        if (r && r.ok) { log('这一只已退出'); return }
        // 关不掉就把按钮还原，别让它卡在"正在退出"
        b.disabled = false
        b.textContent = '🚪 退出桌宠'
        log('退出桌宠失败：' + JSON.stringify(r))
      }).catch(function (err) {
        b.disabled = false
        b.textContent = '🚪 退出桌宠'
        log('退出桌宠异常：' + (err && err.message))
      })
    })
    // 挨着「打开桌宠」放，两个多桌宠相关的按钮在一起
    var spawn = menu.querySelector('.dshpet-spawn-btn')
    if (spawn && spawn.parentNode) spawn.parentNode.insertBefore(b, spawn.nextSibling)
    else menu.appendChild(b)
    return true
  }

  // ⚠️⚠️ **这两个监听必须在模块加载时就注册，不能等 start()。**
  //    start() 是外壳那个 4 秒定时器调的，而主进程的落座指令在页面
  //    did-finish-load 之后就开始发了（约 0.5 秒起、每 400ms 一次）——
  //    等 start() 才注册的话，**一条都收不到**，新桌宠就永远停在
  //    默认位置（和已有那只完全重合）。实测就是这么挂的。
  //    现在加载即注册：setCenter 在物理模块 start() 之前会失败（root 还没接管），
  //    主进程会一直重发，等 4 秒后物理起来了自然就落上了。
  if (api.onPeers) api.onPeers(onPeers)
  if (api.onSetPos) api.onSetPos(onSetPos)
  if (api.onImpulse) api.onImpulse(onImpulse)
  if (api.onPetCount) api.onPetCount(onCount)
  if (api.petCount) api.petCount().then(function (r) { if (r && r.count) petCount = r.count }).catch(function () {})

  function start() {
    setInterval(report, REPORT_MS)
    report()
    setInterval(checkContact, CONTACT_MS)
    // 问主进程"我是不是多开出来的" —— 是的话才加「退出桌宠」
    if (api.petInfo) {
      api.petInfo().then(function (info) {
        isExtra = !!(info && info.isExtra)
        // 告诉 drag-physics 的实体约束："我是不是第一只" ——
        // 第一只撞不动（用户要求"保持在右下角"）。见 drag-physics 的 resolveSolid。
        try { window.__dshpetIsExtra = isExtra } catch (e) {}
        extraKnown = true
        if (isExtra) {
          // 菜单一出现就立刻注入，之后菜单重建也会自动补
          //（见 renderer/shell.js 的 __dshpetWatchRows 说明）
          if (window.__dshpetOnMenuReady) window.__dshpetOnMenuReady(injectQuitRow)
          else injectQuitRow()
        }
        log('已就绪（每 ' + REPORT_MS + 'ms 上报一次立绘位置；' +
          (isExtra ? '这是多开出来的，菜单里有「退出桌宠」' : '这是第一只') + '）')
      }).catch(function () { log('已就绪（问不到自己的身份，按第一只处理）') })
    } else {
      log('已就绪（每 ' + REPORT_MS + 'ms 上报一次立绘位置）')
    }
  }

  window.__dshpetCollide = {
    start: start, poke: poke, report: report,    // 给自检用
    _overlapOf: overlapOf,
    _onPeers: onPeers,
    _onSetPos: onSetPos,
    _onImpulse: onImpulse,
    _onCount: onCount,
    _petCount: function () { return petCount },
    _checkContact: checkContact,
    _peers: function () { return peers },
    _placed: function () { return placed },
    _injectQuitRow: injectQuitRow,
    _isExtra: function () { return isExtra },
    _extraKnown: function () { return extraKnown },
    _setExtra: function (v) { isExtra = !!v },
    _margin: MARGIN,
  }
})()
