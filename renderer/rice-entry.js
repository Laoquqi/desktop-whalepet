// ============================================================================
// 把「偷吃白饭」的入口收进小鲸鱼的 ☰ 菜单
// ============================================================================
// 背景：rice 插件默认在她右上角浮一个小标签（`.dshrice-chip`，写着「🍚 偷吃白饭」），
// 点它开合米粒设置面板。用户要求**不要在外面显示**，收进菜单里。
//
// 做法：
//   · 用 CSS 把那个小标签藏掉（`display:none`）—— **不是删掉它**，
//     因为面板的开合逻辑挂在它的 click 上，留着才能复用。
//   · 在鲸鱼的 ☰ 菜单里加一行，点它就**程序化触发 chip 的 click**。
//     隐藏元素照样能 .click()，所以开合行为与原来完全一致。
//
// ⚠️ 为什么不去调 rice 内部的 openMenu()：它是闭包里的私有函数，没有对外暴露。
//    触发 DOM 事件是这里唯一稳定、且不依赖对方内部结构的接法。
(function () {
  'use strict'
  var api = window.petApi || {}
  function log(msg) { try { if (api.log) api.log('[米粒入口] ' + msg) } catch (e) {} }

  function ensureCss() {
    if (document.getElementById('dshpet-rice-entry-css')) return
    var st = document.createElement('style')
    st.id = 'dshpet-rice-entry-css'
    st.textContent = [
      // 藏掉浮在她身上的小标签
      '.dshrice-chip{display:none !important}',
      // 菜单里那一行：**带边框的小方框**，和原来那个浮动标签一个观感
      // （原来是 background:rgba(32,49,112,.75) 的深底白字；菜单是白底，
      //   所以这里换成"浅底 + 深色描边"，一样是个被框住的按钮）
      '.dshpet-rice-row{display:inline-flex;align-items:center;gap:4px;' +
        'margin:5px 0;padding:2px 9px;border:1px solid rgba(32,49,112,.5);' +
        'border-radius:7px;background:rgba(32,49,112,.08);color:#203170;' +
        'font-size:12px;line-height:1.4;white-space:nowrap;cursor:pointer;' +
        'user-select:none;-webkit-user-select:none}',
      '.dshpet-rice-row:hover{background:rgba(32,49,112,.18)}',
      '.dshpet-rice-row:active{background:rgba(32,49,112,.28)}',
      // 按下期间把面板"钉住"：位置由 #dshpet-rice-pin-css 那条动态规则负责
      // （类 + !important，压得住 rice 的行内 left），这里只需要废掉位移。
      '.dshrice-menu.dshpet-presspin{transform:none !important}',
    ].join('')
    document.head.appendChild(st)
  }

  function injectRow() {
    var menu = document.querySelector('.dshwv-menu')
    if (!menu) return false
    if (menu.querySelector('.dshpet-rice-row')) return true
    var chip = document.querySelector('.dshrice-chip')
    if (!chip) return false            // 米粒插件还没就绪，下次再试

    var row = document.createElement('div')
    row.className = 'dshpet-rice-row'
    row.title = '打开「偷吃白饭」的设置面板'
    var label = document.createElement('span')
    label.textContent = '🍚 偷吃白饭'
    row.appendChild(label)
    row.addEventListener('click', function (ev) {
      ev.stopPropagation()
      try {
        // 转交给 rice 自己的开合逻辑（隐藏元素也能触发 click）
        chip.click()
        // 面板刚开 → **立刻**算一次避让。
        // 用 rAF：回调赶在浏览器绘制之前，所以"先重合再瞬移"那一帧根本不会被画出来。
        // （上一版是用 MutationObserver 监听整个 body 达到同样目的 —— 代价是整个页面
        //   被拖成幻灯片，见 start() 里那段说明。）
        requestAnimationFrame(function () { keepPanelClear() })
        // 再来两拍兜底：面板可能带开合动画，第一帧还没到位
        setTimeout(keepPanelClear, 60)
        setTimeout(keepPanelClear, 260)
        log('已打开米粒面板')
      } catch (err) { log('打开失败: ' + (err && err.message)) }
    })

    // 插在「拖动物理」那一行后面；找不到就接在第一个菜单行之后
    var phys = menu.querySelector('.dshpet-phys-row')
    var anchor = phys || menu.querySelector('.dshwv-menu-row')
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(row, anchor.nextSibling)
    else menu.appendChild(row)
    return true
  }

  // ------------------------------------------------------------------------
  // 让米粒面板**往左让开**小鲸鱼自己的 ☰ 菜单
  // ------------------------------------------------------------------------
  // 两个面板都是 fixed 定位、都挂在她旁边，所以很容易叠在一起。
  // rice 自己的 placeMenu() 把它摆在**她的左侧**（i.left - gap - 面板宽），
  // 但没考虑"鲸鱼菜单此刻也开着"这种情况 —— 于是就重合了。
  //
  // ⚠️⚠️ **上一版这里是"每次往左再推一点"，结果是面板左右来回跳、根本没法用。**
  //    原因：rice 的 placeMenu() 每 700ms 会重跑一次并把 left 写回去，
  //    而我们每 150ms 又推一次 —— 一拉一推就成了振荡。
  //
  //    正确做法有两条，缺一不可：
  //      ① **算绝对值，不要算增量**。每次直接算出"要让开需要多少 margin"，
  //         同一个输入必然得到同一个输出 —— 不会累积、不会来回。
  //      ② **改 margin-left，不改 left**。left 是 placeMenu 的地盘，
  //         我们碰它就会被写回去；margin-left 它从不碰，写一次就稳住。
  // ⚠️⚠️ **避让用 transform，不用 marginLeft。**
  //    rice 自己的 placeMenu() 会**周期性重写 `left`**（面板跟着她走）。
  //    之前用 marginLeft 补偿：它一改 left，我们的补偿值就失效，
  //    面板会在**指针底下跳一下** —— 点击就落到别的地方去了。
  //    这正是"有时点了相关功能没反应 + 菜单直接关闭"里那个"有时"：
  //    只有重摆恰好发生在按下与抬起之间才会中招，所以是概率性的。
  //    transform 和 left 是两套独立的东西：它改它的 left，我们加我们的位移，
  //    两者相加的结果稳定，不会再互相打架。
  var panelObs = null
  var lastPanelLeft = null
  // —— 按下期间"钉住"面板：见 pinPanel() 的说明 ——
  var pinned = null            // { el, left, top }
  var pressInPanel = false     // 这一次手势是不是从面板里按下的
  var swallowClickOnce = false // 抬起后那次 click 要不要挡掉（别让 rice 误关面板）
  var panelWasOpen = false     // 用来只在"开合沿"上重置位移

  function panelLeft(panel) {
    var l = parseFloat(panel.style.left)
    if (!isFinite(l)) l = parseFloat(getComputedStyle(panel).left) || 0
    return l
  }
  function panelShift(panel) {
    return parseFloat(panel.style.getPropertyValue('--dshpet-panel-dx')) || 0
  }
  function setPanelShift(panel, dx) {
    try {
      panel.style.setProperty('--dshpet-panel-dx', String(dx))
      panel.style.transform = dx ? ('translateX(' + dx + 'px)') : ''
    } catch (e) {}
  }

  // ------------------------------------------------------------------------
  // 按下 → 抬起之间，**把面板钉在原地**
  // ------------------------------------------------------------------------
  // ⚠️⚠️ 这是"进入菜单点了相关功能没反应 + 菜单直接关闭"的**根治**。
  //
  //    实测（聚焦探针抓到的原始数据）：在面板里按下控件的那一刻，鲸鱼自己的
  //    `onDocPointerDown` 判定"点在 ☰ 菜单外面" → `closeMenu()`；菜单一关，
  //    下面 keepPanelClear() 就把"避让位移"归零 → 面板**横向弹回 233px**。
  //    于是：
  //      · pointerup 时指针底下已经不是那个控件了 → 浏览器把 click 派发到
  //        按下/抬起目标的**最近公共祖先**（BODY）→ 控件收不到 click =「点了没反应」
  //      · 而 BODY 不在 menuEl 里 → rice 那句"点面板外面就关" →「菜单直接关闭」
  //    两个症状是同一次位移造成的；而位移发生在"按下与抬起之间"这个只有
  //    几十~一百多毫秒的窗口里 —— 撞上 keepPanelClear 那 150ms 的一次 tick
  //    才中招，所以表现为**有时**。
  //
  //    修法两层，缺一不可：
  //      ① **钉住**：按下时记下当前视觉位置，用行内 !important 写死 left/top，
  //         并用 CSS 把 transform 压成 none —— rice 每 700ms 的 placeMenu()、
  //         我们的 keepPanelClear()、以及她自己的瞬移都动不了它。
  //      ② **不归零**：菜单关掉时不再清掉避让位移（见 keepPanelClear），
  //         从根上消掉那 233px 的弹回。
  //    另外抬起后若那次 click 落在面板外，挡掉它（swallowClickOnce）——
  //    用户明明点的是面板里的控件，不该被当成"点外面"。
  //
  // ⚠️ **钉住的位置不能用"行内 left/top !important"来写。**
  //    踩过一次：rice 的 placeMenu() 每 700ms 会 `menuEl.style.left = ...`，
  //    而 `setProperty('left', v)` **不带 !important 会把我们那条带 !important
  //    的声明整条替换掉**（同一个属性只有一个声明槽）—— 于是慢一点的点击
  //    （按住超过 700ms）钉住就失效了。
  //    更糟的是解除时 `removeProperty('left')` 会把 **rice 自己写的那个值也删掉**，
  //    面板瞬间掉回 CSS 里的 `left:0` —— 实测闪一下 `-233,0`。
  //    所以改成**一条独立的小样式表**：类名 + !important，值写在规则里。
  //    类选择器的 !important 压得住行内非 !important，且**完全不碰** rice 的行内值，
  //    解除时只是把类摘掉，rice 的 left 原样还在。
  var pinStyleEl = null
  function ensurePinCss() {
    if (pinStyleEl && pinStyleEl.parentNode) return pinStyleEl
    pinStyleEl = document.getElementById('dshpet-rice-pin-css')
    if (!pinStyleEl) {
      pinStyleEl = document.createElement('style')
      pinStyleEl.id = 'dshpet-rice-pin-css'
      pinStyleEl.textContent = ''
      document.head.appendChild(pinStyleEl)
    }
    return pinStyleEl
  }

  function pinPanel(panel) {
    if (pinned || !panel) return
    var r = panel.getBoundingClientRect()
    pinned = { el: panel, left: Math.round(r.left), top: Math.round(r.top) }
    try {
      // 先写规则、再加类（同一个任务里，中间不会绘制）
      ensurePinCss().textContent =
        '.dshrice-menu.dshpet-presspin{left:' + pinned.left + 'px !important;' +
        'top:' + pinned.top + 'px !important;transform:none !important}'
      panel.classList.add('dshpet-presspin')
    } catch (e) {}
  }
  function unpinPanel() {
    if (!pinned) return
    var p = pinned.el
    pinned = null
    try {
      p.classList.remove('dshpet-presspin')
      // 规则留着也没用，清掉；rice 的行内 left/top 一直没被动过，原样生效
      if (pinStyleEl) pinStyleEl.textContent = ''
    } catch (e) {}
    // 交还控制权：立刻按真实几何重算一次（把 rice 的 left 和我们的位移对齐）
    lastPanelLeft = null
    keepPanelClear()
  }

  function installPressGuard() {
    if (window.__dshpetPressGuard) return
    window.__dshpetPressGuard = true
    document.addEventListener('pointerdown', function (e) {
      var p = (e.target && e.target.closest) ? e.target.closest('.dshrice-menu.dshrice-open') : null
      if (!p) { pressInPanel = false; return }
      pressInPanel = true
      pinPanel(p)
    }, true)
    var endPress = function () {
      if (!pressInPanel) return
      // 抬起后紧接着会派发 click —— 如果它落到面板外，那是"面板被挪走"造成的假象
      swallowClickOnce = true
      setTimeout(function () { swallowClickOnce = false }, 400)
      pressInPanel = false
      unpinPanel()
    }
    document.addEventListener('pointerup', endPress, true)
    document.addEventListener('pointercancel', endPress, true)
    // 手势从面板里开始、click 却落在面板外 → 挡掉，别让 rice 当成"点外面"把面板关了
    document.addEventListener('click', function (e) {
      if (!swallowClickOnce) return
      swallowClickOnce = false
      var t = e.target
      var inside = !!(t && t.closest && t.closest('.dshrice-menu'))
      if (inside) return
      try { e.stopPropagation() } catch (err) {}
      log('挡掉一次"面板被挪走后落在外面"的点击（否则会误关面板）')
    }, true)
  }
  // 盯住面板自己的 style：**rice 一改 left，就在同一帧把补偿补上**。
  // 不然"left 变了、补偿还没跟上"的那一帧会被画出来 —— 就是"面板跳一下"。
  // MutationObserver 回调是微任务，跑在绘制之前，所以那一帧根本不会被画出来。
  // 只盯**这一个元素**（不是整棵文档 —— 上一版监听 subtree 把页面拖垮过）。
  function watchPanel(panel) {
    if (panelObs) return
    try {
      panelObs = new MutationObserver(function () {
        var l = panelLeft(panel)
        if (lastPanelLeft !== null && Math.abs(l - lastPanelLeft) > 0.5) keepPanelClear()
        lastPanelLeft = l
      })
      panelObs.observe(panel, { attributes: true, attributeFilter: ['style'] })
    } catch (e) {}
  }

  function keepPanelClear() {
    try {
      var panel = document.querySelector('.dshrice-menu.dshrice-open')
      if (!panel) { panelWasOpen = false; return }
      // —— 面板刚由"关"变"开"：位移归零，从干净的状态重算 ——
      //    只在**开合沿**上做，不在"菜单关着"的每一拍做（那正是弹回的来源）。
      if (!panelWasOpen) {
        panelWasOpen = true
        lastPanelLeft = null
        if (Math.round(panelShift(panel)) !== 0) setPanelShift(panel, 0)
      }
      // —— 按下期间绝不移动面板 ——
      //    （pinPanel 已经用 !important 钉住了，这里只是别做无用功、也别把
      //      keepPanelClear 算出来的值写进 --dshpet-panel-dx 干扰解除后的重算。）
      if (pinned) return
      watchPanel(panel)
      var whale = document.querySelector('.dshwv-menu')
      var baseLeft = panelLeft(panel)
      lastPanelLeft = baseLeft
      var curShift = panelShift(panel)

      // ⚠️⚠️ **判"菜单开没开"必须看 dshwv-menu-open 这个类，不能看尺寸！**
      //    .dshwv-menu 关闭时是 `opacity:0; pointer-events:none`，
      //    **不是 display:none** —— 所以 offsetWidth / getBoundingClientRect
      //    在关闭状态下照样有值（而且带着 scale(.96) translateY(10px) 的变换）。
      //    上一版就是按尺寸判断的，于是菜单明明关着也把面板推走；
      //    它的位置一变推力就变 —— 面板就左右跳。
      var menuOpen = !!(whale && whale.classList.contains('dshwv-menu-open'))
      if (!menuOpen) {
        // ⚠️⚠️ **菜单关掉时不要归零！**（这是"点了没反应 + 菜单直接关闭"的另一半根因）
        //    在面板里点一下控件，鲸鱼自己的 onDocPointerDown 会把 ☰ 菜单关掉；
        //    旧代码在菜单一关就把避让位移清零 → 面板横向弹回两百多像素，
        //    而那一刻用户的手指还没抬起来 —— 抬起时指针底下已经不是那个控件了。
        //    面板此刻**不需要**再避让（菜单已经关了），但"弹回去"这个动作必须
        //    留到下次重新打开面板时再做，否则就是在用户点击的半途抽走面板。
        return
      }

      var wr = whale.getBoundingClientRect()
      var pr = panel.getBoundingClientRect()
      var w = pr.width || panel.offsetWidth || 252
      var vOverlap = pr.top < wr.bottom && pr.bottom > wr.top

      // 目标：面板右边缘 = 鲸鱼菜单左边缘 - 8px。
      // 用"不含 margin 的左边"来算，得到的是**绝对目标 margin**（≤0）——
      // 同一个输入必然得到同一个输出，不会累积、不会来回。
      var want = 0
      if (vOverlap) {
        want = Math.min(0, wr.left - 8 - (baseLeft + w))
        var minShift = -Math.max(0, baseLeft - 8)   // 别推到屏幕外
        if (want < minShift) want = minShift
      }
      want = Math.round(want)

      // 阈值放宽到 8px：rice 会周期性重摆面板，left 会有一点浮动，
      // 为此反复微调反而会让人看见"抖"。宁可粗一点、稳一点。
      if (Math.abs(want - Math.round(curShift)) > 8) setPanelShift(panel, want)
    } catch (e) {}
  }

  var obs = null

  function start() {
    ensureCss()
    installPressGuard()
    // 菜单一出现就立刻注入，之后菜单重建也会自动补
    //（见 renderer/shell.js 的 __dshpetWatchRows 说明）
    if (window.__dshpetOnMenuReady) window.__dshpetOnMenuReady(injectRow)
    else injectRow()

    // ⚠️⚠️ 这里绝对不能用 MutationObserver 监听整个 body。
    //    上一版就是这么写的，结果把整个桌宠拖垮了（用户：改完之后完全没法用了）。
    //    原因两层叠在一起：
    //      ① keepPanelClear 自己会写 panel.style.marginLeft，而它在监听 style 变化 ——
    //         等于自己喂自己；
    //      ② 更要命的是 subtree:true 把整棵文档都盯上了：鲸鱼那边气泡、动画
    //         每时每刻都在改 class/style，于是每改一次就同步跑一遍
    //         getComputedStyle + getBoundingClientRect（两次强制重排）——
    //         整个页面被拖成幻灯片，点击也跟着不可靠了。
    //
    //    正确做法：**只在我们自己打开面板的那一刻算一次**，用 rAF 保证赶在绘制之前。
    //    面板只有我们能打开（那个小标签是 display:none，用户点不到），
    //    所以在 openPanel() 里主动调一次就够了 —— 比监听全世界便宜一万倍。
    // 兜底轮询（万一漏了某条路径，比如 left 被 placeMenu 改写）
    setInterval(keepPanelClear, 150)
    log('入口已就绪')
  }

  window.__dshpetRiceEntry = {
    start: start, injectRow: injectRow, keepPanelClear: keepPanelClear,
    // 排障用：自检要能问"面板此刻有没有被钉住"
    isPinned: function () { return !!pinned },
    pinnedRect: function () { return pinned ? { l: pinned.left, t: pinned.top } : null },
  }
})()
