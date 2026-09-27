// ============================================================================
// 「笑一下」贴图：偷吃成功、以及余额告急时，换成笑的那张贴图 2 秒
// ============================================================================
// 触发条件（用户要求）：
//   ① 偷吃白饭**成功且没被打断**（碗正常放下、没被点她打翻）
//   ② 检测到余额 < 5 元
//   ③ 检测到余额 < 1 元
//   ④ 检测到余额 == 0
// 表现：贴图换成 小鲸鱼笑.png，**2 秒后**恢复成"变化前那张"。
//
// 贴图走外壳路由 /whale-sprite-laugh.png（见 lib/shell.js）——
// 文件放在 vendor/rice/assets/ 里，但 rice 的素材白名单是它自己维护的映射表，
// 不动 vendor，改由外壳直接发。这跟已有的「小鲸鱼闭眼.png」是同一套做法。
//
// ⚠️ 交还贴图时用 `window.__dshpetLaugh` 这个**独立标志**，而不是
//    rice-role.js 用的 `__dshpetSpriteOverride`：
//    那个变量有自己的"先存原图、再还原"逻辑，两边共用的话，
//    它会把我们的笑图当成"原本的贴图"存下来 —— 交还时就还成笑图了。
//    whale-expression.js 的 desiredSrc() 已经把 __dshpetLaugh 放在最高优先级。
(function () {
  'use strict'
  var api = window.petApi || {}

  var LAUGH_URL = '/whale-sprite-laugh.png'
  var SHOW_MS = 2000          // 用户要求：2 秒
  var POLL_MS = 5000          // 余额轮询（和形象模块同一个节奏）

  var timer = null
  var showing = false
  var prevSrc = null          // "变化前那张" —— 用户要求恢复成它

  // —— 米粒图（嘴上那几粒米，.dshrice-grain）——
  // 用户要求：**贴图变的时候米粒图同时消失，贴图恢复的时候才同时出现。**
  // 原因很直白：笑的那张图嘴上没有米，米粒图还挂着就穿帮了。
  var grainTimer = null
  var grainWasShown = false   // 这次"笑"开始时，米粒图是不是正露着
  var grainMs = 1750          // 米粒停留时长（rice 的默认值；启动后从它的配置里读真实值）

  function log(m) { try { if (api.log) api.log('[笑一下] ' + m) } catch (e) {} }
  function whaleImg() { return document.querySelector('img.dshwv-img') }
  function grainEl() { return document.querySelector('.dshrice-grain') }

  // --------------------------------------------------------------------------
  // 样式：把米粒图"按住不显示"
  // --------------------------------------------------------------------------
  // 用**自己的类 + !important**去压，而不是去删 rice 的 dshrice-grain-show ——
  // 那个类是 rice 自己计时的状态，删了它，rice 到点就不会再管了，
  // 我们也没法知道"它本来还剩多久"。按住不显示、放开就恢复，最不侵入。
  function ensureCss() {
    if (document.getElementById('dshpet-laugh-css')) return
    var st = document.createElement('style')
    st.id = 'dshpet-laugh-css'
    st.textContent = [
      // transition:none 是为了"**同时**消失" —— 米粒图本身有 .18s 的淡出，
      // 留着的话贴图已经换了、米粒还在淡出，看起来就是没同步。
      '.dshrice-grain.dshpet-grain-hidden{opacity:0 !important;transition:none !important}',
    ].join('')
    document.head.appendChild(st)
  }

  // 米粒图现在是不是"露着"（rice 的状态）
  function grainShown() {
    var g = grainEl()
    return !!(g && g.classList.contains('dshrice-grain-show'))
  }
  function setGrainHidden(on) {
    var g = grainEl()
    if (!g) return
    if (on) g.classList.add('dshpet-grain-hidden')
    else g.classList.remove('dshpet-grain-hidden')
  }
  // 贴图恢复了 → 米粒图也要**同时**出现。
  // ⚠️ 笑有 2 秒，而米粒图的停留只有 grainMs（默认 1750ms），
  //    也就是说 rice 自己的计时器**多半在笑的过程中就到点了**、把类摘掉了。
  //    所以这里不能只是"解除按住"，还得在它已经被摘掉时补回来，
  //    并且自己安排一次同样的停留时长（否则它会一直挂着不走）。
  function resumeGrain() {
    var g = grainEl()
    if (!g) return
    if (g.classList.contains('dshrice-grain-show')) return   // rice 还没到点，交给它
    g.classList.add('dshrice-grain-show')
    if (grainTimer) clearTimeout(grainTimer)
    grainTimer = setTimeout(function () {
      grainTimer = null
      try { g.classList.remove('dshrice-grain-show') } catch (e) {}
    }, grainMs)
  }

  // 米粒停留时长读 rice 的真实配置（用户可能改过），读不到就用默认值
  function loadRiceCfg() {
    try {
      fetch('/dsh-rice/config', { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (d) {
          var v = d && d.config && Number(d.config.grainMs)
          if (isFinite(v) && v > 0) grainMs = v
        })
        .catch(function () {})
    } catch (e) {}
  }

  // "变化前那张"到底该记哪张？
  // ⚠️ 不能无脑记 img 当前那张：**眨眼序列中间那三帧是"过路帧"** ——
  //    半闭/全闭/半睁每 90ms 换一张，一闪而过。如果笑刚好在眨眼中间触发，
  //    记下来的就是一张半闭眼的过路帧；而形象状态机不可用（比如「启用形象切换」
  //    被关掉）时，restore() 的兜底会把这张写回去 —— 她就**半闭着眼定在那儿**了。
  //    所以碰上过路帧就改记"普通状态基准图"（baseSrc），那才是真正意义上的"原来那张"。
  function stablePrevSrc(cur) {
    try {
      var exp = window.__dshpetWhaleExp
      if (!exp || !exp.IMG) return cur
      var IMG = exp.IMG
      var transient = [IMG.half_closed_eyes, IMG.close_eyes, IMG.half_open_eyes]
      for (var i = 0; i < transient.length; i++) {
        if (transient[i] && cur === transient[i]) {
          var b = (exp._internal && exp._internal.baseSrc) ? exp._internal.baseSrc() : ''
          return b || IMG.main || cur
        }
      }
    } catch (e) {}
    return cur
  }

  // --------------------------------------------------------------------------
  // 换图 / 还原
  // --------------------------------------------------------------------------
  function laugh(why) {
    var img = whaleImg()
    if (!img) return false
    if (!showing) {
      // 只在"开始笑"的那一刻记原图；已经在笑就别覆盖了
      // （2 秒内又来一次触发时，要恢复的仍然是**最初**那张）
      prevSrc = stablePrevSrc(img.getAttribute('src') || '')
      // 米粒图：和贴图**同时**消失
      grainWasShown = grainShown()
      setGrainHidden(true)
    }
    showing = true
    // 先把标志立起来，再写 src —— 这样形象状态机的 MutationObserver
    // 看到这次变化时会直接让路（既不会抢回去，也不会把笑图当成"新角色"记进 baseSrc）
    window.__dshpetLaugh = LAUGH_URL
    if (img.getAttribute('src') !== LAUGH_URL) img.setAttribute('src', LAUGH_URL)
    if (timer) clearTimeout(timer)
    timer = setTimeout(restore, SHOW_MS)
    log('笑一下（' + why + '）')
    return true
  }

  function restore() {
    if (timer) { clearTimeout(timer); timer = null }
    if (!showing) return
    showing = false
    var img = whaleImg()
    // 先撤标志，再让状态机重新决定该显示哪张（它会按心情/疲惫/baseSrc 算）
    window.__dshpetLaugh = null
    var exp = window.__dshpetWhaleExp
    if (exp && exp.apply) {
      try { exp.apply(true) } catch (e) {}
    }
    // 兜底：状态机没接管（比如「启用形象切换」被关掉了）时，
    // 自己还原成**变化前那张** —— 也就是用户说的"变化前的最初的贴图"。
    if (img && img.getAttribute('src') === LAUGH_URL) {
      var back = prevSrc || ''
      if (back && back !== LAUGH_URL) img.setAttribute('src', back)
    }
    // 米粒图：和贴图**同时**出现（见 resumeGrain 的说明）
    setGrainHidden(false)
    if (grainWasShown) resumeGrain()
    grainWasShown = false
    log('已恢复')
  }

  // --------------------------------------------------------------------------
  // ① 偷吃成功（没被打断）
  // --------------------------------------------------------------------------
  // 从 DOM 上判：rice 的碗会依次加这些类 ——
  //   开始吃：dshrice-up
  //   被抓现行：dshrice-spill 或 dshrice-head（碗被打翻/扣头顶）
  //   吃完了：把 dshrice-up 摘掉（没有 spill/head）
  // 所以「碗落下了 + 期间从没出现过 spill/head」= 这一顿**成功且没被打断**。
  //
  // 另外要求"嘴上那几粒米出现过"（dshrice-grain-show）：
  // 那是"吃到最后一口"的标志，能挡掉"刚举碗就被 stopEating 收掉"这种误判。
  var bowlWatched = false
  function watchBowl() {
    // ⚠️ **必须幂等。** 碗可能比我们晚建好，所以外面用"重试几次"的循环调它 ——
    //    而那个循环是 `if (watchBowl() || tries > 60) clearInterval(t)`，
    //    也就是**每次重试都会再调一次**。不做保护的话就会挂上多个观察器，
    //    同一次"偷吃成功"被判成好几次（实测日志里同一毫秒打了两条"笑一下"）。
    if (bowlWatched) return true
    var bowl = document.querySelector('.dshrice-bowl')
    if (!bowl) return false
    bowlWatched = true
    var mealActive = false
    var spilled = false
    var grainShown = false
    var obs = new MutationObserver(function () {
      var cls = bowl.className || ''
      var up = cls.indexOf('dshrice-up') >= 0
      var spill = cls.indexOf('dshrice-spill') >= 0 || cls.indexOf('dshrice-head') >= 0
      if (spill) spilled = true
      if (up) {
        if (!mealActive) { mealActive = true; spilled = false; grainShown = false }
        return
      }
      if (!mealActive) return
      // 碗落下了 —— 这一顿结束
      mealActive = false
      if (!spilled && grainShown) laugh('偷吃成功')
      spilled = false
      grainShown = false
    })
    obs.observe(bowl, { attributes: true, attributeFilter: ['class'] })
    // 米粒的出现单独盯（它是另一个元素）
    var grain = document.querySelector('.dshrice-grain')
    if (grain) {
      var gObs = new MutationObserver(function () {
        if ((grain.className || '').indexOf('dshrice-grain-show') >= 0) grainShown = true
      })
      gObs.observe(grain, { attributes: true, attributeFilter: ['class'] })
    }
    log('已在盯碗（偷吃成功判定）')
    return true
  }
  // --------------------------------------------------------------------------
  // ② 余额告急：< 5 / < 1 / == 0
  // --------------------------------------------------------------------------
  // 三个阈值各自**只在"往下穿过"的那一次**触发，回到阈值以上就复位 ——
  // 否则余额一直低于 5 的时候，每 5 秒都会笑一次。
  var fired = { lt5: false, lt1: false, eq0: false }
  var lastBalance = null

  function checkBalance(total) {
    if (!isFinite(total)) return
    lastBalance = total
    if (total >= 5) { fired.lt5 = false; fired.lt1 = false; fired.eq0 = false; return }
    if (total >= 1) { fired.lt1 = false; fired.eq0 = false }
    if (total > 0) { fired.eq0 = false }
    if (total < 5 && !fired.lt5) { fired.lt5 = true; laugh('余额 < 5（' + total + '）'); return }
    if (total < 1 && !fired.lt1) { fired.lt1 = true; laugh('余额 < 1（' + total + '）'); return }
    if (total === 0 && !fired.eq0) { fired.eq0 = true; laugh('余额为 0') }
  }

  function fetchBalance() {
    try {
      fetch('/dsh-whale/balance.json', { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (d) {
          if (d && isFinite(Number(d.totalBalance))) checkBalance(Number(d.totalBalance))
        })
        .catch(function () {})
    } catch (e) {}
  }

  // --------------------------------------------------------------------------
  function start() {
    ensureCss()
    loadRiceCfg()
    var tries = 0
    var t = setInterval(function () {
      tries++
      if (watchBowl() || tries > 60) clearInterval(t)
    }, 500)
    watchBowl()
    fetchBalance()
    setInterval(fetchBalance, POLL_MS)
    // 用户可能中途改「米粒停留」那一项 —— 偶尔重读一次
    setInterval(loadRiceCfg, 60000)
    log('已就绪')
    return true
  }

  window.__dshpetLaughSprite = {
    start: start,
    // 自检用
    laugh: laugh, restore: restore,
    isShowing: function () { return showing },
    url: LAUGH_URL,
    // 自检用：米粒图的同步状态
    grainHidden: function () {
      var g = grainEl()
      return !!(g && g.classList.contains('dshpet-grain-hidden'))
    },
    grainShown: grainShown,
    grainMs: function () { return grainMs },
    // 自检用：把余额喂进来，验三个阈值的"只触发一次 + 能复位"
    feedBalance: function (v) { checkBalance(Number(v)) },
    firedState: function () { return { lt5: fired.lt5, lt1: fired.lt1, eq0: fired.eq0, last: lastBalance } },
    // 自检用：手动跑一次"偷吃成功"判定所需的内部状态（见 watchBowl）
    _watchBowl: watchBowl,
  }
})()
