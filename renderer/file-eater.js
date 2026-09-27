// ============================================================================
// 拖文件"吃掉"（移植自参考实现的 pet/file_eater.py）
// ============================================================================
// ⚠️⚠️ **只做视觉反馈与统计，绝不删除 / 移动 / 修改被拖入的文件。**
//    渲染端这里只把**路径**交给主进程去 stat（读大小），
//    主进程侧也只 stat —— 全链路没有任何写操作。
//
// 参考实现把吃动画做成"从随机动作池里挑一个带「吃/eat/啃」关键词的动画"；
// 本项目的立绘是静态 PNG、没有动作池，所以改成：
//   点击同款 Q 弹 + 一个浮起来的小提示（吃了几个、多大），观感等价。
(function () {
  'use strict'
  var api = window.petApi || {}

  var STATS_KEY_HINT = 'dshpet-eat-count'   // 本地轻量计数（真正的统计在主进程侧）

  function log(m) { try { if (api.log) api.log('[吃掉] ' + m) } catch (e) {} }
  function human(n) {
    var v = Number(n) || 0
    if (v < 1024) return v + ' B'
    if (v < 1048576) return (v / 1024).toFixed(1) + ' KB'
    if (v < 1073741824) return (v / 1048576).toFixed(1) + ' MB'
    return (v / 1073741824).toFixed(1) + ' GB'
  }

  // ---- 吃掉反馈：Q 弹 + 浮字 ----
  function pokeOnce() {
    var img = document.querySelector('img.dshwv-img')
    if (!img) return
    try {
      var X = window.__dshpetSpriteXform
      img.style.transformOrigin = '50% 100%'
      img.style.transition = 'none'
      if (X) X.set('poke', X.scale(1.14, 0.84))
      else img.style.transform = 'scale(1.14,.84)'
      requestAnimationFrame(function () {
        img.style.transition = 'transform .3s cubic-bezier(.34,1.56,.64,1)'
        if (X) X.set('poke', X.scale(1, 1))
        else img.style.transform = 'scale(1,1)'
      })
    } catch (e) {}
  }

  function toast(text) {
    try {
      var old = document.getElementById('dshpet-eat-toast')
      if (old && old.parentNode) old.parentNode.removeChild(old)
      var el = document.createElement('div')
      el.id = 'dshpet-eat-toast'
      el.textContent = text
      el.style.cssText = 'position:fixed;left:50%;top:0;transform:translate(-50%,-100%);' +
        'padding:4px 10px;border-radius:9px;background:rgba(255,255,255,.96);' +
        'border:1px solid rgba(32,49,112,.35);color:#203170;' +
        'font:12px/1.5 -apple-system,"Microsoft YaHei",system-ui,sans-serif;' +
        'box-shadow:0 4px 12px rgba(0,0,0,.16);pointer-events:none;z-index:10002;' +
        'transition:opacity .4s ease;white-space:nowrap'
      document.body.appendChild(el)
      // 贴在她头顶
      var img = document.querySelector('img.dshwv-img')
      if (img) {
        var r = img.getBoundingClientRect()
        el.style.left = Math.round(r.left + r.width / 2) + 'px'
        el.style.top = Math.round(r.top - 8) + 'px'
      }
      requestAnimationFrame(function () { el.style.opacity = '1' })
      setTimeout(function () { el.style.opacity = '0' }, 2200)
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el) }, 2800)
    } catch (e) {}
  }

  // ---- 落文件 ----
  var lastDrop = 0
  function pathsOf(dt) {
    var out = []
    if (!dt || !dt.files || !dt.files.length) return out
    for (var i = 0; i < dt.files.length; i++) {
      var f = dt.files[i]
      var p = ''
      try { p = api.filePathOf ? api.filePathOf(f) : '' } catch (e) { p = '' }
      if (!p) { try { p = f.path || '' } catch (e) {} }   // 老版本 Electron 的兜底
      if (p) out.push(p)
    }
    return out
  }

  function onDragOver(e) {
    // 必须 preventDefault 才会收到 drop
    try { e.preventDefault() } catch (err) {}
    try { e.dataTransfer.dropEffect = 'copy' } catch (err) {}
  }

  function onDrop(e) {
    try { e.preventDefault() } catch (err) {}
    try { e.stopPropagation() } catch (err) {}
    var now = Date.now()
    if (now - lastDrop < 400) return      // 防抖：一次拖放别触发两次
    lastDrop = now
    var paths = pathsOf(e.dataTransfer)
    if (!paths.length) { log('拖进来的不是本地文件，忽略'); return }
    pokeOnce()
    if (!api.eatFiles) { toast('🧾 吃不了（接口不可用）'); return }
    api.eatFiles(paths).then(function (r) {
      if (!r || !r.ok) { log('吃掉失败：' + JSON.stringify(r)); return }
      var parts = []
      if (r.files) parts.push(r.files + ' 个文件')
      if (r.folders) parts.push(r.folders + ' 个文件夹')
      toast('🧾 吃掉 ' + (parts.join(' + ') || (paths.length + ' 项')) + ' · ' + r.human)
      log('吃掉 ' + paths.length + ' 项 → ' + r.human + '（累计 ' + (r.stats && r.stats.feed_count) + ' 次）')
    }).catch(function (err) { log('吃掉异常：' + (err && err.message)) })
  }

  // ---- 菜单入口：看累计统计 ----
  function injectMenuRow() {
    var menu = document.querySelector('.dshwv-menu')
    if (!menu) return false
    if (menu.querySelector('.dshpet-eat-row')) return true
    var row = document.createElement('div')
    row.className = 'dshpet-eat-row'
    var b = document.createElement('button')
    b.type = 'button'
    b.textContent = '🧾 吃掉统计'
    b.title = '看看累计"吃"了多少（只统计，不会动你的文件）'
    b.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:2px 9px;' +
      'border:1px solid rgba(32,49,112,.5);border-radius:7px;background:rgba(32,49,112,.08);' +
      'color:#203170;font:12px/1.4 inherit;cursor:pointer;user-select:none;-webkit-user-select:none'
    b.addEventListener('click', function (e) {
      e.stopPropagation()
      if (!api.eatStats) return
      api.eatStats().then(function (st) {
        if (!st) return
        toast('累计 ' + st.feed_count + ' 次 · ' + st.item_count + ' 项 · ' + (st.human || human(st.total_bytes)))
      }).catch(function () {})
    })
    row.appendChild(b)
    var base = menu.querySelector('.dshpet-spin-row') || menu.querySelector('.dshpet-sling-row') ||
      menu.querySelector('.dshpet-phys-row')
    if (base && base.parentNode) base.parentNode.insertBefore(row, base.nextSibling)
    else menu.appendChild(row)
    return true
  }

  function boot() {
    document.addEventListener('dragover', onDragOver, true)
    document.addEventListener('drop', onDrop, true)
    // 拖进来的文件**不许**让页面跳走（默认行为是导航到那个文件）
    try {
      window.addEventListener('dragover', function (e) { e.preventDefault() }, false)
      window.addEventListener('drop', function (e) { e.preventDefault() }, false)
    } catch (e) {}
    if (window.__dshpetOnMenuReady) window.__dshpetOnMenuReady(injectMenuRow)
    else injectMenuRow()
    log('已就绪（拖文件给她 = 吃掉，只统计不动文件）')
  }

  window.__dshpetFileEater = {
    boot: boot, injectMenuRow: injectMenuRow,
    _pathsOf: pathsOf, _human: human, _toast: toast, _pokeOnce: pokeOnce,
  }
})()
