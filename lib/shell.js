// ============================================================================
// 外壳页面路由
// ============================================================================
// 页面**由本地服务发出**（而不是用 file:// 打开）—— 这样页面与所有
// /dsh-whale/* /dsh-rice/* 接口同源，挂件里那些绝对路径
// （fetch('/dsh-whale/balance.json')、img.src='/dsh-whale/rua.gif'…）
// 不用做任何改写就能命中。
//
// 脚本/样式放在独立文件里（而不是内联），是为了能用严格 CSP：
// script-src 'self'，不需要 'unsafe-inline'。
import fs from 'node:fs'
import path from 'node:path'

const SHELL_FILES = {
  '/': ['renderer/index.html', 'text/html; charset=utf-8'],
  '/shell.js': ['renderer/shell.js', 'application/javascript; charset=utf-8'],
  '/shell.css': ['renderer/shell.css', 'text/css; charset=utf-8'],
  // 拖动物理（移植自 dsh-pet 的 pet/physics.py）单独一个文件，别把 shell.js 撑肥
  '/drag-physics.js': ['renderer/drag-physics.js', 'application/javascript; charset=utf-8'],
  // 「偷吃白饭」的菜单入口（把浮动小标签收进 ☰ 菜单）
  '/rice-entry.js': ['renderer/rice-entry.js', 'application/javascript; charset=utf-8'],
  // 挂件自带面板往左让开一级菜单（只改 margin-left，不动 left/transform）
  '/panel-focus.js': ['renderer/panel-focus.js', 'application/javascript; charset=utf-8'],
  // 桌宠菜单扩展（删掉避让滚动条/宽度，加打开 dsh 网页端）
  '/menu-extras.js': ['renderer/menu-extras.js', 'application/javascript; charset=utf-8'],
  '/game-mode.js': ['renderer/game-mode.js', 'application/javascript; charset=utf-8'],
  '/menu-steady.js': ['renderer/menu-steady.js', 'application/javascript; charset=utf-8'],
  // 面板居中（二级/三级面板显示在屏幕正中央且可拖动）
  '/menu-center.js': ['renderer/menu-center.js', 'application/javascript; charset=utf-8'],
  // 米粒唱歌那一行的音乐选择（全在外壳里做，vendor 保持原版）
  '/rice-songs.js': ['renderer/rice-songs.js', 'application/javascript; charset=utf-8'],
  // 米粒面板版面修补（带单位的行永远不换行：滑块可压缩、数字与单位不换行）
  '/rice-layout.js': ['renderer/rice-layout.js', 'application/javascript; charset=utf-8'],
  // 「识别歌曲和作者」：菜单开关 + 识别结果气泡
  '/now-playing.js': ['renderer/now-playing.js', 'application/javascript; charset=utf-8'],
  // 闭眼贴图（放在 vendor/rice/assets 里，但 rice 的素材白名单不认它 ——
  // 那是它自己维护的映射表，我们不动 vendor，改由外壳直接发）
  // ⚠️ 文件名是 **ASCII**（whale_closeeyes.png）—— 这两个文件原先叫
  //    「小鲸鱼闭眼.png」「小鲸鱼笑.png」，后来统一改成了 ASCII 名。
  //    改名的好处很实在：中文文件名在这条链路上要过 URL/打包/文件系统三道编码，
  //    一旦哪一环没按 UTF-8 走，就会变成"读不到文件 → 外壳回 500 → 图默默不显示"
  //    （这次就是因为只改了文件名、没同步改这里的路由，两张图一起 500）。
  '/whale-sprite-closeeye.png': ['vendor/rice/assets/whale_closeeyes.png', 'image/png'],
  // 「笑一下」贴图（偷吃成功 / 余额告急时闪 2 秒）。同样放在 vendor/rice/assets 里、
  // 由外壳直接发 —— 理由和上面那张闭眼图完全一样（rice 的白名单是它自己维护的映射表）。
  '/whale-sprite-laugh.png': ['vendor/rice/assets/whale_laugh.png', 'image/png'],
  // 「笑一下」的贴图切换逻辑
  '/laugh-sprite.js': ['renderer/laugh-sprite.js', 'application/javascript; charset=utf-8'],
  // 多状态形象的 9 张图（vendor/whale/assets/expressions/ 下，逐个列出）
  '/whale-exp/main.png': ['vendor/whale/assets/expressions/main.png', 'image/png'],
  '/whale-exp/stroking.png': ['vendor/whale/assets/expressions/stroking.png', 'image/png'],
  '/whale-exp/angry.png': ['vendor/whale/assets/expressions/angry.png', 'image/png'],
  '/whale-exp/disappointed.png': ['vendor/whale/assets/expressions/disappointed.png', 'image/png'],
  '/whale-exp/shy.png': ['vendor/whale/assets/expressions/shy.png', 'image/png'],
  '/whale-exp/exhausted.png': ['vendor/whale/assets/expressions/exhausted.png', 'image/png'],
  '/whale-exp/close_eyes.png': ['vendor/whale/assets/expressions/close_eyes.png', 'image/png'],
  '/whale-exp/half_closed_eyes.png': ['vendor/whale/assets/expressions/half_closed_eyes.png', 'image/png'],
  '/whale-exp/half_open_eyes.png': ['vendor/whale/assets/expressions/half_open_eyes.png', 'image/png'],
  // 米粒面板「角色」那一行 + 抓现行时的闭眼贴图
  '/rice-role.js': ['renderer/rice-role.js', 'application/javascript; charset=utf-8'],
  // 多状态形象（从 For-WinDesktop 版移植）
  '/whale-expression.js': ['renderer/whale-expression.js', 'application/javascript; charset=utf-8'],
  // 多桌宠：位置上报 + 相撞反应
  '/pet-collide.js': ['renderer/pet-collide.js', 'application/javascript; charset=utf-8'],
  // 立绘 transform 合成器（点击Q弹 / 弹弓形变 / 黄金回旋 三路合成）
  '/sprite-xform.js': ['renderer/sprite-xform.js', 'application/javascript; charset=utf-8'],
  // 黄金回旋（移植自 pet/golden_spin.py）
  '/golden-spin.js': ['renderer/golden-spin.js', 'application/javascript; charset=utf-8'],
  // 拖文件吃掉（移植自 pet/file_eater.py）
  '/file-eater.js': ['renderer/file-eater.js', 'application/javascript; charset=utf-8'],
  // 通透模式（菜单开关：循环播背景音乐 + 循环点击动画）
  '/tongtou-mode.js': ['renderer/tongtou-mode.js', 'application/javascript; charset=utf-8'],
  // 菜单太高时顶部会被窗口裁掉 → 自动限高 + 可滚动
  '/menu-fit.js': ['renderer/menu-fit.js', 'application/javascript; charset=utf-8'],
}

