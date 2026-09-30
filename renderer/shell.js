// ============================================================================
// 桌面外壳脚本
// ============================================================================
// 同源架构：页面由本地服务发出，所以挂件里的 /dsh-whale/* /dsh-rice/* 都是同源请求，
// 这里**不需要**做任何 URL 改写。
//
// 只做三件事：
//   ① 按指针位置决定鼠标穿透（空白处穿透，挂件上接管）
//   ② 依次载入原版挂件脚本与 rice 客户端脚本
//   ③ 启动失败时给出可读提示，而不是让用户对着空桌面发呆
(function () {
  var api = window.petApi || {}
  function log(msg) { try { if (api.log) api.log(msg) } catch (e) {} }

  var hintEl = null
  function hint(text, sticky) {
    if (!hintEl) hintEl = document.getElementById('boot-hint')
    if (!hintEl) return
    hintEl.textContent = text
    hintEl.style.display = 'block'
    if (!sticky) setTimeout(function () { hintEl.style.display = 'none' }, 6000)
  }

  window.addEventListener('error', function (ev) {
    log('页面错误: ' + (ev.message || '') + ' @ ' + (ev.filename || '') + ':' + (ev.lineno || 0))
  })
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason
    log('未处理的 Promise 拒绝: ' + ((r && r.message) || r))
  })

  // ===========================================================================
  // ① 鼠标穿透判定
  // ===========================================================================
  // 背景：窗口是一张**全屏透明覆盖层**。默认整窗穿透（不挡桌面操作），
  //       只有指针真的落在挂件上时才接管鼠标。
  //
  // ⚠️ 这里曾经踩过一个坑，务必看清：
  //    最初只用 elementFromPoint 判断"指针在不在挂件上" —— **完全不行**。
  //    因为挂件刻意把 `.dshwv-root`、`.dshwv-body`、`img.dshwv-img` 都设成
  //    `pointer-events:none`（它自己另有一套逐像素命中图），
  //    elementFromPoint 会跳过它们、返回 BODY。
  //    实测：立绘中心、根节点中心、根节点左上角，三处全都返回 `BODY`。
  //    结果就是 —— **穿透永远不关，左键点她完全没反应**（拖动也一样）。
  //
  // 解法：**复刻挂件自己的命中图**。它的算法在 whale-widget.js 的 isWhaleHit 里：
  //    · 一张 610×610 的画布，图片按 object-fit:contain + object-position:right bottom 绘制
  //    · 指针坐标换算成画布坐标，翻转时 lx = 610 - lx
  //    · 读该点 alpha，> 10 即命中
  //    翻转状态不读内部变量，直接看 DOM 上有没有 `.dshwv-left` 类（上游也是这么表达的）。
  //
  // 另外 elementFromPoint 仍然要保留：菜单按钮、各种面板、rice 的元素是
  // `pointer-events:auto`，那些情况下它能正确返回。
  // 两条判据取**或**，才是完整的"指针在挂件上"。

  var HIT_SIZE = 610
  var hitPixels = null      // Uint8ClampedArray(HIT_SIZE*HIT_SIZE*4)
  var hitSrc = null         // 已经建好命中图的图片地址
  var hitLoading = false

  function whaleImg() { return document.querySelector('img.dshwv-img') }

  function ensureHitMap(src) {
    if (!src || src === hitSrc || hitLoading) return
    hitLoading = true
    var probe = new Image()
    probe.onload = function () {
      try {
        var c = document.createElement('canvas')
        c.width = HIT_SIZE
        c.height = HIT_SIZE
        var ctx = c.getContext('2d', { willReadFrequently: true })
        var iw = probe.width || HIT_SIZE
        var ih = probe.height || HIT_SIZE
        // 与上游一致：contain + 右下对齐
        var s = Math.min(HIT_SIZE / iw, HIT_SIZE / ih)
        var dw = iw * s
        var dh = ih * s
        ctx.drawImage(probe, HIT_SIZE - dw, HIT_SIZE - dh, dw, dh)
        hitPixels = ctx.getImageData(0, 0, HIT_SIZE, HIT_SIZE).data
        hitSrc = src
      } catch (err) {
        hitPixels = null
        hitSrc = src
        log('命中图构建失败: ' + (err && err.message))
      }
      hitLoading = false
    }
    probe.onerror = function () {
      // 图片取不到：不要因此把整块区域当成"她"（那会变成一块点不动的死区），
      // 退化成"矩形内可交互"，与上游策略一致。
      hitPixels = null
      hitSrc = src
      hitLoading = false
    }
    probe.src = src
  }

  function whaleHit(x, y) {
    var img = whaleImg()
    if (!img) return false
    var r
    try { r = img.getBoundingClientRect() } catch (err) { return false }
    if (!r || r.width <= 0 || r.height <= 0) return false
    // 矩形外直接排除，省掉画布查询
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return false

    ensureHitMap(img.getAttribute('src'))
    if (!hitPixels) {
      // 命中图还没就绪（首次加载中）或构建失败：退回矩形判定
      return true
    }
    var lx = Math.floor((x - r.left) / r.width * HIT_SIZE)
    var ly = Math.floor((y - r.top) / r.height * HIT_SIZE)
    if (lx < 0 || ly < 0 || lx >= HIT_SIZE || ly >= HIT_SIZE) return false
    var root = document.querySelector('.dshwv-root')
    if (root && root.classList.contains('dshwv-left')) lx = HIT_SIZE - lx
    if (lx < 0 || lx >= HIT_SIZE) return false
    return hitPixels[(ly * HIT_SIZE + lx) * 4 + 3] > 10
  }
  // 暴露给自检用（带项目前缀，不污染全局命名空间）
  window.__petWhaleHit = whaleHit
  // 给自检用：问"这个坐标现在会不会让窗口接收鼠标事件"
  window.__petShellEvaluate = function (x, y) { return evaluate(x, y) }
  window.__petHitInfo = function () {
    return { src: hitSrc, ready: !!hitPixels, loading: hitLoading }
  }

  function isPanelElement(el) {
    if (!el) return false
    if (el === document.body || el === document.documentElement) return false
    if (el.id === 'root' || el.id === 'boot-hint') return false
    return true
  }

  var lastInteractive = null
  var waitMoveLog = false     // 诊断：让路恢复后等第一个 mousemove（见 onReevalInteractive）
  var lastX = -1
  var lastY = -1
  var forced = false          // 托盘强制穿透

  function setInteractive(on) {
    on = !!on
    if (on === lastInteractive) return
    lastInteractive = on
    try { if (api.setInteractive) api.setInteractive(on) } catch (e) {}
  }

  function evaluate(x, y) {
    if (forced) return false
    // ⚠️ **米粒设置面板开着的时候，整窗都要接收鼠标事件。**
    //    不然"点空白处关闭面板"永远不生效：面板之外的区域是穿透的，
    //    点击直接落到桌面上，页面根本收不到 —— 面板里那个"点外面关闭"的
    //    处理器自然也不会触发。代价是面板开着时桌面点不动，
    //    但第一下点击就会把面板关掉，随后立刻恢复穿透。
    try {
      if (document.querySelector('.dshrice-menu.dshrice-open')) return true
    } catch (err) {}
    // ⚠️ **「形象与互动」设置面板开着时同理。**
    //    它摆在桌宠菜单左边、离她很远 —— 那块区域平时是穿透的，
    //    点击直接落到桌面上，页面收不到，"点空白处关闭"就永远不生效。
    //    （第一版漏了这条，用户报"点空白处关不掉"就是这个原因。）
    try {
      var ep = document.querySelector('.dshpet-exp-panel')
      if (ep && getComputedStyle(ep).display !== 'none') return true
    } catch (err) {}
    // ⚠️ **小鲸鱼 ☰ 菜单开着的时候，整窗也要接收鼠标事件。**
    //    挂件本来就有"点菜单外面收起菜单"的逻辑（onDocPointerDown，
    //    菜单内部/各面板/按钮都已豁免），但空白处是穿透的 —— 点击直接落到
    //    桌面上，页面收不到，那条逻辑永远等不到事件。与上面两个面板同一条
    //    道理：菜单开着 → 整窗接管；第一下点击要么点在菜单里、要么把菜单
    //    关掉，关掉后下一次判定立刻恢复穿透。
    try {
      if (document.querySelector('.dshwv-menu.dshwv-menu-open')) return true
    } catch (err) {}
    var el = null
    try { el = document.elementFromPoint(x, y) } catch (err) {}
    if (isPanelElement(el)) return true
    return whaleHit(x, y)
  }

  // ⚠️ 这个函数每帧最多只该跑一次，而且**拖动期间根本不该跑**。
  //    evaluate() 里有两个强制重排的调用：elementFromPoint() 和 whaleHit() 里的
  //    getBoundingClientRect()。鼠标事件一秒几十上百个，每次都同步重排 = 拖动一卡一卡。
  //    拖动时她本来就是可交互状态，判定没有意义 —— 所以直接跳过（见 __dshpetDragging）。
  var updateScheduled = false
  function update(e) {
    lastX = e.clientX
    lastY = e.clientY
    if (waitMoveLog) {                      // 诊断：让路恢复后的第一个鼠标移动
      waitMoveLog = false
      log('让路恢复后收到第一个 mousemove (' + lastX + ',' + lastY + ') → 事件通道正常')
    }
    if (window.__dshpetDragging) return          // 拖动中：跳过，别和拖动抢布局
    if (updateScheduled) return                  // 合并到下一帧，多个事件只算一次
    updateScheduled = true
    // ⚠️⚠️ **这里绝对不能用 requestAnimationFrame。**
    //    原来写的是 rAF(...)，而**被节流的渲染进程不跑 rAF 回调** ——
    //    全屏让路时主进程会 setBackgroundThrottling(true)，
    //    恢复后即使关掉节流，rAF 回调也可能一直不被调度。
    //    后果：鼠标事件明明到了（handler 跑了），但真正决定穿透状态的
    //    setInteractive() **永远不执行** → 窗口永远停在"穿透" →
    //    表现就是用户说的"一点反应都没有"（连桌宠菜单都点不了）。
    //    改用 setTimeout(0)：定时器即使被节流也只是延迟，不会像 rAF 那样彻底不跑。
    setTimeout(function () {
      updateScheduled = false
      setInteractive(evaluate(lastX, lastY))
    }, 0)
  }

  window.addEventListener('mousemove', update, true)
  // 指针离开窗口 → 恢复穿透
  window.addEventListener('mouseleave', function () { setInteractive(false) })
  window.addEventListener('blur', function () { setInteractive(false) })

  // ⚠️⚠️ **主进程要求"重新评估穿透"时必须真的重新下发。**
  //    背景（用户报"全屏视频进出后点不了"）：
  //      主进程和渲染端各有一个状态缓存，都是"值没变就跳过"：
  //        main.cjs:  if (interactiveOf.get(w) === on) return
  //        这里:      if (on === lastInteractive) return
  //      而窗口 hide()/showInactive() 之后，Electron 那边**实际**的穿透状态
  //      可能已经复位，两个缓存却还认为"没变" → 谁都不重新下发 →
  //      窗口永远停在"点一下直接穿到桌面"= 点不了。
  //    所以收到主进程的信号后：**清掉本地缓存**，再用最后已知坐标强制重算一次。
  //    （下面那个 1 秒兜底复核也依赖 lastX/lastY，不够确定 —— 这条是确定性的。）
  if (api.onReevalInteractive) {
    api.onReevalInteractive(function () {
      // ⚠️⚠️ **只清缓存，绝对不要用旧坐标重算。**
      //    lastX/lastY 是**全屏前**鼠标的位置 —— 那时鼠标在视频上（视频全屏了），
      //    拿它 evaluate() 必然得出"穿透"，于是刚被主进程接管回来的窗口
      //    又被打回穿透 —— 死锁原样保留（日志实测：
      //    「重新评估鼠标穿透 → 穿透」，紧接着用户就点不动了）。
      //
      //    主进程那边已经把窗口强制设成"接管"了，这里只要**让下一次真实的
      //    mousemove 能重新下发**就够了 —— 清掉本地缓存即可。
      //    用户把鼠标移到她身上时会触发 mousemove，那时 evaluate 用的是
      //    **真实指针位置**，判定才准。
      lastInteractive = null
      // —— 诊断：等下一次鼠标移动，看事件到底有没有到窗口 ——
      // "点不了"查了四轮。这条日志是**决定性**的：
      //   有 → 事件到了，问题在判定逻辑
      //   没有 → 事件根本没到窗口（窗口不可见 / 位置离谱 / 被系统挡住）
      waitMoveLog = true
      log('已清穿透缓存（等下一次鼠标移动重新判定，不用旧坐标硬算）')
    })
  }

  // 全屏让路：主进程会在 260ms 后 hide 窗口，这里先把画面淡出。
  // ⚠️ 必须在 hide **之前** 跑完 —— 窗口一隐藏，渲染就停了，动画不会再推进。
  //    淡出结束后立刻把 opacity 复位（窗口已经不可见了，复位不会被看到），
  //    这样下次恢复显示时不会残留一个透明的画面。
  if (api.onFadeOut) {
    api.onFadeOut(function () {
      try {
        var el = document.documentElement
        el.style.transition = 'opacity .22s ease'
        el.style.opacity = '0'
        setTimeout(function () {
          try { el.style.opacity = '1' } catch (e) {}
        }, 400)
      } catch (e) {}
    })
  }

  // 兜底：面板开合、她被拖动之后，指针没动但状态该变 —— 每 1 秒用最后坐标复核一次
  setInterval(function () {
    if (lastX < 0) return
    var want = evaluate(lastX, lastY)
    if (want !== lastInteractive) setInteractive(want)
  }, 1000)

  // 托盘「强制鼠标穿透」开关（万一自动判定在某些机器上不合适，给个逃生口）
  if (api.onForcePassthrough) {
    api.onForcePassthrough(function (on) {
      forced = !!on
      setInteractive(false)
      log('强制鼠标穿透：' + (forced ? '开' : '关'))
    })
  }

  // ===========================================================================
  // ② 载入原版脚本
  // ===========================================================================
  // 顺序不能反：rice 的客户端要读鲸鱼已经建好的 DOM（.dshwv-root / .dshwv-img）。
  function loadScript(src) {
    return new Promise(function (resolve) {
      var s = document.createElement('script')
      s.src = src
      s.onload = function () { resolve(true) }
      s.onerror = function () { resolve(false) }
      document.body.appendChild(s)
    })
  }

  // ===========================================================================
  // ③ 托盘「回到右下角」
  // ===========================================================================
  if (api.onResetPos) {
    api.onResetPos(function () {
      try {
        localStorage.removeItem('dshw-pos')
        localStorage.removeItem('dshw-snap')
        localStorage.removeItem('dshw-scale')
      } catch (err) {}
      // ⚠️ 必须走主进程重载：location.reload() 在本应用里无效（见 main.cjs 说明）
      if (api.reload) api.reload()
    })
  }

  // ⚠️ **必须在加载挂件之前**清掉位置记录。
  //    挂件在初始化时就会读 localStorage['dshw-pos'] 恢复位置 —— 那发生在我们启动
  // 每次打开都落在"桌面右下角、任务栏**上面**"。
  //
  // ⚠️ 这里**不能只 removeItem**。挂件的基础样式是 `.dshwv-root{right:0;bottom:0}` ——
  //    "bottom:0" 是相对**窗口**的；而我们的窗口为了能覆盖整屏，高度是整屏 1152
  //    （见 main.cjs 里 setBounds 那段）。于是没有位置记录时，
  //    挂件会把她放在 y=1152 —— **正好在任务栏下面**。
  //    （上一版就是清掉记录，结果"打开时依然在任务栏下面"。）
  //
  // 正确做法：**直接写一个正确的记录**，让挂件初始化时一步到位：
  //   vAnchor=bottom + vDist=任务栏高度 → 挂件算出的 top = innerHeight - 立绘高 - vDist
  //   即"立绘底边正好落在任务栏上沿"，而且不用等她先闪一下再被我们纠正。
  try {
    var taskbarH = Math.max(0, (screen.height || 0) - (screen.availHeight || 0))
    var availTop = Number(screen.availTop) || 0
    localStorage.setItem('dshw-pos', JSON.stringify({
      v: 2,
      hAnchor: 'right',
      hDist: 0,                 // 贴右
      vAnchor: 'bottom',
      vDist: taskbarH + availTop,   // 离窗口下沿 = 任务栏高度（任务栏在顶部时也成立）
    }))
  } catch (e) {}

  ;(async function boot() {
    // ⚠️⚠️ **各模块往菜单/面板里加按钮开关的统一起点。**
    //    以前每个模块各写一个 500ms 轮询 —— 用户报的
    //    "打开菜单还要等一会才出现那些按钮" 就是这么来的：
    //    挂件**每次开菜单都会把菜单行重建一遍**，我们注入的行被清掉，
    //    只能等下一次轮询（最坏 500ms）补回来。
    //
    //    这里盯的是**容器自己的直接子节点**（childList），不是整棵文档。
    //    ⚠️ **绝对不能用 subtree:true 盯 body** —— 见 renderer/rice-entry.js 里的血泪教训：
    //      鲸鱼的气泡/动画每帧都在改 class，subtree 会让回调每帧都跑，
    //      同步一遍重排就能把整个页面拖成幻灯片、点击也跟着不可靠。
    //      只盯一个容器的直接子节点，开销可以忽略。
    window.__dshpetWatchRows = function (selector, fn) {
      var run = function () {
        try { return !!fn() } catch (e) { log('菜单注入失败: ' + (e && e.message)); return false }
      }
      // 先立刻试一次 —— shell 起来时挂件已经加载完，菜单多半已经在了，这一下就够
      run()
      var rowObs = null
      var attach = function () {
        if (rowObs) return true
        var el = document.querySelector(selector)
        if (!el) return false
        try {
          rowObs = new MutationObserver(function () { run() })
          rowObs.observe(el, { childList: true })
        } catch (e) {}
        return !!rowObs
      }
      if (attach()) return
      // 容器还没建出来：**慢速轮询**找它，找到就换成上面的精细观察。
      // 这里刻意不用 MutationObserver —— 只有启动那一小会儿，轮询便宜得多。
      var n = 0
      var t = setInterval(function () {
        n++
        if (attach() || n > 40) clearInterval(t)
      }, 250)
    }
    // 鲸鱼 ☰ 菜单（绝大多数按钮开关都在这儿）
    window.__dshpetOnMenuReady = function (fn) { window.__dshpetWatchRows('.dshwv-menu', fn) }

    var okW = await loadScript('/dsh-whale/widget.js')
    if (!okW) {
      hint('鲸鱼挂件脚本加载失败 —— 托盘 →「打开日志」看 pet.log', true)
      return
    }
    var okR = await loadScript('/dsh-rice/rice.js')
    if (!okR) hint('「偷吃白饭」加载失败，鲸鱼挂件本身不受影响')

    // 拖动物理：必须在挂件**初始化之后**再 start()（它要读 .dshwv-root 的位置和菜单节点）。
    //
    // ⚠️ 关于监听顺序（这里很容易想反）：
    //    它要能拦下挂件的 pointermove / pointerup，靠的是 `stopImmediatePropagation()`
    //    —— 而它只对"同一阶段、还没执行到的监听器"有效。所以**我们的必须先执行**。
    //    两者的监听器都挂在 document 的 capture 阶段，执行顺序 = **注册顺序**：
    //      · 挂件的 pointerdown 是在模块初始化时注册的（很早）
    //      · 但挂件的 pointermove / pointerup / pointercancel 是在**每次按下时才注册**的
    //      · 我们在 start() 里一次性注册（比"每次按下"早）
    //    → 所以 pointermove / pointerup 上，我们注册得更早、执行得更早，拦得住 ✓
    //    → 而 pointerdown 我们**故意不拦**（点击弹气泡挂在它上面），谁先谁后都无所谓。
    var okP = await loadScript('/drag-physics.js')
    // 把「偷吃白饭」的浮动小标签收进鲸鱼菜单
    await loadScript('/rice-entry.js')
    // ⚠️ 面板左移模块**已停用**（2026-09-30，用户第二次要求回退）。
    //    用户反馈："每次都只改'自定义'" —— 说明只有 .dshwv-fontmenu /
    //    .dshwv-rgbmenu / .dshwv-qcolmenu 这三个生效，其它面板没反应
    //    （它们大概不是 position:fixed，或者被外层容器定位，
    //     在面板自己身上加 margin-left 不起作用）。
    //    结果就是"只动了自定义菜单"—— 用户不想要这个效果。已全部恢复原状。
    //    文件保留；以后要做先搞清楚各面板的真实定位方式（先加只读诊断）。
    // await loadScript('/panel-shift.js')
    await loadScript('/menu-extras.js')
    // 米粒面板版面修补：按行打类名（带单位的行永远不换行）
    await loadScript('/rice-layout.js')
    await loadScript('/rice-songs.js')
    await loadScript('/rice-role.js')
    await loadScript('/whale-expression.js')
    // ⚠️ 合成器必须**先于**任何会写 transform 的模块加载
    await loadScript('/sprite-xform.js')
    await loadScript('/pet-collide.js')
    await loadScript('/golden-spin.js')
    await loadScript('/file-eater.js')
    // 「笑一下」贴图（偷吃成功 / 余额告急）—— 必须在 whale-expression 之后
    // （它要把自己的标志塞进形象状态机的优先级里）
    await loadScript('/laugh-sprite.js')
    await loadScript('/now-playing.js')

    // ⚠️⚠️⚠️ **就绪等待：轮询到挂件真就绪就立刻启动，不再盲等 4 秒。**
    //
    //    这里以前是 `setTimeout(function () { ... }, 4000)` ——
    //    用户报的"打开菜单还要等一会才出现那些按钮开关"**就是它**：
    //    全部模块的 start()（包括所有菜单注入）都排在这 4 秒之后。
    //    光把轮询改成观察器没用 —— 那会儿代码压根还没开始跑。
    //
    //    就绪判据按原来那句注释里说的真实依赖来定：
    //      · __dshWhaleInit —— 挂件脚本已执行
    //      · .dshwv-root    —— 物理要读它的位置
    //      · .dshwv-menu    —— 各模块要往菜单里加行
    //      · 立绘已量到尺寸 —— 否则物理按错误尺寸夹取、菜单行也排不对
    //    兜底：最多等 4 秒（和原来一样），到点无论如何都启动。
    function bootModules() {
      if (!window.__dshWhaleInit) {
        hint('挂件没有初始化 —— 托盘 →「打开日志」，把 pet.log 发给维护者', true)
        return
      }
      // 预热命中图，免得第一次移上去要等图片解码
      var img = whaleImg()
      if (img) ensureHitMap(img.getAttribute('src'))
      // 挂件就绪之后再启动物理（它要读 .dshwv-root 的位置和挂件的菜单节点）
      if (okP && window.__dshpetPhysics) {
        try { window.__dshpetPhysics.start() } catch (err) { log('拖动物理启动失败: ' + (err && err.message)) }
      }
      if (window.__dshpetRiceEntry) {
        try { window.__dshpetRiceEntry.start() } catch (err) { log('米粒入口启动失败: ' + (err && err.message)) }
      }
      if (window.__dshpetMenuExtras) {
        try { window.__dshpetMenuExtras.start() } catch (err) { log('菜单扩展启动失败: ' + (err && err.message)) }
      }
      if (window.__dshpetRiceSongs) {
        try { window.__dshpetRiceSongs.start() } catch (err) { log('米粒音乐启动失败: ' + (err && err.message)) }
      }
      if (window.__dshpetRiceLayout) {
        try { window.__dshpetRiceLayout.start() } catch (err) { log('米粒版面修补启动失败: ' + (err && err.message)) }
      }
      if (window.__dshpetRiceRole) {
        try { window.__dshpetRiceRole.start() } catch (err) { log('米粒角色启动失败: ' + (err && err.message)) }
      }
      if (window.__dshpetWhaleExp) {
        try { window.__dshpetWhaleExp.start() } catch (err) { log('形象与互动启动失败: ' + (err && err.message)) }
      }
      if (window.__dshpetCollide) {
        try { window.__dshpetCollide.start() } catch (err) { log('多桌宠启动失败: ' + (err && err.message)) }
      }
      if (window.__dshpetGoldenSpin) {
        try { window.__dshpetGoldenSpin.boot() } catch (err) { log('黄金回旋启动失败: ' + (err && err.message)) }
      }
      if (window.__dshpetFileEater) {
        try { window.__dshpetFileEater.boot() } catch (err) { log('拖文件吃掉启动失败: ' + (err && err.message)) }
      }
      if (window.__dshpetLaughSprite) {
        try { window.__dshpetLaughSprite.start() } catch (err) { log('笑一下贴图启动失败: ' + (err && err.message)) }
      }
      if (window.__dshpetNowPlaying) {
        try { window.__dshpetNowPlaying.start() } catch (err) { log('识别歌曲启动失败: ' + (err && err.message)) }
      }
    }

    var bootT0 = Date.now()
    var bootTimer = setInterval(function () {
      var rootEl = document.querySelector('.dshwv-root')
      var menuEl = document.querySelector('.dshwv-menu')
      var imgEl = whaleImg()
      var sized = !!(imgEl && imgEl.getBoundingClientRect().width > 0)
      var ready = !!window.__dshWhaleInit && !!rootEl && !!menuEl && sized
      if (ready || Date.now() - bootT0 > 4000) {
        clearInterval(bootTimer)
        log('挂件就绪（等了 ' + (Date.now() - bootT0) + 'ms，' +
          (ready ? '判据全满足' : '超时兜底') + '）→ 启动各模块')
        bootModules()
      }
    }, 50)
  })()
})()
