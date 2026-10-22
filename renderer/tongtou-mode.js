// ============================================================================
// 通透模式 —— ☰ 菜单里「拖动物理」右边那个开关
// ============================================================================
// 用户要求：
//   打开 → 自动播放背景音乐（单曲循环），同时**一直循环**做"点击桌宠"的动画；
//   关闭 → 音乐停、动画停，恢复原状。
//
// 几个关键决定（都是踩过坑才这么写的）：
//
// ① 音乐走外壳路由 `/pet-music.mp3`，**不用中文文件名当 URL**。
//    中文 + 空格 + 括号要过 URL 编码、asar 打包、文件系统三道，
//    哪一环没按 UTF-8 走就是"读不到 → 404 → 静音"（这坑本项目踩过）。
//    路由那头按目录里第一个音频文件找 → 换歌只要把 mp3 丢进
//    vendor/whale/assets/music/ 就行，不用改代码。
//
// ② 动画复用 pet-collide 的 poke()，但必须传 silent：
//    poke() 原本会 ①播按压/松手音 ②通知黄金回旋接一圈。
//    循环调用的话 ①会变成每 0.7 秒"啵啵"两声盖住音乐，
//    ②会让"点击后转一圈"模式变成停不下来的旋转。所以走 pokeSilent()。
//
// ③ **开关状态不持久化**：Chromium 的自动播放策略要求"用户手势"，
//    如果启动时自动恢复成开，play() 会被拒绝 —— 界面显示"开"、
//    实际没声音也没动画，比不做更糟。所以每次启动一律是关的。
//
// ④ 多开时只有第一只放音乐（第二只再放一遍就是两个声部叠在一起）。
//    判断用主进程给的 __dshpetIsExtra。
(function () {
  'use strict'
  var api = window.petApi || {}

  var MUSIC = '/pet-music.mp3'
  var POKE_MS = 700            // 循环节奏：动画本身 280ms，留一点余量更像"蹦"
  var VOLUME = 0.9

  var on = false
  var audio = null
  var timer = null

  function log(m) { try { if (api.log) api.log('[通透模式] ' + m) } catch (e) {} }

  // --------------------------------------------------------------------------
  // 样式：开关和「拖动物理」那一行同款，靠 margin-left:auto 贴到右边
  // --------------------------------------------------------------------------
  function ensureCss() {
    if (document.getElementById('dshpet-tt-css')) return
    var st = document.createElement('style')
    st.id = 'dshpet-tt-css'
    st.textContent = [
      '.dshpet-tt-group{display:flex;align-items:center;gap:6px;margin-left:auto;flex:0 0 auto}',
      '.dshpet-tt-group input{width:16px;height:16px;accent-color:#203170;cursor:pointer;flex:0 0 auto}',
      '.dshpet-tt-group span{cursor:pointer;white-space:nowrap}',
      // 拖动物理那一行万一不存在时的独立行（同款外观）
      '.dshpet-tt-row{display:flex;align-items:center;gap:6px;margin:5px 0;' +
        'color:#203170;font-size:12px;white-space:nowrap}',
      '.dshpet-tt-row input{width:16px;height:16px;accent-color:#203170;cursor:pointer;flex:0 0 auto}',
    ].join('\n')
    document.head.appendChild(st)
  }

  // --------------------------------------------------------------------------
  // 菜单行：插进「拖动物理」那一行，靠右
  // --------------------------------------------------------------------------
  // ⚠️ **不能只靠 __dshpetOnMenuReady。** 自检实测：
  //    · 本模块在 12:36:31.994 就绪，而「拖动物理」那一行是 12:36:32.05x 才注入的
  //      —— 我们先跑，phys 行还不存在，直接 return false；
  //    · 而 drag-physics 是把行插进 **.dshwv-menu-row 的父节点**（内层容器），
  //      不是 menu 的直接子节点 —— 菜单级观察器（childList，无 subtree）**收不到**，
  //      于是开关永远不出现（自检里 在物理行内=false）。
  //    所以这里三管齐下：
  //      ① 先试一次（菜单已建好时立刻成功）
  //      ② 盯住 **phys 行的父容器**（真正的插入点），行被重建时同帧补回
  //      ③ 800ms 看门狗兜底（整块菜单被替换时，旧观察器会失效）
  function injectRow() {
    var menu = document.querySelector('.dshwv-menu')
    if (!menu) return false
    ensureCss()

    var host = menu.querySelector('.dshpet-phys-row')
    if (!host) return false                     // 等「拖动物理」那一行先出现
    attachRowObs(host)

    if (host.querySelector('.dshpet-tt-group')) return true

    var group = document.createElement('span')
    group.className = 'dshpet-tt-group'

    var cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.className = 'dshpet-tt-cb'
    cb.checked = on
    cb.title = '打开后循环播放背景音乐，并一直循环做点击动画（不出声）'
    cb.addEventListener('change', function (ev) {
      ev.stopPropagation()
      setOn(cb.checked)
    })

    var label = document.createElement('span')
    label.textContent = '通透模式'
    label.addEventListener('click', function (ev) {
      ev.stopPropagation()
      setOn(!on)
    })

    group.appendChild(cb)
    group.appendChild(label)
    host.appendChild(group)
    return true
  }

  // 盯住 phys 行的父容器：行被重建（挂件每次开菜单都会重建行）时立刻补回，
  // 不用等看门狗那 800ms。
  var rowObs = null
  var obsHost = null
  function attachRowObs(host) {
    var parent = host.parentNode
    if (!parent) return
    if (obsHost === parent && rowObs) return
    if (rowObs) { try { rowObs.disconnect() } catch (e) {} }
    obsHost = parent
    try {
      rowObs = new MutationObserver(function () { injectRow() })
      rowObs.observe(parent, { childList: true })
    } catch (e) { rowObs = null }
  }

  // --------------------------------------------------------------------------
  // 音乐
  // --------------------------------------------------------------------------
  function ensureAudio() {
    if (audio) return audio
    audio = new Audio(MUSIC)
    audio.loop = true
    audio.preload = 'auto'
    audio.volume = VOLUME
    audio.addEventListener('error', function () {
      var e = audio && audio.error
      log('音乐加载失败（code=' + (e && e.code) + '）—— 检查 vendor/whale/assets/music/ 里有没有音频文件')
    })
    return audio
  }

  function playMusic() {
    // 多开的那几只不放音乐（否则同一首歌叠两遍）
    if (window.__dshpetIsExtra === true) {
      log('这是多开出来的桌宠 —— 只做动画，不放音乐（避免叠音）')
      return
    }
    var a = ensureAudio()
    try { a.currentTime = 0 } catch (e) {}
    var p = a.play()
    if (p && p.catch) {
      p.catch(function (err) {
        // 最常见的两种：autoplay 被拒（不是用户手势）、文件 404
        log('音乐播放被拒/失败: ' + (err && err.name) + ' ' + (err && err.message))
      })
    }
    log('音乐开始循环播放 ' + MUSIC)
  }

  function stopMusic() {
    if (!audio) return
    try { audio.pause() } catch (e) {}
    try { audio.currentTime = 0 } catch (e) {}
    log('音乐已停止')
  }

  // --------------------------------------------------------------------------
  // 动画循环
  // --------------------------------------------------------------------------
  function pokeOnce() {
    var C = window.__dshpetCollide
    if (C && C.pokeSilent) { C.pokeSilent(); return }
    // 兜底（pet-collide 没加载时）：直接做同款 squash & stretch，不出声
    var img = document.querySelector('img.dshwv-img')
    if (!img) return
    try {
      var X = window.__dshpetSpriteXform
      img.style.transformOrigin = '50% 100%'
      img.style.transition = 'none'
      if (X) X.set('poke', X.scale(1.12, 0.86))
      else img.style.transform = 'scale(1.12,.86)'
      // 双 rAF：保证"压扁"那一帧真的被画出来（单层会被合并掉，看着像没动）
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          img.style.transition = 'transform .28s cubic-bezier(.34,1.56,.64,1)'
          if (X) X.set('poke', X.scale(1, 1))
          else img.style.transform = 'scale(1,1)'
        })
      })
    } catch (e) {}
  }

  function startAnim() {
    stopAnim()
    pokeOnce()
    timer = setInterval(pokeOnce, POKE_MS)
  }

  function stopAnim() {
    if (timer) { clearInterval(timer); timer = null }
    // 正好停在"压扁"那一帧时手动复位，别让她一直是扁的
    try {
      var X = window.__dshpetSpriteXform
      if (X) X.clear('poke')
    } catch (e) {}
  }

  // --------------------------------------------------------------------------
  // 开关
  // --------------------------------------------------------------------------
  function setOn(v) {
    v = !!v
    if (v === on) {
      // 状态没变也要把界面同步一下（菜单重建后新复选框可能是旧的勾选态）
      syncCb()
      return
    }
    on = v
    syncCb()
    if (v) {
      startAnim()
      playMusic()
      log('已开启（音乐循环 + 点击动画循环）')
    } else {
      stopAnim()
      stopMusic()
      log('已关闭，已恢复原状')
    }
  }

  function syncCb() {
    var cb = document.querySelector('.dshpet-tt-cb')
    if (cb) cb.checked = on
  }

  // --------------------------------------------------------------------------
  // 启动
  // --------------------------------------------------------------------------
  function boot() {
    ensureCss()
    if (window.__dshpetOnMenuReady) window.__dshpetOnMenuReady(injectRow)
    else injectRow()
    // 看门狗：挂件整块重建菜单时，之前的行/观察器全没了，靠它把开关补回来。
    // 800ms 一次、只做两次 querySelector，开销可以忽略（别改成 subtree 观察 body ——
    // 挂件的气泡每帧都在改 class，那样会把页面拖成幻灯片，rice-entry 里踩过）。
    setInterval(injectRow, 800)
    log('已就绪（菜单里「拖动物理」右边应有「通透模式」）')
  }

  window.__dshpetTongtou = {
    isOn: function () { return on },
    set: setOn,
    _inject: injectRow,
    _pokeOnce: pokeOnce,
    // 自检/诊断用：看音乐到底有没有在走（不暴露任何密钥类东西）
    _state: function () {
      return {
        on: on,
        paused: audio ? audio.paused : null,
        time: audio ? audio.currentTime : null,
        loop: audio ? audio.loop : null,
        src: audio ? String(audio.src || '') : null,
        err: (audio && audio.error) ? audio.error.code : null,
      }
    },
  }

  boot()
})()