// ----------------------------------------------------------------------------
// 背景音乐（通透模式用）
// ----------------------------------------------------------------------------
// 两条路由：
//   · `/pet-music-list.json` —— 歌单：`{ ok, count, songs:[{ i, name, size, v }] }`
//   · `/pet-music.mp3`       —— 音频本体，用 `?n=<歌名>&v=<mtime>` 指定是哪一首
//
// ⚠️ 为什么歌名放 **query** 而不放路径：
//    路径里的中文要过 URL 编码 / asar 打包 / 文件系统三道，哪一环没按 UTF-8 走
//    就是"读不到 → 404 → 静音"（本项目闭眼贴图那次就是这么坏的）。
//    query 只有 URL 一道，`encodeURIComponent` + Node 的 URL 解析保证还原成原文。
//    路径名仍是 ASCII 的 `/pet-music.mp3`，不带参数 = 第一首 —— 和以前完全兼容。
//
// ⚠️ 必须支持 **Range**：<audio loop> 循环、以及浏览器预读时都会发
//    `Range: bytes=...`。只会回 200 全量的话，循环处会有可闻的断点。
//
// ⚠️⚠️ **不用 fs.createReadStream** —— 打包后文件可能在 asar 里，
//    而 asar 对 `createReadStream(path, {start,end})` 的区间支持并不可靠
//    （dev 模式跑得好好的，装成 exe 就变成"有声音但循环/拖动进度是坏的"，
//      这种只在打包后才暴露的坑最难查）。
//    改成 readFileSync + 切片：asar 下 readFileSync 是官方保证可用的。
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|wav|flac|opus)$/i
const AUDIO_MIME = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
}

