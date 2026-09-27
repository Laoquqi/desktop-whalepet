// ============================================================================
// 米粒「唱歌」那一行的音乐选择（**全部在外壳里做，vendor 保持原版**）
// ============================================================================
// 需求：
//   · 删掉原来那句「歌放在 songs/ 文件夹里」
//   · 换成「选择音乐…」+「默认」两个按钮（和"音效"那套同款）
//       选择音乐… → 打开桌宠自己的 songs 文件夹
//       默认     → 换回随包那首 let-me-go
//   · 按钮下面一个选择栏：点它在**下面**展开二级菜单，列出 songs/ 里的音频；
//     二级菜单**置顶一项「🎲 随机播放」**，下面才是各首
//   · 选哪首就唱哪首（不是随机）；选「随机播放」才是上游那套随机
//
// ⚠️ 为什么"选哪首就唱哪首"要在外壳里用**拦截 fetch** 实现：
//    rice 的 pickSong() 在它自己的闭包里，外面改不了它的配置。
//    但它每次唱歌前都会 fetch('/dsh-rice/songs.json') 取歌单 ——
//    我们只要让这份歌单**只剩选中的那一首**，它的"多首随机"自然就变成"只唱那首"。
//    选「随机播放」时不拦，原样放行（就是上游原本的行为）。
//    好处：**一个字都不用改 vendor**，以后上游升级直接换文件即可。
(function () {
  'use strict'
  var api = window.petApi || {}

  var KEY = 'dshpet-rice-song'          // 选中的文件名；空串 = 随机播放
  var DEFAULT_SONG = 'let-me-go.webm'   // 随包那首（主进程启动时会拷进 songs 目录）
  var RANDOM = ''                       // 用空串表示"随机"，和 rice 的默认行为对齐

  var songList = []                     // 最近一次取回的歌单
  var sel = null, listEl = null, labelEl = null, open = false

  function log(m) { try { if (api.log) api.log('[米粒音乐] ' + m) } catch (e) {} }
  function chosen() { try { return localStorage.getItem(KEY) || '' } catch (e) { return '' } }
  function setChosen(v) { try { localStorage.setItem(KEY, v || '') } catch (e) {} }

  // --------------------------------------------------------------------------
  // 拦截歌单请求：选中的那首 → 只返回它；随机 → 原样放行
  // --------------------------------------------------------------------------
  function installFetchHook() {
    if (window.__dshpetSongHook) return
    window.__dshpetSongHook = true
    var origFetch = window.fetch
    // 留一份原件：我们自己取歌单时必须用它 ——
    // 用被拦过的那份会让歌单只剩选中那一首，下拉里就看不到别的歌了。
    window.__dshpetOrigFetch = origFetch
    window.fetch = function (input, init) {
      var url = (typeof input === 'string') ? input : ((input && input.url) || '')
      if (url.indexOf('/dsh-rice/songs.json') < 0) return origFetch.apply(this, arguments)
      var want = chosen()
      if (!want) return origFetch.apply(this, arguments)   // 随机播放：不拦
      return origFetch.apply(this, arguments).then(function (res) {
        return res.json().then(function (d) {
          var all = (d && d.songs) || []
          var hit = all.filter(function (s) { return s.file === want })
          if (!hit.length) hit = all      // 选的那首被删了 → 退回全部（等于随机）
          return new Response(JSON.stringify({ ok: true, songs: hit }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          })
        })
      })
    }
  }

  // --------------------------------------------------------------------------
  // 样式
  // --------------------------------------------------------------------------
  function ensureCss() {
    if (document.getElementById('dshpet-song-css')) return
    var st = document.createElement('style')
    st.id = 'dshpet-song-css'
    st.textContent = [
      '.dshpet-songwrap{display:block}',
      '.dshpet-songsel{display:flex;align-items:center;justify-content:space-between;gap:6px;' +
        'margin:4px 0 0;padding:2px 8px;border:1px solid rgba(32,49,112,.35);border-radius:7px;' +
        'background:rgba(32,49,112,.06);cursor:pointer;user-select:none;-webkit-user-select:none}',
      '.dshpet-songsel:hover{background:rgba(32,49,112,.14)}',
      '.dshpet-songsel-label{font-size:12px;color:#203170;overflow:hidden;' +
        'text-overflow:ellipsis;white-space:nowrap}',
      '.dshpet-songsel-arrow{color:#9fb0d9;font-size:10px;flex:0 0 auto}',
      '.dshpet-songlist{margin:2px 0 0;max-height:132px;overflow:auto;' +
        'border:1px solid rgba(32,49,112,.35);border-radius:7px;background:#fff}',
      '.dshpet-songitem{padding:3px 8px;font-size:12px;color:#203170;cursor:pointer;' +
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshpet-songitem:hover{background:rgba(32,49,112,.12)}',
      '.dshpet-songitem.dshpet-on{background:rgba(32,49,112,.22);font-weight:600}',
      '.dshpet-songitem.dshpet-random{border-bottom:1px solid rgba(32,49,112,.2)}',
      '.dshpet-songempty{padding:3px 8px;font-size:12px;color:#9fb0d9}',
    ].join('')
    document.head.appendChild(st)
  }

  // --------------------------------------------------------------------------
  // 选择栏
  // --------------------------------------------------------------------------
  function labelText() {
    var want = chosen()
    if (!want) return '🎲 随机播放'
    for (var i = 0; i < songList.length; i++) {
      if (songList[i].file === want) return songList[i].name || songList[i].file
    }
    return want + '（已不在 songs/ 里）'
  }
  function refreshLabel() { if (labelEl) labelEl.textContent = labelText() }

  function buildList() {
    if (!listEl) return
    listEl.textContent = ''
    var want = chosen()
    // 置顶的「随机播放」
    var rnd = document.createElement('div')
    rnd.className = 'dshpet-songitem dshpet-random' + (want ? '' : ' dshpet-on')
    rnd.textContent = '🎲 随机播放'
    rnd.setAttribute('data-song', RANDOM)
    listEl.appendChild(rnd)
    if (!songList.length) {
      var em = document.createElement('div')
      em.className = 'dshpet-songempty'
      em.textContent = 'songs/ 里还没有歌'
      listEl.appendChild(em)
      return
    }
    for (var i = 0; i < songList.length; i++) {
      var s = songList[i]
      var it = document.createElement('div')
      it.className = 'dshpet-songitem' + (want && want === s.file ? ' dshpet-on' : '')
      it.textContent = s.name || s.file
      it.setAttribute('data-song', s.file)
      listEl.appendChild(it)
    }
  }

  function fetchSongs() {
    // 注意：这里必须用**原始 fetch**，不能用被我们拦过的那份 ——
    // 否则选中的歌会让歌单只剩一首，下拉里就看不到别的歌了。
    var f = window.__dshpetOrigFetch || window.fetch
    return f('/dsh-rice/songs.json', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (d) { songList = (d && d.songs) || []; return songList })
      .catch(function () { return songList })
  }

  function toggleList(force) {
    if (!sel || !listEl) return
    open = (typeof force === 'boolean') ? force : !open
    listEl.style.display = open ? 'block' : 'none'
    if (!open) return
    buildList()
    // 每次展开都重取歌单 —— 刚往 songs/ 里丢的歌立刻能看到
    fetchSongs().then(function () { buildList(); refreshLabel() })
  }

  function choose(file) {
    setChosen(file)
    refreshLabel()
    toggleList(false)
    buildList()
    log('已切换音乐：' + (file || '随机播放'))
  }

  // --------------------------------------------------------------------------
  // 把这一行塞进米粒面板
  // --------------------------------------------------------------------------
  function buildRow() {
    var wrap = document.createElement('div')
    wrap.className = 'dshrice-row dshpet-songrow'

    var lab = document.createElement('span')
    lab.textContent = '音乐 '
    wrap.appendChild(lab)

    var bPick = document.createElement('button')
    bPick.type = 'button'
    bPick.className = 'dshpet-songpick'
    bPick.textContent = '选择音乐…'
    bPick.title = '打开桌宠的 songs 文件夹（把音频丢进去就行，不用改文件名）'
    bPick.addEventListener('click', function (e) {
      e.stopPropagation()
      if (api.openSongsFolder) { api.openSongsFolder(); log('已请求打开 songs 文件夹') }
      else log('主进程没有 openSongsFolder 接口')
    })
    wrap.appendChild(bPick)

    var bDef = document.createElement('button')
    bDef.type = 'button'
    bDef.className = 'dshpet-songdef'
    bDef.textContent = '默认'
    bDef.title = '换回随包自带的那首'
    bDef.addEventListener('click', function (e) { e.stopPropagation(); choose(DEFAULT_SONG) })
    wrap.appendChild(bDef)

    // 选择栏本体（按钮行下面单独一行）
    var selWrap = document.createElement('div')
    selWrap.className = 'dshpet-songwrap'
    sel = document.createElement('div')
    sel.className = 'dshpet-songsel'
    labelEl = document.createElement('span')
    labelEl.className = 'dshpet-songsel-label'
    var arrow = document.createElement('span')
    arrow.className = 'dshpet-songsel-arrow'
    arrow.textContent = '▾'
    sel.appendChild(labelEl)
    sel.appendChild(arrow)
    sel.addEventListener('click', function (e) { e.stopPropagation(); toggleList() })
    selWrap.appendChild(sel)

    listEl = document.createElement('div')
    listEl.className = 'dshpet-songlist'
    listEl.style.display = 'none'
    listEl.addEventListener('click', function (e) {
      e.stopPropagation()
      var it = e.target && e.target.closest ? e.target.closest('.dshpet-songitem') : null
      if (it) choose(it.getAttribute('data-song') || '')
    })
    selWrap.appendChild(listEl)

    var holder = document.createElement('div')
    holder.appendChild(wrap)
    holder.appendChild(selWrap)
    return holder
  }

  // 面板里的行是 <div class="dshrice-row"><span>歌放在 songs/ 文件夹里</span></div>
  function replaceNote() {
    var menu = document.querySelector('.dshrice-menu')
    if (!menu) return false
    if (menu.querySelector('.dshpet-songrow')) return true
    var spans = menu.querySelectorAll('.dshrice-row span')
    for (var i = 0; i < spans.length; i++) {
      var t = spans[i].textContent || ''
      if (t.indexOf('songs/') < 0 && t.indexOf('文件夹') < 0) continue
      var row = spans[i].closest('.dshrice-row')
      if (!row || !row.parentNode) continue
      row.parentNode.insertBefore(buildRow(), row)
      row.parentNode.removeChild(row)          // 把原来那句文字删掉
      refreshLabel()
      fetchSongs()
      return true
    }
    return false
  }

  function start() {
    ensureCss()
    installFetchHook()
    // 米粒面板一出现就立刻改，之后面板重建也会自动补
    //（见 renderer/shell.js 的 __dshpetWatchRows 说明）
    if (window.__dshpetWatchRows) window.__dshpetWatchRows('.dshrice-menu', replaceNote)
    else replaceNote()
    log('音乐选择已就绪')
  }

  window.__dshpetRiceSongs = {
    start: start,
    replaceNote: replaceNote,
    chosen: chosen,
    label: labelText,
    defaultSong: DEFAULT_SONG,
  }
})()
