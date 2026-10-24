// ============================================================================
// 菜单高度自适应 —— 菜单太高时顶部会被窗口裁掉
// ============================================================================
// 用户报：「桌宠菜单顶部被挡住了」。
//
// 根因：菜单是 `position:fixed` + **bottom 锚定**（positionMenu 把它摆在立绘上方），
// 高度完全由内容决定。内容一多（先是拖动物理/通透模式/形象与互动那些行，
// 后来又加了「自定义余额」+ 一行状态提示），它就会**往窗口上方长出去** ——
// 而桌宠窗口只有 900 高，超出的部分直接被裁，用户看到的就是「顶部被挡住」。
// 实测：平时菜单 top=6（勉强放得下），一旦出现「已应用：气泡显示总余额 …」
// 这行状态，top 立刻变成 **-19**（顶部被切掉 19px）。
//
// 修法：**只在真的放不下时**才限高 + 允许滚动，平时一个字都不动（不加滚动条）。
//   · 可用高度 = innerHeight − 菜单 inline bottom − 8
//     ⚠️ 用 inline `bottom` 而不是 getBoundingClientRect：菜单开场有
//        `transform: scale(.96) translateY(10px)` 动画，rect 会跟着变，
//        按 rect 算会在动画期间算出偏小的可用高度。
//   · 菜单 bottom 是固定的 → 限高之后它是"从顶部往下收"，底部仍然贴着立绘上方，
//     不会盖住她，也不会跑位。
//   · 限高后 `scrollHeight` 不变，所以判据稳定，不会来回抖。
//
// ⚠️ 不要用「观察 body 子树」来驱动（挂件的气泡每帧都在改 class）——
//    这里只用 300ms 轮询：菜单没开时只做一次 querySelector，开销可以忽略；
//    开着时每 300ms 读一次 scrollHeight（强制重排一次），也是可接受量级。
(function () {
  'use strict'

  var lastKey = ''
  var clearTimer = null

  function log(m) {
    try { if (window.petApi && window.petApi.log) window.petApi.log('[菜单高度] ' + m) } catch (e) {}
  }

  function fit() {
    var m = document.querySelector('.dshwv-menu')
    if (!m) return

    // 菜单收起：把我们加的样式撤干净（挂件自己也会清，但别留下残留）。
    // ⚠️ 撤除必须**延迟到淡出结束之后**（350ms）：渐出动画的 100ms 里
    //    内容回流会让盒子 663→788 长高 125px，用户看到渐出中途"弹一下"
    //    （CDP 逐帧实测）。淡出结束时菜单已 opacity:0，撤了也没人看见。
    if (!m.classList.contains('dshwv-menu-open')) {
      if (lastKey && !clearTimer) {
        clearTimer = setTimeout(function () {
          clearTimer = null
          try {
            if (!m.classList.contains('dshwv-menu-open')) {
              m.style.maxHeight = ''
              m.style.overflowY = ''
              m.style.overscrollBehavior = ''
              lastKey = ''
            }
          } catch (err) {}
        }, 350)
      }
      return
    }
    try { if (clearTimer) { clearTimeout(clearTimer); clearTimer = null } } catch (err) {}

    var bottomPx = parseFloat(m.style.bottom)
    if (!isFinite(bottomPx)) return
    var avail = Math.floor(window.innerHeight - bottomPx - 8)
    if (!(avail > 0)) return

    var need = m.scrollHeight
    var key = avail + '|' + need
    if (key === lastKey) return          // 没变化就不动 DOM（避免无谓重排）
    lastKey = key

    if (need > avail + 1) {
      m.style.maxHeight = avail + 'px'
      m.style.overflowY = 'auto'
      m.style.overscrollBehavior = 'contain'
      log('内容 ' + need + 'px 超过可用 ' + avail + 'px → 限高并允许滚动')
    } else {
      m.style.maxHeight = ''
      m.style.overflowY = ''
      m.style.overscrollBehavior = ''
    }
  }

  function start() {
    if (window.__dshpetMenuFit) return
    window.__dshpetMenuFit = true
    setInterval(fit, 300)
    window.addEventListener('resize', fit)
    fit()
    log('已就绪（菜单放不下时自动限高 + 可滚动）')
  }

  window.__dshpetMenuFitApi = { fit: fit }
  start()
})()