function mountMusic(server, candidates) {
  // 候选目录，按顺序取**第一个真实存在的**：
  //   ① 主进程传进来的 —— 打包后是 exe 旁边那份 extraFiles。
  //      必须是**真实文件系统路径**：资源管理器打不开 asar，用户也没法往里丢歌，
  //      而「自定义」按钮要打开的正是这个文件夹。
  //   ② 兜底：rootDir 下那份（dev 模式两者是同一个；asar 里也读得到）。
  const dirs = (candidates || []).filter(Boolean)
  const pickDir = () => {
    for (const d of dirs) {
      try {
        if (fs.statSync(d).isDirectory()) return d
      } catch (err) {}
    }
    return dirs[0] || null
  }

  // 歌单：**纯码位排序**。
  // ⚠️ 不用 localeCompare —— 它依赖 ICU 语言环境，打包版和开发版可能排出不同顺序，
  //    那样"列表里的第 i 首"就会指到另一首歌上。
  const listSongs = () => {
    const dir = pickDir()
    if (!dir) return []
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch (err) {
      return []
    }
    return names
      .filter((n) => AUDIO_EXT.test(n) && n.charAt(0) !== '.')
      .sort()
      .map((n, i) => {
        let size = 0
        let mtimeMs = 0
        try {
          const st = fs.statSync(path.join(dir, n))
          size = st.size
          mtimeMs = st.mtimeMs
        } catch (err) {}
        return { i, name: n, size, mtimeMs }
      })
  }

  // 内容缓存：最多留 4 首 —— 换歌不用每次重读盘，也不会把整个文件夹塞进内存
  const cache = new Map()
  const load = (abs) => {
    const st = fs.statSync(abs)
    const hit = cache.get(abs)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit
    const buf = fs.readFileSync(abs)
    const item = { abs, mtimeMs: st.mtimeMs, size: buf.length, buf }
    cache.set(abs, item)
    while (cache.size > 4) cache.delete(cache.keys().next().value)
    return item
  }

  // ① 歌单
  server.mount({
    kind: 'exact',
    path: '/pet-music-list.json',
    handler: (req, res) => {
      const songs = listSongs()
      const body = JSON.stringify({
        ok: true,
        count: songs.length,
        songs: songs.map((x) => ({ i: x.i, name: x.name, size: x.size, v: Math.round(x.mtimeMs) })),
      })
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        // 歌单**必须不缓存**：用户刚往文件夹里丢的歌要立刻出现在选择栏里
        'Cache-Control': 'no-store',
        'Content-Length': String(Buffer.byteLength(body)),
      })
      res.end(body)
    },
  })

  // ② 音频本体
  server.mount({
    kind: 'exact',
    path: '/pet-music.mp3',
    handler: (req, res) => {
      const songs = listSongs()
      if (!songs.length) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('no audio file in vendor/whale/assets/music/')
        return
      }
      let q = null
      try {
        q = new URL(req.url || '/', 'http://127.0.0.1').searchParams
      } catch (err) {}
      // 按歌名取；歌名对不上（文件被删/改名）再按序号；都不行就用第一首
      let song = null
      const want = q && q.get('n')
      if (want) song = songs.find((x) => x.name === want) || null
      if (!song) {
        const i = parseInt((q && q.get('i')) || '', 10)
        song = (Number.isFinite(i) && songs[i]) ? songs[i] : songs[0]
      }
      const abs = path.join(pickDir(), song.name)
      let file
      try {
        file = load(abs)
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('music read failed: ' + String((err && err.message) || err))
        return
      }
      const buf = file.buf
      const size = file.size
      res.setHeader('Content-Type', AUDIO_MIME[path.extname(song.name).toLowerCase()] || 'audio/mpeg')
      res.setHeader('Accept-Ranges', 'bytes')
      // 本地文件，缓存住：循环时不再反复读盘
      res.setHeader('Cache-Control', 'public, max-age=3600')

      const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim())
      if (m && (m[1] || m[2])) {
        let start
        let end
        if (!m[1]) {
          // 后缀式 `bytes=-N`（要最后 N 字节）—— 浏览器预读/循环时会发这种
          const n = parseInt(m[2], 10)
          start = Math.max(0, size - (Number.isFinite(n) ? n : 0))
          end = size - 1
        } else {
          start = parseInt(m[1], 10)
          end = m[2] ? parseInt(m[2], 10) : size - 1
        }
        if (!Number.isFinite(start) || start < 0) start = 0
        if (!Number.isFinite(end) || end >= size) end = size - 1
        if (start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` })
          res.end()
          return
        }
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': String(end - start + 1),
        })
        res.end(buf.subarray(start, end + 1))
        return
      }
      res.writeHead(200, { 'Content-Length': String(size) })
      res.end(buf)
    },
  })
  return ['/pet-music-list.json', '/pet-music.mp3']
}

// opts.musicDir：通透模式音乐所在的**真实目录**（打包后 = exe 旁边那份 extraFiles）。
// 由主进程算好传进来 —— 渲染进程和 shell.js 都不该自己猜 exe 在哪。
export function mountShell(server, rootDir, opts) {
  const mounted = []
  for (const [route, [rel, mime]] of Object.entries(SHELL_FILES)) {
    const abs = path.join(rootDir, rel)
    server.mount({
      kind: 'exact',
      path: route,
      handler: (req, res) => {
        let body
        try {
          body = fs.readFileSync(abs)
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('shell file missing: ' + rel)
          return
        }
        res.writeHead(200, {
          'Content-Type': mime,
          'Cache-Control': 'no-store',
          'Content-Length': String(body.length),
        })
        res.end(body)
      },
    })
    mounted.push(route)
  }
  // 通透模式的背景音乐（单独挂：要支持 Range + 歌单，不能走上面那套全量返回）
  try {
    const o = opts || {}
    for (const r of mountMusic(server, [
      o.musicDir,                                          // 主进程给的（打包后 = exe 旁边）
      path.join(rootDir, 'vendor/whale/assets/music'),     // 兜底（dev / asar）
    ])) {
      mounted.push(r)
    }
  } catch (err) {
    // 音乐挂不上不该影响整个外壳
  }
  return mounted
}

export { SHELL_FILES }
