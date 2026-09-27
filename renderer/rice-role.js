// ============================================================================
// 米粒面板「角色」那一行 + 被抓现行时的闭眼贴图（**全在外壳里做，vendor 保持原版**）
// ============================================================================
// ① 抓现行、盆扣到她头顶时 → 贴图换成"被砸到头顶"那张（默认是自带的「小鲸鱼闭眼」），
//    盆消失时换回**她原本的贴图**；盆扣上头顶的同一刻做一次"点她"同款动画（无音效）。
// ② 面板「素材·米粒,碗和角色」组里加一行「角色」：
//      文字 角色 + 按钮 选择图片… + 按钮 默认 + 文字（自带 / 自定义）
//    ⚠️ 这一行选的是**"被盆砸到头时"的贴图**，不是她平时的贴图 ——
//       平时的贴图由挂件自己的「角色」菜单管，两者互不干涉。
//    「选择图片…」打开的是**用户的 Screenshots 文件夹**
//    （走主进程 dialog 的 defaultPath；网页那套 <input type=file> 不允许指定初始目录）。
//    样式**直接克隆「波谷饭」那一行**，不自己写 CSS —— 上游改样式我们自动跟着走。
//
// ⚠️ 为什么这些都不改 vendor：rice 的 PANEL 是它自己闭包里的数据，外面改不了；
//    但面板是**真实 DOM**，在外壳里改 DOM 一样能达到目的，上游升级时直接换文件即可。
(function () {
  'use strict'
  var api = window.petApi || {}

  var KEY_HIT = 'dshpet-whale-hit-sprite'   // 用户选的"被砸到头顶"贴图（data URL）；空 = 用自带那张
  var BUILTIN_HIT_URL = '/whale-sprite-closeeye.png'   // 自带的闭眼图（外壳路由，见 lib/shell.js）

  var normalSrc = null        // 她**原本**的贴图（换之前记下来）
  var hitTimer = null
  var hitOn = false

  function log(m) { try { if (api.log) api.log('[米粒角色] ' + m) } catch (e) {} }
  function whaleImg() { return document.querySelector('img.dshwv-img') }
  function chosenHit() { try { return localStorage.getItem(KEY_HIT) || '' } catch (e) { return '' } }
  function hitSrc() { return chosenHit() || BUILTIN_HIT_URL }

  // --------------------------------------------------------------------------
  // ① 抓现行 → 换成"被砸到头顶"那张
  // --------------------------------------------------------------------------
  // rice 的落点分两套：dshrice-head = 扣在她头顶；dshrice-spill = 倒扣在旁边地面。
  // 用户要的是"盆盖到头顶时" → 只认 dshrice-head。
  // 但碗一加上类，动画**还没飞到头顶**（撞击点在整段的 68% 处）——
  // 所以等那一拍再换贴图，不然她会在碗还在半空时就闭眼。
  var HEAD_MS = 900, HEAD_HIT_PCT = 0.68
  function toHitSprite() {
    var img = whaleImg()
    if (!img) return
    if (!hitOn) {
      var cur = img.getAttribute('src') || ''
      // ⚠️ **别把「笑一下」那张当成"原本的贴图"存下来。**
      //    它是 laugh-sprite.js 的临时贴图（2 秒后自己会还原）；
      //    存成 normalSrc 的话，一旦走到下面那条"形象状态机不可用"的兜底分支，
      //    她就会被还原成**笑图**、永远停在那儿。
      if (!(window.__dshpetLaugh && cur === window.__dshpetLaugh)) normalSrc = cur
      hitOn = true
    }
    var want = hitSrc()
    // 告诉形象状态机：这段时间贴图归我们管（它会让路，不会把我们的图抢回去）
    window.__dshpetSpriteOverride = want
    if (img.getAttribute('src') !== want) img.setAttribute('src', want)
    // —— "点她"同款动画：一次 squash & stretch，无音效 ——
    try {
      img.style.transformOrigin = '50% 100%'
      img.style.transition = 'none'
      img.style.transform = 'scale(1.10,.88)'
      requestAnimationFrame(function () {
        img.style.transition = 'transform .26s cubic-bezier(.34,1.56,.64,1)'
        img.style.transform = 'scale(1,1)'
      })
    } catch (e) {}
    log('已换成"被砸到头顶"的贴图')
  }
  function restoreNormal() {
    if (hitTimer) { clearTimeout(hitTimer); hitTimer = null }
    if (!hitOn) { window.__dshpetSpriteOverride = null; return }
    var img = whaleImg()
    // 交还给形象状态机 —— 它会按当前心情/疲惫状态重新决定该显示哪张
    window.__dshpetSpriteOverride = null
    if (img && window.__dshpetWhaleExp && window.__dshpetWhaleExp.apply) {
      hitOn = false
      window.__dshpetWhaleExp.apply(true)
      log('已把贴图交还给形象状态机')
      return
    }
    if (img) {
      // 恢复成**她原本的贴图**（换之前那一张）。
      // ⚠️ 不是"用户选的那张" —— 用户选的那张是**被砸到时**才用的。
      // 另外别往笑图上还原（见 toHitSprite 里的说明）。
      var back = (window.__dshpetLaugh && normalSrc === window.__dshpetLaugh) ? '' : normalSrc
      if (back && img.getAttribute('src') !== back) img.setAttribute('src', back)
      try { img.style.transform = ''; img.style.transition = '' } catch (e) {}
    }
    hitOn = false
    log('已恢复她原本的贴图')
  }

  function watchBowl() {
    var bowl = document.querySelector('.dshrice-bowl')
    if (!bowl) return false
    var obs = new MutationObserver(function () {
      var cls = bowl.className || ''
      if (cls.indexOf('dshrice-head') >= 0) {
        // 碗开始飞 → 等"撞上头顶"那一拍再换
        if (hitTimer) clearTimeout(hitTimer)
        hitTimer = setTimeout(toHitSprite, Math.round(HEAD_MS * HEAD_HIT_PCT))
      } else if (cls.indexOf('dshrice-gone') >= 0 || cls.indexOf('dshrice-spill') >= 0) {
        restoreNormal()          // 碗该消失了（或走的是"倒扣在旁边"那套）
      } else if (cls.indexOf('dshrice-up') < 0) {
        restoreNormal()
      }
    })
    obs.observe(bowl, { attributes: true, attributeFilter: ['class'] })
    log('已在盯碗的类')
    return true
  }

  // --------------------------------------------------------------------------
  // ② 「角色」那一行
  // --------------------------------------------------------------------------
  function refreshName() {
    var el = document.querySelector('.dshpet-role-name')
    if (el) el.textContent = chosenHit() ? '自定义' : '自带'
  }

  function buildRoleRow(template) {
    var row = template.cloneNode(true)
    row.className = 'dshrice-row dshpet-role-row'
    // 模板是「波谷饭」那一行：<div>波谷饭 <button>选择图片…</button> <button>默认</button> <span/></div>
    // 第一段非空文本 = 标签
    for (var i = 0; i < row.childNodes.length; i++) {
      var nd = row.childNodes[i]
      if (nd.nodeType === 3 && String(nd.nodeValue || '').trim()) { nd.nodeValue = '角色 '; break }
    }
    var btns = row.querySelectorAll('button')
    if (btns[0]) {
      btns[0].textContent = '选择图片…'
      btns[0].title = '从 Screenshots 文件夹选一张图，作为"被盆砸到头顶时"的贴图'
      btns[0].addEventListener('click', function (e) {
        e.stopPropagation()
        if (!api.pickImage) { log('主进程没有 pickImage 接口'); return }
        api.pickImage().then(function (r) {
          if (!r || !r.ok) { log('没选图：' + JSON.stringify(r)); return }
          try { localStorage.setItem(KEY_HIT, r.dataUrl) } catch (err) {}
          refreshName()
          log('已换"被砸到头顶"的贴图：' + r.name)
          // 立刻给个反馈：如果此刻正被砸着，马上换过去；否则闪一下让她看见效果
          var img = whaleImg()
          if (img) {
            if (hitOn) img.setAttribute('src', r.dataUrl)
            else {
              var keep = img.getAttribute('src')
              img.setAttribute('src', r.dataUrl)
              setTimeout(function () {
                if (!hitOn && img.getAttribute('src') === r.dataUrl) img.setAttribute('src', keep)
              }, 700)
            }
          }
        }).catch(function (err) { log('选图失败：' + (err && err.message)) })
      })
    }
    if (btns[1]) {
      btns[1].textContent = '默认'
      btns[1].title = '换回自带那张（小鲸鱼闭眼）'
      btns[1].addEventListener('click', function (e) {
        e.stopPropagation()
        try { localStorage.removeItem(KEY_HIT) } catch (err) {}
        refreshName()
        var img = whaleImg()
        if (img && hitOn) img.setAttribute('src', BUILTIN_HIT_URL)
        log('已换回自带的"被砸到头顶"贴图')
      })
    }
    var nameEl = row.querySelector('.dshrice-mut')
    if (nameEl) { nameEl.className = 'dshrice-mut dshpet-role-name'; nameEl.textContent = chosenHit() ? '自定义' : '自带' }
    return row
  }

  function injectRoleRow() {
    var menu = document.querySelector('.dshrice-menu')
    if (!menu) return false
    if (menu.querySelector('.dshpet-role-row')) return true

    // 找「波谷饭」那一行当模板 —— 用户要求"和波谷饭那一行的样式保持一致"，
    // 那就**直接克隆它**，而不是自己写一套 CSS（上游改样式我们自动跟着走）
    var tmpl = null, grp = null
    var rows = menu.querySelectorAll('.dshrice-row')
    for (var i = 0; i < rows.length; i++) {
      if ((rows[i].textContent || '').indexOf('波谷饭') >= 0) { tmpl = rows[i]; grp = rows[i].parentNode; break }
    }
    if (!tmpl || !grp) return false
    // 组标题改名：素材 · 米粒与碗 → 素材·米粒,碗和角色
    // ⚠️ 实际渲染出来 `·` 两边**带空格**，所以用 \s* 容错
    var heads = menu.querySelectorAll('.dshrice-grp-h')
    for (var h = 0; h < heads.length; h++) {
      var ht = String(heads[h].textContent || '')
      if (ht.indexOf('素材') >= 0 && ht.indexOf('角色') < 0) {
        heads[h].textContent = ht.replace(/素材\s*·\s*米粒与碗/, '素材·米粒,碗和角色')
      }
    }
    grp.insertBefore(buildRoleRow(tmpl), tmpl.nextSibling)
    refreshName()
    log('已加「角色」行')
    return true
  }

  // --------------------------------------------------------------------------
  function start() {
    var tries = 0
    var t = setInterval(function () {
      tries++
      var a = watchBowl()
      var b = injectRoleRow()
      if ((a && b) || tries > 60) clearInterval(t)
    }, 500)
    watchBowl()
    injectRoleRow()
    log('已就绪')
  }

  window.__dshpetRiceRole = {
    start: start, injectRoleRow: injectRoleRow, watchBowl: watchBowl,
    toHitSprite: toHitSprite, restoreNormal: restoreNormal,
    builtinHitUrl: BUILTIN_HIT_URL, key: KEY_HIT,
    // 兼容旧名字（自检里用的是 toCloseEye / restoreEye）
    toCloseEye: toHitSprite, restoreEye: restoreNormal,
  }
})()
