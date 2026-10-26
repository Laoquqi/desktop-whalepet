// ============================================================================
// 「识别歌曲和作者」—— 菜单开关 + 识别结果气泡
// ============================================================================
// 用户需求：
//   · 桌宠菜单里加一个「识别歌曲和作者」开关
//   · 打开后，从酷狗音乐 / 网易云音乐 / QQ音乐 识别出正在播的歌和作者
//   · 识别完弹一个气泡，里面是歌名和作者
//   · **作者名字换行**（歌名一行、作者一行）
//   · **所有字都保持在气泡里面，而且每一行都居中**
//
// 识别本身在主进程（lib/now-playing.js + lib/gsmtc.ps1），这里只负责：
//   ① 菜单里的那一行开关（持久化在 localStorage）
//   ② 把主进程推过来的结果渲染成气泡
//
// ⚠️ 为什么自己画一个气泡，而不是往挂件自己的 `.dshwv-text` 里塞字：
//    那个 textBox 是挂件闭包里的私有变量，它自己有一套"泡泡队列/消耗泡泡/
//    自定义模块"的逻辑在管它的内容与显隐。我们往里塞字会被它下一拍清掉，
//    而且会把余额泡泡的排版搞乱。
//    所以这里**复用它的 SVG 泡泡形状**（同一段 path/ellipse、同一个 viewBox），
//    自己挂一个并排的浮层 —— 看起来完全一致，又互不干扰。
(function () {
  'use strict'
  var api = window.petApi || {}
  var KEY = 'dshpet-now-playing'
  var KEY_LY = 'dshpet-now-lyrics'

  var pop = null, textEl = null, titleEl = null, artistEl = null
  var hideTimer = null
  var waitTimer = null
  // 「没在播」的宽限收起定时器：主进程 1.5s 一推，切歌间隙/暂停时会推 null ——
  // 收到 null 立刻 hide 的话，气泡就会"被按下去又弹起来"（用户看到的"歌手名字在闪"）。
  // 所以 null 时**保持现状**，30s 一直没歌才收。
  var nullHideTimer = null
  // ⚠️ 用户明确要求：**歌名/作者气泡弹出 2 秒后消失**（原来是 7000）。
  //    只影响"没开歌词 / 歌词没拿到"这一种情况 ——
  //    歌词模式（lyState==='ready'）是**常驻**不自动收的；
  //    歌词还在找（'loading'）时给 15 秒。这两条在 show() 里单独处理，不受这里影响。
  var SHOW_MS = 2000

  // —— 歌词状态 ——
  // 主进程每 1.5 秒推一次"当前播放到第几秒"，但歌词要一句接一句地跟着走，
  // 1.5 秒的粒度太粗。所以这里记下"收到 pos 的那一刻"，之后用本地定时器
  // 自己往前推 —— 每拍再从主进程校准一次，既顺滑又不会漂。
  var lyLines = []
  var lyState = 'none'      // none | loading | ready | notfound
  var lyBasePos = -1        // 收到 pos 时的播放位置
  var lyBaseAt = 0          // 收到 pos 时的本地时间（performance.now）
  // 播放器**不给位置数据**时（酷狗就是），本地时钟是唯一权威。
  // 暂停时必须"停表"：只冻结 lyBasePos、不再按 elapsed 往前走。
  var lyPaused = false
  var lyTick = null
  var lyCurText = ''
  var lastInfo = null
  var lastPos = -1        // 上一拍拿到的播放进度（判断"pos 有没有在走"）
  var lastLyLogAt = 0     // 歌词同步诊断日志的限流时间戳
  var lastPlaying = null  // 上一拍的播放状态（判断"刚恢复播放"）

  function log(m) { try { if (api.log) api.log('[识别歌曲] ' + m) } catch (e) {} }
  function enabled() { try { return localStorage.getItem(KEY) === '1' } catch (e) { return false } }
  function setEnabled(v) { try { localStorage.setItem(KEY, v ? '1' : '0') } catch (e) {} }
  function lyricsEnabled() { try { return localStorage.getItem(KEY_LY) === '1' } catch (e) { return false } }
  function setLyricsEnabled(v) { try { localStorage.setItem(KEY_LY, v ? '1' : '0') } catch (e) {} }

  // --------------------------------------------------------------------------
  // 样式
  // --------------------------------------------------------------------------
  // 尺寸单位沿用挂件的 `--dshw-u`（= --dshw-base / 1026），这样她缩放时
  // 气泡里的字跟着一起缩放，不会出现"图小了字还那么大"。
  function ensureCss() {
    if (document.getElementById('dshpet-np-css')) return
    var st = document.createElement('style')
    st.id = 'dshpet-np-css'
    st.textContent = [
      // 菜单里那一行开关：和「拖动物理」那一行同款
      '.dshpet-np-row{display:flex;align-items:center;gap:6px;margin:5px 0;color:#203170;font-size:12px;white-space:nowrap}',
      '.dshpet-np-row input{width:16px;height:16px;accent-color:#203170;cursor:pointer;flex:0 0 auto}',
      '.dshpet-np-row span{cursor:pointer}',

      // —— 气泡本体：和 .dshwv-pop 同尺寸、同位置口径 ——
      // z-index 取 2（挂件自己的泡泡是 1），万一同时出现，我们在上面
      '.dshpet-np-pop{position:absolute;left:0;top:0;width:100%;aspect-ratio:1026/700;' +
        'pointer-events:none;z-index:2;--dshw-u:calc(var(--dshw-base) / 1026);' +
        'opacity:0;transition:opacity .2s ease}',
      '.dshpet-np-pop.dshpet-np-open{opacity:1}',
      '.dshpet-np-pop svg{display:block;width:100%;height:100%;pointer-events:none}',
      // 泡泡成形动画：和挂件同一套（三块错开弹出）
      '.dshpet-np-pop .dshpet-np-bshape,.dshpet-np-pop .dshpet-np-b1,.dshpet-np-pop .dshpet-np-b2{' +
        'opacity:0;transform:scale(.7);transform-box:fill-box;transform-origin:50% 50%;' +
        'transition:opacity .2s ease,transform .2s ease}',
      '.dshpet-np-pop.dshpet-np-open .dshpet-np-bshape,' +
      '.dshpet-np-pop.dshpet-np-open .dshpet-np-b1,' +
      '.dshpet-np-pop.dshpet-np-open .dshpet-np-b2{opacity:1;transform:none}',
      '.dshpet-np-pop.dshpet-np-open .dshpet-np-b2{transition-delay:0s}',
      '.dshpet-np-pop.dshpet-np-open .dshpet-np-b1{transition-delay:.13s}',
      '.dshpet-np-pop.dshpet-np-open .dshpet-np-bshape{transition-delay:.26s}',
      '.dshpet-np-pop .dshpet-np-bshape{transition-delay:.1s}',
      '.dshpet-np-pop .dshpet-np-b1{transition-delay:.2s}',
      '.dshpet-np-pop .dshpet-np-b2{transition-delay:.3s}',

      // —— 文字区 ——
      // 锚点和挂件一样：泡泡主体的视觉中心（--dshw-vx/--dshw-vy 由挂件算好写在
      // documentElement 上）。宽高各留一点余量，保证字不压到泡泡描边上。
      '.dshpet-np-text{position:absolute;left:var(--dshw-vx,44.25%);top:var(--dshw-vy,36%);' +
        'width:62%;height:58%;transform:translate(-50%,-50%);' +
        'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
        // ⚠️ 挂件的 .dshwv-text 是 white-space:nowrap（它只放一行数字）。
        //    我们必须**显式覆盖成 normal**，否则长歌名会被拉成一条线冲出泡泡。
        'white-space:normal;text-align:center;color:#536ba9;line-height:1.2;' +
        'overflow:hidden;pointer-events:none;' +
        '--dshpet-np-scale:1}',
      '.dshpet-np-pop.dshpet-np-open .dshpet-np-text{opacity:1}',
      // 她朝左时整只是 scaleX(-1) 翻过来的，文字要再翻一次才是正的
      '.dshwv-root.dshwv-left .dshpet-np-text{transform:translate(-50%,-50%) scaleX(-1)}',

      // 两行：歌名 / 作者。各自**整行居中**（width:100% + text-align:center），
      // 长内容在行内折行也仍然是居中的。
      '.dshpet-np-line{display:block;width:100%;text-align:center;' +
        'overflow-wrap:anywhere;word-break:break-word}',
      '.dshpet-np-title{font-size:calc(var(--dshw-u) * 84 * var(--dshpet-np-scale,1));' +
        'font-weight:700;color:#203170;letter-spacing:.01em}',
      '.dshpet-np-artist{font-size:calc(var(--dshw-u) * 62 * var(--dshpet-np-scale,1));' +
        'font-weight:500;color:#536ba9;margin-top:calc(var(--dshw-u) * 18 * var(--dshpet-np-scale,1))}',
      // 歌词模式：上面一行小字标出"这是哪首歌"，下面一行大字是当前这一句
      '.dshpet-np-lyhead{font-size:calc(var(--dshw-u) * 44 * var(--dshpet-np-scale,1));' +
        'font-weight:500;color:#9fb0d9;margin-bottom:calc(var(--dshw-u) * 20 * var(--dshpet-np-scale,1))}',
      '.dshpet-np-lyric{font-size:calc(var(--dshw-u) * 78 * var(--dshpet-np-scale,1));' +
        'font-weight:700;color:#203170;letter-spacing:.01em}',
      // 歌词逐句切换时淡入一下，避免生硬跳字
      '.dshpet-np-lyric.dshpet-np-fade{animation:dshpet-np-fadein .28s ease}',
      '@keyframes dshpet-np-fadein{from{opacity:.15}to{opacity:1}}',
    ].join('')
    document.head.appendChild(st)
  }

  // --------------------------------------------------------------------------
  // 建气泡（复用挂件那段 SVG 泡泡形状）
  // --------------------------------------------------------------------------
  function build() {
    if (pop) return pop
    var body = document.querySelector('.dshwv-body')
    if (!body) return null
    ensureCss()
    pop = document.createElement('div')
    pop.className = 'dshpet-np-pop'
    // 形状与挂件 .dshwv-pop 里的那一份**逐字一致**（同样的 viewBox / path / 两个尾巴）
    pop.innerHTML = '<svg viewBox="0 0 1026 700" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">' +
      '<path class="dshpet-np-bshape" fill="#FFFFFF" stroke="#203170" stroke-width="18" stroke-linejoin="round" stroke-linecap="round" d="M 827 248 A 373 232 0 1 0 81 246 A 373 232 0 0 0 301 465 A 57 32 10 0 0 413 484 A 373 232 0 0 0 827 248 Z"/>' +
      '<ellipse class="dshpet-np-b1" cx="352" cy="561" rx="37.5" ry="26" fill="#FFFFFF" stroke="#203170" stroke-width="18"/>' +
      '<ellipse class="dshpet-np-b2" cx="442" cy="646" rx="24.5" ry="18" fill="#FFFFFF" stroke="#203170" stroke-width="18"/>' +
      '</svg>'

    textEl = document.createElement('div')
    textEl.className = 'dshpet-np-text'
    titleEl = document.createElement('div')
    titleEl.className = 'dshpet-np-line dshpet-np-title'
    artistEl = document.createElement('div')
    artistEl.className = 'dshpet-np-line dshpet-np-artist'
    textEl.appendChild(titleEl)
    textEl.appendChild(artistEl)
    pop.appendChild(textEl)
    body.appendChild(pop)
    return pop
  }

  // --------------------------------------------------------------------------
  // 自动缩字号：**保证所有字都留在泡泡里**
  // --------------------------------------------------------------------------
  // 光靠 overflow:hidden 只是"把溢出裁掉"，字就看不见了 —— 那不算"保持在气泡里"。
  // 所以这里量一下：装不下就整体缩小（歌名/作者一起缩，保持两行的比例），
  // 直到真的装得下为止。缩到 0.45 还装不下（极少见）就认了，靠裁切兜底。
  //
  // ⚠️⚠️ **不能用 scrollHeight 判断"装不装得下"。**
  //    文字区是 `display:flex; flex-direction:column; justify-content:center` ——
  //    内容超高时它**上下两头一起溢出**，而 scrollHeight 只算"末端方向"的溢出，
  //    于是超了也量不出来（实测：明明溢出 45px，scrollHeight 却说刚好装得下，
  //    字号一档都没缩，字就压出泡泡了）。
  //    改成**把每个子元素的高度（含上下 margin）加起来**，这是可靠的。
  function contentHeight() {
    var need = 0
    for (var i = 0; i < textEl.children.length; i++) {
      var el = textEl.children[i]
      var cs = getComputedStyle(el)
      if (cs.display === 'none') continue
      need += el.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0)
    }
    return need
  }
  function fitText() {
    if (!textEl) return 1
    var scale = 1
    textEl.style.setProperty('--dshpet-np-scale', '1')
    // 逐档缩，最多 12 档；每档都重新量一次（会强制重排，但只在弹气泡时跑几次）
    for (var i = 0; i < 12; i++) {
      var fitsH = contentHeight() <= textEl.clientHeight + 1
      var fitsW = textEl.scrollWidth <= textEl.clientWidth + 1
      if (fitsH && fitsW) break
      scale -= 0.05
      if (scale < 0.45) { scale = 0.45; break }
      textEl.style.setProperty('--dshpet-np-scale', String(scale))
    }
    return scale
  }

  function hide() {
    if (waitTimer) { clearTimeout(waitTimer); waitTimer = null }
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
    if (lyTick) { clearInterval(lyTick); lyTick = null }
    if (pop) pop.classList.remove('dshpet-np-open')
  }

  // --------------------------------------------------------------------------
  // 歌词：把"第几秒"换算成"该显示哪一句"
  // --------------------------------------------------------------------------
  function nowPos() {
    if (lyBasePos < 0) return -1
    // 暂停中：位置本来就该冻住，**不能**再按 elapsed 往前推
    if (lyPaused) return lyBasePos
    return lyBasePos + (performance.now() - lyBaseAt) / 1000
  }
  function pickLine() {
    if (!lyLines.length) return ''
    const pos = nowPos()
    if (pos < 0) return lyLines[0].text
    let cur = lyLines[0]
    for (let i = 0; i < lyLines.length; i++) {
      if (lyLines[i].t <= pos + 0.2) cur = lyLines[i]
      else break
    }
    return cur.text
  }
  function renderLyricLine(force) {
    if (!artistEl) return
    const text = pickLine()
    if (!force && text === lyCurText) return
    lyCurText = text
    artistEl.textContent = text || '♪'
    // 重放淡入动画
    try {
      artistEl.classList.remove('dshpet-np-fade')
      void artistEl.offsetWidth
      artistEl.classList.add('dshpet-np-fade')
    } catch (e) {}
    fitText()
  }
  function startLyricTicker() {
    if (lyTick) return
    // 200ms 一跳：够跟得上换句，又不至于一直重排
    lyTick = setInterval(function () {
      if (!pop || !pop.classList.contains('dshpet-np-open')) return
      if (lyState !== 'ready') return
      renderLyricLine(false)
    }, 200)
  }

  // 当前该用哪种版式：有歌词 → 歌词版式；否则 → 歌名/作者版式
  function applyMode() {
    if (!pop) return
    const lyricMode = lyricsEnabled() && lyState === 'ready' && lyLines.length > 0
    if (lyricMode) {
      titleEl.className = 'dshpet-np-line dshpet-np-lyhead'
      artistEl.className = 'dshpet-np-line dshpet-np-lyric'
    } else {
      titleEl.className = 'dshpet-np-line dshpet-np-title'
      artistEl.className = 'dshpet-np-line dshpet-np-artist'
    }
  }

  // 挂件自己的泡泡开着的时候先别弹 —— 两个泡泡叠在一起没法看。
  // 等它关掉再弹（最多等 8 秒，超时就直接弹，别把消息吞了）。
  function showWhenFree(info, waited) {
    waited = waited || 0
    var whaleBubbleOpen = false
    try {
      var wb = document.querySelector('.dshwv-pop')
      whaleBubbleOpen = !!(wb && wb.classList.contains('dshwv-pop-open'))
    } catch (e) {}
    if (whaleBubbleOpen && waited < 8000) {
      if (waitTimer) clearTimeout(waitTimer)
      waitTimer = setTimeout(function () { showWhenFree(info, waited + 400) }, 400)
      return
    }
    show(info)
  }

  function show(info) {
    if (!info || !info.title) return false
    if (!build()) return false
    // ⚠️⚠️ **别在这里就覆盖 lastInfo。**
    //    下面要用它判断"是不是同一首歌"，先覆盖的话 sameSong 永远为 true，
    //    "换歌要重新锚定"这条就永远不会触发。赋值挪到函数末尾。

    // —— 同步歌词状态 ——
    // ⚠️⚠️ **这里不能无条件重新锚定。**
    //    主进程开着歌词时**每 1.5 秒推一次**，而播放器不一定上报播放进度：
    //      · 不上报 → pos = -1
    //      · 报了但恒定 → pos 一直是同一个值
    //    旧代码每次都 `lyBasePos = info.pos; lyBaseAt = now`，
    //    于是前者永远停在 LRC 第一行（头几行是「作词/作曲」），
    //    后者每 1.5 秒跳回第一行 —— 表现就是**卡在作词作曲 + 闪烁**。
    //    正确做法：**pos 真在推进才用它对齐**；否则保留锚点，
    //    让本地时钟继续跑（一句一句往下走，比冻住强）。
    const prev = lastInfo                     // 上一拍的 info（还没被覆盖）
    const sameSong = !!(prev && prev.title === info.title &&
      String(prev.artist || '') === String(info.artist || ''))
    lyLines = Array.isArray(info.lyrics) ? info.lyrics : []
    lyState = info.lyricsState || 'none'

    // —— 和播放器进度对齐 ——
    // ⚠️⚠️ **不能每次推送都硬锚定。**
    //    主进程的 pos 是每 1.5 秒**采样**一次再推过来的，天然滞后 0~1.5 秒。
    //    每次都 `lyBasePos = info.pos` 就等于每 1.5 秒把时钟**往回拽**一次 →
    //    锯齿 → 用户看到的正是"歌词对不上播放器进度"。
    //
    //    所以分三种情况：
    //      · 换歌          → 硬对齐（必须）
    //      · pos 确实在走  → 只追**偏差**的一部分（软对齐，不倒退）
    //      · pos 不走/-1   → 完全不动，让本地时钟继续跑
    // —— 先判断：这个播放器到底给不给「位置」——
    // ⚠️⚠️ 酷狗实测（`_smtc-probe.log`：300ms × 25 秒 × 84 拍，中途拖过进度条、暂停过）：
    //      pos   恒 0.000（拖进度条也不变）
    //      posAt 恒 -11644473600000（WinRT 时间轴未初始化时的默认值）
    //      dur / rate 恒 0
    //    只有 title / artist / status 是有效的。
    //    所以「pos = 0 且 posAt 无效」必须判成**没有位置** ——
    //    否则 0 会被当成"位置 0"参与硬对齐，暂停→恢复时歌词会**跳回第一行**。
    const posRaw = (typeof info.pos === 'number') ? info.pos : -1
    const posAtRaw = (typeof info.posAt === 'number') ? info.posAt : -1
    const havePosAt = posAtRaw > 0
    const hasRealPos = (posRaw > 0) || havePosAt

    // —— 把"采样快照"换算成"此刻的真实播放位置" ——
    // ⚠️⚠️ **这是能不能准的关键。**
    //    info.pos 是 posAt 那一刻的快照（500ms 才采一次），直接拿它对齐最多差一整个
    //    采样间隔；两次采样之间用"本地时钟猜"又必然漂。有了 posAt 就能精确外推：
    //        livePos = pos + (现在 - posAt)/1000 * rate
    //    精度几十毫秒 —— 于是每次推送都可以放心**硬对齐**。
    //    暂停时**不外推**（位置本来就该冻住）；没有位置数据时 livePos 保持 -1。
    let livePos = -1
    if (hasRealPos) {
      if (havePosAt) {
        const ageMs = Date.now() - posAtRaw
        const canExtrapolate = (info.playing !== false) && ageMs >= 0 && ageMs < 5000
        livePos = posRaw + (canExtrapolate ? ageMs / 1000 * (Number(info.rate) || 1) : 0)
      } else {
        livePos = posRaw
      }
    }
    const posOk = livePos >= 0
    // 位置是**量化**的吗？（src=msaa → 从播放器界面读的整数秒，误差 ±0.5s）
    // 量化数据不能每次硬对齐 —— 见下面 posOk 分支里那段长注释。
    const quantizedPos = String(info.src || '') === 'msaa'
    // ⚠️ 三个判断都要用**上一拍**的 lastPos，所以先把它记下来再更新。
    //    `posFirst`（第一次拿到真位置）单独拎出来：酷狗那种 pos 恒 0 的播放器
    //    永远走"无位置"分支，lastPos 一直是 -1；等它某天真的给了位置，
    //    光靠 posJumped 是判不出来的（lastPos < 0 时那两条都是 false），
    //    结果就是"位置变了但歌词不动"——自检里的换句用例第一次就是这么挂的。
    const hadLastPos = lastPos >= 0
    const posAdvanced = posOk && hadLastPos && livePos > lastPos + 0.05
    // —— 快进 / 快退（拖进度条、点进度条、切段落）——
    // ⚠️⚠️ **必须用"绝对差"判断，不能用"是否变大"。**
    //    采样间隔 500ms，正常播放两拍之间 pos 只涨 ~0.5s，
    //    所以 |Δ| > 2s 就是**跳变**（快进或快退）。
    //    只用 `pos > lastPos` 的话：**快退时 pos 是变小的**，
    //    posAdvanced 判不成立 → 会一路落到最后的"什么都不做" →
    //    本地时钟继续往前跑 → 歌词**留在后面不动**（这正是快退时的表现）。
    const posJumped = posOk && hadLastPos && Math.abs(livePos - lastPos) > 2
    const posFirst = posOk && !hadLastPos
    if (posOk) lastPos = livePos
    // **恢复播放**（上一拍暂停，这一拍在放）
    const resumed = (info.playing !== false) && lastPlaying === false
    const pausedNow = info.playing === false

    if (posOk) {
      // ================================================================
      // 暂停：有位置数据也要**停表**
      // ================================================================
      // 原来这里无条件 lyPaused = false，暂停时靠"每拍硬对齐到同一个 pos"
      // 表面冻结 —— 位置不动，但基准每 500ms 被重设一次。
      // 量化位置（MSAA）改成"只前进"之后这条路就不成立了：
      // 界面秒数不变 → err 恒为负 → 什么都不做 → **本地时钟会继续往前跑**。
      // 所以必须显式停表：把此刻的 elapsed 冻进 lyBasePos，nowPos() 直接返回它。
      // 恢复时 resumed=true → 走下面的硬对齐，基准重新对上。
      if (pausedNow) {
        if (!lyPaused) {
          lyBasePos = nowPos()
          lyBaseAt = performance.now()
          lyPaused = true
        }
      } else {
        lyPaused = false
        // ================================================================
        // 量化位置（src=msaa：从播放器界面上读的**整数秒**）
        // ================================================================
        // ⚠️⚠️ 这类数据和 smtc/elog 的毫秒级位置**必须区别对待**，否则会出现
        //     用户实测的两个症状：歌词"这句↔上句"反复跳、而且整体稍慢。
        //
        //     机制：界面显示 02:02 时真实位置在 122.0~122.99 之间，我们只能拿到 122，
        //     且 posAt 每次都设成"此刻"。如果照原样每次硬对齐：
        //        第 1 拍：livePos=122.0 → lyBasePos=122.0（时钟拉回整数）
        //        0.2s 后本地时钟走到 122.2
        //        第 2 拍：界面还是 122 → livePos=122.05 → **又拉回 122.05**（倒退！）
        //     于是位置永远在 [122, 122.3] 里锯齿，跨过句子边界就来回跳，
        //     而且永远比真实慢半秒（界面跳到 123 之前，我们到不了 123）。
        //
        //     解法：量化位置**只前进、不倒退**。
        //       · 界面比我们快（err > 0）→ 小幅追（40%），收敛但不抖
        //       · 界面比我们慢（err ≤ 0，量化误差或还没刷新）→ **什么都不做**
        //       · 明显偏离（err > 1.5s）→ 那是真 seek，硬对齐
        //     换歌 / 恢复 / 第一次拿到位置 仍然走硬对齐（那几种情况基准本来就不可信）。
        if (quantizedPos && sameSong && !resumed && !posJumped && !posFirst && lyBasePos >= 0) {
          const shown = lyBasePos + (performance.now() - lyBaseAt) / 1000
          const err = livePos - shown
          if (err > 1.5) {
            // 真 seek（界面秒数跳了一大截）→ 硬对齐
            lyBasePos = livePos
            lyBaseAt = performance.now()
          } else if (err > 0.05) {
            // 界面比我们快一点 → 追 40%，2~3 拍收敛，不会因为 1 秒的量化误差就跳
            lyBasePos = shown + err * 0.4
            lyBaseAt = performance.now()
          }
          // else：界面比我们慢（量化误差 / 还没刷新到下一秒）→ 保持本地时钟，
          //       **不改 lyBasePos**，这是"不倒退"的关键
        } else if (havePosAt || resumed || !sameSong || posJumped || posFirst) {
          // 换歌 / 恢复播放 / 快进快退 / 第一次拿到位置 → 一律硬对齐
          // （毫秒级的 smtc/elog 走这里，每次都硬对齐是对的）
          lyBasePos = livePos
          lyBaseAt = performance.now()
        } else if (posAdvanced) {
          const shown = lyBasePos + (performance.now() - lyBaseAt) / 1000
          const err = livePos - shown
          if (Math.abs(err) > 1.2) {
            // 真的跑偏了 → 硬对齐
            lyBasePos = livePos
          } else {
            // 小偏差 → 只追一半：既不倒退、也没有锯齿。
            // （采样间隔已从 1500ms 降到 500ms，追 50% 能在 1 秒内收敛，
            //   又不会因为单次抖动就跳。）
            lyBasePos = shown + err * 0.5
          }
          lyBaseAt = performance.now()
        } else if (lyBasePos < 0) {
          // pos 不可用（-1）或一直没锚过 → 从 0 起用本地时钟
          lyBasePos = 0
          lyBaseAt = performance.now()
        }
      }   // ← if (pausedNow) 的 else 结束
    } else {
      // ===== 没有位置数据（酷狗）：**本地时钟是唯一权威** =====
      // 三条规则，一条都不能少：
      //   ① 换歌 / 还没锚过 → 从 0 起（否则会沿用上一首的进度）
      //   ② 暂停 → **停表**（把此刻的 elapsed 冻进 lyBasePos，之后 nowPos() 不再走）
      //   ③ 恢复 → **续走**（只重置基准时刻，不动 lyBasePos）
      // 注意这里**绝不**把任何 pos 值写进 lyBasePos —— 没有数据就别假装有。
      // 代价：酷狗拖进度条**无法感知**（数据源里就没有），只能靠换歌/暂停来纠。
      if (!sameSong || lyBasePos < 0) {
        lyBasePos = 0
        lyBaseAt = performance.now()
        lyPaused = false
      } else if (pausedNow && !lyPaused) {
        lyBasePos = nowPos()
        lyPaused = true
      } else if (!pausedNow && lyPaused) {
        lyPaused = false
        lyBaseAt = performance.now()
      }
    }

    // —— 限流诊断（每 ~10 秒一条）——
    // 实机"歌词对不上进度"时，这条日志能直接回答关键问题：
    //   pos 到底有没有在走？显示时间跟它差多少？
    //   走的是"硬对齐 / 软对齐 / 本地时钟"哪一条？
    // 只看日志就能定位，不用再猜。
    if (lyricsEnabled() && lyState === 'ready' && lyLines.length) {
      var nowMs = performance.now()
      if (nowMs - lastLyLogAt > 10000) {
        lastLyLogAt = nowMs
        var shownNow = nowPos()
        var mode = !posOk
          ? (lyPaused ? '暂停(停表/无位置数据)' : '本地时钟(无位置数据)')
          : lyPaused ? '暂停(停表)'
          : havePosAt ? '外推硬对齐'
          : posJumped ? '硬对齐(快进快退)'
          : posAdvanced ? (Math.abs(livePos - shownNow) > 1.2 ? '硬对齐' : '软对齐')
          : '本地时钟(pos没在走)'
        try {
          if (api.log) api.log('[歌词同步] 采样=' + (posOk ? info.pos.toFixed(1) : '-1') +
            ' 外推=' + (livePos >= 0 ? livePos.toFixed(2) : '-') +
            ' 显示=' + (shownNow >= 0 ? shownNow.toFixed(2) : '-') +
            ' 差=' + (livePos >= 0 && shownNow >= 0 ? (shownNow - livePos).toFixed(2) : '-') +
            's 方式=' + mode + ' 当前句=' + JSON.stringify(String(lyCurText || '').slice(0, 12)))
        } catch (e) {}
      }
    }
    // 同一首歌的例行更新：**不要**清空 lyCurText，
    // 否则 renderLyricLine 会以为"行变了"而重放淡入 → 每 1.5 秒闪一下
    if (!sameSong) lyCurText = ''

    applyMode()

    if (lyricsEnabled() && lyState === 'ready' && lyLines.length) {
      titleEl.textContent = info.title + ' · ' + (info.artist || '未知歌手')
      // ⚠️ 传 false（不是 true）：行没变就不重放淡入动画。
      //    上面刚把 lyCurText 处理好了 —— 换了歌它是空的，所以第一次照样会渲染。
      renderLyricLine(false)
    } else {
      titleEl.textContent = String(info.title || '')
      // 用户要求"作者名字要换行" —— 所以作者**始终**单独一行。
      // 拿不到作者时给个占位，保持两行的结构稳定（而不是忽高忽低）。
      artistEl.textContent = String(info.artist || '未知歌手')
    }

    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
    pop.classList.add('dshpet-np-open')
    // ⚠️⚠️ **不能把 fitText 挂在 requestAnimationFrame 里。**
    //    窗口不可见时（自检就是 show:false）Chromium 不出帧，rAF 回调**永远不跑** ——
    //    第一版写成 rAF(fitText) + 里面再 setTimeout(fitText,420)，
    //    于是"自动缩字号"整条链一次都没执行，长歌名就压出泡泡了。
    //    缩字号是**必须发生**的事，所以直接同步跑一次，再用两个定时器复量
    //    （形状/字体有 0.2~0.36s 的过渡，量两次更准）。
    fitText()
    setTimeout(fitText, 60)
    setTimeout(fitText, 420)

    // 歌词模式：气泡**常驻**（歌词要一直跟着走），不设自动收起
    if (lyricsEnabled() && lyState === 'ready' && lyLines.length) {
      startLyricTicker()
    } else {
      if (lyTick) { clearInterval(lyTick); lyTick = null }
      // 歌词还在找的时候别 7 秒就收掉 —— 找到了还要显示
      var waitLyrics = lyricsEnabled() && lyState === 'loading'
      hideTimer = setTimeout(hide, waitLyrics ? 15000 : SHOW_MS)
    }
    lastInfo = info        // ← 放在末尾：下一拍拿它判断"是不是同一首歌"
    lastPlaying = info.playing !== false
    return true
  }

  // --------------------------------------------------------------------------
  // 菜单里那两行开关
  // --------------------------------------------------------------------------
  // 第一行「识别歌曲和作者」，第二行「识别歌词」（紧跟在它下面）。
  function makeRow(labelText, title, initial, onApply) {
    var row = document.createElement('div')
    row.className = 'dshpet-np-row'
    var cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = initial
    cb.title = title
    var label = document.createElement('span')
    label.textContent = labelText
    function apply(on) {
      cb.checked = on
      onApply(on)
    }
    cb.addEventListener('change', function (e) { e.stopPropagation(); apply(cb.checked) })
    label.addEventListener('click', function (e) { e.stopPropagation(); apply(!cb.checked) })
    row.appendChild(cb)
    row.appendChild(label)
    return { row: row, cb: cb, set: function (v) { cb.checked = !!v } }
  }

  function injectRow() {
    var menu = document.querySelector('.dshwv-menu')
    if (!menu) return false
    if (menu.querySelector('.dshpet-np-row')) return true

    // ① 识别歌曲和作者
    var songRow = makeRow(
      '🎵 识别歌曲和作者',
      '打开后：识别酷狗音乐 / 网易云音乐 / QQ音乐 里正在播放的歌和作者，并在她头上弹气泡',
      enabled(),
      function (on) {
        setEnabled(on)
        if (api.nowPlayingSet) {
          api.nowPlayingSet(on).then(function (r) { log('歌曲开关 → ' + on + '  ' + JSON.stringify(r)) })
            .catch(function (e) { log('歌曲开关失败：' + (e && e.message)) })
        } else log('主进程没有 nowPlayingSet 接口（preload 版本过旧？）')
        if (!on) hide()
      }
    )
    // ② 识别歌词（在①下面）
    var lyRow = makeRow(
      '📝 识别歌词',
      '打开后：气泡里显示当前这一句歌词，跟着音乐一句接一句（歌词来自 QQ音乐）',
      lyricsEnabled(),
      function (on) {
        setLyricsEnabled(on)
        if (api.nowPlayingLyricsSet) {
          api.nowPlayingLyricsSet(on).then(function (r) { log('歌词开关 → ' + on + '  ' + JSON.stringify(r)) })
            .catch(function (e) { log('歌词开关失败：' + (e && e.message)) })
        } else log('主进程没有 nowPlayingLyricsSet 接口（preload 版本过旧？）')
        // 关掉歌词 → 回到歌名/作者版式并重新计时收起
        if (lastInfo) show(lastInfo)
        else hide()
      }
    )

    var anchor = menu.querySelector('.dshpet-phys-row') || menu.querySelector('.dshwv-menu-row')
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(songRow.row, anchor.nextSibling)
      anchor.parentNode.insertBefore(lyRow.row, songRow.row.nextSibling)
    } else {
      menu.appendChild(songRow.row)
      menu.appendChild(lyRow.row)
    }
    return true
  }

  function start() {
    ensureCss()
    if (api.onNowPlaying) {
      api.onNowPlaying(function (info) {
        if (!enabled()) return
        if (!info) {
          // 切歌间隙 / 暂停时的空推送：**保持现状**（歌词气泡继续显示），
          // 30s 一直没歌才收起。立刻 hide 会让气泡每 1.5 秒闪一次。
          if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
          if (!nullHideTimer) {
            nullHideTimer = setTimeout(function () { nullHideTimer = null; hide() }, 30000)
          }
          return
        }
        if (nullHideTimer) { clearTimeout(nullHideTimer); nullHideTimer = null }
        // ⚠️ **暂停 → 立刻收起气泡。**
        //    主进程现在会把"暂停中的那首"也推过来（带 playing:false），
        //    所以这里能区分"暂停"和"切歌间隙"：
        //      · 暂停 → 立刻 hide()，并让歌词时钟停下（hide 会清 lyTick）
        //      · 切歌间隙（info 为 null）→ 还是保持现状，避免闪
        //    用户要求："暂停播放的同时显示歌词的气泡要同步消失"。
        if (info.playing === false) {
          if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
          // ⚠️ **必须在这里就把 lastPlaying 置 false。**
          //    暂停时下面直接 return 了，走不到 show() 末尾那句赋值 ——
          //    不置的话"恢复播放"永远判不出来，恢复后就不会硬对齐。
          lastPlaying = false
          hide()
          return
        }
        showWhenFree(info, 0)
      })
    }
    // 页面重载后把开关状态同步给主进程（主进程默认是关的）
    if (enabled() && api.nowPlayingSet) {
      api.nowPlayingSet(true).then(function () {
        // 歌词开关依赖"识别歌曲"已经开着，所以要在它之后再同步
        if (lyricsEnabled() && api.nowPlayingLyricsSet) api.nowPlayingLyricsSet(true).catch(function () {})
      }).catch(function () {})
    }
    // 菜单一出现就立刻注入，之后菜单重建也会自动补
    //（见 renderer/shell.js 的 __dshpetWatchRows 说明）
    if (window.__dshpetOnMenuReady) window.__dshpetOnMenuReady(injectRow)
    else injectRow()
    log('已就绪（歌曲=' + (enabled() ? '开' : '关') + ' 歌词=' + (lyricsEnabled() ? '开' : '关') + '）')
    return true
  }

  window.__dshpetNowPlaying = {
    start: start, injectRow: injectRow,
    // 自检用：不走"识别"，直接按歌名/作者弹一次气泡
    show: show, hide: hide, fitText: fitText,
    isEnabled: enabled,
    isLyricsEnabled: lyricsEnabled,
    // 自检用：把歌词灌进去，验证"一句接一句"的换句逻辑。
    // ⚠️ 必须**走 show() 这条正常路径**（而不是直接改内部变量）——
    //    show() 会从 info 里读 lyrics/lyricsState/pos 并覆盖内部状态，
    //    第一版直接改变量再调 show(lastInfo)，结果刚设好的歌词被 show() 用
    //    旧的 info 覆盖回 'none'，自检里表现为"歌词模式根本没切过去"。
    setLyricsForTest: function (lines, pos) {
      var info = lastInfo ? Object.assign({}, lastInfo) : { title: '测试', artist: '' }
      info.lyrics = Array.isArray(lines) ? lines : []
      info.lyricsState = info.lyrics.length ? 'ready' : 'notfound'
      info.pos = (typeof pos === 'number' && pos >= 0) ? pos : -1
      show(info)
      return lyState
    },
    lyricLine: function () { return artistEl ? artistEl.textContent : null },
    lyricHead: function () { return titleEl ? titleEl.textContent : null },
    lyricState: function () { return { state: lyState, count: lyLines.length, pos: nowPos() } },
    bubble: function () { return pop },
  }
})()
