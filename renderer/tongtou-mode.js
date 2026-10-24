// ============================================================================
// 通透模式 —— ☰ 菜单里**单独一行**的开关（+ 歌曲选择 + 自定义）
// ============================================================================
// 用户要求：
//   打开 → 自动播放背景音乐（单曲循环），同时**一直循环**做"点击桌宠"的动画；
//   关闭 → 音乐停、动画停，恢复原状。
//   后来追加：开关**单独一行**；开关右边一个**歌曲选择栏**；选择栏右边一个
//   「自定义」按钮（打开音乐文件夹）；选择栏要能列出文件夹里**所有**歌。
//
// 几个关键决定（都是踩过坑才这么写的）：
//
// ① 歌名放 **query**、不放路径。
//    `/pet-music.mp3?n=<歌名>` —— 中文 + 空格 + 括号在路径里要过 URL 编码、
//    asar 打包、文件系统三道，哪一环没按 UTF-8 走就是"读不到 → 404 → 静音"
//    （本项目踩过这个坑）。query 只有 URL 一道，`encodeURIComponent` 足够。
//    路由名保持 ASCII，不带参数 = 第一首（和以前完全兼容）。
//
// ② 歌单**从目录现读**，不写死在代码里。
//    选择栏的内容来自 `/pet-music-list.json`（服务端 readdir 出来的），
//    所以往文件夹里丢一首新歌、重开一次菜单它就出现在列表里了。
//
// ③ 动画**不复用** pet-collide 的 poke()，自己按相位驱动：
//    poke() 是"一次性 Q 弹"（瞬间压到 0.86、再 0.28s 弹回），
//    而用户要的是「压 0.25s → 弹 0.25s」无缝循环、压到 3/4 高 ——
//    节奏和深度都不同。自己写还能顺手避开 poke() 的两个副作用
//    （按压音效、通知黄金回旋接一圈）。
//
// ④ **开关状态不持久化**：Chromium 的自动播放策略要求"用户手势"，
//    如果启动时自动恢复成开，play() 会被拒绝 —— 界面显示"开"、
//    实际没声音也没动画，比不做更糟。所以每次启动一律是关的。
//    （**选的歌**是持久化的 —— 它不影响自动播放，只影响"开的时候放哪首"。）
//
// ⑤ 多开时只有第一只放音乐（第二只再放一遍就是两个声部叠在一起）。
//    判断用主进程给的 __dshpetIsExtra。
(function () {
  'use strict'
  var api = window.petApi || {}

  var MUSIC = '/pet-music.mp3'
  var LIST_URL = '/pet-music-list.json'
  var SONG_KEY = 'dshpet-tt-song'      // 记住上次选的歌（只存歌名，不存路径）
  var VOLUME = 0.9

  var on = false
  var audio = null
  var timer = null
  var curUrl = ''                      // 当前 audio 上挂的地址（自己记，别读 a.src —— 会被解析成绝对地址）

  var songs = []                       // [{ i, name, size, v }] 最近一次取回的歌单
  var songName = ''                    // 当前选中的歌名（空 = 列表第一首）
  // 歌单签名（变了才重建下拉，避免无谓重建把下拉关掉）。
  // ⚠️ 初值必须是 null 而不是 ''：空文件夹时签名也是 ''，
  //    用 '' 当初值会让第一次 fillSelect 直接跳过，下拉永远停在"加载中…"。
  var songSig = null
  var listAt = 0                       // 上次拉歌单的时间
  var listBusy = false

  function log(m) { try { if (api.log) api.log('[通透模式] ' + m) } catch (e) {} }

  // --------------------------------------------------------------------------
  // 样式
  // --------------------------------------------------------------------------
  // 视觉上跟「拖动物理」「甩出力度」那一组同一套语言：
  //   同一行高、同一个负边距（悬停底色能铺满整行）、下拉用自绘箭头的圆角玻璃。
  var ARROW = 'background-image:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'6\'%3E%3Cpath d=\'M1 1l4 4 4-4\' stroke=\'%23536ba9\' stroke-width=\'1.5\' fill=\'none\' stroke-linecap=\'round\' stroke-linejoin=\'round\'/%3E%3C/svg%3E");'

  function ensureCss() {
    if (document.getElementById('dshpet-tt-css')) return
    var st = document.createElement('style')
    st.id = 'dshpet-tt-css'
    st.textContent = [
      '.dshpet-tt-row{display:flex;align-items:center;gap:6px;margin:4px -6px;padding:3px 6px;' +
        'border-radius:10px;color:#203170;font-size:12px;white-space:nowrap;' +
        'transition:background .16s ease}',
      '.dshpet-tt-row:hover{background:rgba(32,49,112,.08)}',
      '.dshpet-tt-row>input[type=checkbox]{width:16px;height:16px;accent-color:#203170;' +
        'cursor:pointer;flex:0 0 auto;margin:0}',
      '.dshpet-tt-row>span{cursor:pointer;flex:0 0 auto}',
      // 选择栏：能压缩（min-width:0 是 flex 里让文本真能被压缩的关键），
      // 太长的歌名交给 title 提示，不再把整行撑宽。
      '.dshpet-tt-sel{flex:1 1 auto;min-width:0;max-width:150px;appearance:none;' +
        '-webkit-appearance:none;background-color:rgba(255,255,255,.62);' + ARROW +
        'background-repeat:no-repeat;background-position:right 7px center;background-size:10px 6px;' +
        'border:1px solid rgba(32,49,112,.2);border-radius:9px;padding:2px 22px 2px 8px;' +
        'color:#203170;font:12px/1.4 inherit;cursor:pointer;color-scheme:light;' +
        'text-overflow:ellipsis;' +
        'box-shadow:0 1px 4px rgba(21,36,84,.12),inset 0 1px 0 rgba(255,255,255,.85);' +
        'transition:background-color .16s ease}',
      '.dshpet-tt-sel:hover{background-color:rgba(255,255,255,.88)}',
      '.dshpet-tt-sel:disabled{opacity:.55;cursor:default}',
      '.dshpet-tt-custom{flex:0 0 auto;appearance:none;-webkit-appearance:none;' +
        'border:1px solid rgba(32,49,112,.2);border-radius:9px;' +
        'background-color:rgba(255,255,255,.62);color:#203170;font:12px/1.4 inherit;' +
        'cursor:pointer;padding:2px 8px;line-height:1.4;' +
        'box-shadow:0 1px 4px rgba(21,36,84,.12),inset 0 1px 0 rgba(255,255,255,.85);' +
        'transition:background-color .16s ease}',
      '.dshpet-tt-custom:hover{background-color:rgba(255,255,255,.92)}',
      '.dshpet-tt-custom:active{background-color:rgba(32,49,112,.12)}',
    ].join('\n')
    document.head.appendChild(st)
  }

  // --------------------------------------------------------------------------
  // 菜单行：**单独一行**（开关 + 歌曲选择 + 自定义）
  // --------------------------------------------------------------------------
  // ⚠️ **不能只靠 __dshpetOnMenuReady。** 自检实测过：
  //    · 本模块比 drag-physics 早约 60ms 就绪，那一行还不存在，直接 return false；
  //    · drag-physics 是把行插进 **.dshwv-menu-row 的父节点**（内层容器），
  //      不是 menu 的直接子节点 —— 菜单级观察器（childList，无 subtree）收不到。
  //    所以三管齐下：
  //      ① 先试一次（菜单已建好时立刻成功）
  //      ② 盯住**插入点的父容器**，行被重建时同帧补回
  //      ③ 800ms 看门狗兜底（整块菜单被替换时，旧观察器会失效）
  function injectRow() {
    var menu = document.querySelector('.dshwv-menu')
    if (!menu) return false
    ensureCss()

    var exist = menu.querySelector('.dshpet-tt-row')
    if (exist) {
      syncUi()
      attachRowObs(exist.parentNode)
      return true
    }

    // 插在「弹弓」那一行下面 —— 也就是「拖动物理」这一组的末尾。
    // 开关原来就住在「拖动物理」那一行里，用户会去同一个地方找它。
    var base = menu.querySelector('.dshpet-sling-row') ||
      menu.querySelector('.dshpet-strength-row') ||
      menu.querySelector('.dshpet-phys-row')
    if (!base || !base.parentNode) return false     // 等那几行先出现

    var row = document.createElement('div')
    row.className = 'dshpet-tt-row'

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
    label.className = 'dshpet-tt-label'
    label.textContent = '通透模式'
    label.title = '打开后循环播放背景音乐，并一直循环做点击动画（不出声）'
    label.addEventListener('click', function (ev) {
      ev.stopPropagation()
      setOn(!on)
    })

    var sel = document.createElement('select')
    sel.className = 'dshpet-tt-sel'
    sel.title = '选择要循环播放的歌'
    // 点它/滚它都别冒泡到菜单（否则菜单会关、或者被当成点桌宠）
    sel.addEventListener('click', function (ev) { ev.stopPropagation() })
    sel.addEventListener('mousedown', function (ev) { ev.stopPropagation() })
    sel.addEventListener('change', function (ev) {
      ev.stopPropagation()
      pickSong(sel.value)
    })
    sel.addEventListener('focus', function () { refreshSongs() })

    var btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'dshpet-tt-custom'
    btn.textContent = '自定义'
    btn.title = '打开音乐文件夹 —— 把音频文件丢进去，选择栏里就会出现'
    btn.addEventListener('mousedown', function (ev) { ev.stopPropagation() })
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation()
      ev.preventDefault()
      openFolder()
    })

    row.appendChild(cb)
    row.appendChild(label)
    row.appendChild(sel)
    row.appendChild(btn)

    base.parentNode.insertBefore(row, base.nextSibling)
    attachRowObs(base.parentNode)

    // 下拉先占位（"加载中…"），歌单回来再填
    sel.disabled = true
    var ph = document.createElement('option')
    ph.textContent = '加载中…'
    sel.appendChild(ph)

    syncUi()
    refreshSongs(true)
    return true
  }

  // 盯住插入点的父容器：行被重建（挂件每次开菜单都会重建行）时立刻补回，
  // 不用等看门狗那 800ms。
  var rowObs = null
  var obsHost = null
  function attachRowObs(parent) {
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
  // 歌单
  // --------------------------------------------------------------------------
  function savedSong() { try { return localStorage.getItem(SONG_KEY) || '' } catch (e) { return '' } }
  function saveSong(n) { try { localStorage.setItem(SONG_KEY, n || '') } catch (e) {} }

  function refreshSongs(force) {
    var now = Date.now()
    if (listBusy) return
    if (!force && songs.length && now - listAt < 2000) return   // 2 秒内不重复拉
    listBusy = true
    listAt = now
    fetch(LIST_URL, { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (d) {
        songs = (d && d.songs) || []
        if (!songName) songName = savedSong()
        fillSelect()
        if (songs.length) {
          log('歌单 ' + songs.length + ' 首：' + songs.map(function (s) { return s.name }).join(' / '))
        } else {
          log('歌单是空的 —— ' + LIST_URL + ' 说 vendor/whale/assets/music/ 里没有音频文件')
        }
      })
      .catch(function (err) { log('歌单拉取失败: ' + (err && err.message)) })
      .then(function () { listBusy = false })
  }

  // 当前选中的那首（按歌名找；找不到就退回第一首）
  function currentSong() {
    if (!songs.length) return null
    var want = songName || savedSong()
    for (var i = 0; i < songs.length; i++) {
      if (songs[i].name === want) return songs[i]
    }
    return songs[0]
  }

  function songUrl(s) {
    if (!s) return MUSIC
    // v = 文件 mtime：同一个文件名被换成别的歌时，URL 变了 → 不会吃到旧缓存
    return MUSIC + '?n=' + encodeURIComponent(s.name) + '&v=' + (s.v || 0)
  }

  // 重建下拉。**歌单没变就一个字都不动** ——
  // 否则每次刷新都把 <option> 全换掉，正在展开的原生下拉会被关掉。
  function fillSelect() {
    var sel = document.querySelector('.dshpet-tt-sel')
    if (!sel) return
    var sig = songs.map(function (s) { return s.name + ':' + s.v }).join('|')
    if (sig !== songSig) {
      songSig = sig
      while (sel.firstChild) sel.removeChild(sel.firstChild)
      if (!songs.length) {
        var none = document.createElement('option')
        none.textContent = '（文件夹里没有歌）'
        none.value = ''
        sel.appendChild(none)
        sel.disabled = true
      } else {
        for (var i = 0; i < songs.length; i++) {
          var o = document.createElement('option')
          o.value = songs[i].name
          o.textContent = songs[i].name
          sel.appendChild(o)
        }
        sel.disabled = false
      }
    }
    var cur = currentSong()
    if (cur && sel.value !== cur.name) sel.value = cur.name
    sel.title = cur ? ('正在循环：' + cur.name + '\n点「自定义」打开音乐文件夹') : '选择要循环播放的歌'
  }

  function syncUi() {
    var cb = document.querySelector('.dshpet-tt-cb')
    if (cb) cb.checked = on
    fillSelect()
  }

  // 选了另一首
  function pickSong(name) {
    name = String(name || '')
    if (!name || name === songName) return
    songName = name
    saveSong(name)
    var s = currentSong()
    log('选歌：' + (s ? s.name : '(无)'))
    if (on) startMusic()          // 开着就**立刻换歌**，不用关一次再开
  }

  // --------------------------------------------------------------------------
  // 音乐
  // --------------------------------------------------------------------------
  function ensureAudio() {
    if (audio) return audio
    audio = new Audio()
    audio.loop = true
    audio.preload = 'auto'
    audio.volume = VOLUME
    audio.addEventListener('error', function () {
      var e = audio && audio.error
      log('音乐加载失败（code=' + (e && e.code) + '）—— 检查 vendor/whale/assets/music/ 里有没有音频文件')
    })
    return audio
  }

  // 把当前选中的歌挂到 audio 上（换歌才重新 load）
  function loadSong() {
    var s = currentSong()
    var url = songUrl(s)
    var a = ensureAudio()
    if (curUrl !== url) {
      try { a.pause() } catch (e) {}
      try { a.src = url } catch (e) {}
      // load() 在自检的假 Audio 上不存在 —— 必须判断，否则整个开关会抛异常
      try { if (typeof a.load === 'function') a.load() } catch (e) {}
      curUrl = url
    }
    return s
  }

  function startMusic() {
    // 多开的那几只不放音乐（否则同一首歌叠两遍）
    if (window.__dshpetIsExtra === true) {
      log('这是多开出来的桌宠 —— 只做动画，不放音乐（避免叠音）')
      return
    }
    var s = loadSong()
    var a = ensureAudio()
    try { a.currentTime = 0 } catch (e) {}
    var p = a.play()
    if (p && p.catch) {
      p.catch(function (err) {
        // 最常见的两种：autoplay 被拒（不是用户手势）、文件 404
        log('音乐播放被拒/失败: ' + (err && err.name) + ' ' + (err && err.message))
      })
    }
    log('音乐开始循环播放 ' + (s ? s.name : '(默认)'))
  }

  function stopMusic() {
    if (!audio) return
    try { audio.pause() } catch (e) {}
    try { audio.currentTime = 0 } catch (e) {}
    log('音乐已停止')
  }

  // --------------------------------------------------------------------------
  // 「自定义」→ 打开音乐文件夹
  // --------------------------------------------------------------------------
  // 路径**由主进程拼**（渲染进程不该有能力打开任意目录）。
  // 打开后延迟刷一次歌单：用户可能马上就往里面拖了歌，回来就能选。
  function openFolder() {
    try {
      if (api.openMusicFolder) {
        api.openMusicFolder()
        log('已请求打开音乐文件夹')
        setTimeout(function () { refreshSongs(true) }, 1200)
      } else {
        log('这个版本没有 openMusicFolder —— 无法打开文件夹')
      }
    } catch (e) { log('打开文件夹失败: ' + (e && e.message)) }
  }

  // --------------------------------------------------------------------------
  // 动画循环
  // --------------------------------------------------------------------------
  // 用户要求（改过一次）：
  //   「压扁 → 回弹 → 压扁 → 回弹」要**连贯**，中间不能有停顿；
  //   压扁 0.25 秒、回弹 0.25 秒；压的时候要**压得更下去**，压到桌宠 3/4 的位置。
  //
  // 所以这里**不再复用 pet-collide 的 poke()** —— 那个是"一次性 Q 弹"
  // （瞬间压到 0.86、再 0.28s 弹回），节奏和深度都不对。
  // 改成自己按相位驱动：
  //   · 每 250ms 切一次目标（压 / 弹），transition 时长也正好 250ms
  //     → 上一段的过渡结束点就是下一段的起点，**中间没有任何停留**
  //   · 压：scaleY 0.75（高度压到 3/4）、scaleX 1.15（横向鼓出来，体积守恒感）
  //   · transform-origin 在**底部中心**，所以是"往下坐"而不是整体缩小
  //   · 仍然走 sprite-xform 的 'poke' 那一路 —— 弹弓形变/黄金回旋不会被覆盖
  var CYCLE_MS = 250          // 压 250ms + 弹 250ms = 一拍 0.5 秒
  var SQUASH_X = 1.15
  var SQUASH_Y = 0.75         // 压到 3/4 高
  var squashed = false
  var cycles = 0

  function tick() {
    var img = document.querySelector('img.dshwv-img')
    if (!img) return
    squashed = !squashed
    cycles++
    try {
      var X = window.__dshpetSpriteXform
      img.style.transformOrigin = '50% 100%'
      // ⚠️ 两段必须用**同一条对称缓动**。
      //    之前"压"用 ease-in-out、"弹"用带过冲的曲线，实测下来
      //    下去要 234ms、上来只要 175ms —— 两半观感不均匀（用户要的是各 0.25s）。
      //    用同一条近正弦曲线，下去和上来就一样长、接缝也没有速度突变。
      img.style.transition = 'transform ' + CYCLE_MS + 'ms cubic-bezier(.4,0,.6,1)'
      var t = squashed ? X.scale(SQUASH_X, SQUASH_Y) : X.scale(1, 1)
      if (X) X.set('poke', t)
      else img.style.transform = t
    } catch (e) {}
  }

  function startAnim() {
    stopAnim()
    squashed = false
    tick()                                  // 立刻压下第一拍
    timer = setInterval(tick, CYCLE_MS)     // 之后每 250ms 切一次，无缝
  }

  function stopAnim() {
    if (timer) { clearInterval(timer); timer = null }
    // 正好停在"压扁"那一拍时手动复位，别让她一直是扁的
    try {
      var X = window.__dshpetSpriteXform
      if (X) X.clear('poke')
      var img = document.querySelector('img.dshwv-img')
      if (img) img.style.transition = ''
    } catch (e) {}
  }

  // --------------------------------------------------------------------------
  // 开关
  // --------------------------------------------------------------------------
  function setOn(v) {
    v = !!v
    if (v === on) {
      // 状态没变也要把界面同步一下（菜单重建后新复选框可能是旧的勾选态）
      syncUi()
      return
    }
    on = v
    syncUi()
    if (v) {
      startAnim()
      startMusic()
      log('已开启（' + (currentSong() ? currentSong().name : '默认曲') + ' 循环 + 点击动画循环）')
    } else {
      stopAnim()
      stopMusic()
      log('已关闭，已恢复原状')
    }
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
    log('已就绪（菜单里「拖动物理」组下面应有「通透模式」+ 歌曲选择 + 自定义）')
  }

  window.__dshpetTongtou = {
    isOn: function () { return on },
    set: setOn,
    _inject: injectRow,
    _tick: tick,
    _refreshSongs: refreshSongs,
    // 自检用：假 Audio 试完之后把它扔掉，别让真身被假货顶替
    _resetAudio: function () {
      try { if (audio) audio.pause() } catch (e) {}
      audio = null
      curUrl = ''
    },
    // 自检/诊断用：看音乐到底有没有在走（不暴露任何密钥类东西）
    _state: function () {
      return {
        on: on,
        paused: audio ? audio.paused : null,
        time: audio ? audio.currentTime : null,
        loop: audio ? audio.loop : null,
        src: audio ? String(audio.src || '') : null,
        url: curUrl,
        err: (audio && audio.error) ? audio.error.code : null,
        // 歌单
        song: currentSong() ? currentSong().name : null,
        songCount: songs.length,
        songNames: songs.map(function (s) { return s.name }),
        // 动画：tick 次数（每 250ms 一次）+ 当前相位
        cycles: cycles,
        squashed: squashed,
        cycleMs: CYCLE_MS,
        squashX: SQUASH_X,
        squashY: SQUASH_Y,
      }
    },
  }

  boot()
})()
