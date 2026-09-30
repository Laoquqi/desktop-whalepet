// ============================================================================
// 小鲸鱼「多状态形象 + 互动心情」——从 DeepSeek-Balance-Whale-Widget-For-WinDesktop 移植
// ============================================================================
// 移植过来的四件事：
//   ① 多状态形象：普通 / 生气 / 失落 / 害羞 / 疲惫 / 眨眼 / 半睁眼 / 被抚摸
//   ② 互动与心情：点击（连点）/ 长按 / 抚摸触发不同反应；失望、生气、害羞阈值与眨眼频率可配
//   ③ 疲惫模式：余额低于自定义阈值 → 自动换疲惫表情 + 提示
//   ④ 开机自启（可开关）—— 走主进程，见 main.cjs 的 pet:autostart-*
//
// 图片在 vendor/whale/assets/expressions/，由外壳路由 /whale-exp/<名字>.png 提供
// （见 lib/shell.js）—— 不动 vendor 的挂件本体。
//
// ⚠️ **和挂件"自定义角色"的冲突处理**（用户说"有冲突就不要增加"）：
//    挂件的「角色」菜单可以让用户换成任意立绘。那种情况下我们**不认识**那张图，
//    多状态形象就无从谈起 —— 所以检测到自定义角色时，本模块**自动停用**，
//    并在设置面板里说明原因，而不是硬把她的图换掉。
(function () {
  'use strict'
  var api = window.petApi || {}

  // —— 图片（外壳路由）——
  var IMG = {
    main: '/whale-exp/main.png',
    stroking: '/whale-exp/stroking.png',
    angry: '/whale-exp/angry.png',
    disappointed: '/whale-exp/disappointed.png',
    shy: '/whale-exp/shy.png',
    exhausted: '/whale-exp/exhausted.png',
    close_eyes: '/whale-exp/close_eyes.png',
    half_closed_eyes: '/whale-exp/half_closed_eyes.png',
    half_open_eyes: '/whale-exp/half_open_eyes.png',
  }

  // —— 可配置项（存 localStorage）——
  var DEFAULTS = {
    on: true,
    blinkMinSec: 4,          // 眨眼间隔下限（秒）
    blinkMaxSec: 6,          // 眨眼间隔上限（秒）
    angryClicks: 18,         // 连点多少次生气
    angryWindowSec: 3,       // 连点判定窗口（秒）
    disappointedMin: 10,     // 多久没互动 → 失落（分钟）
    shySec: 6,               // 长按多久 → 害羞（秒）
    exhaustedYuan: 5,        // 余额低于多少 → 疲惫
    petEnabled: true,        // 抚摸（按住不放）是否触发反应
  }
  var K = 'dshpet-exp-cfg'
  var cfg = {}
  function loadCfg() {
    cfg = {}
    for (var k in DEFAULTS) cfg[k] = DEFAULTS[k]
    try {
      var raw = JSON.parse(localStorage.getItem(K) || '{}')
      for (var j in DEFAULTS) if (raw[j] !== undefined && raw[j] !== null) cfg[j] = raw[j]
    } catch (e) {}
  }
  function saveCfg() { try { localStorage.setItem(K, JSON.stringify(cfg)) } catch (e) {} }

  function log(m) { try { if (api.log) api.log('[形象] ' + m) } catch (e) {} }

  // —— 运行时状态 ——
  var imgEl = null
  var mood = ''            // '' | 'angry' | 'disappointed' | 'shy'
  var pressing = false
  var blinkTimer = null
  var idleTimer = null
  var moodTimer = null
  var pressTimer = null
  var clickTimes = []
  var lastInteract = Date.now()
  var exhausted = false
  var applied = null       // 当前写进去的 src（避免重复写）
  var ownWrite = false     // 标记"这次 src 变化是我们写的"
  var srcObs = null
  var disabledReason = ''
  var placeTimer = null      // 面板开着期间"持续贴住菜单"的复核定时器

  function whaleImg() { return document.querySelector('img.dshwv-img') }
  // 余额：直接问宿主要（挂件自己也是这么拿的）。
  // 不用"从挂件的 DOM 里读"—— 那是它的内部实现，换个版本就没了。
  var lastBalance = null
  function fetchBalance() {
    try {
      fetch('/dsh-whale/balance.json', { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (d) {
          if (d && isFinite(Number(d.totalBalance))) lastBalance = Number(d.totalBalance)
        })
        .catch(function () {})
    } catch (e) {}
  }
  function balance() { return lastBalance === null ? null : { totalBalance: lastBalance } }

  // —— 挂件是不是在用"自定义角色"？——
  // 是的话多状态形象没法叠加（我们不知道那张图的其它表情长什么样）→ 自动停用
  function customRoleActive() {
    try {
      var role = localStorage.getItem('dshw-role') || ''
      return !!role
    } catch (e) { return false }
  }

  // --------------------------------------------------------------------------
  // 形象切换
  // --------------------------------------------------------------------------
  // ⚠️ **普通状态用她原本那张图（baseSrc），不用移植包里的 main.png。**
  //    用户的要求是不要动原来的内容，只是增加新功能 ——
  //    如果连平时都换成移植包的 main.png，等于把她的样子改掉了。
  //    所以：只有**生气/失落/害羞/疲惫/被抚摸/眨眼**这些特殊状态才换图，
  //    回到普通状态一律还原成 baseSrc。
  var baseSrc = null
  function desiredSrc() {
    // ⓪ **「笑一下」优先级最高**（由 laugh-sprite.js 管：偷吃成功 / 余额告急时闪 2 秒）。
    //    用一个**独立的**标志，不去动 __dshpetSpriteOverride ——
    //    那个是 rice-role.js 的地盘（"被砸到头"的贴图），它有自己的存取逻辑；
    //    两边共用一个变量的话，它会把我们的笑图当成"原本的贴图"存起来，交还时就还错了。
    if (window.__dshpetLaugh) return window.__dshpetLaugh
    // ① 被抓现行时 rice 那边的"被砸到头"贴图优先（它由 rice-role.js 管）
    if (window.__dshpetSpriteOverride) return window.__dshpetSpriteOverride
    if (!cfg.on || disabledReason) return null      // 不接管
    if (exhausted) return IMG.exhausted
    if (mood === 'angry') return IMG.angry
    if (mood === 'disappointed') return IMG.disappointed
    if (mood === 'shy') return IMG.shy
    if (pressing) return IMG.stroking
    return baseSrc || IMG.main
  }

  function apply(force) {
    if (!imgEl) return
    var want = desiredSrc()
    if (!want) return
    if (!force && want === applied && imgEl.getAttribute('src') === want) return
    applied = want
    ownWrite = true
    try { imgEl.setAttribute('src', want) } catch (e) {}
    ownWrite = false
  }

  // 挂件自己也会写 img.src（**换角色**、初始化）。
  function watchSrc() {
    if (!imgEl || srcObs) return
    try {
      srcObs = new MutationObserver(function () {
        if (ownWrite) return
        var cur0 = imgEl.getAttribute('src') || ''
        // 「笑一下」在管的时候：**只放过它那一张**，别的变化照常处理。
        // ⚠️ 不能写成"只要在笑就整个 return" —— 那样这 2 秒里用户换的角色
        //    （挂件写的 src）会被无视，baseSrc 不更新，笑完她就退回**旧角色**了。
        if (window.__dshpetLaugh && cur0 === window.__dshpetLaugh) return
        if (window.__dshpetSpriteOverride) return    // rice 在管，别抢
        if (disabledReason) return
        if (!cfg.on) return
        var cur = cur0
        if (applied && cur === applied) return
        // ⚠️⚠️ **这是挂件换角色（或换贴图），我们必须"跟着换锚点"，绝不能抢回去。**
        //
        //    上一版的 bug：只判断"cur 不等于我们写的那张"就 apply(true) ——
        //    而 apply 会把图写回 baseSrc（启动时记下的那张）。于是用户每点一次
        //    「角色」里的其它形象，挂件刚把 src 改成新角色，我们**同一帧就改回去**，
        //    表现就是"角色切换不生效"（连点几次都毫无变化）。
        //
        //    正确的语义是：**只有我们自己造成的状态变化才由我们负责**。
        //    挂件主动写的 src 一律视为"新的普通状态基准图"：
        //      · 平时（无心情/不疲惫/没按着）→ 采纳它当新的 baseSrc，什么都不用改
        //      · 有心情时（生气/害羞/…）→ 先更新基准，然后再把心情那张盖上去，
        //        这样心情结束后回到的是**新角色**，而不是旧角色的图
        // 判断"是不是我们写的那几种状态图"：这些是我们的资源，其余都算挂件的图。
        var ours = false
        for (var k in IMG) { if (IMG[k] === cur) { ours = true; break } }
        if (!ours) {
          baseSrc = cur
          log('挂件换了贴图（多半是换角色）→ 已把普通状态基准更新为 ' + cur)
        }
        apply(true)
      })
      srcObs.observe(imgEl, { attributes: true, attributeFilter: ['src'] })
    } catch (e) {}
  }

  // --------------------------------------------------------------------------
  // 眨眼
  // --------------------------------------------------------------------------
  // ⚠️⚠️ **眨眼序列一旦开始就必须能被打断，否则它会把别的状态盖掉。**
  //
  //    上一版的两个毛病（合起来就是"长按不害羞"）：
  //      ① 判断 `mood || pressing || …` 只发生在**序列开始之前**。序列本身是
  //         4 帧、每帧 90ms 的 setTimeout 链 —— 一旦跑起来，中途按下她也不会停，
  //         最后一帧照样把图写回 baseSrc。
  //      ② 更要命的是它**不看时机**：`applied` 被写成眨眼的中间帧，
  //         而 setMood('shy') 那一刻如果眨眼链正跑到一半，
  //         眨眼链的后续帧会在几十毫秒后把 shy 的图覆盖掉 ——
  //         表现就是"长按了半天没反应"（其实害羞触发过，只是立刻被眨眼盖回去了）。
  //
  //    修法：把"当前这一轮眨眼"记成一个 token，任何状态变化都让它作废；
  //    每一帧写图之前都先检查 token 还有效。
  var blinkSeq = 0
  function cancelBlinkSeq() { blinkSeq++ }

  function scheduleBlink() {
    if (blinkTimer) { clearTimeout(blinkTimer); blinkTimer = null }
    if (!cfg.on || disabledReason) return
    var lo = Math.max(1, Number(cfg.blinkMinSec) || 4)
    var hi = Math.max(lo, Number(cfg.blinkMaxSec) || 6)
    var wait = (lo + Math.random() * (hi - lo)) * 1000
    blinkTimer = setTimeout(function () {
      blinkTimer = null
      if (mood || pressing || exhausted || window.__dshpetLaugh || window.__dshpetSpriteOverride) { scheduleBlink(); return }
      var myToken = ++blinkSeq
      var seq = [IMG.half_closed_eyes, IMG.close_eyes, IMG.half_open_eyes, baseSrc || IMG.main]
      var i = 0
      var step = function () {
        // 序列被作废（中途有了心情/按下/被 rice 接管）→ 立刻停手，别再写图
        if (myToken !== blinkSeq) return
        if (i >= seq.length) { scheduleBlink(); return }
        if (mood || pressing || exhausted || window.__dshpetLaugh || window.__dshpetSpriteOverride) { scheduleBlink(); return }
        applied = seq[i]; ownWrite = true
        try { if (imgEl) imgEl.setAttribute('src', seq[i]) } catch (e) {}
        ownWrite = false
        i++
        setTimeout(step, i === seq.length ? 0 : 90)
      }
      step()
    }, wait)
  }

  // --------------------------------------------------------------------------
  // 心情
  // --------------------------------------------------------------------------
  function setMood(m, holdMs) {
    mood = m
    cancelBlinkSeq()          // 心情优先：正在跑的眨眼序列立刻作废
    if (blinkTimer) { clearTimeout(blinkTimer); blinkTimer = null }
    if (moodTimer) { clearTimeout(moodTimer); moodTimer = null }
    apply(true)
    if (m) {
      holdMs = holdMs || 6000
      moodTimer = setTimeout(function () { mood = ''; apply(true); scheduleBlink() }, holdMs)
    } else {
      scheduleBlink()
    }
  }
  function touchIdle() {
    lastInteract = Date.now()
    if (mood === 'disappointed') { mood = ''; apply(true) }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    idleTimer = setTimeout(function () {
      if (mood === 'angry') return
      var mins = Math.max(1, Number(cfg.disappointedMin) || 10)
      setMood('disappointed', 999999)     // 一直失落，直到下次互动
      log('进入失落（' + mins + ' 分钟没互动）')
    }, Math.max(1, Number(cfg.disappointedMin) || 10) * 60000)
  }

  // --------------------------------------------------------------------------
  // 交互：点击 / 长按 / 抚摸
  // --------------------------------------------------------------------------
  // ⚠️⚠️ **判定"这一下是不是点在她身上"必须用坐标，不能用 e.target。**
  //
  //    上一版写的是 `e.target.closest('.dshwv-root')` —— 看上去天经地义，实际**永远为假**，
  //    于是连点不生气、长按不害羞（用户报的就是这两条）。
  //
  //    原因：挂件刻意把 `.dshwv-root` / `.dshwv-body` / `img.dshwv-img` 全设成
  //    `pointer-events:none`（它自己有另一套逐像素命中图，见 whale-widget.js 的 isWhaleHit）。
  //    所以真实的鼠标点**根本落不到这些节点上** —— e.target 一直是 BODY，
  //    `.closest('.dshwv-root')` 自然找不到东西，监听器每次都提前 return。
  //    （shell.js 顶部记着同一个坑：那里最初也用 elementFromPoint，实测立绘中心返回 BODY。）
  //
  //    正确做法：**复刻挂件自己的判据** —— 指针坐标 → 逐像素命中图。
  //    shell.js 已经把这件事做成了 window.__petWhaleHit(x, y)（它连翻转状态都处理了），
  //    直接用；取不到时退回"立绘矩形内"，与上游 hitFailed 时的策略一致。
  function hitHer(x, y) {
    if (typeof x !== 'number' || typeof y !== 'number') return false
    // 挂件自己的 UI（菜单/面板/气泡）和外壳自己的设置面板都不算"点她身上"——
    // 不然在面板里调设置、点菜单，也会被算成连点/抚摸。
    try {
      var el = document.elementFromPoint(x, y)
      if (el && el.closest) {
        // 【修复】她的**泡泡**算"点她"：连点她时第一下就会弹出余额泡泡，
        //   泡泡盖在她上方一大片，用户接着点的这部分全落在泡泡上 ——
        //   原来这里把 .dshwv-pop 一律排除，导致"点 18 次没生气"（大半点击没被计数）。
        //   菜单/面板仍是 UI，照旧排除。
        if (el.closest('.dshwv-pop')) return true
        if (el.closest(
          '.dshwv-menu, .dshwv-rolelist, .dshwv-menu-btn, ' +
          '.dshpet-exp-panel, .dshrice-menu')) return false
      }
    } catch (e) {}
    try {
      if (typeof window.__petWhaleHit === 'function') return !!window.__petWhaleHit(x, y)
    } catch (e) {}
    // 兜底：立绘矩形
    var img = whaleImg()
    if (!img) return false
    try {
      var r = img.getBoundingClientRect()
      return r.width > 0 && r.height > 0 &&
        x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
    } catch (e) { return false }
  }

  function onDown(e) {
    if (!cfg.on || disabledReason) return
    if (!hitHer(e.clientX, e.clientY)) return
    pressing = true
    cancelBlinkSeq()          // 正在跑的眨眼序列立刻作废，别盖掉"被抚摸"那张
    apply(true)
    touchIdle()
    // 长按 → 害羞
    if (pressTimer) clearTimeout(pressTimer)
    if (cfg.petEnabled) {
      pressTimer = setTimeout(function () {
        pressTimer = null
        pressing = false
        setMood('shy', 4000)
        log('长按 → 害羞')
      }, Math.max(2, Number(cfg.shySec) || 6) * 1000)
    }
  }
  function onUp(e) {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null }
    if (!pressing) return
    pressing = false
    cancelBlinkSeq()
    if (mood !== 'shy') apply(true)
    scheduleBlink()
  }
  // 生气 → 把自己甩出去：连点把她惹毛了，她"啪"地一下弹出去，撞边反弹、逐渐停下。
  // ⚠️ **与拖动物理开关无关**（用户的明确要求：不管开关都要弹）—— 走 drag-physics
  //     的 toss 通道（和拖拽松手的抛掷同一条物理管线，所以弹跳手感与"甩走"一致）。
  //     自检模式不弹：她一飞会干扰后续所有与位置/面板相关的断言。
  function angryToss() {
    if (window.petApi && window.petApi.selftest) { log('生气弹跳：自检模式跳过'); return }
    var p = window.__dshpetPhysics
    if (!p || !p.toss) { log('生气弹跳：物理模块还没就绪（刷新前点出来的）→ 本次不弹'); return }
    var speed = 2300 + Math.round(Math.random() * 900)          // 总速率：与真人甩的量级一致
    var dir = Math.random() < 0.5 ? -1 : 1                      // 水平朝向随机
    var vx = dir * Math.round(speed * (0.6 + Math.random() * 0.25))
    var vy = -Math.round(speed * (0.4 + Math.random() * 0.25))  // 往上抛，落地才有弹跳
    try { p.toss(vx, vy) } catch (e) {}
  }

  function onClick(e) {
    if (!cfg.on || disabledReason) return
    if (!hitHer(e.clientX, e.clientY)) return
    var now = Date.now()
    var win = Math.max(1, Number(cfg.angryWindowSec) || 3) * 1000
    // 【修复】从"滚动窗口"改为"间隔判定"：只看**相邻两次点击**的间隔有没有超过窗口。
    //   原来是"窗口秒内的点击总数" —— 默认 3 秒装 18 次 = 每秒 6 次才凑得满，
    //   真人连点一般每秒 3~5 次，点满 18 次时最早的点击早已被窗口挤掉 → 永远不生气。
    //   "连点"的本意是"中间没停太久"，所以只在停顿超过窗口时清空重来。
    var last = clickTimes.length ? clickTimes[clickTimes.length - 1] : 0
    if (now - last > win) clickTimes = []
    clickTimes.push(now)
    touchIdle()
    var need = Math.max(3, Number(cfg.angryClicks) || 18)
    if (clickTimes.length >= need) {
      clickTimes = []
      setMood('angry', 5000)
      angryToss()
      log('连点 ' + need + ' 次 → 生气（弹出去）')
    }
  }

  // --------------------------------------------------------------------------
  // 疲惫模式：余额低于阈值
  // --------------------------------------------------------------------------
  function checkBalance() {
    var b = balance()
    if (!b) return
    var total = Number(b.totalBalance)
    if (!isFinite(total)) return
    var lim = Number(cfg.exhaustedYuan)
    if (!isFinite(lim)) lim = 0
    var now = total < lim
    if (now !== exhausted) {
      exhausted = now
      apply(true)
      log(now ? ('余额 ' + total + ' 低于阈值 ' + lim + ' → 疲惫模式') : '余额恢复 → 退出疲惫模式')
    }
  }

  // --------------------------------------------------------------------------
  // 设置面板
  // --------------------------------------------------------------------------
  var panel = null
  function ensureCss() {
    if (document.getElementById('dshpet-exp-css')) return
    var st = document.createElement('style')
    st.id = 'dshpet-exp-css'
    st.textContent = [
      '.dshpet-exp-row{display:flex;align-items:center;gap:6px;margin:5px 0;color:#203170;font-size:12px}',
      '.dshpet-exp-row label{min-width:96px}',
      '.dshpet-exp-row input[type=number]{width:56px;padding:1px 5px;border:1px solid rgba(32,49,112,.35);' +
        'border-radius:5px;font-size:12px;color:#203170;background:#fff}',
      '.dshpet-exp-row input[type=checkbox]{width:15px;height:15px;accent-color:#203170;cursor:pointer}',
      '.dshpet-exp-hd{font-weight:600;margin:8px 0 2px;color:#203170;font-size:12px}',
      '.dshpet-exp-tip{font-size:11px;color:#7b88ad;margin-top:6px;line-height:1.5}',
      '.dshpet-exp-warn{color:#b4532a}',
      // 入口按钮：和「偷吃白饭」「打开 dsh 网页端」同一观感（被边框框住的小按钮）
      '.dshpet-exp-btn{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;' +
        'border:1px solid rgba(32,49,112,.5);border-radius:7px;background:rgba(32,49,112,.08);' +
        'color:#203170;font:12px/1.4 inherit;cursor:pointer;user-select:none;-webkit-user-select:none}',
      '.dshpet-exp-btn:hover{background:rgba(32,49,112,.18)}',
      // 入口那一行：两个按钮并排（「形象与互动」右边是「打开桌宠」）
      '.dshpet-exp-row-wrap{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.dshpet-spawn-btn{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;' +
        'border:1px solid rgba(32,49,112,.5);border-radius:7px;background:rgba(32,49,112,.08);' +
        'color:#203170;font:12px/1.4 inherit;cursor:pointer;user-select:none;-webkit-user-select:none}',
      '.dshpet-spawn-btn:hover{background:rgba(32,49,112,.18)}',
      '.dshpet-spawn-btn:active{background:rgba(32,49,112,.28)}',
      '.dshpet-exp-btn:active{background:rgba(32,49,112,.28)}',
      // 设置面板：借用米粒面板的外观（它是 position:fixed，靠 left/top 摆位）
      '.dshpet-exp-panel{width:264px;z-index:10001}',
      '.dshpet-exp-panel .dshpet-exp-row label{min-width:110px;flex:0 0 auto}',
      '.dshpet-exp-panel .dshpet-exp-row{justify-content:flex-start}',
      // 入口按钮：和「偷吃白饭」「打开 dsh 网页端」同一观感（被边框框住的小按钮）
      '.dshpet-exp-btn{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;' +
        'border:1px solid rgba(32,49,112,.5);border-radius:7px;background:rgba(32,49,112,.08);' +
        'color:#203170;font:12px/1.4 inherit;cursor:pointer;user-select:none;-webkit-user-select:none}',
      '.dshpet-exp-btn:active{background:rgba(32,49,112,.28)}',
      // 设置面板：借用米粒面板的外观（它是 position:fixed，靠 left/top 摆位）
      '.dshpet-exp-panel{width:264px;z-index:10001}',
      '.dshpet-exp-panel .dshpet-exp-row label{min-width:110px;flex:0 0 auto}',
      '.dshpet-exp-panel .dshpet-exp-row{justify-content:flex-start}',
    ].join('')
    document.head.appendChild(st)
  }

  function row(label, key, min, max, unit) {
    var r = document.createElement('div')
    r.className = 'dshpet-exp-row'
    var l = document.createElement('label')
    l.textContent = label
    r.appendChild(l)
    var i = document.createElement('input')
    i.type = 'number'
    i.min = String(min); i.max = String(max)
    i.value = String(cfg[key])
    i.addEventListener('change', function () {
      var v = Number(i.value)
      if (!isFinite(v)) v = DEFAULTS[key]
      v = Math.max(min, Math.min(max, Math.round(v)))
      cfg[key] = v
      i.value = String(v)
      saveCfg()
      scheduleBlink()
      touchIdle()
      checkBalance()
      log('设置 ' + key + ' = ' + v)
    })
    r.appendChild(i)
    if (unit) { var u = document.createElement('span'); u.textContent = unit; r.appendChild(u) }
    return r
  }
  function toggleRow(label, key, onChange) {
    var r = document.createElement('div')
    r.className = 'dshpet-exp-row'
    var l = document.createElement('label')
    l.textContent = label
    r.appendChild(l)
    var c = document.createElement('input')
    c.type = 'checkbox'
    c.checked = !!cfg[key]
    c.addEventListener('change', function () {
      cfg[key] = c.checked
      saveCfg()
      if (onChange) onChange()
      log('设置 ' + key + ' = ' + c.checked)
    })
    r.appendChild(c)
    return r
  }

  function buildPanel() {
    ensureCss()
    if (panel) return panel
    panel = document.createElement('div')
    panel.className = 'dshrice-menu dshpet-exp-panel'
    var t = document.createElement('div')
    t.className = 'dshpet-exp-hd'
    t.textContent = '形象与互动'
    panel.appendChild(t)

    panel.appendChild(toggleRow('启用形象切换', 'on', function () { apply(true); scheduleBlink() }))
    panel.appendChild(toggleRow('抚摸（长按）反应', 'petEnabled'))
    panel.appendChild(row('眨眼间隔 最短', 'blinkMinSec', 1, 60, '秒'))
    panel.appendChild(row('眨眼间隔 最长', 'blinkMaxSec', 1, 120, '秒'))
    panel.appendChild(row('连点几次生气', 'angryClicks', 3, 100, '次'))
    panel.appendChild(row('连点最大间隔', 'angryWindowSec', 1, 30, '秒'))
    panel.appendChild(row('长按多久害羞', 'shySec', 2, 60, '秒'))
    panel.appendChild(row('多久没互动失落', 'disappointedMin', 1, 240, '分钟'))
    panel.appendChild(row('余额低于多少疲惫', 'exhaustedYuan', 0, 100000, '元'))

    var hd2 = document.createElement('div')
    hd2.className = 'dshpet-exp-hd'
    hd2.textContent = '开机自启'
    panel.appendChild(hd2)
    var autoRow = document.createElement('div')
    autoRow.className = 'dshpet-exp-row'
    var al = document.createElement('label')
    al.textContent = '开机自动启动'
    autoRow.appendChild(al)
    var ac = document.createElement('input')
    ac.type = 'checkbox'
    ac.disabled = true
    autoRow.appendChild(ac)
    panel.appendChild(autoRow)
    if (api.autostartGet) {
      api.autostartGet().then(function (r) {
        ac.checked = !!(r && r.enabled)
        ac.disabled = false
      }).catch(function () {})
      ac.addEventListener('change', function () {
        if (!api.autostartSet) return
        api.autostartSet(ac.checked).then(function (r) {
          ac.checked = !!(r && r.enabled)
          log('开机自启 = ' + ac.checked)
        }).catch(function () {})
      })
    } else {
      ac.title = '当前环境不支持'
    }

    var tip = document.createElement('div')
    tip.className = 'dshpet-exp-tip'
    panel.appendChild(tip)
    panel.__tip = tip

    panel.style.display = 'none'
    document.body.appendChild(panel)
    return panel
  }

  function refreshTip() {
    if (!panel || !panel.__tip) return
    var el = panel.__tip
    el.textContent = ''
    if (disabledReason) {
      el.className = 'dshpet-exp-tip dshpet-exp-warn'
      el.textContent = disabledReason
      return
    }
    el.className = 'dshpet-exp-tip'
    el.textContent = '多状态形象需要"自带角色"才能工作。' +
      '当前状态：' + (exhausted ? '疲惫（余额低）' : (mood || '正常')) + '。' +
      '设置即时生效。'
  }

  // --------------------------------------------------------------------------
  // 摆位：**绝对算法** —— 同一个输入必然得到同一个输出，所以可以反复调用
  // --------------------------------------------------------------------------
  // 用户报的问题：面板和桌宠 ☰ 菜单**重合**了。
  //
  // 上一版的做法是"开面板的那一刻算一次位置，之后就不管了"，而且分了
  // "菜单开着 / 菜单没开"两条分支（菜单没开时锚在入口按钮上）——
  // 两个毛病：
  //   ① **菜单是跟着她走的**。她被人拖走、或被拖动物理弹回来时，菜单
  //      （position:fixed，每次 toggleMenu/positionMenu 重摆）会挪到新位置，
  //      而面板是死的 —— 于是"本来没重合，拖一下就重合了"。
  //   ② 那两条分支**给的其实是同一个横向规则**（都在菜单/按钮左边留 8px），
  //      分成两支只增加了不一致的机会，没有任何好处。
  //
  // 现在只留一条规则，而且**按当前真实几何算绝对值**：
  //   · 横向：面板右边缘 = 参照物（菜单，其次入口按钮）左边缘 − 8px；
  //           左边实在放不下 → 放到参照物的**右侧**（同样留 8px），
  //           这样"她贴着屏幕左边"时也不会压在一起。
  //   · 纵向：面板顶边对齐参照物顶边，超出视口就上收；最后一律夹进视口。
  //   · 参照物没有任何一个存在时 → 退回左上角的安全位。
  // 返回值：算出来的矩形（自检/排障用）。
  var GAP = 8

  function placePanel() {
    if (!panel) return null
    var p = panel.getBoundingClientRect()
    var pw = p.width || 264
    var ph = p.height || 200
    var vw = window.innerWidth
    var vh = window.innerHeight

    // —— 参照物：优先整个菜单（它才是"桌宠菜单"），没有就退到入口按钮 ——
    var ref = null
    var menu = document.querySelector('.dshwv-menu')
    if (menu && menu.classList.contains('dshwv-menu-open')) {
      ref = menu.getBoundingClientRect()
    } else {
      var btn = document.querySelector('.dshpet-exp-btn')
      if (btn) ref = btn.getBoundingClientRect()
    }

    var x, y
    if (ref && ref.width > 0) {
      // 首选：摆到参照物**左边**
      x = ref.left - GAP - pw
      // 左边放不下（会推出屏幕）→ 改摆到**右边**
      if (x < GAP) {
        var rightX = ref.right + GAP
        // 右边也放不下就取"左边还剩多少、右边还剩多少"里更宽的那一侧
        if (rightX + pw > vw - GAP) {
          var roomLeft = ref.left - GAP
          var roomRight = vw - ref.right - GAP
          x = (roomLeft >= roomRight) ? Math.max(GAP, ref.left - GAP - pw) : rightX
        } else {
          x = rightX
        }
      }
      y = ref.top
      // 纵向：别越过视口下沿
      if (y + ph > vh - GAP) y = vh - GAP - ph
    } else {
      // 参照物都没有：左上角安全位
      x = GAP
      y = GAP
    }

    // 最后一律夹进视口（面板比视口还高时露出顶部，内容自己滚）
    x = Math.max(GAP, Math.min(vw - pw - GAP, x))
    y = Math.max(GAP, Math.min(Math.max(GAP, vh - ph - GAP), y))

    x = Math.round(x); y = Math.round(y)
    // 值没变就一个字都不写（和 rice 那边同一个规矩：能不动 DOM 就不动）
    var nx = x + 'px', ny = y + 'px'
    if (panel.style.left !== nx) panel.style.left = nx
    if (panel.style.top !== ny) panel.style.top = ny
    return { l: x, t: y, w: Math.round(pw), h: Math.round(ph) }
  }

  function openPanel() {
    buildPanel()
    refreshTip()
    // ⚠️ 先显示再量：display:none 时 getBoundingClientRect 全是 0，
    //    拿 0 去算位置会把它摆到屏幕外。所以这里先置 block、量完再定坐标。
    panel.style.display = 'block'
    placePanel()
    // 面板开着期间**持续**贴住菜单（菜单会因为她被拖动而移动）。
    // 每 400ms 复核一次绝对值；值没变时 placePanel 不写 DOM，所以很便宜。
    if (!placeTimer) {
      placeTimer = setInterval(function () {
        if (!panel || panel.style.display === 'none') return
        placePanel()
      }, 400)
    }
  }

  function closePanel() {
    if (placeTimer) { clearInterval(placeTimer); placeTimer = null }
    if (panel) panel.style.display = 'none'
  }

  // 在鲸鱼 ☰ 菜单里加一行入口
  function injectRow() {
    var menu = document.querySelector('.dshwv-menu')
    if (!menu) return false
    if (menu.querySelector('.dshpet-exp-btn')) return true
    var row = document.createElement('div')
    row.className = 'dshwv-menu-row dshpet-exp-row-wrap'
    var b = document.createElement('button')
    b.type = 'button'
    b.className = 'dshpet-exp-btn'
    b.textContent = '🎭 形象与互动'
    b.title = '多状态形象、互动心情、疲惫模式、开机自启'
    b.addEventListener('click', function (e) {
      e.stopPropagation()
      // ⚠️ **第二次点击 = 关闭**（用户要求：开关式切换，而不是点了永远开着）。
      var panelEl = document.querySelector('.dshpet-exp-panel')
      var isOpen = !!(panelEl && panelEl.style.display === 'block')
      if (isOpen) { closePanel(); return }
      openPanel()
    })
    row.appendChild(b)
    // —— 「打开桌宠」放在「形象与互动」**右边** ——
    //    没有数量限制：每点一次多一只。走主进程开新窗口（见 main.cjs 的 spawnPet）。
    var b2 = document.createElement('button')
    b2.type = 'button'
    b2.className = 'dshpet-spawn-btn'
    b2.textContent = '打开桌宠'
    b2.title = '再开一只小鲸鱼（没有数量限制）'
    b2.addEventListener('click', function (e) {
      e.stopPropagation()
      if (!api.spawnPet) { log('主进程没有 spawnPet 接口'); return }
      api.spawnPet().then(function (r) {
        if (r && r.ok) log('已开新桌宠，当前共 ' + r.count + ' 只')
        else log('开新桌宠失败：' + JSON.stringify(r))
      }).catch(function (err) { log('开新桌宠异常：' + (err && err.message)) })
    })
    row.appendChild(b2)
    var anchor = menu.querySelector('.dshpet-rice-row') || menu.querySelector('.dshpet-phys-row')
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(row, anchor.nextSibling)
    else menu.appendChild(row)
    return true
  }

  // --------------------------------------------------------------------------
  function start() {
    loadCfg()
    imgEl = whaleImg()
    if (!imgEl) return false
    // 记下她**原本**那张图：普通状态要还原成它（见 desiredSrc 的说明）
    baseSrc = imgEl.getAttribute('src') || '' 
    // ⚠️ **不要因为"用户选过角色"就停用。**
    //    上一版拿 localStorage 的 dshw-role 判断"是不是自定义角色"，
    //    但它**只要挑过一次就会被写上**（哪怕是自带角色）—— 误判。
    //    而且真正的兜底根本不在这里：普通状态我们还原成 baseSrc（启动时她那张图），
    //    所以无论她用的是哪个角色，**平时的样子都不会被我们改掉**。
    //    万一用户觉得形象和角色不搭，设置面板里有「启用形象切换」可以随时关掉。
    if (customRoleActive()) log('提示：她当前用的是自定义角色，形象叠加可能与画风不搭（可在设置里关掉）')
    watchSrc()
    apply(true)
    scheduleBlink()
    touchIdle()
// 点空白处关闭。
    // ⚠️ 用 **capture** 阶段注册在 document 上：
    //    挂件/米粒那边也有各自的 document 点击处理，capture 保证我们一定先看到，
    //    不会被谁 stopPropagation 掉。（原来放在 buildPanel 里是冒泡阶段 —— 会被中途拦掉。）
    document.addEventListener('click', function (e) {
      if (!panel || panel.style.display === 'none') return
      var t = e.target
      if (panel.contains(t) || (t && t.closest && t.closest('.dshpet-exp-btn'))) return
      closePanel()
      log('点空白处：已关闭设置面板')
    }, true)
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panel && panel.style.display !== 'none') closePanel()
    }, true)
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('pointerup', onUp, true)
    document.addEventListener('pointercancel', onUp, true)
    document.addEventListener('click', onClick, true)
    fetchBalance()
    setInterval(function () { fetchBalance(); checkBalance() }, 5000)
    // 菜单一出现就立刻注入，之后菜单重建也会自动补
    //（见 renderer/shell.js 的 __dshpetWatchRows 说明）
    if (window.__dshpetOnMenuReady) window.__dshpetOnMenuReady(injectRow)
    else injectRow()
    log('已就绪' + (disabledReason ? '（停用：自定义角色）' : ''))
    return true
  }

  window.__dshpetWhaleExp = {
    start: start, cfg: function () { return cfg }, IMG: IMG,
    openPanel: openPanel, closePanel: closePanel, placePanel: placePanel,
    apply: apply, setMood: setMood, isExhausted: function () { return exhausted },
    disabledReason: function () { return disabledReason },
    hitHer: hitHer,
    _internal: {
      checkBalance: checkBalance, desiredSrc: desiredSrc, customRoleActive: customRoleActive,
      baseSrc: function () { return baseSrc },
      // 自检用：眨眼会每隔 4~6 秒往 img.src 上写一帧（半闭/全闭/半睁），
      // 于是"换了图 2 秒后又还原成原来那张"这类断言会**偶发**失败 ——
      // 恰好量到眨眼那一帧。自检里先把眨眼停掉，量完再放它继续。
      // ⚠️ 光清定时器不够：序列是 90ms 一步的 setTimeout 链，停在半路会**留下一张
      //    半闭眼的过路帧**。那不是"没在眨眼"该有的样子，也会让断言量到过路帧。
      //    所以停完要 apply(true) 让它回到"现在本该显示的那张"。
      blinkPause: function () {
        if (blinkTimer) { clearTimeout(blinkTimer); blinkTimer = null }
        cancelBlinkSeq()
        apply(true)
      },
      blinkResume: function () { scheduleBlink() },
    },
  }
})()
