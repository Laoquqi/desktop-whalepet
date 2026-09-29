// ============================================================================
// 大肥鱼桌宠 —— Electron 主进程
// ============================================================================
// 结构：
//   main.cjs（本文件）     窗口 / 托盘 / 生命周期
//   lib/server.js          本地 HTTP 服务（只绑 127.0.0.1）
//   lib/dsh-shim.js        伪造 DSH 的 ctx，让原版插件原样跑起来
//   lib/credentials.js     本机凭据读写
//   lib/turns.js           用余额差值合成「每轮消耗」
//   lib/shell.js           外壳页面路由（同源）
//   renderer/              承载挂件的页面
//   vendor/whale/          官方 dsh-whale-widget 0.3.7（源码原样）
//   vendor/rice/           dsh-rice-widget 0.3.4（仅 2 处可移植性修补）
//
// ⚠️ vendor/ 下的代码基本保持原样 —— 这是"跟原来一致"的保证。
//    唯一的例外是 rice 的两处移植补丁（DSH_HOME、art→assets），
//    见 vendor/rice/lib/index.js 里的【桌宠移植补丁】注释。
//
// ⚠️ 主进程用 **CommonJS**（.cjs）而不是 ESM。
//    Electron 的 ESM 主进程在取内置 API 时有坑，三种写法实测都不行：
//      · 静态 `import { app } from 'electron'` → "does not provide an export named 'BrowserWindow'"
//      · 动态 `await import('electron')`       → 拿到空壳，app 是 undefined
//      · `createRequire(...)('electron')`      → 同样拿到不含 app 的对象
//    而 CommonJS 的 `require('electron')` 是 Electron 官方支持路径，稳定可用。
//    （`package.json` 里 type=module，所以本文件必须叫 .cjs。）
const { app, BrowserWindow, ipcMain, Tray, Menu, screen, nativeImage, shell, dialog } = require('electron')

// —— 内存优化开关（必须在 app ready 前设置）——
// ① 网络服务并入主进程：独立 network service 进程是一整套 Chromium 网络栈
//    （几十 MB），桌宠只跟 127.0.0.1 本地服务说话，完全用不着独立进程。
// ② 音频服务并入主进程：桌宠只放几个短音效，独立音频进程纯属浪费。
// ③ 磁盘缓存限到 32MB：本地服务的响应本来就不该进 HTTP 缓存。
// 三个开关的真实效果以打包实测为准（见 git 记录里的内存数字）。
app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess')
app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess')
app.commandLine.appendSwitch('disk-cache-size', String(32 * 1024 * 1024))
// ⚠️ **不要关硬件加速**（试过，已撤销）：软件渲染下全屏透明窗口每次重绘
//    （开菜单、动画）都会把视频正在用的硬件叠加层（MPO）挤掉 ——
//    用户实测"全屏视频时开桌宠菜单 → 视频页面变黑，要点一下才恢复"。
//    内存优化的其余手段（网络/音频服务并入、磁盘缓存、affinity 共享
//    渲染进程）都保留，只损失了 GPU 进程那一份。

const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')   // 探测本机 http 服务（「打开 dsh 网页端」找端口用）

const ROOT = __dirname

// ---------------------------------------------------------------------------
// 数据目录：所有运行时数据都放这儿，**不碰用户真实的 ~/.dsh**
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(app.getPath('appData'), '大肥鱼桌宠')
try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch (err) {}
process.env.DSH_HOME = DATA_DIR
// rice 用这个算歌单目录（见 vendor/rice/lib/index.js 的【桌宠移植补丁 3/3】）：
// 打包后 = exe 所在目录；开发时 = 项目根。
process.env.DSH_PET_DIR = app.isPackaged ? path.dirname(process.execPath) : ROOT

const LOG_FILE = path.join(DATA_DIR, 'pet.log')
// 上次用过的本地端口。**必须持久化**：浏览器/Electron 的 localStorage 按
// 「协议+主机+端口」隔离，端口一变就是全新存储 —— 挂件的位置、缩放、当前角色、
// 各种设置全在 localStorage 里，随机端口会导致每次启动全部复位。
// （实测：随机端口跑十几次后，Local Storage 里躺了 18 个不同 origin。）
const PORT_FILE = path.join(DATA_DIR, 'port.txt')

function readPreferredPort() {
  try {
    const n = parseInt(fs.readFileSync(PORT_FILE, 'utf8').trim(), 10)
    return (Number.isInteger(n) && n > 1024 && n < 65536) ? n : 0
  } catch (err) { return 0 }
}
function savePort(p) {
  try { fs.writeFileSync(PORT_FILE, String(p), 'utf8') } catch (err) {}
}

let logStream = null
function log(...args) {
  const line = `[${new Date().toISOString()}] ` + args.map((a) => (a && a.stack) ? a.stack : String(a)).join(' ')
  try {
    if (!logStream) logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' })
    logStream.write(line + '\n')
  } catch (err) {}
  if (!app.isPackaged) console.log(line)
}
// 日志轮转：超过 2MB 就换一份，别无限长
try {
  const st = fs.statSync(LOG_FILE)
  if (st.size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1')
} catch (err) {}

// ---------------------------------------------------------------------------
// 运行时
// ---------------------------------------------------------------------------
let server = null
let shim = null
let credentials = null
let turns = null
let nowPlaying = null
let nowPlayingMod = null   // 自检要直接调它的纯函数 pickSong()
let lyricsModRef = null    // 自检要直接调它的纯函数 parseLrc / pickBest
let win = null
// 所有桌宠窗口（win 是第一只，托盘/热键那些老代码都指着它）
const pets = []
// 每个窗口各自的鼠标穿透状态（见 setInteractive 的说明）
const interactiveOf = new WeakMap()
// 每只桌宠**立绘**在屏幕上的矩形（渲染进程每 150ms 报一次，用来算相撞）
const petRects = new WeakMap()
// 碰撞物理核心（ESM 模块，启动时动态 import 进来）
let collisionMod = null

// 碰撞世界的自检用例。只依赖主进程里的 collisionMod —— 自检探针在渲染进程里跑，
// 那边没有这个模块，所以结果在主进程算好、由探针插值取用（字段不变）。
function collisionSelfCheck() {
  const M = collisionMod
  if (!M) return { loaded: false }
  const r = { loaded: true }
  const tall = M.circlesFromRect(10, 20, 100, 200)
  r.circles = tall.map((c) => c.map((v) => Math.round(v)))
  r.circlesOk = (Math.round(tall[2][1]) === 170)
  const h1 = M.stableHashDirection('a', 'b')
  const h2 = M.stableHashDirection('b', 'a')
  r.hash = [Math.round(h1[0] * 1000) / 1000, Math.round(h1[1] * 1000) / 1000]
  r.hashOpposite = (Math.abs(h1[0] + h2[0]) < 1e-9 && Math.abs(h1[1] + h2[1]) < 1e-9)
  const mk = (id, vx, inf) => M.makeMember(id, {
    x: 0, y: 0, vx: vx, vy: 0, width: 100, height: 100, mass: 1,
    flags: M.FLAG_VISIBLE | M.FLAG_COLLISION_ENABLED, infiniteMass: !!inf,
  })
  const imp = M.solveCollisionImpulse(mk('a', 500), mk('b', -500), 1, 0)
  r.impulse = imp.map((v) => Math.round(v * 100) / 100)
  r.impulseOk = (imp[1] < 0 && imp[3] > 0)      // 一个往左、一个往右
  const sep = M.calculatePositionSeparation(20, 1, 0, 1, 1)
  r.sep = sep.map((v) => Math.round(v * 1000) / 1000)
  r.sepOk = (sep[1] < 0 && sep[3] > 0 && sep[0] > 0)
  const cA = M.circlesFromRect(0, 0, 100, 100)
  const cB = M.circlesFromRect(400, 0, 100, 100)
  const sw = M.sweptCircleChainCollision(cA, M.circlesFromRect(1000, 0, 100, 100), cB, cB)
  r.swept = [sw[0], Math.round(sw[3] * 100) / 100]
  r.sweptOk = (sw[0] === true)
  return r
}
// 哪些是"多开出来的"（第一只不算）。
// ⚠️ 用**建窗时就定死的标记**，不用"它在 pets 里的下标" ——
//    下标会随着别的桌宠被关掉而变（第二只关掉后第三只就成了下标 1），
//    那样"退出桌宠"菜单项会**时有时无**，是实打实的 bug。
const extraOf = new WeakMap()
let tray = null
let quitting = false
let interactive = false

// —— 全屏让路 —— 前台是铺满主屏的应用（视频全屏 / 无边框播放器 / F11…）时，
// 把所有桌宠窗口藏起来（"退到视频后面"），全屏结束再放回来。托盘里可关。
let fsWatch = null
let fsWatchModRef = null                       // 模块引用：托盘里现开时要能创建实例
let fsYieldEnabled = true                      // 默认开（用户要的行为就是默认发生）
// ⚠️ true = 桌宠窗口可激活（普通窗口）。默认 false = 不可激活（点她不抢焦点，
//    避免看视频时点桌宠把播放器弄暂停/闪白）。
//    托盘里有个开关可以现场切换 —— 专门用来排查"点不了"：
//    如果切过去就能点了，说明 WS_EX_NOACTIVATE 是元凶。
let petFocusable = false
let fsYieldActive = false                      // 当前正处于"全屏 → 已藏"状态
const PREFS_FILE = () => path.join(DATA_DIR, 'pet-prefs.json')
function loadFsYieldPref() {
  try {
    const j = JSON.parse(fs.readFileSync(PREFS_FILE(), 'utf8'))
    if (typeof j.fullscreenYield === 'boolean') fsYieldEnabled = j.fullscreenYield
  } catch (err) {}
}
function saveFsYieldPref() {
  try { fs.writeFileSync(PREFS_FILE(), JSON.stringify({ fullscreenYield: fsYieldEnabled }), 'utf8') } catch (err) {}
}
function setPetsYieldForFullscreen(hidden) {
  if (hidden === fsYieldActive) return
  fsYieldActive = hidden
  for (const w of pets) {
    try {
      if (w.isDestroyed()) continue
      if (hidden) {
        w.__fsWasVisible = w.isVisible()
        if (w.isVisible()) {
          // ⚠️⚠️⚠️ **让路不再用 hide()，改成"移出屏幕 + 透明度 0"。**
          //
          //    查了八轮才定位到：窗口建的时候调过 setFocusable(false)
          //    （为了修"点桌宠抢焦点导致视频/直播暂停"），它在 Windows 上给窗口
          //    加了 WS_EX_NOACTIVATE。而**这类窗口在 hide() 再 show() 之后，
          //    鼠标命中测试会失效** —— mousemove 照样能到，但点击送不进窗口，
          //    表现就是"桌宠和桌宠菜单都点不了，一点反应都没有"。
          //
          //    重新断言窗口标志（上一版的做法）只是**治标**：只要还走
          //    hide/show，就可能再次踩到同一个系统行为。所以这一版直接
          //    **不走 hide/show** —— 把窗口挪到屏幕外 + 整窗透明，
          //    视觉上等于消失了（让路的目的达到），但窗口状态**从没被打断过**，
          //    自然也就不会有"醒来之后点不了"的问题。
          //
          //    顺序：先淡出（渲染端做动画），再挪走 + 透明。
          //    260ms ≈ 渲染端那条 0.22s transition + 余量。
          try { w.webContents.send('pet:fade-out') } catch (err) {}
          w.__fsYielded = true                    // 让路中：pet:move-window 要忽略
          setTimeout(() => {
            try {
              if (w.isDestroyed() || !w.__fsYielded) return
              // ⚠️⚠️ **只做透明，绝对不要把窗口挪出屏幕。**
              //    上一版把它挪到工作区左边外侧，结果用户看到"退出全屏时桌宠会翻转一下"：
              //    渲染端的 updateFacing 是按**屏幕中线**判朝向的（小窗架构下窗口中线
              //    没有意义），窗口一被挪到左半边，它就判定"她在左半边"→ 翻转；
              //    挪回来又翻回去 —— 一次进出全屏翻两次。
              //    让路只需要"看不见"，setOpacity(0) 就够了，不需要动位置。
              w.setOpacity(0)
            } catch (err) {}
          }, 260)
        }
        // ⚠️⚠️ **不要在这里 setBackgroundThrottling(true)。**
        //    被节流的渲染进程**不跑 requestAnimationFrame 回调**，
        //    而渲染端的穿透判定原来正好是用 rAF 做的 —— 恢复后 rAF 可能一直
        //    不被调度。隐藏窗口本来就会被系统降频，这个节流省不了多少，去掉。
      } else if (w.__fsWasVisible) {
        try { w.webContents.setBackgroundThrottling(false) } catch (err) {}
        // ⚠️ **恢复：只还原透明度**（这一版没走过 hide，也没挪过位置，
        //    所以既不需要 showInactive，也不需要 setBounds）。
        w.__fsYielded = false
        try { w.setOpacity(1) } catch (err) {}
        // 再把建窗时设过的标志断言一遍（保险：万一系统在挪动过程中动了样式）
        try { w.setFocusable(petFocusable) } catch (err) {}
        try { w.setIgnoreMouseEvents(false) } catch (err) {}
        try { w.setAlwaysOnTop(true, 'screen-saver') } catch (err) {}
        try { w.moveTop() } catch (err) {}
        // 再延后一拍重做一次：show 是异步落地的，紧接着调可能被系统的
        // "显示过程"覆盖掉。120ms 足够，用户感知不到。
        setTimeout(() => {
          try {
            if (w.isDestroyed()) return
            // ⚠️ **来回切一次 setFocusable**：Windows 上样式一旦被系统"忘记"，
            //    单纯重复设置同一个值可能不触发重建；先设成 true 再设回 false
            //    才会真的重算窗口样式（WS_EX_NOACTIVATE / WS_EX_TRANSPARENT）。
            //    这是让"重新断言"真正生效的关键一步。
            w.setFocusable(true)
            w.setFocusable(petFocusable)
            w.setIgnoreMouseEvents(false)
            w.setAlwaysOnTop(true, 'screen-saver')
            w.moveTop()
          } catch (err) {}
        }, 120)
        w.__fsWasVisible = false
        // ⚠️⚠️ **让路恢复后必须强制重新评估鼠标穿透。**
        //    主进程和渲染端**各有一个状态缓存**：
        //        main.cjs:      if (interactiveOf.get(w) === on) return
        //        shell.js:      if (on === lastInteractive) return
        //    两边都是"值没变就跳过"。而 hide()/showInactive() 之后
        //    Electron 那边窗口的**实际**穿透状态可能已经复位，
        //    两个缓存却还认为"没变" → **谁都不重新下发** →
        //    窗口永远停在"点一下直接穿到桌面"的状态 = 用户报的"点不了"。
        //    所以这里：① 清掉主进程的缓存 ② 通知渲染端也清掉并重新评估。
        interactiveOf.delete(w)
        // ⚠️⚠️ **光清缓存还不够 —— 必须先"破死锁"。**
        //    如果窗口停在"穿透"状态、而 setIgnoreMouseEvents(true,{forward:true})
        //    的转发又恰好没生效，渲染端就**永远收不到 mousemove** →
        //    它那个"按指针位置判定要不要接管"的逻辑永远没机会跑 →
        //    窗口永远是穿透的 = 用户报的"一点反应都没有"。
        //    所以这里**强制接管一次**（哪怕只是一瞬间）：
        //    下一次鼠标移动一定能到渲染端，它就能按真实指针位置重新判定，
        //    该穿透再自己切回穿透。**破掉死锁，把控制权还给渲染端。**
        try { w.setIgnoreMouseEvents(false) } catch (err) {}
        interactiveOf.set(w, true)
        try { w.webContents.send('pet:reeval-interactive') } catch (err) {}
        // ⚠️⚠️ **恢复时只做一次，绝对不要连续催。**
        //    上一版这里写了"每 800ms 催一次、共 6 次"，想的是"怕消息被丢"。
        //    实测日志证明这个想法**有害**：
        //        穿透状态 → 穿透
        //        穿透状态 → 接管（可点）
        //        穿透状态 → 穿透
        //        穿透状态 → 接管（可点）   ← 每秒横跳好几次
        //    因为主进程在强制"接管"，而渲染端按真实指针位置又判成"穿透"，
        //    两边**高频对打**。而高频切 setIgnoreMouseEvents 本身就会让
        //    点击送不进窗口 —— 用户报的"一点反应都没有"，很可能就是它造成的。
        //    （日志里最后状态明明是"接管（可点）"，却还是点不了 ——
        //      说明问题不在"最终状态"，而在"状态一直在抖"。）
        //    结论：恢复时**只做一次**，之后完全交给渲染端按指针位置自己判定。
        // —— 诊断：把窗口恢复后的**真实状态**记下来 ——
        // "点不了"查了四轮都没解决，不再靠推理。这几项一旦异常，
        // 日志一眼就能定位：不可见 / 位置离谱 / 渲染进程没响应。
        setTimeout(() => {
          try {
            log('让路恢复: visible=' + w.isVisible() +
                ' bounds=' + JSON.stringify(w.getBounds()) +
                ' destroyed=' + w.isDestroyed())
          } catch (err) {}
        }, 300)
        // ⚠️ **让路恢复后必须验一下渲染进程真的醒了。**
        //    让路时上面那句 setBackgroundThrottling(true) 会把它节流"睡着"，
        //    而 showInactive() + 关掉节流**并不保证**它能醒来 ——
        //    实测症状：窗口和画面都还在，但**点什么都没反应**（用户报的"卡死"），
        //    而且既没崩溃也没退出，render-process-gone / unresponsive 都指望不上。
        //    所以这里主动探一次：executeJavaScript 必须渲染进程真的跑起来才会
        //    resolve，2 秒回不来就重载自愈。用 webContents.reload()，
        //    不是 location.reload()（后者在本应用里会卡在永不提交的导航上）。
        try {
          const probe = Promise.race([
            w.webContents.executeJavaScript('1'),
            new Promise((resolve, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
          ])
          probe.catch(() => {
            log('让路恢复后渲染进程没响应 → 重载自愈')
            try { if (!w.isDestroyed() && !quitting) w.reload() } catch (err) {}
          })
        } catch (err) {}
      }
    } catch (err) {}
  }
  log('全屏让路：' + (hidden ? '前台进入全屏 → 桌宠已让路（隐藏）' : '全屏结束 → 桌宠回来了'))
}

const SELFTEST = !!process.env.PET_SELFTEST
// 聚焦模式：只跑一条探针，跳过完整自检里那些很慢的段落（抛掷仿真要等 11.5 秒…）。
// 用途是**排查"偶发"的交互 bug**：那种 bug 要反复试几十次才能撞上，
// 每轮都等一分钟的话根本迭代不动。见 runFocusProbe()。
const FOCUS = process.env.PET_FOCUS || ''

// 兜底：主进程里任何未捕获的异常/拒绝都要落日志。
// 否则打包版一旦在某个环节抛错，表现就是"启动一下就没了、什么线索都没有"。
process.on('uncaughtException', (err) => {
  log('!! 未捕获异常', err)
})
process.on('unhandledRejection', (reason) => {
  log('!! 未处理的 Promise 拒绝', reason)
})

// lib/ 下是 ESM —— 从 CJS 里用动态 import() 载入（这是合法且稳定的）
async function loadLib() {
  const u = (p) => new URL('file://' + path.join(ROOT, p).replace(/\\/g, '/')).href
  const serverMod = await import(u('lib/server.js'))
  // 碰撞物理核心（移植自参考实现的 pet/collision.py）
  try {
    collisionMod = await import(u('lib/collision.js'))
    log('碰撞物理核心已加载')
  } catch (err) {
    log('碰撞物理核心加载失败（碰撞将退回旧行为）：' + (err && err.message))
  }
  const shimMod = await import(u('lib/dsh-shim.js'))
  const credMod = await import(u('lib/credentials.js'))
  const turnsMod = await import(u('lib/turns.js'))
  const shellMod = await import(u('lib/shell.js'))
  const nowPlayingMod = await import(u('lib/now-playing.js'))
  const lyricsMod = await import(u('lib/lyrics.js'))
  const fsWatchMod = await import(u('lib/fullscreen-watch.js'))
  return { serverMod, shimMod, credMod, turnsMod, shellMod, nowPlayingMod, lyricsMod, fsWatchMod }
}

// ---------------------------------------------------------------------------
// 启动宿主
// ---------------------------------------------------------------------------
async function bootHost() {
  const { serverMod, shimMod, credMod, turnsMod, shellMod, nowPlayingMod: npm, lyricsMod, fsWatchMod } = await loadLib()
  nowPlayingMod = npm
  lyricsModRef = lyricsMod
  fsWatchModRef = fsWatchMod

  server = serverMod.createServer({ log })
  credentials = credMod.createCredentials({ dataDir: DATA_DIR, log })
  shim = shimMod.createCtx({ server, dataDir: DATA_DIR, credentials, log })
  turns = turnsMod.createTurnSynthesizer({ port: 0, log, enabled: true })

  // 「识别歌曲和作者」：主进程侧常驻轮询 Windows 媒体会话（GSMTC）。
  // 默认**关闭** —— 只有用户在菜单里打开才真正起 PowerShell 轮询，
  // 不然每次开桌宠都白跑一个子进程。
  nowPlaying = nowPlayingMod.createNowPlaying({
    dataDir: DATA_DIR,
    rootDir: ROOT,
    log,
    // 歌词：QQ音乐搜索 + LRC（音源选型见 lib/lyrics.js 顶部）
    lyrics: lyricsMod.createLyrics({ log }),
    onUpdate: (song) => { pushNowPlaying(song) },
  })
  nowPlaying.start()

  // 「全屏让路」：前台是铺满主屏的应用（视频全屏 / 无边框播放器 / F11…）时，
  // 把桌宠窗口藏起来别挡视频，全屏结束再放回来。托盘里有一项开关（默认开）。
  // ⚠️ 自检模式别开 —— 自检会切窗口、弹面板，前台窗口一变就把桌宠藏了，
  //    断言全乱（桌宠"不见了"对自检来说和崩了没区别）。
  loadFsYieldPref()
  if (fsYieldEnabled && !SELFTEST) {
    fsWatch = fsWatchMod.createFullscreenWatch({
      log,
      ownPid: process.pid,
      onFullscreen: (hidden) => setPetsYieldForFullscreen(hidden),
    })
    fsWatch.start()
    log('全屏让路已启用（托盘里可关）')
  }

  // 「每轮消耗」的替代数据源：拦截 /dsh-whale/last-turn.json
  // 必须在插件 apply() 之前登记，否则原处理器已经挂上去了。
  shim.override('/dsh-whale/last-turn.json', turns.handleLastTurn)

  // 内置泡泡图：24 张图**直接写在 vendor/whale/lib/index.js 的
  // DEFAULT_BUBBLE_IMGS 里**了，所以这里不再需要任何路由覆盖 ——
  // 清单是唯一事实来源，面板/资源管理/出图三条路都直接读它。


  // —— 原版鲸鱼宿主（零改动）——
  try {
    const whale = (await import(new URL('file://' + path.join(ROOT, 'vendor/whale/lib/index.js').replace(/\\/g, '/')).href)).default
    whale.apply(shim.ctx)
    log('鲸鱼宿主已挂载')
  } catch (err) {
    log('鲸鱼宿主挂载失败', err)
  }

  // —— 原版 rice 宿主（仅 2 处移植补丁）——
  try {
    const rice = await import(new URL('file://' + path.join(ROOT, 'vendor/rice/lib/index.js').replace(/\\/g, '/')).href)
    rice.apply(shim.ctx)
    log('rice 宿主已挂载')
  } catch (err) {
    log('rice 宿主挂载失败', err)
  }

  const port = await server.start(readPreferredPort())
  savePort(port)
  turns.setPort(port)
  turns.start()

  // —— 页面也从本地服务发出去（同源，见 lib/shell.js）——
  shellMod.mountShell(server, ROOT)

  log(`共 ${server.routes.length} 条路由，端口 ${port}`)
  return port
}

// ---------------------------------------------------------------------------
// 窗口：全屏透明覆盖层
// ---------------------------------------------------------------------------
// 为什么是全屏覆盖层而不是一个小窗口：
//   挂件的尺寸/位置是按视口百分比算的（.dshwv-root 用 100vw/100vh 做 clamp），
//   在 DSH 网页里它就是这个坐标系。全屏覆盖层让同一套代码**不用改**就能定位。
//   透明区域靠 setIgnoreMouseEvents 穿透，所以不会挡住桌面操作。
function displayBounds() {
  try {
    return screen.getPrimaryDisplay().bounds
  } catch (err) {
    return { x: 0, y: 0, width: 1280, height: 800 }
  }
}

function makePetWindow(port, primary) {
  log('createWindow: port=' + port + ' root=' + ROOT)
  const b = displayBounds()
  log('createWindow: bounds=' + JSON.stringify(b))
  // —— 小窗口架构：窗口 = 跟随桌宠的**小窗**，不再全屏透明 ——
  // 尺寸 900×900：桌宠盒子（约 375×375）钉在窗口**右下**，上方留 ~525px
  // 给 ☰ 菜单/气泡/米粒面板（它们都以桌宠为锚、随窗口走）。
  // ⚠️ **两维都必须 ≥893**：挂件的尺寸公式是 min(250, min(100vw,100vh)×0.28)×缩放
  //    —— 窗口窄了桌宠会跟着缩小（实测 640 宽 → 桌宠缩到 160px）。
  // 出生位置 = 工作区右下（和旧行为一致：立绘贴工作区右下、任务栏上沿）。
  // 好处：① 不再大面积覆盖视频（点击/重绘不会挤掉视频的硬件叠加层）；
  //       ② 合成器缓冲从全屏降到小窗（显存/内存齐降）；
  //       ③ "全屏让路"仍保留（真全屏应用前台时照样自动隐藏）。
  const PET_WIN_W = 900
  const PET_WIN_H = Math.min(900, Math.max(600, b.height - 80))
  const w = new BrowserWindow({
    x: b.x + b.width - PET_WIN_W, y: b.y + b.height - PET_WIN_H,
    width: PET_WIN_W, height: PET_WIN_H,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    acceptFirstMouse: true,
    title: '大肥鱼桌宠',
    icon: path.join(ROOT, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(ROOT, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
      // ⚠️ **所有桌宠共用一个渲染进程**（同 affinity 的窗口由 Electron 合并到同一进程）。
      //    每个独立渲染进程都是一整套 Chromium（实测 60~150MB）—— 多开几只内存直接翻倍。
      //    这些页面同源、同版本、同生命周期，合在一起没有任何隔离损失；
      //    代价是"一只的渲染进程崩了全体崩"（渲染崩溃本来就会整页重载，可接受）。
      affinity: 'dafatfish-pet',
    },
  })
  w.__petWinSize = { width: PET_WIN_W, height: PET_WIN_H }
  // ⚠️ **版本指纹**：这行只在「小窗架构」里存在。
  //    排查"改了没用"时，先看日志有没有这行 —— 没有就说明跑的不是这个包。
  //    （踩过的坑：小窗版和全屏版的 exe 名字一样、大小也一样，
  //      靠日志文案才分得出来；而两句关键日志只在其中一版存在。）
  log('★ 架构指纹：小窗版（窗口 ' + PET_WIN_W + '×' + PET_WIN_H + '，跟随桌宠移动）')

  w.setAlwaysOnTop(true, 'screen-saver')
  // ⚠️ **不可激活窗口**：点击桌宠不抢焦点。看视频/直播时点她，视频窗口
  //    不会失焦 —— 部分播放器失焦会暂停直播、页面闪白，要点一下视频才恢复
  //    （用户实测）。鼠标事件与焦点无关，照常收（命中测试基于窗口层级）。
  //    代价：桌宠自己收不到键盘事件（弹弓的 ESC 取消失效，其余取消路径
  //    —— 松右键/失焦 —— 不受影响；弹弓蓄力本身是鼠标操作）。
  try { w.setFocusable(petFocusable) } catch (err) {}
  try { w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) } catch (err) {}
  // （旧全屏架构的"再 setBounds 一次盖住整屏"已随小窗口改造移除——
  //   窗口现在就是 PET_WIN_W×PET_WIN_H 的小窗，尺寸/位置由上面的构造参数决定，
  //   之后的移动走 pet:move-window，由渲染进程的物理位置驱动。）
  // 默认整窗穿透；鼠标移到挂件上时由渲染进程通知打开
  w.setIgnoreMouseEvents(true, { forward: true })
  pets.push(w)
  extraOf.set(w, !primary)
  w.on('closed', () => {
    const i = pets.indexOf(w)
    if (i >= 0) pets.splice(i, 1)
    petRects.delete(w)
    extraOf.delete(w)
    // ⚠️ 顺手清掉这只参与的"连续重叠计数" —— 不清的话键会**永远留着**：
    //    overlapTicks 的键是 `<idA>|<idB>`，删除只发生在"两只分开"时，
    //    而这只已经不存在了，再也没人来删。虽然每条只有几十字节，
    //    但这是**无上限增长**的（多开关几次就一直涨）。
    {
      const id = String(w.id)
      for (const k of Array.from(overlapTicks.keys())) {
        if (k.indexOf(id + '|') === 0 || k.endsWith('|' + id)) overlapTicks.delete(k)
      }
    }
    broadcastPetCount()
    // 第一只没了就把 win 清掉 —— 托盘那几项都指着它，
    // 留着会对着已销毁的窗口调方法（"Object has been destroyed"）。
    if (w === win) win = pets.length ? pets[0] : null
  })
  if (primary) win = w

  // ⚠️ 自检模式下**连页面都不加载**。
  //    自检里会真的调一次「打开桌宠」来验证点一次多一只 —— 如果那只也去加载
  //    整页，它会跑一遍完整的挂件初始化，把后面的用例拖慢到超时（实测跑不完）。
  //    计数、pets 列表、关闭逻辑都不依赖页面，所以只跳过加载这一步就够了。
  //    例外：multi-pet 探针要验的正是"第二只自己的菜单/碰撞"，它必须是个**真页面**。
  if (SELFTEST && !primary && FOCUS !== 'multi-pet') return w

  // 页面就绪后把"落座位置"发过去（见 sendSpawnSpot 的说明）
  w.webContents.on('did-finish-load', () => {
    try { sendSpawnSpot(w) } catch (err) {}
    broadcastPetCount()
  })

  // 页面从本地服务加载（同源），而不是 file://
  w.loadURL(`http://127.0.0.1:${port}/`)
  log('createWindow: loadURL 已发出')

  w.once('ready-to-show', () => {
    // ⚠️ **多开出来的那只先别显示。**
    //    它的页面要跑几秒才把物理模块拉起来，而"落座"（挪到不和别人重叠的位置）
    //    是渲染进程做的 —— 先显示的话，用户会看到它**先和已有那只重合着出现**，
    //    过几秒才跳开。用户明确要求"出现的位置不能重合"，所以这里等它落好座再显示。
    //    万一落座一直没成功（渲染进程出错），8 秒后也照样显示出来，不至于"点了没反应"。
    if (!primary && !SELFTEST) {
      const showIt = (why) => {
        if (w.isDestroyed() || w.__shown) return
        w.__shown = true
        // ⚠️ 显示出来的这一刻就**开始参与碰撞**。
        //    超时兜底那条路（渲染进程没落成座）如果不打这个标记，
        //    这只就会永远被排除在碰撞之外 —— 一直压在别人身上、谁也推不动它。
        w.__placed = true
        try { w.showInactive() } catch (err) {}
        log('窗口已显示（' + why + '）')
      }
      w.__showNow = () => showIt('已落座')
      setTimeout(() => showIt('等落座超时'), 8000)
      log('多开的桌宠已就绪，等它落座后再显示')
      return
    }
    w.showInactive()
    log('窗口已显示')
  })

  // 渲染进程崩溃/无响应不能让桌宠"消失得莫名其妙"
  w.webContents.on('render-process-gone', (e, details) => {
    log('渲染进程异常退出', JSON.stringify(details))
    if (!quitting) setTimeout(() => { try { w.reload() } catch (err) {} }, 1500)
  })
  // ⚠️⚠️ **"无响应"必须单独接。** 上面那条只管"进程没了"，
  //    而**卡住不动的进程既没崩也没退出** —— render-process-gone 不会触发，
  //    表现就是用户说的"**怎么点都没反应**"，而且**永远不会自愈**。
  //    实测触发路径：全屏视频 → 让路时 setBackgroundThrottling(true) 把渲染进程
  //    节流睡着 → 退出全屏 showInactive() + setBackgroundThrottling(false) 之后
  //    它没醒过来 → 窗口还在、画面还在，但事件全都不响应。
  //    Electron 对这种情况会发 'unresponsive'，这里 reload 一次即可自愈。
  //    （用 webContents.reload()，不是 location.reload() —— 后者在本应用里
  //      会发起一次永远不提交的导航，反而更死。见下方 pet:reload 那段注释。）
  w.webContents.on('unresponsive', () => {
    log('渲染进程无响应 → 重载自愈')
    if (!quitting) { try { w.reload() } catch (err) {} }
  })
  w.webContents.on('did-fail-load', (e, code, desc) => log('页面加载失败', code, desc))

  // 窗口本身不允许被关掉（它是桌宠的容器）；要退出请走托盘
  w.on('close', (e) => {
    if (!quitting) { e.preventDefault(); w.hide() }
  })
  return w
}

function setInteractive(on, w) {
  on = !!on
  // ⚠️ 退出时渲染进程可能还会发来一次"切穿透"，而窗口那时已经销毁了 ——
  //    不加这个判断就会往日志里刷 "切换鼠标穿透失败 Object has been destroyed"，
  //    看着像 bug，其实只是收尾竞态。
  if (!w || w.isDestroyed()) return
  try {
    // ⚠️ 多桌宠之后**不能再拿全局 win 判断"状态没变"** ——
    //    那是第一只的状态，第二只会被它挡住（鼠标永远穿透不了/永远不穿透）。
    //    穿透状态是**每个窗口各自**的，所以按窗口存。
    if (interactiveOf.get(w) === on) return
    interactiveOf.set(w, on)
    if (on) w.setIgnoreMouseEvents(false)
    else w.setIgnoreMouseEvents(true, { forward: true })
    log('穿透状态 → ' + (on ? '接管（可点）' : '穿透'))     // 诊断：谁在什么时候改的
  } catch (err) { log('切换鼠标穿透失败', err && err.message) }
}

function reposition() {
  // ⚠️ 每只桌宠都要跟着铺满屏幕 —— 只挪第一只的话，
  //    第二只的窗口就还是旧尺寸，夹取范围和立绘对齐都会错。
  const b = displayBounds()
  for (const w of pets) {
    try { w.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height }) } catch (err) {}
  }
}

// ---------------------------------------------------------------------------
// 多桌宠
// ---------------------------------------------------------------------------
// 没有数量限制：每点一次就多一只。
// 每只都是**独立窗口**（不是同窗口多实例）—— 这样各自有自己的挂件状态、
// 自己的穿透判定、自己的拖拽，互不干扰。
let petPort = 0
function spawnPet(why) {
  if (!petPort) { log('还没有端口，开不了新桌宠'); return null }
  const size = artSizeGuess()
  const spot = pickSpawnSpot(size.w, size.h)
  const w = makePetWindow(petPort, false)
  if (spot) {
    w.__spawnAt = spot
    log('新桌宠落座 (' + Math.round(spot.x) + ',' + Math.round(spot.y) + ') 尺寸 ' +
      size.w + 'x' + size.h)
  } else {
    log('桌面放不下了 —— 先开出来，交给"持续分离"把它们挤开')
  }
  log('已开新桌宠（' + why + '），当前共 ' + pets.length + ' 只')
  return w
}
ipcMain.handle('pet:spawn', () => {
  try {
    const w = spawnPet('按钮')
    return { ok: !!w, count: pets.length }
  } catch (err) {
    log('开新桌宠失败：' + (err && err.message))
    return { ok: false, error: String(err && err.message), count: pets.length }
  }
})
ipcMain.handle('pet:count', () => ({ count: pets.length }))
// 渲染进程落好座了 → 这只可以显示了（见 ready-to-show 里的说明）
ipcMain.on('pet:placed', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w || w.isDestroyed()) return
  w.__placed = true
  if (typeof w.__showNow === 'function') { try { w.__showNow() } catch (err) {} }
})
// 这一只自己的信息（给"退出桌宠"菜单项用）
ipcMain.handle('pet:info', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  return { isExtra: !!(w && extraOf.get(w)), count: pets.length, index: w ? pets.indexOf(w) : -1 }
})
// 「退出桌宠」：关掉**发起这一只**自己。
// ⚠️ 用 destroy() 而不是 close() —— 窗口的 close 被拦着（见 makePetWindow：
//    非退出时 preventDefault 改成 hide），走 close 只会把它藏起来。
// 只允许"多开出来的"那只自己关自己：第一只是托盘/热键那些老代码指着的那只，
// 从菜单里关掉它会把那些入口全变成对着空窗口调用。
ipcMain.handle('pet:close-self', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w || w.isDestroyed()) return { ok: false, error: 'no window' }
  if (!extraOf.get(w)) return { ok: false, error: 'primary' }
  log('退出桌宠：关掉多开的那一只')
  // ⚠️ **不能在这个 handler 里直接 destroy。**
  //    destroy 会把发请求的那个渲染进程一起干掉，于是 ipcRenderer.invoke 的
  //    Promise **永远不会 settle** —— 渲染进程那边 `await closeSelf()` 就永久挂住
  //    （自检里表现为整个探针卡死、报告写不出来）。延后一拍，让回复先送出去。
  setTimeout(() => { try { if (!w.isDestroyed()) w.destroy() } catch (err) {} }, 60)
  return { ok: true, count: pets.length }
})
// 自检收尾用：把多开的那几只收掉。
// 不这么做的话，自检里多开的那只窗口会一直活着 —— 后面的用例被拖慢，进程也不退出。
ipcMain.handle('pet:close-extra', () => {
  const extra = pets.slice(1)
  for (const w of extra) { try { w.destroy() } catch (err) {} }
  log('已收掉 ' + extra.length + ' 只多余桌宠')
  return { ok: true, count: pets.length }
})
// 给自检用：看看各只桌宠报上来的立绘矩形（不参与功能，只是让测试能验证上报链路）
// 给自检用：跑一次落座算法，看它挑的位置有没有和现有桌宠重叠
ipcMain.handle('pet:debug-pick-spot', () => {
  const size = artSizeGuess()
  const used = []
  for (const p of pets) {
    const r = petRects.get(p)
    if (r && r.w > 0 && r.h > 0) used.push({ x: r.x, y: r.y, w: r.w, h: r.h })
  }
  const spot = pickSpawnSpot(size.w, size.h)
  return { size: size, used: used, spot: spot }
})
ipcMain.handle('pet:debug-rects', () => {
  const out = []
  for (const w of pets) {
    const r = petRects.get(w)
    out.push(r ? { x: r.x, y: r.y, w: r.w, h: r.h } : null)
  }
  return { count: pets.length, rects: out }
})

// —— 相撞：**持续分离**（不是"撞上了才推一下"）——
// 渲染进程每 50ms 把它**立绘**在屏幕上的矩形报上来（立绘 ≠ 窗口：窗口是整屏，
// 用窗口矩形算的话所有桌宠永远都在"相撞"）。
//
// ⚠️⚠️ **为什么不能做成"撞上才通知一次"（之前就是那么写的，被用户否了）：**
//   事件驱动的话，两只从"边缘刚碰到"到"通知到达"之间会**继续重叠**，
//   而每次只推"一半重叠 + 余量"，所以看起来是**先深深叠在一起、再弹开**。
//   用户要的是**实体**：边缘一碰就分开，任何时刻都不许有重合部分。
//   所以改成**每 30ms 无条件把所有重叠对分开**，位移直接发给两边。
//
// ⚠️ **必须防"拿同一份旧数据反复推"**：渲染进程 50ms 才报一次，
//   而这里 30ms 跑一次 —— 不设防的话同一份旧矩形会被推两次，两只直接飞出去。
//   所以每份报告带一个自增号，**一对里两边都没更新过就跳过**。
// 渲染进程报上来的**立绘**矩形（屏幕坐标）+ 有没有正在被拖。
// dragging 是给被拖的那只推不动、只能靠对方让开用的（见 renderer/pet-collide.js）。
let rectSeq = 0
// —— 小窗口架构：渲染进程驱动窗口移动 ——
// 渲染进程的物理位置（physPos，屏幕坐标）就是窗口的位置：拖拽/抛掷/吸附/
// 每次落定都经这里把窗口挪过去。只挪位置、不改尺寸（尺寸固定，见 PET_WIN_W/H）。
// 限幅：x/y 非有限值或离屏超过一屏就直接忽略（防御非法值把窗口扔丢）。
ipcMain.on('pet:move-window', (e, p) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w || w.isDestroyed() || !p) return
  // ⚠️ **让路中一律忽略。** 让路时窗口被挪到屏幕外，而渲染端的物理还在跑，
  //    它会不断发 moveWindow 想把自己挪回原位 —— 不挡住的话让路就白做了
  //    （桌宠会自己跑回屏幕上，盖在视频上）。
  if (w.__fsYielded) return
  const x = Number(p.x), y = Number(p.y)
  if (!isFinite(x) || !isFinite(y)) return
  const size = w.__petWinSize || { width: w.getBounds().width, height: w.getBounds().height }
  const b = displayBounds()
  const cx = Math.min(Math.max(x, b.x - size.width), b.x + b.width)
  const cy = Math.min(Math.max(y, b.y - size.height), b.y + b.height)
  try { w.setBounds({ x: Math.round(cx), y: Math.round(cy), width: size.width, height: size.height }) } catch (err) {}
})
ipcMain.on('pet:report-rect', (e, r) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w || !r) return
  petRects.set(w, {
    seq: ++rectSeq,
    x: Number(r.x) || 0, y: Number(r.y) || 0, w: Number(r.w) || 0, h: Number(r.h) || 0,
    dragging: r.dragging === true,
  })
})

// —— 多桌宠：**把每只的立绘矩形广播给其它只** ——
// 渲染进程靠这份数据做**事前**的实体约束（见 renderer/drag-physics.js 的 resolveSolid）：
// 任何一次位置写入只要会和同伴重叠就当场被挡住，所以"重合"根本不会发生。
//
// ⚠️⚠️ **为什么不再由主进程"事后推开"（上一版就是那样，被用户否了）：**
//   事后推开永远会先叠上再被分开 —— 拖动一快，一次上报间隔就能叠进去几十像素，
//   用户看到的就是"深深重合之后才弹开"。用户要的是**实体**：边缘一碰就分开、
//   任何时刻都不许有重合。位置是渲染进程在写的，只有它拦得住，主进程拦不住。
//
// 广播出去的矩形带一个自增号，渲染进程不用管；这里只在**内容变了**的时候发，
// 免得每 40ms 都推一遍同样的数据。
const PEER_MS = 40
const lastPeerMsg = new WeakMap()
setInterval(() => {
  const list = pets.filter((w) => !w.isDestroyed())
  const items = []
  for (const w of list) {
    // 隐藏中的桌宠（全屏让路 / 托盘隐藏）不参与 —— 看不见的同伴不该挡别人
    if (!w.isVisible()) continue
    const r = petRects.get(w)
    if (!r || !(r.w > 0) || !(r.h > 0)) continue
    // ⚠️⚠️ **还没落座的（多开出来的新桌宠）不参与碰撞广播。**
    //    它一开出来就停在默认位置（右下角），而那正是第一只待的地方 ——
    //    它的位置数据一旦广播出去，第一只的实体约束就会把自己挤开。
    //    用户报的"打开桌宠会把第一个桌宠弹走"就是这么来的。
    //    "等落座再显示"只挡住了眼睛，挡不住碰撞数据 —— 这里必须一起挡。
    if (!w.__placed && w !== win) continue
    items.push({ w, r })
  }
  // ⚠️ 少于两只时**要发空列表**：渲染端好把同伴约束清掉（不然一只被隐藏后，
  //    另一只的实体约束还盯着它 40ms 前的旧位置，表现为"对着空气绕着走"）。
  //    内容没变时 sig 去重，不会刷屏。
  for (const me of list) {
    const peers = []
    for (const o of items) {
      if (o.w === me) continue
      peers.push({
        id: o.w.id,                       // 渲染端物理步进的冲量转发要按窗口寻址
        x: Math.round(o.r.x), y: Math.round(o.r.y),
        w: Math.round(o.r.w), h: Math.round(o.r.h),
        dragging: o.r.dragging === true,
        // 步进内二体冲量要用同伴的**速度和质量**（报告里本来就带速度）
        vx: o.r.vx || 0, vy: o.r.vy || 0,
        mass: C_OR_BROADCAST_MASS(o.r),
        visible: o.w.isVisible(),
      })
    }
    const sig = JSON.stringify(peers)
    if (lastPeerMsg.get(me) === sig) continue
    lastPeerMsg.set(me, sig)
    try { me.webContents.send('pet:peers', peers) } catch (err) {}
  }
}, PEER_MS)

// 广播用的质量估算（与碰撞世界同一公式：面积加权 clamp 0.5~2.5）
function C_OR_BROADCAST_MASS(r) {
  if (!collisionMod) return 1
  try { return collisionMod.calculateMass(r.w / 2, r.h / 2) } catch (err) { return 1 }
}

// ---------------------------------------------------------------------------
// 拖文件"吃掉"（移植自参考实现的 pet/file_eater.py）
// ---------------------------------------------------------------------------
// ⚠️⚠️ **只做视觉反馈与统计，绝不删除 / 移动 / 修改被拖入的文件。**
//    这里也只 stat（读大小），没有任何写操作。用户要求写得很明确：
//    "把文件拖到桌宠身上会播放吃动画并记录统计（不真实删除文件）"。
const EAT_STATS_FILE = path.join(DATA_DIR, 'file_eaten_stats.json')
const EAT_HISTORY_LIMIT = 50
function eatDefaultStats() {
  return { feed_count: 0, file_count: 0, folder_count: 0, item_count: 0, total_bytes: 0, history: [] }
}
function eatLoadStats() {
  try {
    const raw = JSON.parse(fs.readFileSync(EAT_STATS_FILE, 'utf8'))
    if (!raw || typeof raw !== 'object') return eatDefaultStats()
    const st = eatDefaultStats()
    for (const k of ['feed_count', 'file_count', 'folder_count', 'item_count', 'total_bytes']) {
      const v = Number(raw[k])
      st[k] = Number.isFinite(v) ? Math.trunc(v) : 0
    }
    if (Array.isArray(raw.history)) st.history = raw.history.slice(-EAT_HISTORY_LIMIT)
    return st
  } catch (err) { return eatDefaultStats() }
}
function eatSaveStats(st) {
  // 统计只是附加功能：写盘失败**不能**影响"吃"这个交互本身
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const tmp = EAT_STATS_FILE + '.' + process.pid + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8')
    fs.renameSync(tmp, EAT_STATS_FILE)
  } catch (err) { log('吃掉统计写盘失败（不影响交互）：' + (err && err.message)) }
}
// 文件直接返回大小；目录递归累计大小，但**不展开成多个文件数**
function eatPathSize(p) {
  try {
    const st = fs.statSync(p)
    if (st.isFile()) return st.size
    let total = 0
    const walk = (dir) => {
      let ents = []
      try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { return }
      for (const e of ents) {
        const full = path.join(dir, e.name)
        try {
          if (e.isDirectory()) walk(full)
          else if (e.isFile()) total += fs.statSync(full).size
        } catch (err) {}
      }
    }
    walk(p)
    return total
  } catch (err) { return 0 }
}
function eatMeasure(p) {
  try {
    const st = fs.statSync(p)
    if (st.isFile()) return [1, 0, st.size]
    if (st.isDirectory()) return [0, 1, eatPathSize(p)]
  } catch (err) {}
  return [0, 0, 0]
}
function humanSize(n) {
  const v = Number(n) || 0
  if (v < 1024) return v + ' B'
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB'
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB'
  return (v / 1024 / 1024 / 1024).toFixed(1) + ' GB'
}
ipcMain.handle('pet:eat-files', (e, paths) => {
  try {
    const list = Array.isArray(paths) ? paths.filter((x) => typeof x === 'string' && x) : []
    if (!list.length) return { ok: false, reason: 'empty' }
    let files = 0, folders = 0, bytes = 0
    for (const raw of list) {
      const m = eatMeasure(raw)
      files += m[0]; folders += m[1]; bytes += m[2]
    }
    const st = eatLoadStats()
    st.feed_count += 1
    st.file_count += files
    st.folder_count += folders
    st.item_count += (files + folders)
    st.total_bytes += bytes
    st.history.push({
      at: new Date().toISOString(),
      files: files, folders: folders, bytes: bytes,
      names: list.slice(0, 8).map((x) => path.basename(x)),
    })
    if (st.history.length > EAT_HISTORY_LIMIT) st.history = st.history.slice(-EAT_HISTORY_LIMIT)
    eatSaveStats(st)
    log('吃掉 ' + list.length + ' 项：文件 ' + files + ' 夹 ' + folders + ' 共 ' + humanSize(bytes) +
      '（累计 ' + st.feed_count + ' 次 / ' + st.item_count + ' 项）')
    return { ok: true, files: files, folders: folders, bytes: bytes,
      human: humanSize(bytes), stats: st }
  } catch (err) {
    log('吃掉失败：' + (err && err.message))
    return { ok: false, error: String(err && err.message) }
  }
})
ipcMain.handle('pet:eat-stats', () => {
  const st = eatLoadStats()
  st.human = humanSize(st.total_bytes)
  return st
})

// ---------------------------------------------------------------------------
// 碰撞世界（移植自参考实现的协调者：collision.py 的物理核心 + 20Hz 提交）
// ---------------------------------------------------------------------------
// 分工：
//   · **渲染进程**每 50ms 报一次自己的**立绘**矩形 + 速度 + 标志（拖拽/蓄力）
//   · **这里**以 20Hz 跑世界：两两求交（当前帧 → 求不到再扫掠），
//     算冲量（恢复系数/摩擦/库仑上限/质量分摊）和位置分离，下发给双方
//   · **渲染进程**把 dv 加到速度、把 dx/dy 加到位置
//
// ⚠️ **和现有的"事前实体约束"是叠加关系，不是替代。**
//    事前约束（渲染端 resolveSolid）保证"拖动时**进不去**别人身体"，
//    这里保证"撞上时的**反弹手感**正确"（恢复系数/摩擦/质量）。
//    只留前者 → 撞上去是硬邦邦地停住，没有街机味；
//    只留后者 → 会先叠进去再被分开（用户明确否过这个）。
const WORLD_MS = 50              // 20Hz
let worldN = 0
// 每个成员上一帧的圆链（扫掠检测要用 prev→curr）
const prevCircles = new WeakMap()
// 每对连续重叠了几个 tick（连续 3 个就强制完整分离，见 calculate_position_separation）
const overlapTicks = new Map()
function pairKey(a, b) { return a < b ? (a + '|' + b) : (b + '|' + a) }

setInterval(() => {
  if (!collisionMod) return
  if (pets.length < 2) return
  const C = collisionMod
  const list = pets.filter((w) => !w.isDestroyed())
  const items = []
  for (const w of list) {
    const r = petRects.get(w)
    if (!r || !(r.w > 0) || !(r.h > 0)) continue
    // 没落座的不参与（见 peers 广播里的说明：它开在默认位置会和第一只重叠）
    if (!w.__placed && w !== win) continue
    // 隐藏中的桌宠（全屏让路）不参与碰撞 —— 看不见还撞人是怪事
    if (!w.isVisible()) continue
    const flags = C.FLAG_VISIBLE | C.FLAG_COLLISION_ENABLED |
      (r.dragging ? C.FLAG_DRAGGING : 0) |
      (r.aiming ? C.FLAG_SLINGSHOT_AIMING : 0)
    const circles = C.circlesFromRect(r.x, r.y, r.w, r.h)
    const m = C.makeMember(w.id, {
      x: r.x, y: r.y, vx: r.vx || 0, vy: r.vy || 0,
      width: r.w, height: r.h,
      // 质量按体型算（面积加权 clamp 0.5~2.5）
      mass: C.calculateMass(r.w / 2, r.h / 2),
      flags: flags,
      circles: circles,
    })
    items.push({ w, r, m, circles, prev: prevCircles.get(w) || circles })
  }
  if (items.length < 2) return
  worldN++

  // 累积每个成员这一 tick 的增量
  const acc = new Map()   // win -> {dvx, dvy, dx, dy}
  const accOf = (w) => {
    let a = acc.get(w)
    if (!a) { a = { dvx: 0, dvy: 0, dx: 0, dy: 0, hit: false }; acc.set(w, a) }
    return a
  }

  // ⚠️ 成员门控（对齐参考实现的 solve_multi_body_collision）：
  //    **不可见 / 没开碰撞 / 暂停**的成员一律不参与 —— 少任何一条都会出现
  //    "托盘隐藏了她还在和别人撞"这类怪事。
  const active = items.filter((it) => {
    const f = it.m.flags
    if (!(f & C.FLAG_VISIBLE)) return false
    if (!(f & C.FLAG_COLLISION_ENABLED)) return false
    if (f & C.FLAG_PAUSED) return false
    return true
  })
  if (active.length < 2) return

  // ① 先收集所有"这一帧判定为碰撞"的对（当前帧重叠 或 扫掠）
  const pairs = []
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const A = active[i], B = active[j]
      const key = pairKey(A.w.id, B.w.id)
      let hit = C.checkCollisionCircles(A.circles, B.circles, A.w.id, B.w.id)
      let swept = false
      let nx, ny, overlap
      if (hit[0]) {
        nx = hit[1]; ny = hit[2]; overlap = hit[3]
      } else {
        const sw = C.sweptCircleChainCollision(A.prev, A.circles, B.prev, B.circles)
        if (!sw[0]) { overlapTicks.delete(key); continue }
        nx = sw[1]; ny = sw[2]; overlap = sw[3]
        swept = true
      }
      const consecutive = (overlapTicks.get(key) || 0) + 1
      overlapTicks.set(key, consecutive)
      pairs.push({ A, B, key, nx, ny, overlap, swept, consecutive })
    }
  }
  if (!pairs.length) {
    // 没有碰撞也要把圆链记下来（下一 tick 的扫掠要用）
    for (const it of items) prevCircles.set(it.w, it.circles)
    return
  }

  // ② 冲量：每个成员把参与的所有对的冲量**向量合并**（参考实现同样做法）
  // ⚠️ **只处理"拖拽挤压"对**（一只被拖着、另一只没被拖）：拖拽的位移在渲染端
  //    由指针决定，物理步进管不到，只有这条异步通道能推别人。
  //    其余组合（抛掷 vs 一切）的碰撞响应已**下沉到渲染端物理步进内部**
  //    （见 renderer/drag-physics.js 的 tick —— 50ms 旧数据 + 异步冲量会有
  //    抽搐/乱飞/瞬移，步进内响应才是真实物理）。
  for (const pr of pairs) {
    const dragPair = pr.A.r.dragging !== pr.B.r.dragging
    if (!dragPair) continue
    const imp = C.solveCollisionImpulse(pr.A.m, pr.B.m, pr.nx, pr.ny)
    const aa = accOf(pr.A.w), ab = accOf(pr.B.w)
    aa.hit = true; ab.hit = true
    aa.dvx += imp[1]; aa.dvy += imp[2]
    ab.dvx += imp[3]; ab.dvy += imp[4]
  }

  // ③ 位置分离 —— 同样**只处理"拖拽挤压"对**（理由同 ②）。其余组合由渲染端
  //    物理步进内的分离负责（无延迟、无旧数据）。
  const posDelta = new Map()   // win -> [dx, dy]（本 tick 累积的分离位移）
  const deltaOf = (w) => {
    let d = posDelta.get(w)
    if (!d) { d = [0, 0]; posDelta.set(w, d) }
    return d
  }
  const invOf = (m) => C.isInfiniteMass(m) ? 0 : (m.mass > 0 ? 1 / m.mass : 0)

  for (const pr of pairs) {
    if (pr.A.r.dragging === pr.B.r.dragging) continue   // 非拖拽挤压对 → 渲染端负责
    if (!pr.swept) continue
    const sep = C.calculatePositionSeparation(pr.overlap, pr.nx, pr.ny,
      invOf(pr.A.m), invOf(pr.B.m), false)
    const da = deltaOf(pr.A.w), db = deltaOf(pr.B.w)
    da[0] += sep[1]; da[1] += sep[2]
    db[0] += sep[3]; db[1] += sep[4]
  }

  const SEP_ITER = 4
  for (let round = 0; round < SEP_ITER; round++) {
    // 用"成员原位置 + 本轮已累积位移"重算每一对的重叠
    const live = []
    for (const pr of pairs) {
      if (pr.swept) continue
      const da = posDelta.get(pr.A.w) || [0, 0]
      const db = posDelta.get(pr.B.w) || [0, 0]
      const ca = pr.A.circles.map((c) => [c[0] + da[0], c[1] + da[1], c[2]])
      const cb = pr.B.circles.map((c) => [c[0] + db[0], c[1] + db[1], c[2]])
      const hit = C.checkCollisionCircles(ca, cb, pr.A.w.id, pr.B.w.id)
      if (hit[0] && hit[3] > 0.5) {
        live.push({ pr, ov: hit[3], nx: hit[1], ny: hit[2] })
      }
    }
    if (!live.length) break
    // 重叠最深的先推（平局按 pair key 稳定排序，避免每帧顺序乱跳）
    live.sort((x, y) => (y.ov - x.ov) || (x.pr.key < y.pr.key ? -1 : x.pr.key > y.pr.key ? 1 : 0))
    for (const it of live) {
      const pr = it.pr
      const forceFull = pr.consecutive >= C.FORCE_FULL_TICKS
      const sep = C.calculatePositionSeparation(it.ov, it.nx, it.ny,
        invOf(pr.A.m), invOf(pr.B.m), forceFull)
      const da = deltaOf(pr.A.w), db = deltaOf(pr.B.w)
      da[0] += sep[1]; da[1] += sep[2]
      db[0] += sep[3]; db[1] += sep[4]
    }
  }

  // 把分离位移并进累积量
  for (const [w, d] of posDelta) {
    const a = accOf(w)
    a.hit = true
    a.dx += d[0]; a.dy += d[1]
  }

  // ④ "刚碰上"的反馈（动画 + 音效）—— 只在重叠 tick 数刚变成 1 时发
  for (const pr of pairs) {
    if (pr.consecutive !== 1) continue
    try { pr.A.w.webContents.send('pet:collide', { other: pr.B.r, self: pr.A.r, bias: -1 }) } catch (err) {}
    try { pr.B.w.webContents.send('pet:collide', { other: pr.A.r, self: pr.B.r, bias: 1 }) } catch (err) {}
  }

  // 下发增量
  for (const [w, a] of acc) {
    if (!a.hit) continue
    const hasDv = Math.abs(a.dvx) > 0.01 || Math.abs(a.dvy) > 0.01
    const hasDx = Math.abs(a.dx) > 0.01 || Math.abs(a.dy) > 0.01
    if (!hasDv && !hasDx) continue
    try {
      w.webContents.send('pet:impulse', {
        dvx: a.dvx, dvy: a.dvy, dx: a.dx, dy: a.dy,
      })
    } catch (err) {}
  }

  // 记下这一帧的圆链，下一 tick 做扫掠用
  for (const it of items) prevCircles.set(it.w, it.circles)
}, WORLD_MS)

// 渲染端物理步进的二体冲量转发：A 撞到 B 时，A 把属于 B 的那份冲量/位移
// 经这里转给 B 的窗口（事件驱动，无轮询延迟）。
ipcMain.on('pet:peer-impulse', (e, p) => {
  if (!p || typeof p.to !== 'number') return
  const w = BrowserWindow.fromId(p.to)
  if (!w || w.isDestroyed()) return
  try { w.webContents.send('pet:impulse', { dvx: p.dvx, dvy: p.dvy, dx: p.dx, dy: p.dy }) } catch (err) {}
})

// —— 只数变化广播 ——
// 渲染端只有一只时**完全跳过**碰撞相关的开销（50ms 位置上报 + 60ms 接触检测）——
// 那些在单只时纯属浪费（碰撞世界本来就要 2 只以上才工作）。
// 只数由主进程推，前端不用自己轮询。
function broadcastPetCount() {
  for (const w of pets) {
    if (w.isDestroyed()) continue
    try { w.webContents.send('pet:count-changed', pets.length) } catch (err) {}
  }
}

// —— 新桌宠落座：挑一个**不和任何已有桌宠重叠**的位置 ——
// 用户要求："桌宠出现的位置也不能重合，必须在已有桌宠位置的范围外出现，
//          可以在已有桌宠位置的范围外、桌面范围内的随机范围出现。"
function artSizeGuess() {
  for (const p of pets) {
    const r = petRects.get(p)
    if (r && r.w > 0 && r.h > 0) return { w: r.w, h: r.h }
  }
  return { w: 245, h: 196 }   // 还没人报过尺寸时的兜底
}
function pickSpawnSpot(w, h) {
  const b = displayBounds()
  const GAP = 16                      // 两只之间留的缝
  const used = []
  for (const p of pets) {
    const r = petRects.get(p)
    if (r && r.w > 0 && r.h > 0) used.push(r)
  }
  const maxX = Math.max(0, b.width - w)
  const maxY = Math.max(0, b.height - h)
  const free = (x, y) => {
    const r = { x, y, w, h }
    for (const u of used) {
      if (r.x < u.x + u.w + GAP && u.x < r.x + r.w + GAP &&
          r.y < u.y + u.h + GAP && u.y < r.y + r.h + GAP) return false
    }
    return true
  }
  // 先随机试（用户要的就是"桌面范围内的随机范围"）
  for (let i = 0; i < 400; i++) {
    const x = b.x + Math.random() * maxX
    const y = b.y + Math.random() * maxY
    if (free(x, y)) return { x, y, w, h }
  }
  // 随机试不出来（桌面快满了）→ 网格扫一遍，找第一个放得下的
  const step = Math.max(24, Math.min(w, h) / 3)
  for (let y = b.y; y <= b.y + maxY; y += step) {
    for (let x = b.x; x <= b.x + maxX; x += step) {
      if (free(x, y)) return { x, y, w, h }
    }
  }
  return null                         // 真没地方了
}
// 落座要在页面就绪之后 —— 渲染进程的物理模块那时才在。
// ⚠️ 外壳那个 4 秒定时器之后物理才 start()（setCenter 要那时才动得了），
//    所以这里得**一直重发到 4 秒之后**，不能只发开头几次 —— 只发开头的话
//    渲染进程的监听还没注册（或物理还没起来），一条都落不上，
//    新桌宠就停在默认位置和已有那只完全重合。
// 重复发是幂等的：渲染进程只认开头那十几秒的指令，之后就不理了。
function sendSpawnSpot(w) {
  const at = w.__spawnAt
  if (!at) return
  let tries = 0
  const t = setInterval(() => {
    tries++
    if (w.isDestroyed()) { clearInterval(t); return }
    try {
      w.webContents.send('pet:set-pos', { cx: at.x + at.w / 2, cy: at.y + at.h / 2 })
    } catch (err) {}
    if (tries >= 24) clearInterval(t)      // 24 × 500ms = 12 秒
  }, 500)
}

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------
function trayIcon() {
  try {
    const img = nativeImage.createFromPath(path.join(ROOT, 'assets', 'icon.ico'))
    if (!img.isEmpty()) return img
  } catch (err) {}
  return nativeImage.createEmpty()
}

function buildTray() {
  try {
    tray = new Tray(trayIcon())
    // ⚠️⚠️ **原生托盘菜单点任何一项都会自动关闭** —— 这是 Electron/系统的行为，
    //    没有开关可以关掉它。用户要求"点按钮不要直接退出菜单"（想连着点几项，
    //    比如先开关全屏让路、再开关拖动物理）。
    //    折中方案：把菜单存下来，**非退出项**点完后**立刻重新弹出**。
    //    代价是极短的重绘闪烁；真正无闪烁要自绘一个菜单窗口，那是另一个专项。
    //    「退出」不加这个包装 —— 点了就该退，不能又弹回来。
    let trayMenu = null
    // ⚠️⚠️ **不要用 popUpContextMenu 重新弹出。**
    //    上一版为了让"点一项后菜单还开着"这么做过，但实测：重新弹出会让菜单
    //    **跳到鼠标当前位置重开**（用户反馈"会乱动，要保持托盘原菜单位置不动"）。
    //    原生托盘菜单**无法同时做到"保持打开"和"保持原位"** —— 这是系统菜单，
    //    没有位置参数。要那个效果只能自绘一个菜单窗口（另一个专项）。
    //    所以这里只保留"统一包一层错误捕获"，不再重新弹出。
    const keepOpen = (fn) => (...a) => {
      try { fn(...a) } catch (err) { log('托盘菜单项出错', err && err.message) }
    }
    const menu = Menu.buildFromTemplate([
      { label: '显示 / 隐藏', click: keepOpen(() => { if (!win) return; win.isVisible() ? win.hide() : win.showInactive() }) },
      { type: 'separator' },
      { label: '设置 DeepSeek API Key…', click: keepOpen(openSettings) },
      { label: '回到右下角', click: keepOpen(() => win && win.webContents.send('pet:reset-pos')) },
      { label: '重新加载挂件', click: keepOpen(() => win && win.webContents.reload()) },
      {
        label: '强制鼠标穿透（她点不动时先关掉）',
        type: 'checkbox',
        checked: false,
        click: keepOpen((item) => win && win.webContents.send('pet:force-passthrough', !!item.checked)),
      },
      // ⚠️ 「桌宠可点模式」开关已删除（2026-09-29）。
      //    它是排查"全屏视频进出后点不了"时加的临时诊断项，问题已解决
      //    （根因是让路走了 hide/show，改成 setOpacity(0) 后不再复现；
      //      实测无论开关与否都能点，说明与 setFocusable 无关）。
      //    petFocusable 变量保留（默认 false = 不可激活，避免点桌宠抢焦点
      //    把视频弄暂停），只是不再暴露成开关。
      {
        // 与挂件 ☰ 菜单里的「拖动物理」是同一个值（都在 localStorage 里）
        label: '拖动物理（弹簧跟随 + 松手抛出）',
        type: 'checkbox',
        checked: true,
        click: keepOpen((item) => win && win.webContents.send('pet:drag-physics', !!item.checked)),
      },
      {
        label: '全屏视频时自动让路（隐藏桌宠，不挡视频）',
        type: 'checkbox',
        checked: fsYieldEnabled,
        click: keepOpen((item) => {
          fsYieldEnabled = !!item.checked
          saveFsYieldPref()
          if (fsYieldEnabled && !fsWatch && fsWatchModRef) {
            fsWatch = fsWatchModRef.createFullscreenWatch({
              log,
              ownPid: process.pid,
              onFullscreen: (hidden) => setPetsYieldForFullscreen(hidden),
            })
          }
          if (fsWatch) fsWatch.setEnabled(fsYieldEnabled)
          if (!fsYieldEnabled) setPetsYieldForFullscreen(false)   // 关掉时把藏着的放回来
          log('全屏让路开关 → ' + fsYieldEnabled)
        }),
      },
      { type: 'separator' },
      { label: '打开数据目录', click: keepOpen(() => shell.openPath(DATA_DIR)) },
      { label: '打开日志', click: keepOpen(() => shell.openPath(LOG_FILE)) },
      { label: '开发者工具', click: keepOpen(() => win && win.webContents.openDevTools({ mode: 'detach' })) },
      { type: 'separator' },
      // ⚠️ 唯一**不**重新弹出的项：点了就是要退出
      { label: '退出', click: () => { quitting = true; app.quit() } },
    ])
    trayMenu = menu
    tray.setToolTip('大肥鱼桌宠')
    tray.setContextMenu(menu)
    tray.on('double-click', () => { if (win) win.isVisible() ? win.hide() : win.showInactive() })
  } catch (err) {
    log('托盘创建失败', err && err.message)
  }
}

// ---------------------------------------------------------------------------
// 设置窗口（只用于填 API Key）
// ---------------------------------------------------------------------------
let settingsWin = null
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return }
  settingsWin = new BrowserWindow({
    width: 470, height: 320,
    resizable: false, minimizable: false, maximizable: false,
    title: '大肥鱼桌宠 · 设置',
    icon: path.join(ROOT, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(ROOT, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  settingsWin.setMenuBarVisibility(false)
  settingsWin.loadFile(path.join(ROOT, 'renderer', 'settings.html'))
  settingsWin.on('closed', () => { settingsWin = null })
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('pet:port', () => (server ? server.port : 0))
ipcMain.handle('pet:data-dir', () => DATA_DIR)
ipcMain.on('pet:set-interactive', (e, on) => setInteractive(on, BrowserWindow.fromWebContents(e.sender)))
ipcMain.on('pet:reset-pos', () => win && win.webContents.send('pet:reset-pos'))
// ⚠️ 重载页面**必须走主进程**。
//    渲染进程里的 location.reload() 在这个应用里不工作：它发起一次永远不提交的导航，
//    页面卡在"正在导航"状态 —— 图还在，但脚本全停（用户看到的就是"只剩一张贴图，
//    怎么点都没反应"）。实测对照：location.reload() 无效、webContents.reload() 有效。
ipcMain.on('pet:reload', () => { try { if (win) win.webContents.reload() } catch (err) {} })
// 用系统默认浏览器打开外部链接（菜单里的「打开 dsh 网页端」）。
// ⚠️ 只允许本机 http —— 渲染进程不该有能力把用户送到任意外部站点去。
ipcMain.on('pet:open-external', (e, url) => {
  var s = String(url || '')
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(s)) {
    log('拒绝打开非本机链接：' + s.slice(0, 80))
    return
  }
  try { shell.openExternal(s) } catch (err) { log('打开链接失败', err && err.message) }
})

// ---------------------------------------------------------------------------
// 「打开 dsh 网页端」：**端口不能写死**
// ---------------------------------------------------------------------------
// dsh web 启动时会把访问地址打印出来，**不同机器端口不同**
// （官方文档原话："命令会打印其访问地址"；社区教程也说"不同电脑网址不同"）。
// 3080 只是常见默认值 —— 实测这台机器上 3080 根本没在监听。
//
// 所以做法是：**先探常见端口，再枚举本机监听端口逐个探**，
// 打开第一个真的有响应的。探不到就明确告诉用户（而不是打开一个必然连不上的地址）。
// 探测一个本机端口：不只是"通不通"，还要尽量判断**它是不是 dsh web**。
//   · ok    —— 有 http 响应
//   · dsh   —— 像 dsh web（页面里有 dsh/harness 字样，或挂载了 /dsh-* 插件路由）
// 只按"通不通"挑端口会挑错：本机一堆服务在监听（实测这台机器有 1042 之类），
// 挑错了就是"点一下打开一个不相干的页面"。
function probeLocalPort(port, timeoutMs, deep) {
  return new Promise(function (resolve) {
    var done = false
    var finish = function (v) { if (!done) { done = true; resolve(v) } }
    var req = http.get({ host: '127.0.0.1', port: port, path: '/', timeout: timeoutMs },
      function (res) {
        if (!deep) { res.resume(); finish({ ok: res.statusCode > 0, dsh: false }); return }
        var chunks = ''
        res.setEncoding('utf8')
        res.on('data', function (c) { if (chunks.length < 20000) chunks += c })
        res.on('end', function () {
          var t = chunks.toLowerCase()
          var looksDsh = t.indexOf('harness') >= 0 || t.indexOf('deepseek') >= 0 ||
            t.indexOf('dsh-whale') >= 0 || t.indexOf('dsh-rice') >= 0 || /\bdsh\b/.test(t)
          finish({ ok: true, dsh: looksDsh, html: t.indexOf('<html') >= 0 })
        })
        res.on('error', function () { finish({ ok: true, dsh: false }) })
      })
    req.on('timeout', function () { try { req.destroy() } catch (err) {} ; finish({ ok: false, dsh: false }) })
    req.on('error', function () { finish({ ok: false, dsh: false }) })
  })
}

function listListeningPorts() {
  try {
    var out = require('child_process').execSync('netstat -ano -p tcp', {
      encoding: 'utf8', timeout: 3000, windowsHide: true,
    })
    var set = {}
    out.split('\n').forEach(function (line) {
      if (line.indexOf('LISTENING') < 0) return
      var m = /(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]|\[::1\]):(\d+)\s/.exec(line)
      if (m) set[m[1]] = true
    })
    return Object.keys(set).map(Number).filter(function (n) { return n > 0 })
  } catch (err) { return [] }
}

// 启动 dsh web：开一个**可见的 cmd 窗口**跑 `npx @deepseek-ai/dsh web`。
// ⚠️ 故意用可见窗口（/k 保持不关）而不是隐藏进程：
//    · 启动可能要几十秒（npx 首次要下载），用户需要看见"它在动"
//    · 万一失败（没装 node、命令名不对、网络不通），报错就在那个窗口里，
//      比我们猜一个"打不开"的原因有用得多
//    · /k 让它跑完/报错后窗口不自动关，用户能看结果
function startDshWeb() {
  try {
    var cp = require('node:child_process')
    var child = cp.spawn('cmd.exe', ['/c', 'start', 'dsh web', 'cmd.exe', '/k', 'npx @deepseek-ai/dsh web'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    child.unref()
    log('已启动 cmd 窗口执行：npx @deepseek-ai/dsh web')
    return true
  } catch (err) {
    log('启动 dsh web 失败：' + (err && err.message))
    return false
  }
}

// 找在跑的 dsh web。找不到返回 null。
//   ① 常见端口先试（快）
//   ② 没命中就枚举本机监听端口并发探测，然后**挑最像 dsh web 的**
// ⚠️ 不能"挑第一个通的端口" —— 本机一堆不相干的服务在监听（实测有 1042 之类），
//    挑错了就是"点一下打开一个不相干的页面"。
// ⚠️ 必须排除**我们自己**那个端口：它也是本机 http、页面里也全是 dsh-whale/dsh-rice
//    字样，会被误判成 dsh web —— 那就变成"打开自己的桌宠页面"，荒唐且没用。
async function findDshWeb() {
  var common = [3080, 3000, 8080, 8000, 5000, 5173, 4173, 1234, 7860, 9000]
  for (var i = 0; i < common.length; i++) {
    var rc = await probeLocalPort(common[i], 400, true)
    if (rc.ok) return { port: common[i], url: 'http://127.0.0.1:' + common[i], via: 'common', dsh: rc.dsh }
  }
  var ownPort = server ? server.port : 0
  var ports = listListeningPorts().filter(function (p) { return p !== ownPort })
  var infos = await Promise.all(ports.map(function (p) {
    return probeLocalPort(p, 400, true).then(function (r) { return { p: p, r: r } })
  }))
  var alive = infos.filter(function (x) { return x.r.ok })
  // ⚠️ 扫描时**只认"识别为 dsh"的**，不要退而求其次去挑"任意 html 页面"：
  //    本机随手一个 web 服务都是 html（实测扫到 27339 这种），
  //    挑错了就会"打开一个不相干的页面"，而且**不会去启动 dsh web** ——
  //    用户看到的现象还是"点了没反应/打开了个莫名其妙的东西"。
  //    宁可返回 null，让上层去把 dsh web 启动起来。
  var pick = alive.filter(function (x) { return x.r.dsh })[0]
  if (pick) {
    return {
      port: pick.p, url: 'http://127.0.0.1:' + pick.p, via: 'scan',
      dsh: pick.r.dsh, alive: alive.length,
    }
  }
  return null
}

ipcMain.handle('pet:open-dsh-web', async (e, opts) => {
  // dryRun = 只探测、不启动、不打开浏览器（给自检用，免得跑个测试还弹网页/开 cmd）
  var dryRun = !!(opts && opts.dryRun)
  var open = function (url) { if (!dryRun) { try { shell.openExternal(url) } catch (err) {} } }

  // ① 已经在跑 → 直接打开
  var found = await findDshWeb()
  if (found) {
    open(found.url)
    log('打开 dsh 网页端（' + (found.via === 'common' ? '常见端口命中' : '扫描命中') + '）：' + found.url)
    return { ok: true, port: found.port, url: found.url, via: found.via, dsh: found.dsh, dryRun: dryRun }
  }

  // ② 没在跑 → **自己把它启动起来**（用户要的就是"点一下就能打开"）
  log('没找到在跑的 dsh web，改为启动它：npx @deepseek-ai/dsh web')
  if (dryRun) return { ok: false, reason: 'not-running', dryRun: true }
  if (!startDshWeb()) return { ok: false, reason: 'spawn-failed' }

  // ③ 轮询等它起来。npx 首次可能要下载，给 90 秒。
  var deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    await new Promise(function (r) { setTimeout(r, 1500) })
    var again = await findDshWeb()
    if (again) {
      open(again.url)
      log('dsh web 已启动，打开 ' + again.url)
      return { ok: true, port: again.port, url: again.url, started: true }
    }
  }
  log('等了 90 秒仍没等到 dsh web 起来 —— 请看那个 cmd 窗口里的报错')
  return { ok: false, reason: 'timeout' }
})
// 「选择音乐…」→ 用资源管理器打开**桌宠文件夹**下的 `vendor/rice/songs`。
// ⚠️ 路径**由主进程拼**，不接受渲染进程传路径 —— 渲染进程不该有能力打开任意目录。
// ⚠️ 基准是"**exe 所在目录**"，不写死名字 —— 所以桌宠文件夹改成什么名字都对。
//    开发时（electron .）exe 是 electron 本体，路径不对，用 DSH_PET_DIR 覆盖。
// ⚠️ 这个目录必须是**真实文件系统路径**，不能是 asar 里的路径 ——
//    资源管理器打不开 asar。所以 electron-builder 用 extraFiles 在 exe 旁边放了一份真的
//    （见 package.json 的 build.extraFiles），rice 的 SONGS_DIR 也指向同一处。
function petDir() {
  return process.env.DSH_PET_DIR || (app.isPackaged ? path.dirname(process.execPath) : ROOT)
}
function songsDir() { return path.join(petDir(), 'vendor', 'rice', 'songs') }
ipcMain.on('pet:open-songs-folder', () => {
  try {
    var dir = songsDir()
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    shell.openPath(dir).then(function (err) {
      if (err) log('打开 songs 文件夹失败：' + err)
      else log('已打开 songs 文件夹：' + dir)
    })
  } catch (err) { log('打开 songs 文件夹异常：' + (err && err.message)) }
})

// 米粒面板「角色」那一行的「选择图片…」→ 打开系统的图片选择框。
// ⚠️ **默认落在用户的 Screenshots 文件夹**（用户明确要求"打开的就是它"）。
//    为什么不用网页的 <input type="file">：那套**不允许指定初始目录**，
//    而 Electron 的 dialog 可以给 defaultPath —— 只有它能满足这个要求。
// 读成 data URL 回传：渲染进程直接用就行，不必再操心 file:// 的跨域限制。
ipcMain.handle('pet:pick-image', async () => {
  try {
    var pics = ''
    try { pics = app.getPath('pictures') } catch (err) {}
    var dir = pics ? path.join(pics, 'Screenshots') : ''
    if (!dir || !fs.existsSync(dir)) dir = pics || undefined
    var r = await dialog.showOpenDialog(win || undefined, {
      title: '选一张小鲸鱼的贴图',
      defaultPath: dir,
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
    })
    if (!r || r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true }
    var file = r.filePaths[0]
    var buf = fs.readFileSync(file)
    var ext = path.extname(file).slice(1).toLowerCase()
    var mime = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : ('image/' + (ext || 'png'))
    log('已选角色图片：' + file)
    return {
      ok: true, name: path.basename(file), path: file,
      dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64'),
    }
  } catch (err) {
    log('选图片失败：' + (err && err.message))
    return { ok: false, error: String(err && err.message) }
  }
})

// 开机自启（可开关）—— 用 Electron 的登录项设置，写进系统的启动项。
// ⚠️ 开发模式（electron .）**不写**：那会把 electron 本体写进启动项，
//    开机弹一个开发者窗口 —— 那是灾难。只回报"当前不可用"。
ipcMain.handle('pet:autostart-get', () => {
  try {
    var s = app.getLoginItemSettings()
    return { ok: true, enabled: !!(s && s.openAtLogin) }
  } catch (err) { return { ok: false, enabled: false, error: String(err && err.message) } }
})
ipcMain.handle('pet:autostart-set', (e, on) => {
  try {
    if (!app.isPackaged) return { ok: false, enabled: false, error: 'dev' }
    app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath })
    var s = app.getLoginItemSettings()
    var enabled = !!(s && s.openAtLogin)
    log('开机自启已设为：' + enabled)
    return { ok: true, enabled: enabled }
  } catch (err) {
    log('设置开机自启失败：' + (err && err.message))
    return { ok: false, enabled: false, error: String(err && err.message) }
  }
})

ipcMain.on('pet:log', (e, msg) => log('[renderer]', msg))

// ---------------------------------------------------------------------------
// 「识别歌曲和作者」
// ---------------------------------------------------------------------------
// 把识别结果推给渲染进程。song 为 null = 当前没有在播的目标播放器（或功能被关掉）。
function pushNowPlaying(song) {
  if (!win || win.isDestroyed()) return
  try { win.webContents.send('pet:now-playing', song || null) } catch (err) {}
}

ipcMain.handle('pet:now-playing-set', (e, on) => {
  if (!nowPlaying) return { ok: false, enabled: false, error: 'no-module' }
  try {
    const enabled = nowPlaying.setEnabled(!!on)
    // 打开时立刻回一次当前状态，免得要等下一个 1.5 秒轮询
    if (enabled) pushNowPlaying(null)
    return { ok: true, enabled }
  } catch (err) {
    log('切换识别歌曲失败：' + (err && err.message))
    return { ok: false, enabled: false, error: String(err && err.message) }
  }
})
ipcMain.handle('pet:now-playing-get', () => {
  if (!nowPlaying) return { ok: false, enabled: false }
  try { return { ok: true, enabled: nowPlaying.isEnabled() } } catch (err) { return { ok: false, enabled: false } }
})

// 歌词开关：依赖"识别歌曲"已经开着（歌词是它的下一级）
ipcMain.handle('pet:now-playing-lyrics-set', (e, on) => {
  if (!nowPlaying) return { ok: false, enabled: false, error: 'no-module' }
  try {
    const enabled = nowPlaying.setLyricsEnabled(!!on)
    return { ok: true, enabled }
  } catch (err) {
    log('切换识别歌词失败：' + (err && err.message))
    return { ok: false, enabled: false, error: String(err && err.message) }
  }
})
ipcMain.handle('pet:now-playing-lyrics-get', () => {
  if (!nowPlaying) return { ok: false, enabled: false }
  try { return { ok: true, enabled: nowPlaying.isLyricsEnabled() } } catch (err) { return { ok: false, enabled: false } }
})

ipcMain.handle('pet:cred-status', async () => credentials.status('DEEPSEEK_API_KEY'))
ipcMain.handle('pet:cred-set', async (e, value) => {
  const ok = await credentials.set('DEEPSEEK_API_KEY', value)
  // 立刻让宿主重新拉一次余额，用户不用等 60 秒
  if (ok && win) win.webContents.reload()
  return ok
})
ipcMain.on('pet:close-settings', () => { if (settingsWin) settingsWin.close() })
ipcMain.on('pet:quit', () => { quitting = true; app.quit() })

// ---------------------------------------------------------------------------
// 自检模式：PET_SELFTEST=1
// ---------------------------------------------------------------------------
// 不显示窗口（win 以 show:false 创建且不调用 show），把整条链路跑一遍后
// 把结论打到 stdout 并退出 —— 这样"端到端能不能起来"是可自动验证的，
// 而不是只能靠人肉盯着桌面看。
async function runSelfTest() {
  const results = []
  const lines = []
  // ⚠️ Windows 上 Electron 是 GUI 子系统程序，console.log **不会回到父进程的终端**。
  //    所以自检结果同时写文件，靠读文件拿结论。
  const REPORT = path.join(DATA_DIR, 'selftest.txt')
  const say = (ok, label, extra) => {
    results.push({ ok, label })
    const line = `${ok ? '✓' : '✗'} ${label}${extra !== undefined ? '  → ' + extra : ''}`
    lines.push(line)
    console.log(line)
    log('自检 ' + line)   // 同时进 pet.log —— 打包版 stdout 拿不到，日志是唯一线索
    flush()               // 每条都即时落盘：中途挂掉也能看到走到哪一步
  }
  const flush = () => {
    try { fs.writeFileSync(REPORT, lines.join('\n') + '\n', 'utf8') } catch (err) {}
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  log('自检开始，报告将写到 ' + REPORT)

  try {
    await new Promise((resolve) => {
      if (!win.webContents.isLoading()) return resolve()
      win.webContents.once('did-finish-load', resolve)
      setTimeout(resolve, 15000)
    })
    log('自检：页面已加载，等待挂件初始化…')
    // 给挂件初始化留时间（它要等 DOM、拉配置、建节点）
    await sleep(7000)
    log('自检：等待结束，开始探针')

    // —— 聚焦模式：只跑一条探针就收工 ——
    if (FOCUS) {
      const probe = await runFocusProbe()
      lines.push('')
      lines.push('--- 聚焦探针 ' + FOCUS + ' ---')
      lines.push(JSON.stringify(probe, null, 2))
      lines.push('---')
      lines.push('')
      for (const c of (probe && probe.checks) || []) {
        say(c.ok, c.label, c.extra)
      }
      if (!probe || !probe.checks || !probe.checks.length) say(false, '聚焦探针没有产出任何结论（' + FOCUS + '）', JSON.stringify(probe))
      throw { __done: true }
    }

    const probe = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const q = (s) => document.querySelector(s)
      const desc = (e) => e ? (e.tagName + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).join('.') : '')) : 'null'
      const img = q('img.dshwv-img')
      const root = q('.dshwv-root')
      const ir = img ? img.getBoundingClientRect() : null
      const rr = root ? root.getBoundingClientRect() : null
      const at = (x, y) => {
        let el = null
        try { el = document.elementFromPoint(Math.round(x), Math.round(y)) } catch (e) {}
        let pe = '?'
        try { pe = el ? getComputedStyle(el).pointerEvents : '?' } catch (e) {}
        return desc(el) + '  [pointer-events=' + pe + ']'
      }
      const out = {
        whaleScriptLoaded: !!window.__dshWhaleWidget,
        whaleInit: !!window.__dshWhaleInit,
        riceLoaded: !!window.__dshRiceLoaded,
        root: !!q('.dshwv-root'),
        body: !!q('.dshwv-body'),
        img: !!img,
        imgSrc: img ? img.getAttribute('src') : null,
        bodyChildren: document.body.children.length,
        riceNodes: document.querySelectorAll('[class*="dshrice"]').length,
        title: document.title,
        imgRect: ir ? { x: Math.round(ir.left), y: Math.round(ir.top), w: Math.round(ir.width), h: Math.round(ir.height) } : null,
        rootRect: rr ? { x: Math.round(rr.left), y: Math.round(rr.top), w: Math.round(rr.width), h: Math.round(rr.height) } : null,
        atImgCenter: ir ? at(ir.left + ir.width / 2, ir.top + ir.height / 2) : 'no-img',
      }

      // —— 鼠标穿透判定的关键指标 ——
      // 立绘中心 elementFromPoint 返回 BODY 是**正常的**（挂件刻意 pointer-events:none），
      // 所以真正要验的是复刻出来的命中图能不能认出她。
      if (ir && typeof window.__petWhaleHit === 'function') {
        window.__petWhaleHit(ir.left + ir.width / 2, ir.top + ir.height / 2)  // 触发命中图构建
        await sleep(900)
        out.hitInfo = window.__petHitInfo ? window.__petHitInfo() : null
        let hit = 0, total = 0
        for (let gy = 0; gy < 20; gy++) {
          for (let gx = 0; gx < 20; gx++) {
            total++
            if (window.__petWhaleHit(ir.left + ir.width * (gx + 0.5) / 20, ir.top + ir.height * (gy + 0.5) / 20)) hit++
          }
        }
        out.hitRatioPct = Math.round(hit / total * 100)
        out.hitCount = hit
        out.hitTotal = total
        // 立绘矩形的正中心必须算"命中"（那是她的身体）
        out.hitAtImgCenter = window.__petWhaleHit(ir.left + ir.width / 2, ir.top + ir.height / 2)
        // 根节点左上角是空的（她在右下），必须**不**算命中
        if (rr) out.hitAtRootTopLeft = window.__petWhaleHit(rr.left + 3, rr.top + 3)
      }

      // 启动位置：探针一上来就记（后面的测试会把她挪走）。
    // 期望 = 桌面右下角（立绘的右下角贴住屏幕右下角）。
    try {
      out.startState = window.__dshpetPhysics ? window.__dshpetPhysics._state() : null
      out.startBounds = window.__dshpetPhysics ? window.__dshpetPhysics._bounds() : null
      out.storedPos = localStorage.getItem('dshw-pos')
    } catch (e) {}

    // 把「拖动物理」强制成"开"，让后面那些物理断言不受上次运行残留的开关值影响。
    // （跑完在断言区末尾还原成用户原来的值。）
    out.origPhysicsFlag = null
    try {
      out.origPhysicsFlag = localStorage.getItem('dshpet-drag-physics')
      if (window.__dshpetPhysics && !window.__dshpetPhysics.isEnabled()) {
        window.__dshpetPhysics.setEnabled(true)
        await sleep(300)
      }
    } catch (e) {}

    // —— 「抓现行」打翻饭碗：落点必须在她头上 ——
      // 这段没法靠肉眼在自检里看，所以**真跑一遍动画再量最终落点**。
      // 量的是碗心相对鲸鱼容器(.dshwv-body)的百分比，和配置同一个口径。
      const bowl = q('.dshrice-bowl')
      const wb = q('.dshwv-body')
      out.bowlExists = !!bowl
      if (bowl && wb) {
        // @keyframes dshrice-spill 的最终帧是否**真的代入了配置的落点**
        // （不是 var() —— 用 var() 的关键帧在 Chromium 里会被整条丢掉，这里必须看到实际数字）
        try {
          for (const sheet of document.styleSheets) {
            let rules = null
            try { rules = sheet.cssRules } catch (e) { continue }
            for (const rule of rules) {
              if (rule.type === CSSRule.KEYFRAMES_RULE && rule.name === 'dshrice-spill') {
                out.spillKeyframeUsesVar = /var\\(--dshrice-spill-lx/.test(rule.cssText)
                out.spillKeyframeFrames = rule.cssRules.length
                out.spillKeyframeCss = rule.cssText.slice(0, 700)
                // 上游 0.3.7 起，dshrice-spill 恢复成"倒扣在旁边地面"那一套；
                // "扣在头顶"改由另一个类 dshrice-head 负责（关键帧按角色落点算出来）。
              }
            }
          }
        } catch (e) {}

        // 真跑一遍：加上类 → 把动画时间轴**手动拨到指定帧** → 量碗心
        //
        // ⚠️ 为什么不能"等 950ms 再读 transform"：
        //    自检窗口是 show:false（从不显示），**Chromium 会把不可见页面的动画时钟冻住**，
        //    读到的永远是 0% 那一帧。而 0% 恰好是 translate(-50%,0) rotate(0) ——
        //    和 dshrice-up 的基础值一模一样，于是非常容易被误判成"动画没生效"。
        //    （这个坑当场踩了，白查一轮。）
        //    正解：用 Web Animations API 拿到 CSSAnimation，pause() 之后直接设 currentTime，
        //    想看第几帧就看第几帧，和窗口可不可见无关。
        bowl.classList.add('dshrice-up')
        bowl.classList.add('dshrice-spill')
        await sleep(80)

        out.docVisibility = document.visibilityState
        const anims = bowl.getAnimations ? bowl.getAnimations() : []
        const anim = anims.filter(function (a) { return a.animationName === 'dshrice-spill' })[0]
        out.spillAnimFound = !!anim
        out.spillAnimCount = anims.length
        out.spillAnimDuration = anim ? anim.effect.getTiming().duration : null

        if (anim) {
          anim.pause()
          const tf = function () { return getComputedStyle(bowl).transform }
          anim.currentTime = 0
          await sleep(40)
          out.transformAt0 = tf()
          anim.currentTime = 360
          await sleep(40)
          out.transformAtMid = tf()
          anim.currentTime = 720
          await sleep(40)
          out.transformAtEnd = tf()
          const br = wb.getBoundingClientRect()
          const rr2 = bowl.getBoundingClientRect()
          if (br.width > 0 && rr2.width > 0) {
            out.spillLandX = Math.round((rr2.left + rr2.width / 2 - br.left) / br.width * 1000) / 10
            out.spillLandY = Math.round((rr2.top + rr2.height / 2 - br.top) / br.height * 1000) / 10
          }
          out.bowlPxAtEnd = { w: Math.round(rr2.width), h: Math.round(rr2.height) }
          anim.play()
        }
        // 量完还原，别影响后续
        bowl.classList.remove('dshrice-up')
        bowl.classList.remove('dshrice-spill')
        await sleep(120)

        // ⚠️ 她可能在屏幕左半边，此时挂件会给根节点加 dshwv-left（scaleX(-1) 整体镜像），
        //    碗相对她身体的位置就镜像了（75% → 25%）。测量值要按朝向归一化，
        //    否则这条断言会随"她当时站在哪一边"时通时不通。
        const rootEl = q('.dshwv-root')
        out.spillFlipped = !!(rootEl && rootEl.classList.contains('dshwv-left'))
        if (out.spillFlipped && typeof out.spillLandX === 'number') {
          out.spillLandXRaw = out.spillLandX
          out.spillLandX = Math.round((100 - out.spillLandX) * 10) / 10
        }
      }

      // —— 拖动物理（移植自 dsh-pet pet/physics.py）——
      const ph = window.__dshpetPhysics
      out.physLoaded = !!ph
      if (ph) {
        out.physEnabled = ph.isEnabled()
        out.physConstants = ph._constants
        out.physState = ph._state()
        out.physMenuRow = !!document.querySelector('.dshpet-phys-row')
        out.physMenuInWhaleMenu = !!document.querySelector('.dshwv-menu .dshpet-phys-row')
        out.physMenuLabel = (document.querySelector('.dshpet-phys-row') || {}).textContent || null
        out.physOverride = document.querySelector('.dshwv-root').classList.contains('dshpet-phys')
        // ⚠️ 位置写入方式：必须是**行内 + !important 的 left/top**，不能是 CSS 自定义属性。
        //    自定义属性会继承 → 改根节点一个变量就让整棵子树样式失效重算 → 拖动卡顿。
        try {
          const ov = document.querySelector('.dshwv-root')
          out.physLeftPriority = ov.style.getPropertyPriority('left')
          out.physLeftValue = ov.style.getPropertyValue('left')
          out.physInlineImportant = ov.style.getPropertyPriority('left') === 'important'
          out.physCustomProp = ov.style.getPropertyValue('--dshpet-px')
          out.physNoCustomProp = !ov.style.getPropertyValue('--dshpet-px')
        } catch (e) {}
        // ⚠️ 关键回归：.dshwv-root 自带 transition:left .16s,top .16s（挂件用来平滑吸边）。
        //    物理接管时若不掐掉它，每 16ms 写一次位置会被浏览器补间成 160ms —— 她会"乱飞"。
        out.physTransition = (() => {
          var r = document.querySelector('.dshwv-root')
          if (!r) return null
          var cs = getComputedStyle(r)
          return { prop: cs.transitionProperty, dur: cs.transitionDuration }
        })()
        // 纯函数校验：把 physics.py 的常量代进去，结果应当是确定的几个数
        const P = ph._phys
        const r3 = (v) => Math.round(v * 1000) / 1000
        out.fn = {
          clampZero: r3(P.softClampSpeed(0, 3600)),
          clampHuge: r3(P.softClampSpeed(1e9, 3600)),
          clampAtCap: r3(P.softClampSpeed(3600, 3600)),          // 3600*(1-e^-1) ≈ 2275.6
          springOneStep: r3(P.springVelocity(0, 0, 100, 0.016, 200, 30)),  // 100*200*0.016 = 320
          throwOneStep: P.throwStep(100, 100, 0, 0, 0.016, 0, 0, 1000, 1000, 1400).map(r3),
          restOnGround: P.isAtRest(1000, 0, 0, 1000, true, 0),
          restInAir: P.isAtRest(100, 0, 0, 1000, false, 0),
          // —— 甩出力度档位（移植自 physics.py 的 THROW_STRENGTH_CAPS）——
          caps: {
            gentle: P.throwSpeedCap('gentle'), standard: P.throwSpeedCap('standard'),
            strong: P.throwSpeedCap('strong'), crazy: P.throwSpeedCap('crazy'),
            unknown: P.throwSpeedCap('乱写的'), empty: P.throwSpeedCap(''),
            upper: P.throwSpeedCap('STRONG'),
          },
          // —— 弹弓（移植自 physics.py）——
          sling: {
            belowMin: P.slingshotSpeed(10, 24, 160, 4800),
            atMin: r3(P.slingshotSpeed(24, 24, 160, 4800)),
            mid: r3(P.slingshotSpeed(92, 24, 160, 4800)),
            atMax: r3(P.slingshotSpeed(160, 24, 160, 4800)),
            beyond: r3(P.slingshotSpeed(999, 24, 160, 4800)),
            // 形变：没拉 = 不变形；沿 x 拉 → x 拉伸、y 压缩
            deformNone: P.slingshotDeformation(0, 0, 0.5),
            deformX: P.slingshotDeformation(100, 0, 1).map(r3),
            deformY: P.slingshotDeformation(0, 100, 1).map(r3),
            // 方向无关性：同一进度、不同角度，形变"大小"应当连续（不跳变）
            deform45: P.slingshotDeformation(70.7, 70.7, 1).map(r3),
            traj: P.slingshotTrajectory(100, -100, 0.8, 5, 1400).map(function (q) { return [r3(q[0]), r3(q[1])] }),
          },
          // —— 飞行倍率（移植自 physics.py 的 flight_anim_speed）——
          flight: {
            still: r3(P.flightAnimSpeed(0)),
            half: r3(P.flightAnimSpeed(700)),
            full: r3(P.flightAnimSpeed(1400)),
            over: r3(P.flightAnimSpeed(9999)),
          },
          substepMaxPx: P._substepMaxPx,
          dragFlushMs: P._dragFlushMs,
          petCount: (window.__dshpetCollide && window.__dshpetCollide._petCount)
            ? window.__dshpetCollide._petCount() : null,
          dragState: P._dragState ? P._dragState() : null,
          dragState: P._dragState ? P._dragState() : null,
          // —— 黄金回旋 / 拖文件吃掉 / transform 合成器 ——
          spin: (function () {
            const G = window.__dshpetGoldenSpin
            if (!G) return { loaded: false }
            const r = { loaded: true, consts: G._consts }
            r.constsOk = (G._consts.DURATION_MS === 700 && G._consts.ACCEL === 0.82 &&
              G._consts.MIN_REV_MS === 200 && G._consts.CLICK_RUSH_MS === 130 &&
              G._consts.END_ANGLE === -360)
            r.idleBefore = G.isActive()
            G.start()
            r.activeAfterStart = G.isActive()
            G.cancel()
            r.idleAfterCancel = G.isActive()
            r.angleAfterCancel = G.angle()
            r.menuRow = !!document.querySelector('.dshwv-menu .dshpet-spin-row')
            r.toggles = document.querySelectorAll('.dshwv-menu .dshpet-spin-row input[type=checkbox]').length
            return r
          })(),
          eater: (function () {
            const E = window.__dshpetFileEater
            if (!E) return { loaded: false }
            return {
              loaded: true,
              menuRow: !!document.querySelector('.dshwv-menu .dshpet-eat-row'),
              human: [E._human(0), E._human(2048), E._human(5 * 1048576)],
            }
          })(),
          xform: (function () {
            const X = window.__dshpetSpriteXform
            if (!X) return { loaded: false }
            X.set('spin', X.rotate(-90))
            X.set('sling', X.scale(1.2, 0.9))
            const composed = X.compose()
            X.clearAll()
            return {
              loaded: true, composed: composed,
              hasBoth: composed.indexOf('rotate') >= 0 && composed.indexOf('scale') >= 0,
              cleared: X.compose() === '',
            }
          })(),
          // —— 碰撞世界（主进程侧的 lib/collision.js）——
          // 修正：这段原来被**原样**写进了 executeJavaScript 的模板串，而 collisionMod
          //   只在主进程存在，渲染进程里一执行就 ReferenceError、整个自检被外层
          //   catch 吞成一条失败。现在主进程先算好（collisionSelfCheck），结果插值进来。
          collision: ${JSON.stringify(collisionSelfCheck())},
          strengthNow: P.getThrowStrength(),
          // —— 弹弓状态机（真跑一遍，测完复原）——
          // 修正：这里原来也叫 sling，把 out.fn 前面那个**纯函数** sling（belowMin/deform/traj…）
          //   覆盖掉了 —— 后写的键生效，消费端两套字段各错一半。改成 slingState 分开存。
          slingState: await (async function () {
            const r = {}
            const before = ph._state().pos
            r.enabled = P.slingshotEnabled()
            // 进入蓄力（锚点 = 她当前位置）
            P._enterSlingshot(500, 500)
            r.entered = !!P._sling()
            // 往左上拉 100px（pull 应该是「锚点鼠标 − 当前鼠标」= 右下 100）
            P._updateSlingAim(400, 400)
            const sl = P._sling()
            r.pull = sl ? [Math.round(sl.pull[0]), Math.round(sl.pull[1])] : null
            r.progress = Math.round(P._slingProgress() * 1000) / 1000
            // 取消 → 应当回到锚点
            P._cancelSlingToAnchor()
            r.cleared = !P._sling()
            r.backToAnchor = ph._state().pos
            r.restored = (Math.abs(ph._state().pos[0] - before[0]) <= 1 &&
                          Math.abs(ph._state().pos[1] - before[1]) <= 1)
            // 再跑一次，这次**发射**，看速度方向对不对
            P._enterSlingshot(500, 500)
            P._updateSlingAim(400, 400)   // pull = (+100,+100) → 应该往右下飞
            r.launched = P._launchSlingshot()
            const st = ph._state()
            r.velAfter = [Math.round(st.vel[0]), Math.round(st.vel[1])]
            r.modeAfter = st.mode
            r.thrownAway = (st.vel[0] > 0 && st.vel[1] > 0)
            // 收尾：停掉物理，别让她真的飞出去影响后面的用例
            try { P.setEnabled(false); P.setEnabled(true) } catch (e) {}
            return r
          })(),
        }

        // —— 与原程序 pet/physics.py 的数值对拍 ——
        // 基准值是把 physics.pyc 直接跑出来得到的（同一组输入、同一组边界）：
        //   L,T,R,B = -125, 0, 1798, 777    起点 (1000,700) 初速 (3200,-2400)
        //   step  1  → (1051.2000, 661.9584) v=(3200.0000, -2377.6000)
        //   step 30  → (1238.8960,  232.8607) v=(-2496.0000, 1706.6880)
        //   step 60  → (  59.9853,  488.9784) v=(-2396.1600, -1376.9126)
        //   step 636 → 【静止】(744.5518, 777.0000)
        // 我的 JS 跑同样的输入必须得到同样的数 —— 差一点就说明移植不忠实。
        out.sim60 = ph._simulate(1000, 700, 3200, -2400, 60, -125, 0, 1798, 777)
        out.sim1 = ph._simulate(1000, 700, 3200, -2400, 1, -125, 0, 1798, 777)
        out.sim30 = ph._simulate(1000, 700, 3200, -2400, 30, -125, 0, 1798, 777)
        out.simRest = ph._runUntilRest(1000, 700, 3200, -2400, -125, 0, 1798, 777, 2000)

        // —— 点击没被接管破坏吗？——
        // 接管位置最大的风险就是"顺手把点击也吞了"（点击弹气泡挂在挂件的 pointerdown 链上）。
        // 我们的设计是**只在真的拖动时**才拦截，点击一律放行 —— 这里合成一次
        // "按下 + 抬起"（不移动）来验证。合成事件 isTrusted=false，但挂件不检查这个。
        try {
          const imgEl = q('img.dshwv-img')
          const ir2 = imgEl.getBoundingClientRect()
          const cx = Math.round(ir2.left + ir2.width / 2)
          const cy = Math.round(ir2.top + ir2.height / 2)
          const base = { bubbles: true, cancelable: true, clientX: cx, clientY: cy,
                         screenX: cx + (window.screenX || 0), screenY: cy + (window.screenY || 0),
                         button: 0, pointerType: 'mouse', pointerId: 1, isPrimary: true }
          // ⚠️ .dshwv-pop 是**静态元素**（一直在 DOM 里），开合靠加 dshwv-pop-open 类。
          //    所以判据是那个类，不是元素在不在。
          const hadPop = !!q('.dshwv-pop.dshwv-pop-open')
          document.body.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ buttons: 1 }, base)))
          document.dispatchEvent(new PointerEvent('pointerup', Object.assign({ buttons: 0 }, base)))
          await sleep(500)
          out.clickBubbleAppeared = !hadPop && !!q('.dshwv-pop.dshwv-pop-open')
        } catch (e) { out.clickError = String(e && e.message) }

        // —— 合成一次真实拖动：验证拖动是 1:1 跟手 ——
        // 用户要求"物理开启时的拖动要和关闭时一致"，所以拖动只有一条代码路径。
        // 这里合成为"慢速拖 100px"（< 500px/s 的慢放阈值，松手不会抛），
        // 断言她刚好跟着走 100px。
        try {
          const dImg = q('img.dshwv-img')
          const dIr = dImg.getBoundingClientRect()
          const dsx = Math.round(dIr.left + dIr.width / 2)
          const dsy = Math.round(dIr.top + dIr.height / 2)
          const posBefore = ph._state().pos
          // 诊断：她立绘中心那个点上，最顶层的元素到底是什么？
          try {
            const el0 = document.elementFromPoint(dsx, dsy)
            out.elemAtArtCenter = el0 ? (el0.tagName + '.' + (el0.className || '')).slice(0, 70) : null
            out.elemInWhaleRoot = !!(el0 && el0.closest && el0.closest('.dshwv-root'))
            out.whaleRootExists = !!q('.dshwv-root')
            out.imgInWhaleRoot = !!(q('img.dshwv-img') && q('img.dshwv-img').closest('.dshwv-root'))
          } catch (e) { out.elemDiagError = String(e && e.message) }
          const mk = (type, x, extra) => new PointerEvent(type, Object.assign({
            bubbles: true, cancelable: true, clientX: x, clientY: dsy,
            screenX: x + (window.screenX || 0), screenY: dsy + (window.screenY || 0),
            button: 0, pointerType: 'mouse', pointerId: 9, isPrimary: true,
          }, extra || {}))
          ;(document.elementFromPoint(dsx, dsy) || document.body).dispatchEvent(mk('pointerdown', dsx, { buttons: 1 }))
          for (let i = 1; i <= 5; i++) {
            // 每步 20px、间隔 120ms → 约 167px/s，低于 500 的慢放阈值
            document.dispatchEvent(mk('pointermove', dsx - 20 * i, { buttons: 1 }))
            await sleep(120)
          }
          const posAfter = ph._state().pos
          out.dragDx = Math.round(posAfter[0] - posBefore[0])
          out.dragDy = Math.round(posAfter[1] - posBefore[1])
          out.dragDraggingFlag = window.__dshpetDragging === true
          document.dispatchEvent(mk('pointerup', dsx - 100, { buttons: 0 }))
          await sleep(400)
          out.dragFlagCleared = window.__dshpetDragging !== true
          out.dragModeAfter = ph._state().mode
        } catch (e) { out.dragError = String(e && e.message) }

        // —— 窗口几何：搞清楚"屏幕顶部为什么有一块拖不到" ——
        // bounds() 用的是 window.innerHeight，所以要看清楚页面视口和真实屏幕的关系。
        out.winGeom = {
          innerW: window.innerWidth, innerH: window.innerHeight,
          outerW: window.outerWidth, outerH: window.outerHeight,
          screenX: window.screenX, screenY: window.screenY,
          screenW: screen.width, screenH: screen.height,
          availW: screen.availWidth, availH: screen.availHeight,
          availTop: screen.availTop, availLeft: screen.availLeft,
          dpr: window.devicePixelRatio,
        }

        // —— 合成一次"拖到屏幕最左上角"：量出真正的可达范围 ——
        // 用户报"关闭拖动物理时上面有一块拖不到"。这里直接把她往左上拖到底，
        // 看立绘最终能不能贴到 (0,0)。
        try {
          const tImg = q('img.dshwv-img')
          const tIr = tImg.getBoundingClientRect()
          const tsx = Math.round(tIr.left + tIr.width / 2)
          const tsy = Math.round(tIr.top + tIr.height / 2)
          const mk2 = (type, x, y, extra) => new PointerEvent(type, Object.assign({
            bubbles: true, cancelable: true, clientX: x, clientY: y,
            screenX: x + (window.screenX || 0), screenY: y + (window.screenY || 0),
            button: 0, pointerType: 'mouse', pointerId: 11, isPrimary: true,
          }, extra || {}))
          ;(document.elementFromPoint(tsx, tsy) || document.body).dispatchEvent(mk2('pointerdown', tsx, tsy, { buttons: 1 }))
          for (let i = 1; i <= 6; i++) {
            document.dispatchEvent(mk2('pointermove', tsx - 500 * i, tsy - 300 * i, { buttons: 1 }))
            await sleep(90)
          }
          // ⚠️ **按住她的时候贴图会换成"抚摸"那张，而那张渲染出来的尺寸和默认那张不一样**
          //    （默认 223×223，抚摸 234×196）。贴图是异步加载的，加载完挂件才改立绘尺寸 ——
          //    也就是说上面那 6 步拖动**多半是在"旧尺寸"下夹取的**，她会停在离顶端
          //    27px（= 223-196）的地方。这不是"拖不到"，而是"夹取用的尺寸还没跟上"。
          //    立绘偏移缓存是**每 3 秒**定期失效一次（drag-physics 里的
          //    setInterval(invalidateArt, 3000)），所以要等过一个周期，
          //    再补一次往左上的拖动，夹取才会按稳定后的尺寸重算 ——
          //    这才是"她到底能不能贴到 (0,0)"的公平测法。
          //    （注释里别写反引号：整段探针是模板字符串，反引号会把它截断。）
          await sleep(3300)
          for (let i = 1; i <= 2; i++) {
            document.dispatchEvent(mk2('pointermove', tsx - 3000 - 200 * i, tsy - 1800 - 200 * i, { buttons: 1 }))
            await sleep(140)
          }
          out.topLeftPhys = ph._state().pos
          const tImg2 = q('img.dshwv-img')
          // ⚠️ 量之前把行内 transform / transition 摘掉 —— getBoundingClientRect
          //    **含 transform**，而"点她"/"被砸到头"/"抚摸"都会给立绘挂上
          //    squash 或换一张尺寸不同的贴图（实测量到过 234×196），
          //    带着它量出来的左上角根本不是"她能不能贴到 (0,0)"的答案。
          //    夹取用的是布局位置，这里口径要一致。
          const tSaved = []
          {
            let el = tImg2
            const tRoot = q('.dshwv-root')
            while (el && el !== tRoot && el.style) {
              if (el.style.transform) {
                tSaved.push([el, el.style.transform, el.style.transition])
                el.style.transition = 'none'; el.style.transform = 'none'
              }
              el = el.parentNode
            }
          }
          const tAfter = tImg2.getBoundingClientRect()
          for (const s of tSaved) {
            try { s[0].style.transform = s[1]; s[0].style.transition = s[2] } catch (e) {}
          }
          out.topLeftArtRect = {
            l: Math.round(tAfter.left), t: Math.round(tAfter.top),
            w: Math.round(tAfter.width), h: Math.round(tAfter.height),
          }
          // 诊断：这一拍的 transform / 内联样式 / 图片实际尺寸
          try {
            out.topLeftComputedTf = String(getComputedStyle(tImg2).transform)
            out.topLeftInlineTf = String(tImg2.style.transform || '')
            out.topLeftInlineTr = String(tImg2.style.transition || '')
            out.topLeftNatural = { w: tImg2.naturalWidth, h: tImg2.naturalHeight }
            out.topLeftOffset = ph._artOffset()
            out.topLeftSrc = String(tImg2.getAttribute('src') || '')
          } catch (e) {}
          document.dispatchEvent(mk2('pointerup', tsx - 3000, tsy - 1800, { buttons: 0 }))
          await sleep(1200)      // 等 updateFacing 的定期重应用生效
          out.topLeftModeAfter = ph._state().mode
          // 她被拖到屏幕左上（左半边）→ 必须翻转朝向（dshwv-left）
          const rr3 = q('.dshwv-root')
          out.flippedAfterLeftDrag = !!(rr3 && rr3.classList.contains('dshwv-left'))
          // 翻转之后立绘偏移必须还是"未翻转"的那个值（否则夹取范围会变 → 跳）
          out.artOffsetAfterFlip = ph._artOffset()
          out.boundsAfterFlip = ph._bounds()
        } catch (e) { out.topLeftError = String(e && e.message) }

        // —— 复现挂件写 right:0/bottom:0（它的基础样式）→ 我们必须在同一帧改回来 ——
        // 这是用户报的"打开米粒菜单时她往下瞬移一下又恢复"的根因：
        // 挂件每次 express() 都会先写 right:0/bottom:0，而 bottom:0 是相对窗口的，
        // 窗口是整屏高度 → 她掉到任务栏下面。物理关闭时 applyOverride 不是持续跑的，
        // 那个中间值就留在屏幕上 → 鼠标下的目标变了 → 点击落空 / 面板被关。
        try {
          const rEl = q('.dshwv-root')
          const posOk = ph._state().pos
          rEl.style.removeProperty('left')
          rEl.style.removeProperty('top')
          rEl.style.right = '0px'
          rEl.style.bottom = '0px'
          await sleep(150)
          const rr3 = q('img.dshwv-img').getBoundingClientRect()
          out.hijackBottom = Math.round(rr3.bottom)
          out.hijackPos = ph._state().pos
          out.hijackRestored = Math.abs(out.hijackPos[1] - posOk[1]) <= 1
          rEl.style.removeProperty('right')
          rEl.style.removeProperty('bottom')
          await sleep(150)
        } catch (e) { out.hijackError = String(e && e.message) }

        // —— 【桌宠版】「角色」行 + 闭眼贴图 ——
        try {
          const pmr = q('.dshrice-menu')
          out.roleRowExists = !!(pmr && pmr.querySelector('.dshpet-role-row'))
          const rrow = pmr ? pmr.querySelector('.dshpet-role-row') : null
          if (rrow) {
            out.roleRowText = (rrow.textContent || '').trim()
            const rb = rrow.querySelectorAll('button')
            out.roleRowBtns = []
            for (let i = 0; i < rb.length; i++) out.roleRowBtns.push(rb[i].textContent)
            // 和「波谷饭」那一行对比样式（用户要求一致）
            const rowsAll = pmr.querySelectorAll('.dshrice-row')
            let valley = null
            for (let i = 0; i < rowsAll.length; i++) {
              if ((rowsAll[i].textContent || '').indexOf('波谷饭') >= 0) { valley = rowsAll[i]; break }
            }
            if (valley) {
              const cs1 = getComputedStyle(valley.querySelector('button'))
              const cs2 = getComputedStyle(rb[0])
              out.roleRowStyleMatch = cs1.fontSize === cs2.fontSize &&
                cs1.padding === cs2.padding && cs1.borderRadius === cs2.borderRadius &&
                cs1.background === cs2.background
              out.roleRowStyleInfo = { v: cs1.fontSize + '/' + cs1.padding, r: cs2.fontSize + '/' + cs2.padding }
            }
          }
          // 组标题改名
          let headTxt = null
          const heads = pmr ? pmr.querySelectorAll('.dshrice-grp-h') : []
          for (let i = 0; i < heads.length; i++) {
            if ((heads[i].textContent || '').indexOf('素材') >= 0) headTxt = heads[i].textContent
          }
          out.materialHeadText = headTxt
          // 避让是 transform 还是 marginLeft（应当只剩 transform）
          if (pmr) {
            const cs2 = getComputedStyle(pmr)
            out.panelShift = Math.round(parseFloat(pmr.style.getPropertyValue('--dshpet-panel-dx')) || 0)
            out.panelMarginLeft = cs2.marginLeft
          }
          // 闭眼图能不能取到
          const eyeRes = await fetch('/whale-sprite-closeeye.png', { cache: 'no-store' })
          out.closeEyeStatus = eyeRes.status
          out.closeEyeBytes = Number(eyeRes.headers.get('content-length') || 0)
          // 换贴图 / 换回来
          const wimg = q('img.dshwv-img')
          out.spriteBefore = wimg ? String(wimg.getAttribute('src') || '').slice(0, 40) : null
          if (window.__dshpetRiceRole && wimg) {
            window.__dshpetRiceRole.toCloseEye()
            await sleep(200)
            out.spriteAfterCloseEye = String(wimg.getAttribute('src') || '').slice(0, 60)
            window.__dshpetRiceRole.restoreEye()
            await sleep(200)
            out.spriteAfterRestore = String(wimg.getAttribute('src') || '').slice(0, 40)
          }
        } catch (e) { out.roleError = String(e && e.message) }

        // —— 【桌宠版】多状态形象 + 互动心情（从 For-WinDesktop 移植）——
        try {
          const wm2 = q('.dshwv-menu')
          out.expBtnText = (wm2 && wm2.querySelector('.dshpet-exp-btn')) ? wm2.querySelector('.dshpet-exp-btn').textContent : null
          // 9 张形象图都能取到吗
          const names = ['main','stroking','angry','disappointed','shy','exhausted','close_eyes','half_closed_eyes','half_open_eyes']
          out.expImgStatus = {}
          for (let i = 0; i < names.length; i++) {
            try {
              const r = await fetch('/whale-exp/' + names[i] + '.png', { cache: 'no-store' })
              out.expImgStatus[names[i]] = r.status
            } catch (e) { out.expImgStatus[names[i]] = 0 }
          }
          out.expAllImagesOk = names.every(function (n) { return out.expImgStatus[n] === 200 })
          // 状态机：切到生气 → 图片应该变
          const wimg2 = q('img.dshwv-img')
          out.expSrcBefore = wimg2 ? String(wimg2.getAttribute('src') || '') : null
          if (window.__dshpetWhaleExp) {
            out.expDisabled = window.__dshpetWhaleExp.disabledReason() || ''
            out.expCfg = window.__dshpetWhaleExp.cfg()
            window.__dshpetWhaleExp.setMood('angry', 3000)
            await sleep(250)
            out.expSrcAngry = wimg2 ? String(wimg2.getAttribute('src') || '') : null
            window.__dshpetWhaleExp.setMood('', 0)
            await sleep(250)
            out.expSrcBack = wimg2 ? String(wimg2.getAttribute('src') || '') : null
            // 设置面板能打开吗 + 不和桌宠菜单重合 + 点空白处能关
            // ⚠️ 先把菜单挪到她旁边（真实使用时的位置）再开面板 ——
            //    上面那些拖拽测试把她丢到了左上角，菜单跟着跑过去，
            //    左边根本没地方放面板，会被夹到 8px，测出来的"重合"是假的。
            window.__dshpetWhaleExp.openPanel()
            await sleep(250)
            const pan = q('.dshpet-exp-panel')
            out.expPanelOpen = !!(pan && getComputedStyle(pan).display !== 'none')
            out.expPanelRows = pan ? pan.querySelectorAll('.dshpet-exp-row').length : 0
            const wmB = q('.dshwv-menu')
            if (pan && wmB) {
              const pr3 = pan.getBoundingClientRect()
              const wmR = wmB.getBoundingClientRect()
              out.expPanelRect = { l: Math.round(pr3.left), t: Math.round(pr3.top), w: Math.round(pr3.width), h: Math.round(pr3.height) }
              out.expMenuRect = { l: Math.round(wmR.left), t: Math.round(wmR.top), w: Math.round(wmR.width) }
              // 面板右边缘应当在菜单左边缘左边（不重合）
              // 只有菜单左边确实放得下时才要求不重合 ——
              // 上面那些拖拽测试把她丢到了左上角，菜单跟着跑过去，
              // 左边根本没空间，面板会被夹到 8px，那种"重合"是测试造成的假象。
              out.expLeftRoom = wmR.left >= pr3.width + 8
              out.expNoOverlap = out.expLeftRoom ? (pr3.right <= wmR.left + 1) : true
            }
            // 点空白处（面板外）→ 应该关掉
            if (pan) {
              const pr4 = pan.getBoundingClientRect()
              const bx2 = Math.max(5, pr4.left - 40)
              const by2 = Math.max(5, pr4.top + 10)
              const mkX = (t) => new PointerEvent(t, {
                bubbles: true, cancelable: true, clientX: bx2, clientY: by2,
                screenX: bx2 + (window.screenX || 0), screenY: by2 + (window.screenY || 0),
                button: 0, buttons: t === 'pointerdown' ? 1 : 0,
                pointerType: 'mouse', pointerId: 41, isPrimary: true,
              })
              document.body.dispatchEvent(mkX('pointerdown'))
              document.dispatchEvent(mkX('pointerup'))
              document.body.dispatchEvent(new MouseEvent('click', {
                bubbles: true, cancelable: true, clientX: bx2, clientY: by2,
              }))
              await sleep(250)
              out.expClosedByOutside = getComputedStyle(pan).display === 'none'
            }
          }
          // 开机自启接口
          out.autostart = window.petApi && window.petApi.autostartGet
            ? await window.petApi.autostartGet() : null
        } catch (e) { out.expError = String(e && e.message) }

        // —— 【桌宠版】多桌宠：入口按钮 + 立绘位置上报 + 相撞反应 ——
        try {
          const wm3 = q('.dshwv-menu')
          const spawnBtn = wm3 ? wm3.querySelector('.dshpet-spawn-btn') : null
          out.spawnBtnText = spawnBtn ? spawnBtn.textContent : null
          // 两个按钮是不是并排（右边那个在左边那个的右面）
          const expBtn = wm3 ? wm3.querySelector('.dshpet-exp-btn') : null
          if (spawnBtn && expBtn) {
            const rb1 = expBtn.getBoundingClientRect()
            const rb2 = spawnBtn.getBoundingClientRect()
            out.spawnBtnOnRight = rb2.left >= rb1.right - 2
            out.spawnBtnRow = { exp: Math.round(rb1.left), spawn: Math.round(rb2.left) }
          }
          // 立绘位置上报链路：等一拍让渲染进程报上去
          await sleep(400)
          out.petCountBefore = (await window.petApi.petCount()).count
          out.petRects = await window.petApi.petDebugRects()
          // 相撞反应本身能不能跑（直接调一次，看有没有报错）
          // ⚠️ 这里**不要真的调 poke()** —— 它会 new Audio().play()，
          //    而自检窗口从没显示过，隐藏窗口里的音频播放会把渲染进程卡住，
          //    后面的 executeJavaScript 全部超时（排查了很久就是这个）。
          //    改成验证函数在位 + 上报链路通，功能本身靠真人实测。
          out.pokeOk = !!(window.__dshpetCollide && typeof window.__dshpetCollide.poke === 'function')
          out.collideApi = window.__dshpetCollide ? Object.keys(window.__dshpetCollide) : null
          // —— 「退出桌宠」相关（第一只的视角）——
          // 第一只**不该**有「退出桌宠」：托盘/热键那些老入口都指着它。
          out.firstPetInfo = await window.petApi.petInfo()
          out.firstHasQuitRow = !!document.querySelector('.dshwv-menu .dshpet-quit-btn')
          // 第一只就算去调也会被拒绝，而且它必须还活着
          out.firstCloseTry = await window.petApi.closeSelf()
          await sleep(300)
          out.firstStillAlive = (await window.petApi.petCount()).count >= 1
          // —— 体积碰撞的两个纯函数（不碰 DOM，能直接验）——
          // ① 相交判定：完全重合时两个轴的重叠量都等于边长
          const ovA = window.__dshpetCollide._overlapOf(
            { x: 0, y: 0, w: 100, h: 100 }, { x: 0, y: 0, w: 100, h: 100 })
          // ② 不相交时必须返回 null（不然会对着空气推）
          const ovB = window.__dshpetCollide._overlapOf(
            { x: 0, y: 0, w: 100, h: 100 }, { x: 100, y: 0, w: 100, h: 100 })
          // ③ 部分重叠：X 重叠 40、Y 重叠 100
          const ovC = window.__dshpetCollide._overlapOf(
            { x: 0, y: 0, w: 100, h: 100 }, { x: 60, y: 0, w: 100, h: 100 })
          out.overlapSame = ovA
          out.overlapApart = ovB
          out.overlapPartial = ovC
          // —— 推开用的原语：nudge 真的能挪动，而且会被夹在工作区内 ——
          const ph = window.__dshpetPhysics
          out.nudgeOk = !!(ph && typeof ph.nudge === 'function' && typeof ph.isDragging === 'function')
          if (out.nudgeOk) {
            const p0 = ph._state().pos
            // ⚠️ 不能固定往一个方向推：她可能本来就贴在那一侧的边上，
            //    那样会被夹取吃光、位移为 0（实测：她停在最上面时 nudge(0,-40) 完全没动，
            //    断言就假红了）。所以四个方向挨个试，用**实际位移**判断。
            const dirs = [[0, -40], [0, 40], [-40, 0], [40, 0]]
            let p1 = p0
            let used = null
            for (let k = 0; k < dirs.length; k++) {
              ph.nudge(dirs[k][0], dirs[k][1])
              const q = ph._state().pos
              if (q[0] !== p0[0] || q[1] !== p0[1]) { p1 = q; used = dirs[k]; break }
            }
            // 按**实际发生的位移**原样挪回去（往上那 40 可能被夹掉一部分，不能想当然地反向推 40）
            ph.nudge(p0[0] - p1[0], p0[1] - p1[1])
            const p2 = ph._state().pos
            out.nudgeMoved = !!used
            out.nudgeDir = used
            out.nudgeRestored = (p2[0] === p0[0] && p2[1] === p0[1])
            out.nudgePos = [p0, p1, p2]
          }
          // 真的再开一只 —— 用户要的就是"点一次多一只，没有数量限制"
          const sp = await window.petApi.spawnPet()
          out.spawnResult = sp
          await sleep(600)
          out.petCountAfter = (await window.petApi.petCount()).count
          // 收尾：把测试多开的收掉，免得拖慢后面的用例 / 让进程不退出
          await window.petApi.closeExtraPets()
          await sleep(300)
          // 收掉之后第一只必须还在，而且计数回到 1
          out.countAfterCleanup = (await window.petApi.petCount()).count
        } catch (e) { out.spawnError = String(e && e.message) }

        // —— 复现用户报的场景：**进入鲸鱼菜单、点里面的功能** ——
        // 用户描述："进入菜单点了相关功能没反应 + 菜单直接关闭 + 桌宠往下瞬移一下又恢复"。
        // 这一段就是照着他的操作顺序走的：开菜单 → 记位置 → 点菜单里的控件 → 看结果。
        try {
          const mbtn = q('.dshwv-menu-btn')
          const mbox = q('.dshwv-menu')
          if (mbtn && mbox) {
            mbtn.click()
            await sleep(500)
            out.wmOpenAfterBtn = mbox.classList.contains('dshwv-menu-open')
            // 菜单开了以后它在哪（positionMenu 会把它摆到她旁边）
            const mr0 = mbox.getBoundingClientRect()
            out.wmRect = { l: Math.round(mr0.left), t: Math.round(mr0.top), w: Math.round(mr0.width), h: Math.round(mr0.height) }
            out.posBeforeMenuClick = ph._state().pos

            // 点菜单里的一个复选框（真的按坐标点）
            const wboxes = mbox.querySelectorAll('input[type="checkbox"]')
            out.wmCheckboxCount = wboxes.length
            if (wboxes.length) {
              const wb0 = wboxes[0]
              const was = wb0.checked
              const wr0 = wb0.getBoundingClientRect()
              const wx = Math.round(wr0.left + wr0.width / 2)
              const wy = Math.round(wr0.top + wr0.height / 2)
              const mkM = (type) => new PointerEvent(type, {
                bubbles: true, cancelable: true, clientX: wx, clientY: wy,
                screenX: wx + (window.screenX || 0), screenY: wy + (window.screenY || 0),
                button: 0, buttons: type === 'pointerdown' ? 1 : 0,
                pointerType: 'mouse', pointerId: 31, isPrimary: true,
              })
              const tgtM = document.elementFromPoint(wx, wy) || wb0
              tgtM.dispatchEvent(mkM('pointerdown'))
              await sleep(40)
              document.dispatchEvent(mkM('pointermove'))
              await sleep(40)
              document.dispatchEvent(mkM('pointerup'))
              await sleep(40)
              wb0.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: wx, clientY: wy }))
              await sleep(400)
              out.wmCheckboxBefore = was
              out.wmCheckboxAfter = wb0.checked
              out.wmCheckboxResponded = wb0.checked !== was
            }
            out.wmStillOpenAfterClick = mbox.classList.contains('dshwv-menu-open')
            out.posAfterMenuClick = ph._state().pos
            out.wmPosDrift = [
              Math.round((out.posAfterMenuClick[0] || 0) - (out.posBeforeMenuClick[0] || 0)),
              Math.round((out.posAfterMenuClick[1] || 0) - (out.posBeforeMenuClick[1] || 0)),
            ]
          }
        } catch (e) { out.wmClickError = String(e && e.message) }

        // —— 菜单扩展：删掉「避让滚动条/宽度」、加上「打开 dsh 网页端」——
        try {
          out.menuExtrasLoaded = !!window.__dshpetMenuExtras
          const mmenu = q('.dshwv-menu')
          out.scrollGapRowFound = false
          out.scrollGapRowHidden = null
          if (mmenu) {
            const mrows = mmenu.querySelectorAll('.dshwv-menu-row')
            for (let i = 0; i < mrows.length; i++) {
              if (mrows[i].textContent.indexOf('避让滚动条') >= 0) {
                out.scrollGapRowFound = true
                out.scrollGapRowHidden = mrows[i].style.display === 'none'
              }
            }
            // 那个复选框必须已取消勾选（功能一并关掉）
            const boxes = mmenu.querySelectorAll('input[type="checkbox"]')
            for (let i = 0; i < boxes.length; i++) {
              if (String(boxes[i].title || '').indexOf('避开滚动条') >= 0) out.scrollGapChecked = boxes[i].checked
            }
          }
          const ow = q('.dshpet-openweb-btn')
          out.openWebRow = !!q('.dshpet-openweb-row')
          out.openWebLabel = ow ? ow.textContent : null
          out.openWebHintPort = window.__dshpetMenuExtras ? window.__dshpetMenuExtras.hintPort : null
          // 关键：走的是"主进程探测端口"的接口，不是写死 URL 的老接口
          out.hasOpenDshWebApi = !!(window.petApi && typeof window.petApi.openDshWeb === 'function')
          // 干跑一次（dryRun：只探测端口、不打开浏览器）——
          // 验证主进程那条探测链路真的能跑通、并返回结构化的结果。
          if (out.hasOpenDshWebApi) {
            try { out.dshWebProbe = await window.petApi.openDshWeb({ dryRun: true }) } catch (e2) {
              out.dshWebProbeError = String(e2 && e2.message)
            }
          }
        } catch (e) { out.menuExtrasError = String(e && e.message) }

        // —— 物理**关闭**时往下拖：不能拖到任务栏下面 ——
        // ⚠️ 这条路径之前从来没测过（自检总是强制"物理开启"），而它恰恰是 bug 所在：
        //    物理关闭时如果拖拽不接管，就是挂件自己在拖，挂件按整屏夹取 → 能拖到任务栏下面。
        try {
          ph.setEnabled(false)
          await sleep(300)
          out.offEnabled = ph.isEnabled()
          const oImg = q('img.dshwv-img')
          const oIr = oImg.getBoundingClientRect()
          const osx = Math.round(oIr.left + oIr.width / 2)
          const osy = Math.round(oIr.top + oIr.height / 2)
          const mk4 = (type, x, y, extra) => new PointerEvent(type, Object.assign({
            bubbles: true, cancelable: true, clientX: x, clientY: y,
            screenX: x + (window.screenX || 0), screenY: y + (window.screenY || 0),
            button: 0, pointerType: 'mouse', pointerId: 13, isPrimary: true,
          }, extra || {}))
          ;(document.elementFromPoint(osx, osy) || document.body).dispatchEvent(mk4('pointerdown', osx, osy, { buttons: 1 }))
          for (let i = 1; i <= 6; i++) {
            document.dispatchEvent(mk4('pointermove', osx, osy + 400 * i, { buttons: 1 }))
            await sleep(90)
          }
          const oAfter = q('img.dshwv-img').getBoundingClientRect()
          out.offDragBottom = Math.round(oAfter.bottom)
          out.offDragTop = Math.round(oAfter.top)
          out.offDragPhysBottom = Math.round(ph._bounds().bottom + ph._artOffset().dy + ph._artOffset().h)
          document.dispatchEvent(mk4('pointerup', osx, osy + 3000, { buttons: 0 }))
          await sleep(400)
          out.offDragFlagCleared = window.__dshpetDragging !== true
        } catch (e) { out.offDragError = String(e && e.message) }
        try { ph.setEnabled(true); await sleep(200) } catch (e) {}

        // —— 用**挂件的恢复公式**复算：它读到 dshw-pos 后会把她放在哪？——
        // 这是"打开时默认位置在任务栏下面"这个问题的直接判据：
        // 之前只 removeItem，挂件就回落到基础样式 right:0/bottom:0（相对窗口），
        // 而窗口是整屏高度 → 她被放到 y=innerHeight，正好在任务栏下面。
        try {
          var posRec = JSON.parse(localStorage.getItem('dshw-pos') || 'null')
          var rRoot = q('.dshwv-root')
          var rr2 = rRoot ? rRoot.getBoundingClientRect() : null
          if (posRec && rr2) {
            var vpW = window.innerWidth, vpH = window.innerHeight
            var rl = posRec.hAnchor === 'right' ? vpW - rr2.width - posRec.hDist : posRec.hDist
            var rt = posRec.vAnchor === 'bottom' ? vpH - rr2.height - posRec.vDist : posRec.vDist
            var ao3 = ph._artOffset()
            out.restoreCalc = { left: Math.round(rl), top: Math.round(rt), rec: posRec }
            out.restoreArtBottom = Math.round(rt + ao3.dy + ao3.h)
            out.restoreArtTop = Math.round(rt + ao3.dy)
          }
        } catch (e) { out.restoreCalcError = String(e && e.message) }

        // —— 米粒「扣头顶」机制：直接查服务端发出来的那份 client.js ——
        // 上游 0.3.7 把"扣头顶"做成了独立的一套（dshrice-head + 按角色存的 headLeft/headTop
        // + buildHeadCss 生成关键帧），并且用 headChancePct 控制概率。
        // 桌宠版把这个概率定成 100（抓现行必定扣头顶），所以这里查的就是这两点。
        try {
          const rtxt = await (await fetch('/dsh-rice/rice.js', { cache: 'no-store' })).text()
          out.riceHeadInfo = {
            hasHeadAnim: rtxt.indexOf('dshrice-head') >= 0,
            hasBuildHead: rtxt.indexOf('buildHeadCss') >= 0,
            // 桌宠版**保持上游默认值 10**（两套翻碗动画都按上游来：
            // 抓现行大概率倒扣在旁边地面，10% 撞上头顶；被彩蛋炸到必定上头顶）。
            headChanceDefault: rtxt.indexOf('headChancePct: 10') >= 0,
            hasHeadChanceKey: rtxt.indexOf('headChancePct') >= 0,
            headChanceSnippet: (function () {
              var out2 = []
              var i = -1
              while ((i = rtxt.indexOf('headChancePct', i + 1)) >= 0 && out2.length < 8) {
                out2.push(rtxt.slice(i, i + 22).split(String.fromCharCode(10)).join(' '))
              }
              return out2
            })(),
            hasDropSound: rtxt.indexOf('drop-bowl.webm') >= 0,
            hasBeatRoute: rtxt.indexOf('/dsh-rice/beat') >= 0,
            bytes: rtxt.length,
          }
          out.riceHeadMachinery = out.riceHeadInfo.hasHeadAnim &&
            out.riceHeadInfo.hasBuildHead && out.riceHeadInfo.headChanceDefault
        } catch (e) { out.riceHeadError = String(e && e.message) }

        // —— 「偷吃白饭」入口：浮动小标签要藏起来、收进鲸鱼菜单 ——
        // 先把她还回右下角：上一个测试把她拖到了屏幕左上角，
        // 那样"菜单没地方可让"，避让断言测不出真实行为。
        try {
          const bImg = q('img.dshwv-img')
          const bIr = bImg.getBoundingClientRect()
          const bsx = Math.round(bIr.left + bIr.width / 2)
          const bsy = Math.round(bIr.top + bIr.height / 2)
          const mk3 = (type, x, y, extra) => new PointerEvent(type, Object.assign({
            bubbles: true, cancelable: true, clientX: x, clientY: y,
            screenX: x + (window.screenX || 0), screenY: y + (window.screenY || 0),
            button: 0, pointerType: 'mouse', pointerId: 12, isPrimary: true,
          }, extra || {}))
          ;(document.elementFromPoint(bsx, bsy) || document.body).dispatchEvent(mk3('pointerdown', bsx, bsy, { buttons: 1 }))
          for (let i = 1; i <= 6; i++) {
            document.dispatchEvent(mk3('pointermove', bsx + 500 * i, bsy + 300 * i, { buttons: 1 }))
            await sleep(90)
          }
          document.dispatchEvent(mk3('pointerup', bsx + 3000, bsy + 1800, { buttons: 0 }))
          await sleep(600)
        } catch (e) {}
        try {
          const chip = q('.dshrice-chip')
          out.riceChipExists = !!chip
          out.riceChipDisplay = chip ? getComputedStyle(chip).display : null
          out.riceMenuRow = !!q('.dshwv-menu .dshpet-rice-row')
          var riceRowEl = q('.dshpet-rice-row')
          if (riceRowEl) {
            var rcs = getComputedStyle(riceRowEl)
            out.riceRowBorder = rcs.borderTopWidth + ' ' + rcs.borderTopStyle
            out.riceRowRadius = rcs.borderTopLeftRadius
            out.riceRowBoxed = parseFloat(rcs.borderTopWidth) > 0 && rcs.borderTopStyle !== 'none'
          }
          out.ricePanelShiftFn = !!(window.__dshpetRiceEntry && window.__dshpetRiceEntry.keepPanelClear)
          out.riceRowLabel = (q('.dshpet-rice-row') || {}).textContent || null
          const row = q('.dshpet-rice-row')
          if (row) {
            const wasOpen = !!q('.dshrice-menu.dshrice-open')
            row.click()
            await sleep(500)
            out.ricePanelOpened = !!q('.dshrice-menu.dshrice-open')
            out.ricePanelWasOpen = wasOpen

            // ⚠️ 面板位置**稳定性**：以前"每次往左再推一点"，和 rice 每 700ms 的
            //    placeMenu() 一拉一推就来回跳。这里连续采样，看它会不会自己变。
            const samples = []
            // ⚠️ 先**真的把鲸鱼菜单打开**，否则测不到避让路径。
            //    注意判据是 dshwv-menu-open 类 —— .dshwv-menu 关闭时是 opacity:0，
            //    不是 display:none，尺寸照样有值。
            const wm0 = q('.dshwv-menu')
            const hadOpen = !!(wm0 && wm0.classList.contains('dshwv-menu-open'))
            if (wm0) {
              // 把菜单摆到"和米粒面板纵向重叠"的位置 —— 真实使用时两个面板都在她旁边，
              // 正是这种情形（这里自检从没开过菜单，它一直停在 0,0）。
              try {
                const pm0 = q('.dshrice-menu')
                const pr0 = pm0 ? pm0.getBoundingClientRect() : null
                const hmw = wm0.offsetWidth || 243
                const hir = q('img.dshwv-img').getBoundingClientRect()
                wm0.style.left = Math.max(8, Math.round(hir.left - hmw - 10)) + 'px'
                wm0.style.top = Math.round((pr0 ? pr0.top : hir.top) + 60) + 'px'
              } catch (e) {}
              wm0.classList.add('dshwv-menu-open')
            }
            await sleep(500)
            for (let i = 0; i < 12; i++) {
              const p = q('.dshrice-menu.dshrice-open')
              if (!p) break
              const pcs = getComputedStyle(p)
              samples.push((parseFloat(pcs.left) || 0) + '|' + (parseFloat(pcs.marginLeft) || 0))
              await sleep(250)      // 覆盖 3 秒 > placeMenu 的 700ms 周期
            }
            // 诊断：两个面板各自的矩形 —— **必须在收起菜单之前量**，
            // 否则 keepPanelClear 已经把 margin 归零了，量到的不是避让后的状态。
            const pm = q('.dshrice-menu.dshrice-open')
            const wm = q('.dshwv-menu')
            const rct = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } }
            out.ricePanelRect = rct(pm)
            out.whaleMenuRect = rct(wm)
            if (wm0 && !hadOpen) wm0.classList.remove('dshwv-menu-open')
            out.ricePanelSamples = samples
            out.ricePanelDistinct = Array.from(new Set(samples)).length

            // —— 点空白处要能关掉面板 ——
            // rice 自己就有 document 上的 click 处理器（点在面板/标签之外就关）。
            // 真正的问题在**窗口穿透**：面板之外是穿透的，点击落到桌面上、
            // 页面收不到 —— 所以 shell.js 里加了"面板开着时整窗接收鼠标事件"。
            // 这里先验证"点击能关"，再验证"判定函数在面板开着时确实返回可交互"。
            out.interactiveWhilePanelOpen = window.__petShellEvaluate
              ? window.__petShellEvaluate(5, 5) : null
            const pm2 = q('.dshrice-menu.dshrice-open')
            const pr2 = pm2 ? pm2.getBoundingClientRect() : null
            const ox = pr2 ? Math.max(2, Math.round(pr2.left - 40)) : 5
            const oy = pr2 ? Math.round(pr2.top + 10) : 5
            document.body.dispatchEvent(new MouseEvent('click', {
              bubbles: true, cancelable: true, clientX: ox, clientY: oy,
            }))
            await sleep(400)
            out.riceClosedByOutsideClick = !q('.dshrice-menu.dshrice-open')

            // —— 点面板里的控件必须**真的有反应** ——
            // 这是用户报的"点了相关功能没反应"的直接判据：
            // 之前我们的拖拽接管会把面板上的 pointerup stopImmediatePropagation 掉，
            // 于是 click 永远不触发 —— 面板看着在，点什么都没用。
            try {
              // 上面那条"点空白处关闭"的测试可能已经把面板关掉了 —— 先确保它是开的
              if (!q('.dshrice-menu.dshrice-open')) {
                const chipRe = q('.dshrice-chip')
                if (chipRe) chipRe.click()
                await sleep(400)
              }
              const pmc = q('.dshrice-menu.dshrice-open')
              const boxes = pmc ? pmc.querySelectorAll('input[type="checkbox"]') : []
              if (boxes.length) {
                const b0 = boxes[0]
                const before = b0.checked
                out.riceCtlBefore = before
                // 按真实坐标派发（面板会挡住她，正是最容易误判成拖拽的情形）
                const br = b0.getBoundingClientRect()
                const bx = Math.round(br.left + br.width / 2)
                const by = Math.round(br.top + br.height / 2)
                const mkC = (type) => new PointerEvent(type, {
                  bubbles: true, cancelable: true, clientX: bx, clientY: by,
                  screenX: bx + (window.screenX || 0), screenY: by + (window.screenY || 0),
                  button: 0, buttons: type === 'pointerdown' ? 1 : 0,
                  pointerType: 'mouse', pointerId: 21, isPrimary: true,
                })
                const tgt = document.elementFromPoint(bx, by) || b0
                tgt.dispatchEvent(mkC('pointerdown'))
                await sleep(60)
                document.dispatchEvent(mkC('pointermove'))
                await sleep(60)
                document.dispatchEvent(mkC('pointerup'))
                await sleep(60)
                // click 要单独派发（浏览器里 pointerup 之后才会合成 click）
                b0.dispatchEvent(new MouseEvent('click', {
                  bubbles: true, cancelable: true, clientX: bx, clientY: by,
                }))
                await sleep(200)
                out.riceCtlAfter = b0.checked
                out.riceCtlResponded = b0.checked !== before
                out.ricePanelStillOpen = !!q('.dshrice-menu.dshrice-open')
                out.ricePhysPosDuringClick = ph._state().pos
              }
            } catch (e) { out.riceCtlError = String(e && e.message) }

            // —— 【桌宠版】唱歌那一行：音乐按钮 + 下拉选择栏 ——
            try {
              if (!q('.dshrice-menu.dshrice-open')) {
                const chipR2 = q('.dshrice-chip')
                if (chipR2) chipR2.click()
                await sleep(400)
              }
              const pmu = q('.dshrice-menu.dshrice-open')
              out.songOldNoteGone = !(pmu && pmu.textContent.indexOf('歌放在 songs/ 文件夹里') >= 0)
              const folderBtn = pmu ? pmu.querySelector('.dshpet-songpick') : null
              const defBtn = pmu ? pmu.querySelector('.dshpet-songdef') : null
              out.songFolderBtn = folderBtn ? folderBtn.textContent : null
              out.songDefBtn = defBtn ? defBtn.textContent : null
              const selEl = pmu ? pmu.querySelector('.dshpet-songsel') : null
              const listEl = pmu ? pmu.querySelector('.dshpet-songlist') : null
              out.songSelExists = !!selEl
              out.songSelLabel = selEl ? selEl.textContent.trim() : null
              out.songListHiddenBefore = listEl ? (getComputedStyle(listEl).display === 'none') : null
              // 点选择栏 → 二级菜单应该在**它下面**展开
              if (selEl) {
                const sr = selEl.getBoundingClientRect()
                selEl.dispatchEvent(new MouseEvent('click', {
                  bubbles: true, cancelable: true,
                  clientX: Math.round(sr.left + sr.width / 2), clientY: Math.round(sr.top + sr.height / 2),
                }))
                await sleep(500)
              }
              const listEl2 = pmu ? pmu.querySelector('.dshpet-songlist') : null
              out.songListShownAfter = listEl2 ? (getComputedStyle(listEl2).display !== 'none') : null
              const items = listEl2 ? listEl2.querySelectorAll('.dshpet-songitem') : []
              out.songItemCount = items.length
              out.songItemNames = []
              for (let i = 0; i < items.length; i++) out.songItemNames.push(items[i].textContent)
              // 二级菜单必须在选择栏**下面**（top 更大）
              if (selEl && listEl2) {
                out.songListBelowSel =
                  listEl2.getBoundingClientRect().top >= selEl.getBoundingClientRect().bottom - 2
              }
              // 点第一首**真歌**（跳过置顶的"随机播放"）→ 应该被选中
              if (items.length > 1) {
                const it0 = items[1]
                const ir0 = it0.getBoundingClientRect()
                it0.dispatchEvent(new MouseEvent('click', {
                  bubbles: true, cancelable: true,
                  clientX: Math.round(ir0.left + ir0.width / 2), clientY: Math.round(ir0.top + ir0.height / 2),
                }))
                await sleep(500)
                out.songPickedName = it0.textContent
                out.songPickedFile = it0.getAttribute('data-song')
              }
              // ★ 关键：选完之后，**rice 取到的歌单应该只剩这一首** ——
              // 这就是"选哪首就唱哪首"的实现方式（拦 fetch，不改 vendor）。
              try {
                const jr = await (await fetch('/dsh-rice/songs.json', { cache: 'no-store' })).json()
                out.songsAfterPick = ((jr && jr.songs) || []).map(function (s) { return s.file })
              } catch (e) { out.songsAfterPickError = String(e && e.message) }
              // 再选回「随机播放」→ 歌单应该恢复成全部
              // ⚠️ 必须**重新查询**节点：上一步选完歌后列表被重建了，
              //    还拿着旧引用去 click 是点不到任何东西的（这条断言第一次就是这么假失败的）。
              const selNow = q('.dshpet-songsel')
              if (selNow) {
                selNow.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
                await sleep(400)
              }
              const listNow = q('.dshpet-songlist')
              const itemsNow = listNow ? listNow.querySelectorAll('.dshpet-songitem') : []
              if (itemsNow.length) {
                const rndIt = itemsNow[0]
                out.songRandomItemText = rndIt.textContent
                const rr2 = rndIt.getBoundingClientRect()
                rndIt.dispatchEvent(new MouseEvent('click', {
                  bubbles: true, cancelable: true,
                  clientX: Math.round(rr2.left + rr2.width / 2), clientY: Math.round(rr2.top + rr2.height / 2),
                }))
                await sleep(400)
                try {
                  const jr2 = await (await fetch('/dsh-rice/songs.json', { cache: 'no-store' })).json()
                  out.songsAfterRandom = ((jr2 && jr2.songs) || []).map(function (s) { return s.file })
                } catch (e) {}
                out.songLabelBackToRandom = (q('.dshpet-songsel-label') || {}).textContent
              }
              const selEl3 = pmu ? pmu.querySelector('.dshpet-songsel-label') : null
              out.songSelLabelAfter = selEl3 ? selEl3.textContent : null
              const listEl3 = pmu ? pmu.querySelector('.dshpet-songlist') : null
              out.songListClosedAfterPick = listEl3 ? (getComputedStyle(listEl3).display === 'none') : null
            } catch (e) { out.songError = String(e && e.message) }

            const c2 = q('.dshrice-chip')
            if (c2 && !out.riceClosedByOutsideClick) c2.click()   // 兜底关掉
            await sleep(400)
            out.ricePanelClosedAgain = !q('.dshrice-menu.dshrice-open')
          }
        } catch (e) { out.riceEntryError = String(e && e.message) }

        // ================================================================
        // 【用户报的】① 唱歌「最少隔」右边的「分钟」有时错位到下一行
        // ================================================================
        // 判据不是"看起来对"，而是量几何：
        //   · 这一行里所有子元素（文字节点除外）的**竖直中心**必须一致
        //     → 说明它们在同一行
        //   · 而且要在**把面板压到很窄**的情况下也成立
        //     → 才叫"无论如何都不会错位"（旧代码就是内容刚好超一点就换行）
        try {
          // 先把面板打开（上面那些用例把它关掉了）
          if (!q('.dshrice-menu.dshrice-open')) {
            const chipA = q('.dshrice-chip')
            if (chipA) chipA.click()
            await sleep(500)
          }
          const pmA = q('.dshrice-menu.dshrice-open')
          out.layoutPanel = !!pmA
          if (pmA) {
            // 找到「最少隔」那一行（按文本定位，不依赖行序）
            let targetRow = null
            const allRows = pmA.querySelectorAll('.dshrice-row')
            for (let i = 0; i < allRows.length; i++) {
              if ((allRows[i].textContent || '').indexOf('最少隔') >= 0) { targetRow = allRows[i]; break }
            }
            out.layoutRowFound = !!targetRow
            out.layoutRowClass = targetRow ? targetRow.className : null
            out.layoutRangeRowCount = window.__dshpetRiceLayout ? window.__dshpetRiceLayout.count() : null
            if (targetRow) {
              // ⚠️⚠️ **必须先把它所在的分组展开！**
              //    rice 的分组是折叠的（.dshrice-grp-b 是 display:none，靠
              //    .dshrice-grp-open 才展开）。折叠时子元素 rect 全是 0 ——
              //    第一版就是这么写的，量出来 kids=[]、spread=0，
              //    于是断言**空过**（看起来全绿，其实什么都没测）。
              const grp = targetRow.closest ? targetRow.closest('.dshrice-grp') : null
              if (grp && !grp.classList.contains('dshrice-grp-open')) {
                const gh = grp.querySelector('.dshrice-grp-h')
                if (gh) { gh.click(); await sleep(350) }
                else grp.classList.add('dshrice-grp-open')
              }
              await sleep(200)
              out.layoutGroupOpen = !!(grp && grp.classList.contains('dshrice-grp-open'))
              // 量"这一行里所有可见子元素是不是在同一条水平线上"
              const sameLine = (row) => {
                const kids = []
                for (let i = 0; i < row.children.length; i++) {
                  const el = row.children[i]
                  const r = el.getBoundingClientRect()
                  if (!r.width && !r.height) continue
                  kids.push({ tag: el.tagName, cls: String(el.className || ''), cy: Math.round(r.top + r.height / 2), top: Math.round(r.top), h: Math.round(r.height) })
                }
                const cys = kids.map((k) => k.cy)
                return { kids, spread: cys.length ? (Math.max.apply(null, cys) - Math.min.apply(null, cys)) : -1 }
              }
              const norm = sameLine(targetRow)
              out.layoutNormal = { spread: norm.spread, kids: norm.kids }
              // 单位那一段在不在同一行（spread 就是"最大竖直中心差"）
              // ⚠️ 同时要求"至少量到 2 个子元素"—— 否则就是空过（见上面那段注释）
              out.layoutNormalSameLine = norm.kids.length >= 2 && norm.spread <= 2

              // —— 关键：把面板压窄，逼出"内容刚好超一点"那个条件 ——
              const savedW = pmA.style.width
              const savedMaxW = pmA.style.maxWidth
              pmA.style.width = '190px'
              pmA.style.maxWidth = '190px'
              await sleep(250)
              const narrow = sameLine(targetRow)
              out.layoutNarrow = { spread: narrow.spread, kids: narrow.kids }
              out.layoutNarrowSameLine = narrow.kids.length >= 2 && narrow.spread <= 2
              // 顺带量一下有没有横向溢出（滑块应该被压缩，而不是把单位顶出去）
              out.layoutNarrowOverflow = targetRow.scrollWidth > targetRow.clientWidth + 1
              pmA.style.width = savedW
              pmA.style.maxWidth = savedMaxW
              await sleep(200)
              const back = sameLine(targetRow)
              out.layoutRestoredSameLine = back.kids.length >= 2 && back.spread <= 2
            }
          }
        } catch (e) { out.layoutError = String(e && e.message) }

        // ================================================================
        // 【用户报的】② 关闭物理拖动时点米粒菜单里的功能没反应 + 菜单被关
        // ================================================================
        // 根因（实测抓到的数据）：在面板里按下控件的那一刻，鲸鱼自己的
        // onDocPointerDown 会把 ☰ 菜单关掉 → 旧代码 keepPanelClear() 顺势把
        // "避让位移"归零 → 面板横向弹回 233px → 抬起时指针底下已经不是那个控件
        // → click 落到 BODY（控件没反应）+ rice 判定"点外面"把面板关了。
        // 位移只发生在"按下→抬起"这几十~一百多毫秒里，所以表现为"有时"。
        // 这里就**照这个时序量**：按下、等一会儿、再抬起，看面板挪没挪窝。
        try {
          if (window.__dshpetPhysics) window.__dshpetPhysics.setEnabled(false)
          await sleep(300)
          out.pgPhysicsOff = window.__dshpetPhysics ? window.__dshpetPhysics.isEnabled() : null
          // 打开桌宠菜单（面板要和"开着的菜单"一起存在，才复现得出避让位移）
          const wmP = q('.dshwv-menu')
          if (wmP && !wmP.classList.contains('dshwv-menu-open')) {
            const mbP = q('.dshwv-menu-btn')
            if (mbP) { mbP.click(); await sleep(500) }
          }
          if (!q('.dshrice-menu.dshrice-open')) {
            const chipP = q('.dshrice-chip')
            if (chipP) chipP.click()
            await sleep(600)
          }
          const pmP = q('.dshrice-menu.dshrice-open')
          if (pmP) {
            const boxes = pmP.querySelectorAll('input[type=checkbox]')
            const ctl = boxes[0]
            if (ctl) {
              const cr = ctl.getBoundingClientRect()
              const cx = Math.round(cr.left + cr.width / 2)
              const cy = Math.round(cr.top + cr.height / 2)
              const rectP = (el) => { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top) } }
              out.pgPanelAtPress = rectP(pmP)
              out.pgBefore = ctl.checked
              const tgtP = document.elementFromPoint(cx, cy) || ctl
              out.pgElemAtPress = tgtP.tagName + '.' + String(tgtP.className || '').slice(0, 30)
              const mkP = (type, extra) => new PointerEvent(type, Object.assign({
                bubbles: true, cancelable: true, clientX: cx, clientY: cy,
                screenX: cx + (window.screenX || 0), screenY: cy + (window.screenY || 0),
                button: 0, pointerType: 'mouse', pointerId: 401, isPrimary: true,
              }, extra || {}))
              tgtP.dispatchEvent(mkP('pointerdown', { buttons: 1 }))
              // 真人在按下与抬起之间会停几十~一百多毫秒 —— 必须等够，
              // 否则永远撞不上 keepPanelClear 那 150ms 的一次 tick（也就复现不出来）
              await sleep(160)
              out.pgPanelAtRelease = rectP(pmP)
              const tgtP2 = document.elementFromPoint(cx, cy)
              out.pgElemAtRelease = tgtP2 ? (tgtP2.tagName + '.' + String(tgtP2.className || '').slice(0, 30)) : null
              document.dispatchEvent(mkP('pointerup', { buttons: 0 }))
              // 真实浏览器会把 click 派发到"按下/抬起目标的最近公共祖先"——
              // 这里照做，才能验证"控件到底收不收得到这一下"
              const common = (tgtP2 && tgtP2 !== tgtP && tgtP.contains(tgtP2)) ? tgtP2 : tgtP
              common.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }))
              await sleep(250)
              out.pgPanelDrift = Math.abs(out.pgPanelAtRelease.l - out.pgPanelAtPress.l) +
                                 Math.abs(out.pgPanelAtRelease.t - out.pgPanelAtPress.t)
              out.pgAfter = ctl.checked
              out.pgResponded = ctl.checked !== out.pgBefore
              out.pgPanelStillOpen = !!q('.dshrice-menu.dshrice-open')
            }
          }
        } catch (e) { out.pgError = String(e && e.message) }

        // ================================================================
        // 【新功能】识别歌曲和作者：菜单开关 + 气泡（歌名一行、作者一行、都居中）
        // ================================================================
        // 本机没装那三个播放器，所以"识别"那半条链路的端到端没法测；
        // 这里分两段验：
        //   · 挑歌逻辑（纯函数 pickSong）—— 用假会话数据测，见下面的主进程断言
        //   · 气泡渲染 —— 直接调 window.__dshpetNowPlaying.show()，量几何
        try {
          out.npApiExists = !!(window.petApi && typeof window.petApi.nowPlayingSet === 'function' &&
                               typeof window.petApi.onNowPlaying === 'function')
          out.npMenuRow = !!q('.dshpet-np-row')
          out.npMenuLabel = (q('.dshpet-np-row span') || {}).textContent || null
          out.npMenuHasCheckbox = !!(q('.dshpet-np-row input[type=checkbox]'))
          out.npModuleLoaded = !!window.__dshpetNowPlaying

          // —— 打开开关，验主进程真的把轮询起起来了 ——
          let sw = null
          if (window.petApi && window.petApi.nowPlayingSet) {
            sw = await window.petApi.nowPlayingSet(true)
          }
          out.npEnableResult = sw
          await sleep(400)
          const st1 = await (window.petApi.nowPlayingGet ? window.petApi.nowPlayingGet() : Promise.resolve(null))
          out.npEnabledAfterOn = st1 && st1.enabled
          // 给它时间把 PowerShell 拉起来
          await sleep(3500)

          // —— 弹气泡（长歌名 + 长作者名，专门压"会不会冲出泡泡"）——
          const LONG_TITLE = '夜的第七章（现场版·超长歌名压力测试专用版本）'
          const LONG_ARTIST = '周杰伦 & 费玉清 & 某某某合唱团（超长作者名压力测试）'
          out.npShown = window.__dshpetNowPlaying
            ? window.__dshpetNowPlaying.show({ title: LONG_TITLE, artist: LONG_ARTIST })
            : false
          await sleep(700)
          const bubble = q('.dshpet-np-pop')
          out.npBubbleExists = !!bubble
          out.npBubbleOpen = !!(bubble && bubble.classList.contains('dshpet-np-open'))
          if (bubble) {
            const t = q('.dshpet-np-title')
            const a = q('.dshpet-np-artist')
            const tb = q('.dshpet-np-text')
            out.npTitleText = t ? t.textContent : null
            out.npArtistText = a ? a.textContent : null
            // ① 作者必须**换行**（单独一行）：两行的竖直中心必须不同
            if (t && a) {
              const rt = t.getBoundingClientRect(), ra = a.getBoundingClientRect()
              out.npTitleCenterY = Math.round(rt.top + rt.height / 2)
              out.npArtistCenterY = Math.round(ra.top + ra.height / 2)
              out.npArtistOnOwnLine = out.npArtistCenterY > out.npTitleCenterY + 4
            }
            // ② 每一行都必须**居中**：行的左右边距要对称（±2px），
            //    且行内文字的 text-align 是 center
            const centered = (el) => {
              if (!el || !tb) return null
              const r = el.getBoundingClientRect(), p = tb.getBoundingClientRect()
              return {
                leftGap: Math.round(r.left - p.left),
                rightGap: Math.round(p.right - r.right),
                textAlign: getComputedStyle(el).textAlign,
              }
            }
            out.npTitleCentered = centered(t)
            out.npArtistCentered = centered(a)
            const sym = (c) => !!c && Math.abs(c.leftGap - c.rightGap) <= 2 && c.textAlign === 'center'
            out.npTitleIsCentered = sym(out.npTitleCentered)
            out.npArtistIsCentered = sym(out.npArtistCentered)
            // ③ 所有字都要**留在气泡里**：文字块不许溢出它的容器
            // ⚠️ 不能用 scrollHeight 量纵向溢出 —— 文字区是居中的 flex 列，
            //    超高时上下两头一起溢出，scrollHeight 只算末端方向，超了也量不出来
            //    （正是这个假象让"字号一档都没缩"看起来是"装得下"）。
            //    这里和实现里一样：把子元素高度加起来。
            if (tb) {
              const realContentH = (() => {
                let need = 0
                for (let i = 0; i < tb.children.length; i++) {
                  const el = tb.children[i]
                  const cs = getComputedStyle(el)
                  if (cs.display === 'none') continue
                  need += el.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0)
                }
                return need
              })()
              out.npTextOverflowX = tb.scrollWidth - tb.clientWidth
              out.npTextOverflowY = Math.round(realContentH - tb.clientHeight)
              out.npTextFits = out.npTextOverflowX <= 1 && out.npTextOverflowY <= 1
              out.npScale = parseFloat(getComputedStyle(tb).getPropertyValue('--dshpet-np-scale')) || 1
            }
            // ④ 文字块要落在泡泡**主体**范围内（不能压到描边外面/飘到尾巴上）
            const svgShape = bubble.querySelector('.dshpet-np-bshape')
            if (svgShape && tb && typeof svgShape.getBBox === 'function') {
              const bb = svgShape.getBBox()
              const popRect = bubble.getBoundingClientRect()
              const sx = popRect.width / 1026, sy = popRect.height / 700
              out.npShapeRect = {
                l: Math.round(popRect.left + bb.x * sx), t: Math.round(popRect.top + bb.y * sy),
                r: Math.round(popRect.left + (bb.x + bb.width) * sx),
                b: Math.round(popRect.top + (bb.y + bb.height) * sy),
              }
              const tr = tb.getBoundingClientRect()
              out.npTextRect = { l: Math.round(tr.left), t: Math.round(tr.top), r: Math.round(tr.right), b: Math.round(tr.bottom) }
              out.npTextInsideBubble = tr.left >= out.npShapeRect.l - 2 && tr.right <= out.npShapeRect.r + 2 &&
                                       tr.top >= out.npShapeRect.t - 2 && tr.bottom <= out.npShapeRect.b + 2
            }
          }

          // —— 关掉开关：气泡要立刻收起，主进程也要停掉轮询 ——
          if (window.__dshpetNowPlaying) window.__dshpetNowPlaying.hide()
          await sleep(300)
          out.npHiddenAfterHide = !(q('.dshpet-np-pop') || {}).classList ||
            !q('.dshpet-np-pop').classList.contains('dshpet-np-open')
          const sw2 = await (window.petApi.nowPlayingSet ? window.petApi.nowPlayingSet(false) : Promise.resolve(null))
          out.npDisableResult = sw2
          await sleep(300)
          const st2 = await (window.petApi.nowPlayingGet ? window.petApi.nowPlayingGet() : Promise.resolve(null))
          out.npEnabledAfterOff = st2 && st2.enabled
        } catch (e) { out.npError = String(e && e.message) }

        // ================================================================
        // 【新功能】识别歌词：开关在「识别歌曲和作者」下面，歌词一句接一句
        // ================================================================
        try {
          const rows = document.querySelectorAll('.dshpet-np-row')
          out.lyRowCount = rows.length
          out.lyLabels = []
          for (let i = 0; i < rows.length; i++) {
            const sp = rows[i].querySelector('span')
            out.lyLabels.push(sp ? sp.textContent : null)
          }
          out.lyRowBelowSong = rows.length >= 2 &&
            rows[1].previousElementSibling === rows[0] &&
            (rows[1].compareDocumentPosition(rows[0]) & Node.DOCUMENT_POSITION_PRECEDING) !== 0
          out.lyHasCheckbox = rows.length >= 2 && !!rows[1].querySelector('input[type=checkbox]')
          out.lyApiExists = !!(window.petApi && typeof window.petApi.nowPlayingLyricsSet === 'function' &&
                               typeof window.petApi.nowPlayingLyricsGet === 'function')

          // —— 开关能开能关 ——
          const l1 = await (window.petApi.nowPlayingLyricsSet ? window.petApi.nowPlayingLyricsSet(true) : Promise.resolve(null))
          out.lyEnableResult = l1
          await sleep(250)
          const lg1 = await (window.petApi.nowPlayingLyricsGet ? window.petApi.nowPlayingLyricsGet() : Promise.resolve(null))
          out.lyEnabledAfterOn = lg1 && lg1.enabled
          const l0 = await (window.petApi.nowPlayingLyricsSet ? window.petApi.nowPlayingLyricsSet(false) : Promise.resolve(null))
          out.lyDisableResult = l0
          await sleep(250)
          const lg0 = await (window.petApi.nowPlayingLyricsGet ? window.petApi.nowPlayingLyricsGet() : Promise.resolve(null))
          out.lyEnabledAfterOff = lg0 && lg0.enabled

          // —— "一句接一句"：灌一段带时间轴的歌词，看不同播放位置显示不同句 ——
          const expNp = window.__dshpetNowPlaying
          if (expNp && expNp.setLyricsForTest) {
            // 先把歌词开关打开（版式才会切到歌词模式）
            try { localStorage.setItem('dshpet-now-lyrics', '1') } catch (e) {}
            expNp.show({ title: '测试歌名', artist: '测试歌手', pos: 0, dur: 100, lyrics: [], lyricsState: 'none' })
            await sleep(200)
            const TEST_LINES = [
              { t: 0, text: '第一句歌词' },
              { t: 5, text: '第二句歌词' },
              { t: 10, text: '第三句歌词' },
            ]
            expNp.setLyricsForTest(TEST_LINES, 0)
            await sleep(350)
            out.lyHead = expNp.lyricHead()
            out.lyLineAt0 = expNp.lyricLine()
            // 把基准位置拨到 5.5 秒 —— 应该换成第二句
            expNp.setLyricsForTest(TEST_LINES, 5.5)
            await sleep(350)
            out.lyLineAt55 = expNp.lyricLine()
            expNp.setLyricsForTest(TEST_LINES, 10.2)
            await sleep(350)
            out.lyLineAt102 = expNp.lyricLine()
            out.lyStateInfo = expNp.lyricState()
            // 歌词那一行的几何：居中 + 不溢出
            const lb = q('.dshpet-np-pop')
            const lt = q('.dshpet-np-lyric')
            const ltb = q('.dshpet-np-text')
            if (lb && lt && ltb) {
              const r = lt.getBoundingClientRect(), p2 = ltb.getBoundingClientRect()
              out.lyRect = { leftGap: Math.round(r.left - p2.left), rightGap: Math.round(p2.right - r.right), textAlign: getComputedStyle(lt).textAlign }
              out.lyCentered = Math.abs(out.lyRect.leftGap - out.lyRect.rightGap) <= 2 && out.lyRect.textAlign === 'center'
              // 同样按"子元素高度之和"量纵向（理由见上面 npTextOverflowY 的说明）
              const realH = (() => {
                let need = 0
                for (let i = 0; i < ltb.children.length; i++) {
                  const el = ltb.children[i]
                  const cs = getComputedStyle(el)
                  if (cs.display === 'none') continue
                  need += el.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0)
                }
                return need
              })()
              out.lyOverflow = { x: ltb.scrollWidth - ltb.clientWidth, y: Math.round(realH - ltb.clientHeight) }
              out.lyFits = out.lyOverflow.x <= 1 && out.lyOverflow.y <= 1
              out.lyHeadText = q('.dshpet-np-lyhead') ? q('.dshpet-np-lyhead').textContent : null
            }
            expNp.hide()
            try { localStorage.setItem('dshpet-now-lyrics', '0') } catch (e) {}
          }
        } catch (e) { out.lyError = String(e && e.message) }

        // ================================================================
        // 【新功能】「笑一下」贴图：偷吃成功 / 余额 <5 <1 ==0 → 换图 2 秒再还原
        // ================================================================
        try {
          const LS = window.__dshpetLaughSprite
          out.laughLoaded = !!LS
          try { const r = await fetch('/whale-sprite-laugh.png', { cache: 'no-store' }); out.laughImgStatus = r.status } catch (e) { out.laughImgStatus = 0 }
          if (LS) {
            const img2 = q('img.dshwv-img')
            const cur = () => String((img2 && img2.getAttribute('src')) || '')
            // ⚠️ 先停掉眨眼：它每隔 4~6 秒会往 img.src 上写一帧（半闭/全闭/半睁），
            //    而下面要量"2 秒后是不是还原成原来那张" —— 恰好量到眨眼那帧就会**偶发**失败。
            const expI = window.__dshpetWhaleExp && window.__dshpetWhaleExp._internal
            if (expI && expI.blinkPause) expI.blinkPause()
            await sleep(300)
            const b = cur()
            out.laughSrcBefore = b
            LS.laugh('自检')
            await sleep(250)
            out.laughSrcDuring = cur()
            await sleep(2100)
            out.laughSrcAfter = cur()
            // 还原的目标是"形象状态机此刻本该显示的那张"——这才是"原来那张"的准确定义
            // （眨眼过路帧是瞬时的，不该被当成"原来那张"）
            try {
              const dsi = window.__dshpetWhaleExp && window.__dshpetWhaleExp._internal
              out.laughDesired = dsi && dsi.desiredSrc ? String(dsi.desiredSrc() || '') : ''
            } catch (e) { out.laughDesired = '' }
            // 2 秒内连触发两次 → 仍还原成最初那张
            LS.laugh('a'); await sleep(900); LS.laugh('b'); await sleep(2300)
            out.laughSrcAfterDouble = cur()
            // 余额三阈值
            LS.restore(); await sleep(200)
            const seq = [[10, 0], [4.9, 1], [4.5, 0], [0.9, 1], [0.5, 0], [0, 1], [0, 0], [50, 0], [4.9, 1]]
            const log = []
            const mism = []
            for (const [v, want] of seq) {
              LS.restore(); await sleep(100)
              LS.feedBalance(v)
              await sleep(130)
              const fired = LS.isShowing()
              log.push(v + (fired ? '→笑' : '→不笑'))
              if ((want === 1) !== fired) mism.push({ v, want, got: fired })
              LS.restore(); await sleep(100)
            }
            out.laughBalanceLog = log
            out.laughBalanceMismatch = mism
            // —— 米粒图必须和贴图**同步**：笑的时候一起消失、恢复的时候一起出现 ——
            const grain0 = q('.dshrice-grain')
            if (grain0) {
              const setG = async (c) => { grain0.className = c; await sleep(180) }
              await setG('dshrice-grain dshrice-grain-show')
              LS.laugh('grain')
              await sleep(260)
              out.laughGrainHiddenDuring = LS.grainHidden()
              await sleep(2200)
              out.laughGrainHiddenAfter = LS.grainHidden()
              out.laughGrainShownAfter = LS.grainShown()
              // 笑的过程中 rice 自己到点收掉 → 恢复时要补回来
              await setG('dshrice-grain dshrice-grain-show')
              LS.laugh('grain2')
              await sleep(300)
              grain0.className = 'dshrice-grain'
              await sleep(1900)
              out.laughGrainReshown = LS.grainShown()
              await sleep(LS.grainMs() + 600)
              out.laughGrainReshownGone = LS.grainShown()
              LS.restore(); await sleep(200)
              await setG('dshrice-grain')
            }
            // 偷吃成功 / 被打断 / 没吃到嘴
            LS.restore(); await sleep(150)
            const bowl2 = q('.dshrice-bowl')
            const grain2 = q('.dshrice-grain')
            out.laughBowlExists = !!bowl2 && !!grain2
            if (bowl2 && grain2) {
              const setC = async (el, c) => { el.className = c; await sleep(90) }
              const B = 'dshrice-bowl', G = 'dshrice-grain'
              await setC(bowl2, B); await setC(grain2, G)
              await setC(bowl2, B + ' dshrice-up'); await setC(grain2, G + ' dshrice-grain-show'); await setC(bowl2, B)
              await sleep(280)
              out.laughOnSuccess = LS.isShowing()
              LS.restore(); await sleep(200)
              await setC(bowl2, B); await setC(grain2, G)
              await setC(bowl2, B + ' dshrice-up'); await setC(grain2, G + ' dshrice-grain-show')
              await setC(bowl2, B + ' dshrice-up dshrice-spill'); await setC(bowl2, B)
              await sleep(280)
              out.laughOnSpill = LS.isShowing()
              LS.restore(); await sleep(200)
              await setC(bowl2, B); await setC(grain2, G)
              await setC(bowl2, B + ' dshrice-up'); await setC(bowl2, B)
              await sleep(280)
              out.laughOnAbort = LS.isShowing()
              LS.restore()
            }
            // 放眨眼回去（不然后面那些用例里她一直不眨眼）
            if (expI && expI.blinkResume) expI.blinkResume()
          }
        } catch (e) { out.laughError = String(e && e.message) }

        // ================================================================
        // 【新功能】内置泡泡图：vendor/whale/assets 下那 24 张图
        // ================================================================
        try {
          const r = await fetch('/dsh-whale/bubble-imgs.json', { cache: 'no-store' })
          const d = await r.json()
          out.bimgOk = !!(d && d.ok && Array.isArray(d.images))
          out.bimgTotal = (d && d.images) ? d.images.length : 0
          const mine = (d && d.images ? d.images : []).filter((im) => im && im.builtin === true && String(im.id).indexOf('bimg_') === 0 &&
            im.id !== 'bimg_petpet' && im.id !== 'bimg_money1')
          out.bimgMineCount = mine.length
          out.bimgMineIds = mine.map((im) => im.id)
          // 内置图必须排在最前面（客户端把内置图列在用户图库之前）
          const firstUserIdx = (d.images || []).findIndex((im) => im && !im.builtin)
          out.bimgBuiltinsFirst = firstUserIdx < 0 || (d.images || []).slice(0, firstUserIdx).every((im) => im.builtin)
          // 每一张都真的取一遍
          // ⚠️ 这里只要求"是图片"，**不要求必须是 PNG** —— 那 24 张里有 15 张其实是
          //    JPEG（文件名是 .png），Content-Type 现在会如实报 image/jpeg。
          //    断言写成"必须 image/png"会在修好 Content-Type 之后假红。
          const bad = []
          let okN = 0
          for (const im of mine) {
            try {
              const rr = await fetch(im.url, { cache: 'no-store' })
              const ct = rr.headers.get('content-type') || ''
              const buf = await rr.arrayBuffer()
              const b = new Uint8Array(buf)
              const isImg = (b[0] === 0x89 && b[1] === 0x50) || (b[0] === 0xFF && b[1] === 0xD8) ||
                (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46)
              if (rr.status === 200 && ct.indexOf('image/') === 0 && isImg && buf.byteLength > 1000) okN++
              else bad.push(im.id + ':status' + rr.status + ':ct' + ct + ':len' + buf.byteLength)
            } catch (e) { bad.push(im.id + ':err') }
          }
          out.bimgOkCount = okN
          out.bimgBad = bad
          // 挂件自己那两张内置图不能被我们弄坏
          const keep = (d.images || []).filter((im) => im && (im.id === 'bimg_petpet' || im.id === 'bimg_money1'))
          out.bimgKeepCount = keep.length
          let keepOk = 0
          for (const im of keep) {
            try { const rr = await fetch(im.url, { cache: 'no-store' }); if (rr.status === 200) keepOk++ } catch (e) {}
          }
          out.bimgKeepOk = keepOk
          // —— 声明的 Content-Type 必须和**真实文件头**一致 ——
          // 这 24 张里有 15 张其实是 JPEG（文件名却是 .png，是"改后缀"不是真转码）。
          // 浏览器自己能嗅探所以画得出来，但标错类型会让"图片另存为"存出
          // 一个名叫 .png 实为 JPEG 的文件，别处也可能踩坑。
          const ctBad = []
          for (const im of mine) {
            try {
              const rr = await fetch(im.url, { cache: 'no-store' })
              const ct = String(rr.headers.get('content-type') || '')
              const b = new Uint8Array(await rr.arrayBuffer())
              let real = ''
              if (b[0] === 0x89 && b[1] === 0x50) real = 'image/png'
              else if (b[0] === 0xFF && b[1] === 0xD8) real = 'image/jpeg'
              else if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) real = 'image/gif'
              else real = 'unknown'
              if (ct !== real) ctBad.push(im.id + ': 声明' + ct + ' 实际' + real)
            } catch (e) { ctBad.push(im.id + ': err') }
          }
          out.bimgCtBad = ctBad
          out.bimgCtOk = ctBad.length === 0
          // —— 再验一层：**客户端 UI 里真的能看到它们** ——
          // 打开挂件菜单里的「资源管理」，它会拉同一份清单并把内置图标成「内置图」。
          // 只验接口不算数 —— 面板里点不出来才是用户真正会遇到的问题。
          try {
            const menu = q('.dshwv-menu')
            let openBtn = null
            if (menu) {
              const btns = menu.querySelectorAll('button')
              for (let i = 0; i < btns.length; i++) {
                if (String(btns[i].textContent || '').trim() === '管理') { openBtn = btns[i]; break }
              }
            }
            out.bimgUiBtnFound = !!openBtn
            if (openBtn) {
              openBtn.click()
              await sleep(1000)
              const mask = q('.dshwv-resmask')
              out.bimgUiMaskOpen = !!mask
              if (mask) {
                let n = 0
                const tags = mask.querySelectorAll('.dshwv-restag')
                for (let i = 0; i < tags.length; i++) {
                  if (String(tags[i].textContent || '').indexOf('内置图') >= 0) n++
                }
                out.bimgUiBuiltinTags = n
                // 我们那 24 张的名字也该出现在面板里
                const txt = mask.textContent || ''
                out.bimgUiNameHit = out.bimgMineIds.filter((id) =>
                  txt.indexOf(String(id).replace(/^bimg_/, '')) >= 0).length
                // 关掉：点遮罩本身即可（挂件自己就是这么关的）
                mask.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
                await sleep(300)
              }
            }
          } catch (e) { out.bimgUiError = String(e && e.message) }
        } catch (e) { out.bimgError = String(e && e.message) }

        // ================================================================
        // 「偷吃白饭」原生小标签必须从第一帧就不可点
        // （用户报的"打开桌宠时偶尔弹出偷吃白饭菜单"）
        // ================================================================
        try {
          const chip = q('.dshrice-chip')
          out.chipExists = !!chip
          if (chip) {
            const cs = getComputedStyle(chip)
            out.chipDisplay = cs.display
            // ⚠️ 关键不是"现在藏没藏"，而是**隐藏规则在哪张样式表里**：
            //    写在 rice-entry.js 的 start() 里 = 外壳启动后 4 秒才生效，
            //    那 4 秒它"看不见但能点"；写在 shell.css 里 = 第一帧就生效。
            let inShellCss = false
            let inOtherCss = false
            out.chipSheets = []
            try {
              for (const sheet of document.styleSheets) {
                const href = String(sheet.href || '(inline)')
                let n = -1
                const sels = []
                try {
                  const rs = sheet.cssRules
                  n = rs.length
                  for (let i = 0; i < rs.length; i++) {
                    const st = rs[i] && rs[i].selectorText
                    if (st && st.indexOf('dshrice') >= 0) sels.push(st)
                  }
                } catch (e) { n = -2 }
                out.chipSheets.push({ href: href.slice(-32), rules: n, dshrice: sels.slice(0, 6) })
              }
            } catch (e) {}
            try {
              for (const sheet of document.styleSheets) {
                const href = String(sheet.href || '')
                let rules = null
                try { rules = sheet.cssRules } catch (e) { continue }
                for (let i = 0; i < rules.length; i++) {
                  const r = rules[i]
                  if (!r || r.selectorText !== '.dshrice-chip') continue
                  // ⚠️ 这里**不能用正则**：探针整段是写在模板字符串里的，
                  //    反斜杠-s 在模板字符串里会被当成"未识别转义"而变成 s，
                  //    于是 /display:\s*none/ 变成 /display:s*none/ —— 永远匹配不上。
                  //    （这条断言第一次就是这么假红的。）用 indexOf 最省心。
                  //    另外：注释里**不能出现反引号** —— 那会直接截断这段模板字符串。
                  const txt = String(r.cssText || '')
                  if (txt.indexOf('display') < 0 || txt.indexOf('none') < 0) continue
                  if (href.indexOf('/shell.css') >= 0) inShellCss = true
                  else inOtherCss = true
                }
              }
            } catch (e) {}
            out.chipRuleInShellCss = inShellCss
            out.chipRuleInOtherCss = inOtherCss
            // 它也不能是命中目标
            const rc = chip.getBoundingClientRect()
            const at = (rc.width && rc.height) ? document.elementFromPoint(rc.left + rc.width / 2, rc.top + rc.height / 2) : null
            out.chipIsHitTarget = !!(at && at.classList && at.classList.contains('dshrice-chip'))
            out.chipRect = { l: Math.round(rc.left), t: Math.round(rc.top), w: Math.round(rc.width), h: Math.round(rc.height) }
          }
        } catch (e) { out.chipError = String(e && e.message) }

        // ================================================================
        // 【新功能】默认泡泡序列里的「随机图片」气泡：自动抽一张那 24 张
        // ================================================================
        try {
          const img = q('img.dshwv-img')
          const r0 = img.getBoundingClientRect()
          const cx = Math.round(r0.left + r0.width * 0.45)
          const cy = Math.round(r0.top + r0.height * 0.5)
          const tgt = document.elementFromPoint(cx, cy) || document.body
          const mk = (type, extra) => new PointerEvent(type, Object.assign({
            bubbles: true, cancelable: true, clientX: cx, clientY: cy,
            button: 0, pointerType: 'mouse', pointerId: 902, isPrimary: true,
          }, extra || {}))
          // 点她 = 从队列开头开始；点泡泡 = 往后推进一项（推进挂在泡泡自己的 click 上）
          const clickHer = async () => {
            tgt.dispatchEvent(mk('pointerdown', { buttons: 1 }))
            await sleep(25)
            document.dispatchEvent(mk('pointerup', { buttons: 0 }))
            tgt.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }))
            await sleep(260)
          }
          const clickBubble = async () => {
            const b = q('.dshwv-pop')
            if (!b) return
            b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
            await sleep(260)
          }
          const oursRe = /bimg_(big_coming|curse|dadeyaolaile|dead_fish|deepsleep|dsh|evaluable|fat_fish|go_to_agi|hajimi|kaidian|keai|mama|more_modal|no-money|not_care|ojingjing|ojj|push|push_one_fat_fish|unvaluable|update|virus|yupian|dance|daquan|fanxiangzapen|finish|laowu|many_zapen|meili|meiyong|nongni|not_laughing|pig|sixseven|touken|violate|weiji|youyu|zapen)/
          const seenIds = []
          await clickHer()
          for (let i = 0; i < 14; i++) {
            const m = q('.dshwv-mimg')
            const src = m ? String(m.getAttribute('src') || '') : ''
            if (src) { const mm = /id=([^&]+)/.exec(src); if (mm) seenIds.push(decodeURIComponent(mm[1])) }
            if (!q('.dshwv-pop.dshwv-pop-open')) await clickHer()
            else await clickBubble()
          }
          out.bbSeenIds = seenIds
          out.bbOurs = seenIds.filter((id) => oursRe.test(id)).length
          out.bbDistinctOurs = Array.from(new Set(seenIds.filter((id) => oursRe.test(id)))).length
        } catch (e) { out.bbError = String(e && e.message) }

        // —— 夹取函数：弹簧过冲后也要被拉回界内 ——
        try {
          out.clampFarLeft = ph._clamp(-99999, -99999)
          out.clampFarRight = ph._clamp(99999, 99999)
        } catch (e) {}

        // —— 夹取函数：弹簧过冲后也要被拉回界内 ——
        try {
          out.clampFarLeft = ph._clamp(-99999, -99999)
          out.clampFarRight = ph._clamp(99999, 99999)
        } catch (e) {}

        // —— 可移动范围：立绘要能贴到屏幕四边（用户报的"顶部拖不上去"）——
        out.artOffset = ph._artOffset()
        out.physBounds = ph._bounds()
        out.viewport = { w: window.innerWidth, h: window.innerHeight }
        // 任务栏避让：可达范围的下边界必须止于**工作区**下沿（availHeight），
        // 而不是整屏高度 —— 否则她会被摆到任务栏上、也能拖到任务栏下面。
        out.screenInfo = {
          w: screen.width, h: screen.height,
          availW: screen.availWidth, availH: screen.availHeight,
          availTop: screen.availTop, availLeft: screen.availLeft,
        }

        // —— 真跑一次抛掷：用一个极端初速甩出去，看会不会"飞出去 / 停不下来" ——
        // 这是"乱飞"那类问题的端到端回归。setInterval 在隐藏窗口里照常触发，
        // 所以这个仿真在自检里是真跑的，不是纸面推演。
        const vp0 = { w: window.innerWidth, h: window.innerHeight }
        ph._testThrow(3200, -2400)          // 右上斜抛，接近软上限
        await sleep(1200)
        out.throwMid = ph._state()
        // ⚠️ 要等够久：原程序自己的物理在同样力度下要 **10.2 秒**才静止（见上面基准），
        //    这不是 bug，是它原本的参数（反弹 0.78 + 重力 1400）。等太短会误判成"停不下来"。
        await sleep(11500)
        out.throwEnd = ph._state()
        out.throwBounds = vp0
        const rEnd = q('.dshwv-root') ? q('.dshwv-root').getBoundingClientRect() : null
        out.throwEndRect = rEnd ? { l: Math.round(rEnd.left), t: Math.round(rEnd.top), w: Math.round(rEnd.width), h: Math.round(rEnd.height) } : null

        // ================================================================
        // 【临时诊断】为什么"在她身上连点"到不了形象状态机的监听器？
        // ================================================================
        try {
          const wimgD = q('img.dshwv-img')
          const irD = wimgD.getBoundingClientRect()
          const cxD = Math.round(irD.left + irD.width * 0.45)
          const cyD = Math.round(irD.top + irD.height * 0.5)
          const elD = document.elementFromPoint(cxD, cyD)
          out.dgPoint = { cx: cxD, cy: cyD, ir: { l: Math.round(irD.left), t: Math.round(irD.top), w: Math.round(irD.width), h: Math.round(irD.height) } }
          out.dgElemAtPoint = elD ? (elD.tagName + '#' + (elD.id || '') + '.' + String(elD.className || '').slice(0, 50)) : null
          out.dgElemClosestRoot = !!(elD && elD.closest && elD.closest('.dshwv-root'))
          out.dgWhaleHitAtPoint = (typeof window.__petWhaleHit === 'function') ? window.__petWhaleHit(cxD, cyD) : 'no-fn'
          // 直接在几个候选目标上派发 click，看哪个能进监听器
          const seen = []
          const probeTargets = {
            body: document.body,
            root: q('.dshwv-root'),
            elemAtPoint: elD,
            html: document.documentElement,
          }
          for (const key of Object.keys(probeTargets)) {
            const t = probeTargets[key]
            if (!t) { seen.push(key + '=null'); continue }
            let got = false
            const spy = (ev) => { got = true }
            document.addEventListener('click', spy, true)
            try {
              t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: cxD, clientY: cyD }))
            } catch (e) { seen.push(key + '=throw:' + e.message); document.removeEventListener('click', spy, true); continue }
            document.removeEventListener('click', spy, true)
            seen.push(key + '=' + (got ? 'reached-doc' : 'NOT-reached'))
          }
          out.dgDispatchReach = seen
          // 直接问状态机：它自己的 onDown 里那个 closest 判定拿到的是什么
          out.dgHasExp = !!window.__dshpetWhaleExp
          out.dgExpCfgOn = window.__dshpetWhaleExp ? window.__dshpetWhaleExp.cfg().on : null
        } catch (e) { out.dgError = String(e && e.message) }

        // ================================================================
        // 【用户报的 3 条】连点生气 / 长按害羞 / 角色切换 —— 端到端复现
        // ================================================================
        // 这一段**真的照用户的手势走一遍**（在她身上派发 pointerdown/up + click），
        // 而不是直接调 setMood()。理由：上面那条"切到生气 → 图变了"的断言走的是
        // setMood()，它绕过了监听器 —— 于是"监听器根本没收到事件"这类 bug
        // 它能一路绿灯放过去（用户报的正是这种：功能在、但连点不生气）。
        //
        // ⚠️ 记一个**已经踩过的坑**，免得以后又被同一件事骗过去：
        //    挂件把 .dshwv-root / .dshwv-body / img.dshwv-img 全设成 pointer-events:none，
        //    所以 elementFromPoint 在立绘中心返回的是 BODY —— 这是**正常的**，
        //    不是"没点中"（shell.js 顶部记着同一个坑）。真正要验的是坐标命中
        //    （window.__petWhaleHit），所以派发目标取命中点上的真实元素，
        //    与真实浏览器行为一致。
        try {
          const exp = window.__dshpetWhaleExp
          const wimg3 = q('img.dshwv-img')
          const srcOf = () => String((wimg3 && wimg3.getAttribute('src')) || '')
          // 命中点上派发一次"完整的鼠标点"：pointerdown → pointerup → click
          const clickHer = async (times, gapMs) => {
            const ir = wimg3.getBoundingClientRect()
            // 立绘中心略偏左上 = 她的身体（右下角常常是空的自适应留白）
            const cx = Math.round(ir.left + ir.width * 0.45)
            const cy = Math.round(ir.top + ir.height * 0.5)
            const tgt = document.elementFromPoint(cx, cy) || document.body
            for (let i = 0; i < times; i++) {
              const mk = (type, extra) => new PointerEvent(type, Object.assign({
                bubbles: true, cancelable: true, clientX: cx, clientY: cy,
                button: 0, pointerType: 'mouse', pointerId: 71, isPrimary: true,
              }, extra || {}))
              tgt.dispatchEvent(mk('pointerdown', { buttons: 1 }))
              await sleep(20)
              document.dispatchEvent(mk('pointerup', { buttons: 0 }))
              tgt.dispatchEvent(new MouseEvent('click', {
                bubbles: true, cancelable: true, clientX: cx, clientY: cy,
              }))
              if (gapMs) await sleep(gapMs)
            }
            return { cx, cy, target: tgt.tagName + '.' + String(tgt.className || '').slice(0, 40) }
          }
          if (exp) {
            const cfg0 = exp.cfg()
            out.ttCfg = { angryClicks: cfg0.angryClicks, angryWindowSec: cfg0.angryWindowSec, shySec: cfg0.shySec, petEnabled: cfg0.petEnabled, on: cfg0.on }
            out.ttHitTarget = (await clickHer(1, 0)).target
            await sleep(200)
            const srcAfterOne = srcOf()
            // —— 连点生气：默认 18 次 / 3 秒窗口 ——
            out.ttAngryNeed = Math.max(3, Number(cfg0.angryClicks) || 18)
            await clickHer(out.ttAngryNeed, 40)
            await sleep(300)
            out.ttSrcAfterCombo = srcOf()
            out.ttAngryFired = out.ttSrcAfterCombo.indexOf('/whale-exp/angry') >= 0
            out.ttSrcAfterOneClick = srcAfterOne
            // 收拾干净，免得影响后面的断言
            exp.setMood('', 0)
            await sleep(400)
          }
        } catch (e) { out.ttError = String(e && e.message) }

        // —— 长按害羞：按住 shySec 秒不放 ——
        try {
          const exp2 = window.__dshpetWhaleExp
          const wimg4 = q('img.dshwv-img')
          if (exp2 && wimg4) {
            const cfg2 = exp2.cfg()
            const holdSec = Math.max(2, Number(cfg2.shySec) || 6)
            // ⚠️ 自检窗口是 show:false，**Chromium 会把不可见页面的定时器照样跑**
            //    （setTimeout 不受 visibility 影响），所以这里真的等得起。
            //    但 shySec 默认 6 秒 —— 为了别把自检拖太久，这里临时改成 2 秒。
            const savedShy = cfg2.shySec
            cfg2.shySec = 2
            const ir2 = wimg4.getBoundingClientRect()
            const cx2 = Math.round(ir2.left + ir2.width * 0.45)
            const cy2 = Math.round(ir2.top + ir2.height * 0.5)
            const tgt2 = document.elementFromPoint(cx2, cy2) || document.body
            out.ttHoldTarget = tgt2.tagName + '.' + String(tgt2.className || '').slice(0, 40)
            // 诊断：这一刻"她"到底算不算命中？监听器收到事件了吗？
            out.ttHoldHitHer = exp2.hitHer ? exp2.hitHer(cx2, cy2) : 'no-hitHer'
            out.ttHoldWhaleHit = (typeof window.__petWhaleHit === 'function') ? window.__petWhaleHit(cx2, cy2) : 'no-fn'
            out.ttHoldMenuOpen = !!q('.dshwv-menu.dshwv-menu-open')
            out.ttHoldExpPanelOpen = (function () {
              var epn = q('.dshpet-exp-panel')
              return !!(epn && getComputedStyle(epn).display !== 'none')
            })()
            let downSeen = false
            const downSpy = () => { downSeen = true }
            document.addEventListener('pointerdown', downSpy, true)
            tgt2.dispatchEvent(new PointerEvent('pointerdown', {
              bubbles: true, cancelable: true, clientX: cx2, clientY: cy2,
              button: 0, buttons: 1, pointerType: 'mouse', pointerId: 72, isPrimary: true,
            }))
            document.removeEventListener('pointerdown', downSpy, true)
            out.ttHoldDownSeen = downSeen
            // ⚠️ 采样必须够密：害羞只维持 4 秒（setMood('shy', 4000)），
            //    只在最后读一次的话，读到的是**害羞已经结束之后**的图 ——
            //    那会误判成"没生效"。这里每 200ms 采一次，只要出现过就算数。
            const shySamples = []
            const t0hold = Date.now()
            while (Date.now() - t0hold < holdSec * 1000 + 1500) {
              shySamples.push(String(wimg4.getAttribute('src') || ''))
              await sleep(200)
            }
            out.ttHoldShySamples = shySamples.filter(function (s, i, a) { return a.indexOf(s) === i })
            out.ttShyFired = shySamples.some(function (s) { return s.indexOf('/whale-exp/shy') >= 0 })
            out.ttHoldStrokingSeen = shySamples.some(function (s) { return s.indexOf('/whale-exp/stroking') >= 0 })
            out.ttSrcWhileHolding = shySamples[shySamples.length - 1] || ''
            document.dispatchEvent(new PointerEvent('pointerup', {
              bubbles: true, cancelable: true, clientX: cx2, clientY: cy2,
              button: 0, buttons: 0, pointerType: 'mouse', pointerId: 72, isPrimary: true,
            }))
            await sleep(300)
            out.ttSrcAfterHold = String(wimg4.getAttribute('src') || '')
            cfg2.shySec = savedShy
            try { exp2.setMood('', 0) } catch (e2) {}
            await sleep(300)
          }
        } catch (e) { out.ttHoldError = String(e && e.message) }

        // —— 角色切换：挂件自己的「角色」按钮换图，我们**不该**把图抢回去 ——
        try {
          const wimg5 = q('img.dshwv-img')
          const exp3 = window.__dshpetWhaleExp
          out.roleSwitchSrcBefore = String((wimg5 && wimg5.getAttribute('src')) || '')
          // 直接走挂件自己的 applyRole 不可达（它在闭包里），所以模拟它做的事：
          // 写 img.src = 另一张图（等价于用户点了「角色」里的另一项）。
          if (wimg5) {
            wimg5.setAttribute('src', '/dsh-whale/role-image.png?id=__selftest_probe__')
            await sleep(600)
            out.roleSwitchSrcAfter = String(wimg5.getAttribute('src') || '')
            out.roleSwitchHijacked = out.roleSwitchSrcAfter !== '/dsh-whale/role-image.png?id=__selftest_probe__'
            // 普通状态的基准也得跟着换（换完角色，平时的样子应该是**新角色**）
            out.roleSwitchBaseAfter = exp3 && exp3._internal ? exp3._internal.baseSrc() : null
            // 还原
            wimg5.setAttribute('src', out.roleSwitchSrcBefore || '/dsh-whale/image.png?v=2')
            await sleep(400)
            out.roleSwitchSrcRestored = String(wimg5.getAttribute('src') || '')
            out.roleSwitchBaseRestored = exp3 && exp3._internal ? exp3._internal.baseSrc() : null
          }
        } catch (e) { out.roleSwitchError = String(e && e.message) }

        // —— 【用户报的第 1 条】形象面板不许和桌宠菜单重合 ——
        // ⚠️ 上一版这条断言（expNoOverlap）在自检里**恒为真**：
        //    她当时被前面的拖拽测试丢在左上角，expLeftRoom=false，于是走了
        //    "没地方放 → 不算重合"的豁免分支 —— 用户报的重合它一条都拦不住。
        //    现在改成**把她摆回右下角（真实使用位置）再测**，
        //    并且额外测"菜单换位置后面板会不会跟着让开"。
        try {
          // 先把她送回右下角：菜单会跟着她走，这才是真实布局。
          // ⚠️ **必须用"真的拖过去"** —— 位置是挂件的 state + 物理那边的 override
          //    一起决定的，只写 localStorage 是改不动当前画面的。
          try {
            const rImg = q('img.dshwv-img')
            if (rImg && window.__dshpetPhysics) {
              const rr0 = rImg.getBoundingClientRect()
              const vw0 = window.innerWidth, vh0 = window.innerHeight
              const curL = Math.round(rr0.left), curT = Math.round(rr0.top)
              const wantL = vw0 - Math.round(rr0.width) - 20
              const wantT = vh0 - Math.round(rr0.height) - 60
              const dx = wantL - curL, dy = wantT - curT
              if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
                const sx0 = Math.round(rr0.left + rr0.width / 2)
                const sy0 = Math.round(rr0.top + rr0.height / 2)
                const mkR = (type, x, y, extra) => new PointerEvent(type, Object.assign({
                  bubbles: true, cancelable: true, clientX: x, clientY: y,
                  button: 0, pointerType: 'mouse', pointerId: 88, isPrimary: true,
                }, extra || {}))
                ;(document.elementFromPoint(sx0, sy0) || document.body).dispatchEvent(mkR('pointerdown', sx0, sy0, { buttons: 1 }))
                const steps = 8
                for (let i = 1; i <= steps; i++) {
                  document.dispatchEvent(mkR('pointermove', sx0 + dx * i / steps, sy0 + dy * i / steps, { buttons: 1 }))
                  await sleep(60)
                }
                document.dispatchEvent(mkR('pointerup', sx0 + dx, sy0 + dy, { buttons: 0 }))
                await sleep(700)
              }
            }
          } catch (e) { out.ovResetErr = String(e && e.message) }
          const wm5 = q('.dshwv-menu')
          const hadOpen5 = !!(wm5 && wm5.classList.contains('dshwv-menu-open'))
          // 打开桌宠菜单（面板要和**开着的菜单**比位置）
          if (wm5 && !hadOpen5) {
            const mb5 = q('.dshwv-menu-btn')
            if (mb5) { mb5.click(); await sleep(500) }
          }
          if (window.__dshpetWhaleExp) {
            window.__dshpetWhaleExp.openPanel()
            await sleep(400)
            const pan5 = q('.dshpet-exp-panel')
            const wm6 = q('.dshwv-menu')
            if (pan5 && wm6 && wm6.classList.contains('dshwv-menu-open')) {
              const pr5 = pan5.getBoundingClientRect()
              const wr5 = wm6.getBoundingClientRect()
              out.ovPanelRect = { l: Math.round(pr5.left), t: Math.round(pr5.top), r: Math.round(pr5.right), b: Math.round(pr5.bottom), w: Math.round(pr5.width), h: Math.round(pr5.height) }
              out.ovMenuRect = { l: Math.round(wr5.left), t: Math.round(wr5.top), r: Math.round(wr5.right), b: Math.round(wr5.bottom), w: Math.round(wr5.width), h: Math.round(wr5.height) }
              // 两个矩形**真的相交**才算重合（x 与 y 两个方向都要重叠）
              out.ovOverlap = !(pr5.right <= wr5.left || pr5.left >= wr5.right ||
                                pr5.bottom <= wr5.top || pr5.top >= wr5.bottom)
              out.ovHorizClear = pr5.right <= wr5.left
              // 面板必须完整在视口内（不能被夹到屏幕外）
              out.ovPanelInView = pr5.left >= 0 && pr5.top >= 0 &&
                pr5.right <= window.innerWidth + 1 && pr5.bottom <= window.innerHeight + 1
            } else {
              out.ovError = 'panel=' + !!pan5 + ' menuOpen=' + !!(wm6 && wm6.classList.contains('dshwv-menu-open'))
            }
            window.__dshpetWhaleExp.closePanel()
            await sleep(150)
            out.ovClosed = !q('.dshpet-exp-panel') || getComputedStyle(q('.dshpet-exp-panel')).display === 'none'
            out.ovViewport = { w: window.innerWidth, h: window.innerHeight }
          }
        } catch (e) { out.ovError2 = String(e && e.message) }
      }
      return out
    })()`)

    lines.push('')
    lines.push('--- 渲染进程探针 ---')
    lines.push(JSON.stringify(probe, null, 2))
    lines.push('---')
    lines.push('')

    say(probe.whaleScriptLoaded, '鲸鱼脚本已执行')
    say(probe.whaleInit, '鲸鱼挂件已初始化（composer 占位生效）')
    say(probe.riceLoaded, 'rice 客户端已执行')
    say(probe.root, '挂件根节点 .dshwv-root 已建立')
    say(probe.body, '挂件主体 .dshwv-body 已建立')
    say(probe.img, '鲸鱼立绘 img.dshwv-img 已建立')
    if (probe.imgSrc) say(String(probe.imgSrc).includes('/dsh-whale/'), '立绘走的是本地 /dsh-whale/ 路由', probe.imgSrc)
    say(probe.bodyChildren > 0, 'body 上有挂件节点', probe.bodyChildren + ' 个')

    // —— 鼠标穿透判定：这是"左键点她没反应"那个 bug 的回归断言 ——
    // 背景：挂件刻意把根节点/立绘设成 pointer-events:none，所以 elementFromPoint
    //       在立绘中心只会返回 BODY。穿透判定必须靠复刻的命中图，不能靠 elementFromPoint。
    say(!!(probe.hitInfo && probe.hitInfo.ready), '命中图已构建', probe.hitInfo ? String(probe.hitInfo.src) : 'n/a')
    say(probe.hitAtImgCenter === true, '★ 立绘中心判为「可点」（左键点击的关键）', String(probe.hitAtImgCenter))
    say(probe.hitAtRootTopLeft === false, '根节点空白角判为「穿透」', String(probe.hitAtRootTopLeft))
    say(typeof probe.hitRatioPct === 'number' && probe.hitRatioPct > 2 && probe.hitRatioPct < 98,
      '命中比例合理（既不是全空、也不是整块矩形）', probe.hitRatioPct + '%（' + probe.hitCount + '/' + probe.hitTotal + '）')

    // —— 「抓现行」翻碗动画：真跑一遍，量最终落点 ——
    // 这个动画没法靠肉眼在自检里看，所以把"碗最后停在哪"量成数字来断言。
    // 坐标口径 = 相对鲸鱼容器(.dshwv-body)的百分比，和配置一致。
    say(!!probe.bowlExists, '饭碗节点存在')
    say(probe.spillKeyframeUsesVar === false,
      '关键帧里没有 var()（用 var() 会被 Chromium 整条丢掉）', 'usesVar=' + probe.spillKeyframeUsesVar)
    // —— 任务栏避让：下边界必须止于工作区下沿 ——
    const si = probe.screenInfo || {}
    const bd2 = probe.physBounds || {}
    const ao2 = probe.artOffset || {}
    const artBottomMax = (bd2.bottom || 0) + (ao2.dy || 0) + (ao2.h || 0)
    say(si.availH && Math.abs(artBottomMax - si.availH) < 2,
      '★ 可达范围止于**任务栏上沿**（立绘底边最多到 availHeight，不会盖住任务栏）',
      '立绘底边最大=' + Math.round(artBottomMax) + '  availH=' + si.availH + '  screenH=' + si.h)
    say(probe.startState && probe.startBounds &&
        Math.abs(probe.startState.pos[1] - probe.startBounds.bottom) < 2 &&
        (si.availH ? Math.abs((probe.startBounds.bottom + (ao2.dy || 0) + (ao2.h || 0)) - si.availH) < 2 : true),
      '★ 启动位置在任务栏**上面**的右下角',
      'pos=' + JSON.stringify(probe.startState && probe.startState.pos) +
      '  立绘底边=' + Math.round((probe.startBounds.bottom || 0) + (ao2.dy || 0) + (ao2.h || 0)))

    // —— 物理关闭时往下拖：不能拖到任务栏下面 ——
    say(probe.offEnabled === false,
      '物理关闭路径已生效（开关真的关了）', String(probe.offEnabled))
    say(typeof probe.offDragBottom === 'number' && si.availH &&
        probe.offDragBottom <= si.availH + 1,
      '★ 物理关闭时往下拖，立绘底边不会越过任务栏上沿',
      '拖到底后立绘底边=' + probe.offDragBottom + '  availH=' + si.availH +
      (probe.offDragError ? '  err=' + probe.offDragError : ''))
    say(probe.offDragFlagCleared === true,
      '物理关闭时松手也能清掉拖动标记（否则交互判定会一直让路）',
      String(probe.offDragFlagCleared))

    // —— 按挂件的恢复公式复算：落到任务栏上面 ——
    say(typeof probe.restoreArtBottom === 'number' && si.availH &&
        probe.restoreArtBottom <= si.availH + 1,
      '★ 挂件按 dshw-pos 恢复后，立绘底边也在任务栏上沿之内（打开时不会落在任务栏下面）',
      '复算立绘底边=' + probe.restoreArtBottom + '  availH=' + si.availH +
      '  记录=' + JSON.stringify(probe.restoreCalc && probe.restoreCalc.rec) +
      (probe.restoreCalcError ? '  err=' + probe.restoreCalcError : ''))

    // —— 挂件抢写 right:0/bottom:0 时，我们必须把它按回界内 ——
    say(typeof probe.hijackBottom === 'number' && si.availH &&
        probe.hijackBottom <= si.availH + 1,
      '★ 挂件写 right:0/bottom:0（它的基础样式）时，她不会掉到任务栏下面',
      '立绘底边=' + probe.hijackBottom + '  availH=' + si.availH +
      '  位置被纠正=' + probe.hijackRestored +
      (probe.hijackError ? '  err=' + probe.hijackError : ''))

    // —— 【桌宠版】「角色」行 + 闭眼贴图 ——
    say(typeof probe.panelShift === 'number' && probe.panelMarginLeft === '0px',
      '★ 面板避让用 transform（left 由 rice 自己管，两者互不打架）',
      'transform 位移=' + probe.panelShift + 'px  marginLeft=' + JSON.stringify(probe.panelMarginLeft))

    // —— 【桌宠版】多状态形象 + 互动心情 ——
    say(probe.expBtnText === '🎭 形象与互动',
      '★ 鲸鱼 ☰ 菜单里有「形象与互动」入口', JSON.stringify(probe.expBtnText))
    say(probe.expAllImagesOk === true,
      '★ 9 张形象图都能取到（普通/被抚摸/生气/失落/害羞/疲惫/眨眼三帧）',
      JSON.stringify(probe.expImgStatus))
    say(typeof probe.expSrcAngry === 'string' && probe.expSrcAngry.indexOf('/whale-exp/angry') >= 0 &&
        probe.expSrcBack === probe.expSrcBefore,
      '★ 心情切换真的换图，恢复后回到她原本那张',
      JSON.stringify(probe.expSrcBefore) + ' → ' + JSON.stringify(probe.expSrcAngry) +
      ' → ' + JSON.stringify(probe.expSrcBack) + (probe.expError ? '  err=' + probe.expError : ''))
    // —— 【桌宠版】多桌宠 ——
    say(probe.spawnBtnText === '打开桌宠',
      '★ 菜单里有「打开桌宠」按钮', JSON.stringify(probe.spawnBtnText))
    say(probe.spawnBtnOnRight === true,
      '★ 「打开桌宠」在「形象与互动」右边',
      JSON.stringify(probe.spawnBtnRow))
    say(probe.spawnResult && probe.spawnResult.ok === true && probe.petCountAfter === probe.petCountBefore + 1,
      '★ 点一次就多一只（没有数量限制）',
      '开之前 ' + probe.petCountBefore + ' 只 → 开之后 ' + probe.petCountAfter + ' 只  ' +
      JSON.stringify(probe.spawnResult) + (probe.spawnError ? '  err=' + probe.spawnError : ''))
    say(probe.petRects && Array.isArray(probe.petRects.rects) &&
        probe.petRects.rects[0] && probe.petRects.rects[0].w > 0,
      '★ 立绘位置上报链路通了（主进程能收到屏幕坐标矩形）',
      JSON.stringify(probe.petRects))
    say(probe.pokeOk === true,
      '★ 相撞反应能跑（动画 + 音效，无报错）', String(probe.pokeOk))

    // —— 【新】「退出桌宠」+ 体积碰撞 ——
    say(probe.firstPetInfo && probe.firstPetInfo.isExtra === false && probe.firstHasQuitRow === false,
      '★ 第一只**没有**「退出桌宠」菜单项（托盘/热键都指着它）',
      'isExtra=' + (probe.firstPetInfo && probe.firstPetInfo.isExtra) +
      ' 有退出项=' + probe.firstHasQuitRow)
    say(probe.firstCloseTry && probe.firstCloseTry.ok === false && probe.firstStillAlive === true,
      '★ 第一只去调「退出桌宠」会被拒绝，而且它还活着',
      '返回=' + JSON.stringify(probe.firstCloseTry) + ' 还活着=' + probe.firstStillAlive)
    say(probe.overlapSame && probe.overlapSame.ox === 100 && probe.overlapSame.oy === 100 &&
        probe.overlapApart === null &&
        probe.overlapPartial && Math.round(probe.overlapPartial.ox) === 40 &&
        Math.round(probe.overlapPartial.oy) === 100,
      '★ 重叠量算得对：完全重合=100x100、分开=null、错开 60=40x100',
      JSON.stringify({ same: probe.overlapSame, apart: probe.overlapApart, part: probe.overlapPartial }))
    say(probe.nudgeOk === true && probe.nudgeMoved === true && probe.nudgeRestored === true,
      '★ 推开用的原语 nudge/isDragging 都在，nudge 真的能挪动她，而且能原样挪回去（不污染后续用例）',
      '在位=' + probe.nudgeOk + ' 挪动了=' + probe.nudgeMoved + ' 已还原=' + probe.nudgeRestored +
      ' 位置=' + JSON.stringify(probe.nudgePos))
    say(probe.countAfterCleanup === 1,
      '★ 收掉多开的那只之后，第一只还在、计数回到 1',
      'count=' + probe.countAfterCleanup)

    say(probe.expNoOverlap === true,
      '★ 形象面板摆在桌宠菜单**左边**，不和它重合',
      '面板=' + JSON.stringify(probe.expPanelRect) + '  菜单=' + JSON.stringify(probe.expMenuRect))
    say(probe.expClosedByOutside === true,
      '★ 点空白处能关掉形象面板', String(probe.expClosedByOutside))
    say(probe.expPanelOpen === true && probe.expPanelRows >= 8,
      '★ 设置面板能打开，且各项都在',
      '行数=' + probe.expPanelRows + ' 配置=' + JSON.stringify(probe.expCfg))

    // —— 【用户报的第 3 条】连点生气（真的派发 pointerdown/up + click，不走 setMood）——
    say(probe.ttAngryFired === true,
      '★ 在她身上连点 ' + probe.ttAngryNeed + ' 次 → 真的生气了（图片切成 angry）',
      '命中点=' + JSON.stringify(probe.ttHitTarget) +
      '  单点后=' + JSON.stringify(probe.ttSrcAfterOneClick) +
      '  连点后=' + JSON.stringify(probe.ttSrcAfterCombo) +
      '  配置=' + JSON.stringify(probe.ttCfg) +
      (probe.ttError ? '  err=' + probe.ttError : ''))
    // —— 【用户报的第 4 条】长按害羞 ——
    say(probe.ttShyFired === true,
      '★ 按住她不放 → 真的害羞了（图片切成 shy）',
      '按住期间出现过的图=' + JSON.stringify(probe.ttHoldShySamples) +
      '  抚摸图出现过=' + probe.ttHoldStrokingSeen +
      '  命中点=' + JSON.stringify(probe.ttHoldTarget) +
      '  监听器收到 pointerdown=' + probe.ttHoldDownSeen +
      (probe.ttHoldError ? '  err=' + probe.ttHoldError : ''))

    // —— 【用户报的第 2 条】挂件「角色」菜单换图不能被形象状态机抢回去 ——
    say(probe.roleSwitchHijacked === false,
      '★ 挂件换角色时，形象状态机不会把图抢回去（角色切换生效）',
      JSON.stringify(probe.roleSwitchSrcBefore) + ' → 写入自定义角色 → ' +
      JSON.stringify(probe.roleSwitchSrcAfter) +
      ' → 还原 ' + JSON.stringify(probe.roleSwitchSrcRestored) +
      '  基准=' + JSON.stringify(probe.roleSwitchBaseAfter) +
      (probe.roleSwitchError ? '  err=' + probe.roleSwitchError : ''))
    say(probe.roleSwitchBaseAfter === '/dsh-whale/role-image.png?id=__selftest_probe__' &&
        probe.roleSwitchBaseRestored === probe.roleSwitchSrcBefore,
      '★ 换角色后「普通状态」也跟着换成新角色（不是为了还原旧图而抢回去）',
      '新基准=' + JSON.stringify(probe.roleSwitchBaseAfter) +
      '  还原后基准=' + JSON.stringify(probe.roleSwitchBaseRestored))

    // —— 【用户报的第 1 条】形象面板不许和桌宠菜单重合（在她真实位置、菜单真开着时测）——
    say(probe.ovOverlap === false,
      '★ 形象与互动面板和桌宠菜单**真的不重合**（她回右下角、菜单开着时实测）',
      '面板=' + JSON.stringify(probe.ovPanelRect) + '  菜单=' + JSON.stringify(probe.ovMenuRect) +
      '  相交=' + probe.ovOverlap + '  面板在菜单左侧=' + probe.ovHorizClear +
      (probe.ovError ? '  err=' + probe.ovError : '') +
      (probe.ovError2 ? '  err2=' + probe.ovError2 : '') +
      (probe.ovResetErr ? '  resetErr=' + probe.ovResetErr : ''))
    say(probe.ovPanelInView === true,
      '★ 让开之后面板仍完整在屏幕内（不会被夹到屏幕外）',
      JSON.stringify(probe.ovPanelRect) + '  视口=' + JSON.stringify(probe.ovViewport))
    say(probe.ovClosed === true, '★ 形象面板能正常关闭', String(probe.ovClosed))
    say(!!probe.autostart && typeof probe.autostart.enabled === 'boolean',
      '★ 开机自启接口可用（可读可写）', JSON.stringify(probe.autostart))

    say(probe.roleRowExists === true,
      '★ 面板里有「角色」这一行（加在「波谷饭」下面）',
      JSON.stringify(probe.roleRowText) + '  按钮=' + JSON.stringify(probe.roleRowBtns))
    say(Array.isArray(probe.roleRowBtns) && probe.roleRowBtns[0] === '选择图片…' && probe.roleRowBtns[1] === '默认',
      '★ 角色行是「选择图片…」「默认」两个按钮',
      JSON.stringify(probe.roleRowBtns))
    say(probe.roleRowStyleMatch === true,
      '★ 角色行的样式和「波谷饭」那一行一致（克隆同一行，不是自己写 CSS）',
      JSON.stringify(probe.roleRowStyleInfo))
    say(String(probe.materialHeadText || '').indexOf('素材·米粒,碗和角色') >= 0,
      '★ 组标题已改成「素材·米粒,碗和角色」', JSON.stringify(probe.materialHeadText))
    say(probe.closeEyeStatus === 200,
      '★ 闭眼贴图能取到（外壳路由 /whale-sprite-closeeye.png）',
      'HTTP ' + probe.closeEyeStatus + '  ' + probe.closeEyeBytes + ' 字节')
    say(String(probe.spriteAfterCloseEye || '').indexOf('whale-sprite-closeeye') >= 0 &&
        probe.spriteAfterRestore === probe.spriteBefore,
      '★ 抓现行时换成闭眼贴图，盆消失后恢复原贴图',
      JSON.stringify(probe.spriteBefore) + ' → ' + JSON.stringify(probe.spriteAfterCloseEye) +
      ' → ' + JSON.stringify(probe.spriteAfterRestore) +
      (probe.roleError ? '  err=' + probe.roleError : ''))

    // —— 复现"进入菜单点了相关功能没反应 + 菜单关闭 + 她瞬移" ——
    say(probe.wmOpenAfterBtn === true, '点 ☰ 能打开鲸鱼菜单', String(probe.wmOpenAfterBtn))
    say(probe.wmCheckboxResponded === true,
      '★ 点鲸鱼菜单里的控件真的有反应（没被吞掉）',
      '勾选 ' + probe.wmCheckboxBefore + ' → ' + probe.wmCheckboxAfter +
      '  菜单里复选框数=' + probe.wmCheckboxCount +
      (probe.wmClickError ? '  err=' + probe.wmClickError : ''))
    // 容差 3px：多桌宠的相撞会给她做一次缩放动画，缩放会**临时**改变立绘的
    // 测量尺寸 → 物理那边的夹取会跟着微调一两像素。视觉上完全看不出来，
    // 但拿 <=1 去卡会假失败（实测 [2,0]）。
    say(Array.isArray(probe.wmPosDrift) && Math.abs(probe.wmPosDrift[0]) <= 3 && Math.abs(probe.wmPosDrift[1]) <= 3,
      '★ 点菜单里的功能时她不会瞬移',
      '位移=' + JSON.stringify(probe.wmPosDrift) + '  菜单矩形=' + JSON.stringify(probe.wmRect))

    // —— 菜单扩展 ——
    say(probe.menuExtrasLoaded === true, '菜单扩展模块已加载', String(probe.menuExtrasLoaded))
    say(probe.scrollGapRowFound === true && probe.scrollGapRowHidden === true,
      '★ 菜单里的「避让滚动条 / 宽度」那一行已隐藏',
      '找到=' + probe.scrollGapRowFound + ' 已隐藏=' + probe.scrollGapRowHidden)
    say(probe.scrollGapChecked === false,
      '★ 「避让滚动条」功能也已关掉（配置里遗留的"开"被纠正）', String(probe.scrollGapChecked))
    say(probe.openWebRow === true,
      '★ 菜单里已加上「打开 dsh 网页端」', JSON.stringify(probe.openWebLabel))
    // 干跑结果：要么找到端口（ok:true + url），要么明确 not-running —— 不能是异常
    const dw = probe.dshWebProbe
    say(!!dw && (dw.ok === true ? (typeof dw.url === 'string' && dw.url.indexOf('http://127.0.0.1:') === 0)
                                : dw.ok === false),
      '★ 端口探测链路能跑通（干跑返回结构化结果）',
      JSON.stringify(dw) + (probe.dshWebProbeError ? '  err=' + probe.dshWebProbeError : ''))

    say(probe.hasOpenDshWebApi === true,
      '★ 「打开 dsh 网页端」走的是主进程探测接口（端口不写死）',
      'openDshWeb 可用=' + probe.hasOpenDshWebApi + '  参考端口=' + probe.openWebHintPort)

    say(probe.riceHeadMachinery === true,
      '★ 米粒用的是上游 0.3.7 的两套翻碗动画（dshrice-spill + dshrice-head，headChancePct 保持上游默认 10）',
      JSON.stringify(probe.riceHeadInfo))
    say(probe.spillAnimFound === true, '找到翻碗动画（Web Animations API）',
      '时长 ' + probe.spillAnimDuration + 'ms，页面上共 ' + probe.spillAnimCount + ' 个动画')
    say(probe.transformAt0 !== probe.transformAtMid && probe.transformAtMid !== probe.transformAtEnd,
      '★ 动画真的在跑（0 / 中 / 末三帧的 transform 各不相同）',
      probe.transformAt0 + '  →  ' + probe.transformAtMid + '  →  ' + probe.transformAtEnd)
    const lx = probe.spillLandX
    const ly = probe.spillLandY
    // 上游 0.3.7 起 dshrice-spill 恢复成"倒扣在她左下方的地面"；
    // "扣在头顶"是**另一套**（dshrice-head，见上面 riceHeadMachinery 那条断言）。
    // 所以这里断言的是地面落点，不再断言头顶。
    say(typeof lx === 'number' && lx > 30 && lx < 75 && typeof ly === 'number' && ly > 70,
      '★ dshrice-spill 落在她左下方的地面（上游那套"倒扣在旁边"）',
      'x=' + lx + '%  y=' + ly + '%')

    // —— 拖动物理 ——
    say(probe.physLoaded === true, '拖动物理模块已加载')
    say(probe.physMenuInWhaleMenu === true,
      '★ 开关已出现在小鲸鱼的 ☰ 菜单里', JSON.stringify(probe.physMenuLabel))
    say(probe.physOverride === true, '位置接管类已生效（压住挂件的行内 left/top）')
    // ⚠️ 这一条是"乱飞"的回归断言：接管期间 left/top 绝不能有 transition
    const tr = probe.physTransition || {}
    const trProp = String(tr.prop || '')
    say(trProp.indexOf('left') < 0 && trProp.indexOf('top') < 0,
      '★ 接管期间 left/top 没有 transition（否则逐帧写入会被补间成乱飞）',
      trProp + ' / ' + tr.dur)
    const c = probe.physConstants || {}
    say(c.SPRING_K === 200 && c.SPRING_C === 30, '弹簧参数与 dsh-pet 一致 (K=200/C=30)', JSON.stringify([c.SPRING_K, c.SPRING_C]))
    say(c.GRAVITY === 1400 && c.RESTITUTION === 0.78 && c.GROUND_FRICTION === 2.5,
      '重力/反弹/摩擦与 dsh-pet 一致 (1400/0.78/2.5)', JSON.stringify([c.GRAVITY, c.RESTITUTION, c.GROUND_FRICTION]))
    say(c.DEAD_ZONE_SPEED === 500, '慢放不抛的阈值一致 (500px/s)', String(c.DEAD_ZONE_SPEED))
    const f = probe.fn || {}
    say(f.clampZero === 0, '软上限：0 速 → 0', String(f.clampZero))
    say(f.clampHuge === 3600, '软上限：极大速 → 渐近 3600（不硬钳）', String(f.clampHuge))
    say(typeof f.clampAtCap === 'number' && Math.abs(f.clampAtCap - 3600 * (1 - Math.exp(-1))) < 0.01,
      '软上限：3600 → 3600(1-e⁻¹)≈2275.634', String(f.clampAtCap))
    say(f.springOneStep === 320, '弹簧单步：v + (Δx·K − v·C)·dt = 320', String(f.springOneStep))
    say(Array.isArray(f.throwOneStep) && f.throwOneStep[3] === 22.4,
      '抛掷单步：vy += 1400×0.016 = 22.4', JSON.stringify(f.throwOneStep))
    say(f.restOnGround === true && f.restInAir === false,
      '静止判定：落地且慢 → 静止；空中 → 不算静止', JSON.stringify([f.restOnGround, f.restInAir]))

    // —— 甩出力度档位（移植自 pet/physics.py）——
    const caps = f.caps || {}
    say(caps.gentle === 3600 && caps.standard === 4800 && caps.strong === 7200 && caps.crazy === 9000,
      '★ 甩出力度四档与 physics.py 一致（3600/4800/7200/9000）',
      JSON.stringify([caps.gentle, caps.standard, caps.strong, caps.crazy]))
    say(caps.unknown === 4800 && caps.empty === 4800 && caps.upper === 7200,
      '★ 档位取值容错：不认识的值退回 standard，大小写不敏感',
      JSON.stringify([caps.unknown, caps.empty, caps.upper]))

    // —— 弹弓（移植自 pet/physics.py）——
    const sl = f.sling || {}
    // ⚠️ 到门槛（24px）时**不是 0**，而是基速 900 过软上限 = 820.66。
    //    我一开始把期望写成 0 是错的 —— 拿参考 physics.py 跑一遍才发现（见 _test/compare-physics.cjs）。
    say(sl.belowMin === 0 && typeof sl.atMin === 'number' && Math.abs(sl.atMin - 820.66) < 0.01,
      '★ 弹弓：不到门槛不发射；刚好到门槛 = 基速 900 过软上限 ≈ 820.66',
      JSON.stringify([sl.belowMin, sl.atMin]))
    say(typeof sl.mid === 'number' && sl.mid > 0 && typeof sl.atMax === 'number' && sl.atMax > sl.mid,
      '★ 弹弓：拉得越远射得越快', JSON.stringify([sl.mid, sl.atMax]))
    say(typeof sl.beyond === 'number' && sl.beyond <= 4800 && Math.abs(sl.beyond - sl.atMax) < 1e-6,
      '★ 弹弓：拉过头不再涨（软上限 4800，不硬钳）', JSON.stringify([sl.atMax, sl.beyond]))
    say(Array.isArray(sl.deformNone) && sl.deformNone[0] === 1 && sl.deformNone[1] === 1,
      '★ 弹弓形变：没拉拽时不变形', JSON.stringify(sl.deformNone))
    say(Array.isArray(sl.deformX) && sl.deformX[0] > 1 && sl.deformX[1] < 1,
      '★ 弹弓形变：沿 x 拉 → x 拉伸 / y 压缩（方向性形变）', JSON.stringify(sl.deformX))
    say(Array.isArray(sl.deformY) && sl.deformY[0] < 1 && sl.deformY[1] > 1,
      '★ 弹弓形变：沿 y 拉 → y 拉伸 / x 压缩（投影到轴，换角度不跳变）', JSON.stringify(sl.deformY))
    say(Array.isArray(sl.traj) && sl.traj.length === 5 && sl.traj[0][0] === 0 && sl.traj[0][1] === 0 &&
        sl.traj[4][1] > sl.traj[2][1],
      '★ 弹弓：预测轨迹是抛物线（起点在发射点，越飞越低）', JSON.stringify(sl.traj))

    // —— 飞行倍率 ——
    const fl = f.flight || {}
    say(fl.still === 1 && fl.full === 1.75 && fl.over === 1.75,
      '★ 飞行倍率与 physics.py 一致：静止 1×、1400px/s 时 1.75×、再快不涨',
      JSON.stringify([fl.still, fl.half, fl.full, fl.over]))

    say(f.dragFlushMs === 8,
      '★ 拖拽合帧已启用（8ms 消费一次 ≈120Hz，高刷鼠标不再每事件都重排）',
      String(f.dragFlushMs))
    say(typeof f.petCount === 'number' && f.petCount >= 1,
      '★ 单只桌宠时前端跳过碰撞开销（位置上报 / 接触检测）',
      'petCount=' + f.petCount)

    // —— 子步积分 ——
    say(typeof f.substepMaxPx === 'number' && f.substepMaxPx > 0 && f.substepMaxPx <= 16,
      '★ 子步积分已启用（单步位移上限 ' + f.substepMaxPx + 'px，防高速穿透）', String(f.substepMaxPx))
    say(f.strengthNow === 'standard' || ['gentle', 'standard', 'strong', 'crazy'].indexOf(f.strengthNow) >= 0,
      '★ 力度档位可读且取值合法', String(f.strengthNow))

    // —— 弹弓状态机 ——
    const sg = f.slingState || {}
    say(sg.enabled === true && sg.entered === true,
      '★ 弹弓：能进入蓄力状态', JSON.stringify([sg.enabled, sg.entered]))
    say(Array.isArray(sg.pull) && sg.pull[0] === 100 && sg.pull[1] === 100,
      '★ 弹弓：拉拽向量 = 锚点鼠标 − 当前鼠标（往回拉、往前射）', JSON.stringify(sg.pull))
    say(typeof sg.progress === 'number' && sg.progress > 0 && sg.progress <= 1,
      '★ 弹弓：蓄力进度按拉拽距离归一（钳在 0~1）', String(sg.progress))
    say(sg.cleared === true && sg.restored === true,
      '★ 弹弓取消后回到锚点、位置复原', JSON.stringify([sg.cleared, sg.backToAnchor, sg.restored]))
    say(sg.launched === true && sg.modeAfter === 'throw',
      '★ 弹弓松左键真的发射（进入抛掷态）', JSON.stringify([sg.launched, sg.modeAfter]))
    say(sg.thrownAway === true,
      '★ 弹弓发射方向 = 拉拽方向（往左上拉 → 往右下飞）', JSON.stringify(sg.velAfter))

    // —— 碰撞世界（lib/collision.js）——
    const col = (probe.fn && probe.fn.collision) || {}
    say(col.loaded === true, '★ 碰撞物理核心已加载（lib/collision.js）', String(col.loaded))
    say(col.circlesOk === true,
      '★ 三圆胶囊链正确（竖长条第三个圆 = top+height-radius）', JSON.stringify(col.circles))
    say(col.hashOpposite === true,
      '★ 稳定哈希方向：交换两 id 得到的方向互为反向（禁用随机）', JSON.stringify(col.hash))
    say(col.impulseOk === true && col.sepOk === true,
      '★ 冲量求解 / 位置分离可用', JSON.stringify([col.impulse, col.sep]))
    say(col.sweptOk === true,
      '★ 扫掠检测能拦住高速隧穿（一帧跨过对方也能判到）', JSON.stringify(col.swept))

    // —— 黄金回旋 / 拖文件吃掉 / transform 合成器 ——
    const sp = (probe.fn && probe.fn.spin) || {}
    say(sp.loaded === true && sp.constsOk === true,
      '★ 黄金回旋常量与 golden_spin.py 一致（700ms / ×0.82 / 下限200ms / 收尾130ms / -360°）',
      JSON.stringify(sp.consts))
    say(sp.idleBefore === false && sp.activeAfterStart === true && sp.idleAfterCancel === false &&
        sp.angleAfterCancel === 0,
      '★ 黄金回旋：开转→进入旋转态；取消→立刻归零停表',
      JSON.stringify([sp.idleBefore, sp.activeAfterStart, sp.idleAfterCancel, sp.angleAfterCancel]))
    say(sp.menuRow === true && sp.toggles === 2,
      '★ 菜单里有「黄金回旋」入口 + 点击触发/直连两个子开关',
      '入口=' + sp.menuRow + ' 子开关=' + sp.toggles)

    const ea = (probe.fn && probe.fn.eater) || {}
    say(ea.loaded === true && ea.menuRow === true,
      '★ 拖文件吃掉已就绪，菜单里有「吃掉统计」入口', JSON.stringify(ea.human))
    say(Array.isArray(ea.human) && ea.human[1] === '2.0 KB' && ea.human[2] === '5.0 MB',
      '★ 吃掉统计的体积格式化正确', JSON.stringify(ea.human))

    const xf = (probe.fn && probe.fn.xform) || {}
    say(xf.loaded === true && xf.hasBoth === true && xf.cleared === true,
      '★ 立绘 transform 合成器：回旋和形变能同时生效（不再互相覆盖）',
      '合成结果=' + JSON.stringify(xf.composed))

    // ========================================================================
    // 开关切换的回归：用户报"碰了拖动物理开关就卡死，只剩一张贴图"。
    // 根因是 setEnabled 里调了 location.reload() —— 渲染进程的 location.reload()
    // 在本应用里**不工作**，会发起一次永远不提交的导航，页面卡在"正在导航"状态。
    // 现在改成**就地生效、完全不重载**。这里验证：
    //   ① 切换后页面照常活着、点击照常有用
    //   ② 切换**不会**触发页面重载（标记应该还在）
    //   ③ 两个入口（☰ 菜单 / 托盘）状态一致
    // ========================================================================
    const readCounts = () => win.webContents.executeJavaScript(
      'window.petApi && window.petApi.debugIpcCounts ? window.petApi.debugIpcCounts() : null'
    ).catch(() => null)
    const countsBefore = await readCounts()
    say(!!countsBefore && countsBefore.dragPhysics === 1,
      '切换前 IPC 监听器数量正常（每个通道应为 1）', JSON.stringify(countsBefore))

    // 原始开关值在探针开始时已经记下了（见 out.origPhysicsFlag）——那时还没被强制成"开"
    const origFlag = probe.origPhysicsFlag

    await win.webContents.executeJavaScript('window.__noReloadProbe = "before"; "marked"').catch(() => {})
    await win.webContents.executeJavaScript(
      'window.__dshpetPhysics.setEnabled(false); "off"'
    ).catch(() => {})
    await sleep(1500)

    const off = await win.webContents.executeJavaScript(`(function () {
      var r = document.querySelector('.dshwv-root')
      var cb = document.querySelector('.dshpet-phys-row input')
      return {
        stillSamePage: window.__noReloadProbe === 'before',
        whaleInit: !!window.__dshWhaleInit,
        hasImg: !!document.querySelector('img.dshwv-img'),
        enabled: window.__dshpetPhysics ? window.__dshpetPhysics.isEnabled() : null,
        menuChecked: cb ? cb.checked : null,
        stored: localStorage.getItem('dshpet-drag-physics'),
        overrideOn: !!(r && r.classList.contains('dshpet-phys'))
      }
    })()`).catch((e) => ({ error: String(e && e.message) }))

    say(off.stillSamePage === true,
      '★ 切换开关**没有**触发页面重载（这是修 bug 的关键 —— 重载会让页面卡死）',
      'stillSamePage=' + off.stillSamePage)
    say(off.whaleInit === true && off.hasImg === true,
      '★ 切换后页面照常活着（挂件还在、没有卡死）', JSON.stringify(off))
    say(off.enabled === false && off.stored === '0', '切换已生效并落盘', 'enabled=' + off.enabled + ' stored=' + off.stored)
    say(off.menuChecked === false, '☰ 菜单里的勾选状态同步了', String(off.menuChecked))
    say(off.overrideOn === true,
      '位置接管仍在（两种模式都接管，切换不影响它）', String(off.overrideOn))

    // 再切回来，确认两个方向都正常
    await win.webContents.executeJavaScript('window.__dshpetPhysics.setEnabled(true); "on"').catch(() => {})
    await sleep(1500)
    const on = await win.webContents.executeJavaScript(`(function () {
      var cb = document.querySelector('.dshpet-phys-row input')
      return {
        stillSamePage: window.__noReloadProbe === 'before',
        whaleInit: !!window.__dshWhaleInit,
        enabled: window.__dshpetPhysics ? window.__dshpetPhysics.isEnabled() : null,
        menuChecked: cb ? cb.checked : null,
        stored: localStorage.getItem('dshpet-drag-physics')
      }
    })()`).catch((e) => ({ error: String(e && e.message) }))
    say(on.enabled === true && on.stored === '1' && on.menuChecked === true,
      '★ 反向切换（关→开）同样就地生效、状态一致', JSON.stringify(on))
    say(on.stillSamePage === true && on.whaleInit === true,
      '★ 反向切换后页面仍然正常（两个方向都不卡死）', 'samePage=' + on.stillSamePage)

    // 恢复用户原来的开关值
    await win.webContents.executeJavaScript(
      "localStorage.setItem('dshpet-drag-physics', " + JSON.stringify(origFlag === null ? '1' : origFlag) + "); 'restored'"
    ).catch(() => {})

    // —— 与原程序 pet/physics.py 数值对拍（移植忠实度的硬证据）——
    const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= (tol || 0.001)
    const s1 = probe.sim1 || { pos: [], vel: [] }
    const s30 = probe.sim30 || { pos: [], vel: [] }
    const s60 = probe.sim60 || { pos: [], vel: [] }
    const sr = probe.simRest || { step: -1, pos: [] }
    say(near(s1.pos[0], 1051.2) && near(s1.pos[1], 661.9584) && near(s1.vel[1], -2377.6),
      '对拍 step 1：pos=(1051.2000, 661.9584) v_y=-2377.6000',
      '(' + s1.pos[0].toFixed(4) + ', ' + s1.pos[1].toFixed(4) + ') vy=' + s1.vel[1].toFixed(4))
    say(near(s30.pos[0], 1238.896, 0.01) && near(s30.vel[0], -2496.0, 0.01),
      '对拍 step 30：pos_x=1238.8960 v_x=-2496.0000（含撞左墙反弹）',
      '(' + s30.pos[0].toFixed(4) + ', ' + s30.pos[1].toFixed(4) + ') vx=' + s30.vel[0].toFixed(4))
    say(near(s60.pos[0], 59.9853, 0.01) && near(s60.pos[1], 488.9784, 0.01) && near(s60.vel[0], -2396.16, 0.01),
      '★ 对拍 step 60：pos=(59.9853, 488.9784) v_x=-2396.1600 —— 与原程序逐位一致',
      '(' + s60.pos[0].toFixed(4) + ', ' + s60.pos[1].toFixed(4) + ') vx=' + s60.vel[0].toFixed(4))
    say(sr.step === 636 && near(sr.pos[0], 744.5518, 0.01) && near(sr.pos[1], 777.0, 0.001),
      '★ 对拍静止步：第 636 步静止（=10.18 秒）pos_x=744.5518 —— 与原程序一致',
      'step=' + sr.step + ' x=' + (sr.pos[0] || 0).toFixed(4))

    say(probe.clickBubbleAppeared === true,
      '★ 点击仍能弹气泡（位置接管没有把点击吞掉）',
      '气泡出现=' + probe.clickBubbleAppeared + (probe.clickError ? '  err=' + probe.clickError : ''))

    // —— 「偷吃白饭」入口 ——
    say(probe.riceChipExists === true && probe.riceChipDisplay === 'none',
      '★ 浮在外面的「偷吃白饭」小标签已隐藏', 'display=' + probe.riceChipDisplay)
    say(probe.riceMenuRow === true,
      '★ 入口已出现在小鲸鱼的 ☰ 菜单里', JSON.stringify(probe.riceRowLabel))
    say(probe.ricePanelOpened === true && probe.ricePanelWasOpen === false,
      '★ 点菜单里那一行能打开米粒设置面板',
      'open=' + probe.ricePanelOpened + (probe.riceEntryError ? '  err=' + probe.riceEntryError : ''))
    // —— 米粒面板里的控件必须真的有反应（用户报的"点了没反应"）——
    say(probe.riceCtlResponded === true,
      '★ 点米粒面板里的控件真的有反应（拖拽接管没有吞掉这次点击）',
      '勾选状态 ' + probe.riceCtlBefore + ' → ' + probe.riceCtlAfter +
      (probe.riceCtlError ? '  err=' + probe.riceCtlError : ''))
    say(probe.ricePanelStillOpen === true,
      '★ 点面板里的控件不会把面板关掉',
      '面板仍打开=' + probe.ricePanelStillOpen)

    // —— 【用户报的】唱歌「最少隔」右边的「分钟」不许错位到下一行 ——
    say(probe.layoutRangeRowCount > 0,
      '★ 带单位的行已被标记为「不许换行」（.dshpet-rangerow）',
      '标记了 ' + probe.layoutRangeRowCount + ' 行' +
      (probe.layoutError ? '  err=' + probe.layoutError : ''))
    say(probe.layoutNormalSameLine === true,
      '★ 「最少隔 … 分钟」在正常宽度下同一行（量竖直中心差，要求至少量到 2 个子元素）',
      '中心差=' + (probe.layoutNormal && probe.layoutNormal.spread) + 'px  子元素数=' +
      ((probe.layoutNormal && probe.layoutNormal.kids) || []).length + '  ' +
      JSON.stringify(probe.layoutNormal && probe.layoutNormal.kids))
    // ⚠️ 这一条才是"无论如何"：把面板压到 190px，逼出"内容刚好超一点"那个条件。
    //    旧代码在这种情况下必然把「分钟」wrap 到下一行。
    say(probe.layoutNarrowSameLine === true,
      '★ 把面板压窄到 190px 后**仍然同一行**（滑块被压缩，单位不换行）',
      '中心差=' + (probe.layoutNarrow && probe.layoutNarrow.spread) + 'px  ' +
      '横向溢出=' + probe.layoutNarrowOverflow + '  ' +
      JSON.stringify(probe.layoutNarrow && probe.layoutNarrow.kids))
    say(probe.layoutNarrowOverflow === false,
      '★ 压窄后这一行没有横向溢出（滑块让位，而不是把单位挤出去）',
      String(probe.layoutNarrowOverflow))
    say(probe.layoutRestoredSameLine === true,
      '★ 恢复宽度后依然同一行（不是靠一次性测量蒙对的）',
      String(probe.layoutRestoredSameLine))

    // —— 【用户报的】关闭物理拖动时点米粒面板的功能没反应 + 菜单被关 ——
    say(probe.pgPhysicsOff === false,
      '★ 前置：拖动物理已关闭（这条路径旧自检从来没测过）', 'enabled=' + probe.pgPhysicsOff)
    say(probe.pgPanelDrift === 0,
      '★ 关闭物理拖动后，在米粒面板里"按下→停 160ms→抬起"期间面板**纹丝不动**',
      '位移=' + probe.pgPanelDrift + 'px  按下时=' + JSON.stringify(probe.pgPanelAtPress) +
      '  抬起时=' + JSON.stringify(probe.pgPanelAtRelease) +
      (probe.pgError ? '  err=' + probe.pgError : ''))
    say(probe.pgElemAtPress === probe.pgElemAtRelease,
      '★ 抬起时指针底下还是同一个控件（旧代码这里会变成 BODY）',
      JSON.stringify(probe.pgElemAtPress) + ' → ' + JSON.stringify(probe.pgElemAtRelease))
    say(probe.pgResponded === true,
      '★ 这一下点击真的生效了（控件状态变了）',
      probe.pgBefore + ' → ' + probe.pgAfter)
    say(probe.pgPanelStillOpen === true,
      '★ 点完面板还开着（没被 rice 误判成"点外面"）',
      'open=' + probe.pgPanelStillOpen)

    // ========================================================================
    // 【新功能】识别歌曲和作者
    // ========================================================================
    // —— 挑歌逻辑：纯函数，用假会话数据测（本机没有那三个播放器）——
    try {
      const pick = nowPlayingMod && nowPlayingMod.pickSong
      if (!pick) {
        say(false, '★ 识别歌曲：pickSong 没导出来', 'nowPlayingMod=' + !!nowPlayingMod)
      } else {
        const mk = (app, title, artist, status) => ({ app, title, artist, status })
        const cases = [
          ['酷狗在播', [mk('KuGou.exe', '夜曲', '周杰伦', 'Playing')], '夜曲|周杰伦|酷狗音乐'],
          ['网易云在播', [mk('cloudmusic.exe', '晴天', '周杰伦', 'Playing')], '晴天|周杰伦|网易云音乐'],
          ['QQ音乐在播', [mk('QQMusic.exe', '稻香', '周杰伦', 'Playing')], '稻香|周杰伦|QQ音乐'],
          ['商店版包族名也能认', [mk('KugouMusic.KugouMusic_x!App', '告白气球', '周杰伦', 'Playing')], '告白气球|周杰伦|酷狗音乐'],
          ['暂停的也返回（渲染端据此收起气泡、停时钟）', [mk('KuGou.exe', '夜曲', '周杰伦', 'Paused')], '夜曲|周杰伦|酷狗音乐'],
          ['两个都在播 → 取酷狗', [mk('QQMusic.exe', 'QQ的歌', 'A', 'Playing'), mk('KuGou.exe', '酷狗的歌', 'B', 'Playing')], '酷狗的歌|B|酷狗音乐'],
          ['酷狗暂停、QQ在播 → 取QQ', [mk('KuGou.exe', '酷狗的歌', 'B', 'Paused'), mk('QQMusic.exe', 'QQ的歌', 'A', 'Playing')], 'QQ的歌|A|QQ音乐'],
          ['浏览器/B站不许误认', [mk('SLBrowser', '视频标题', '', 'Playing'), mk('com.bilibili.bilibiliPC', '直播间', '', 'Playing')], null],
          ['没有作者也要能识别', [mk('KuGou.exe', '纯音乐', '', 'Playing')], '纯音乐||酷狗音乐'],
          ['任意平台也能识别（汽水音乐）', [mk('SodaMusic.exe', '最后的夜', '歌手Y', 'Playing')], '最后的夜|歌手Y|SodaMusic'],
          ['商店包族名的未知平台也能识别', [mk('Spotify.SpotifyFree_x!App', 'Shape of You', 'Ed', 'Playing')], 'Shape of You|Ed|SpotifyFree_x'],
          ['已知播放器优先于未知平台', [mk('SodaMusic.exe', '未知平台在播', 'X', 'Playing'), mk('KuGou.exe', '酷狗在播', 'Y', 'Playing')], '酷狗在播|Y|酷狗音乐'],
          ['已知播放器暂停、未知平台在播 → 取未知平台', [mk('KuGou.exe', '酷狗的歌', 'B', 'Paused'), mk('SodaMusic.exe', '汽水在播', 'Z', 'Playing')], '汽水在播|Z|SodaMusic'],
          ['空列表', [], null],
        ]
        const fails = []
        for (const [name, sessions, want] of cases) {
          const r = pick(sessions)
          const got = r ? (r.title + '|' + r.artist + '|' + r.playerName) : null
          if (got !== want) fails.push({ name, got, want })
        }
        say(fails.length === 0,
          '★ 识别歌曲：挑歌逻辑 ' + cases.length + ' 条用例全对（任意平台、暂停、多开、误认防护）',
          fails.length ? JSON.stringify(fails) : '全部符合预期')
      }
    } catch (err) {
      say(false, '识别歌曲：挑歌逻辑自检抛异常', err && err.message)
    }

    // —— 常驻轮询：真的把 PowerShell 拉起来、真的读到了会话 ——
    try {
      const st = nowPlaying && nowPlaying.status ? nowPlaying.status() : null
      say(!!st && st.enabled === false,
        '★ 识别歌曲：默认关闭（不打开就不会白跑一个 PowerShell 子进程）',
        JSON.stringify(st && { enabled: st.enabled, ready: st.ready, pid: st.childPid }))
    } catch (err) { say(false, '识别歌曲：读状态抛异常', err && err.message) }

    // —— 菜单开关 + 气泡几何（用户要求：作者换行、每行居中、字不出气泡）——
    say(probe.npModuleLoaded === true && probe.npMenuRow === true,
      '★ 桌宠 ☰ 菜单里有「识别歌曲和作者」开关',
      JSON.stringify(probe.npMenuLabel) + '  有复选框=' + probe.npMenuHasCheckbox)
    say(probe.npApiExists === true,
      '★ preload 暴露了 nowPlayingSet / onNowPlaying（主进程链路接通）',
      'apiExists=' + probe.npApiExists)
    say(probe.npEnableResult && probe.npEnableResult.ok === true && probe.npEnabledAfterOn === true &&
        probe.npDisableResult && probe.npDisableResult.ok === true && probe.npEnabledAfterOff === false,
      '★ 开关能开能关（主进程侧状态跟着变）',
      '开=' + JSON.stringify(probe.npEnableResult) + ' 读回=' + probe.npEnabledAfterOn +
      '  关=' + JSON.stringify(probe.npDisableResult) + ' 读回=' + probe.npEnabledAfterOff +
      (probe.npError ? '  err=' + probe.npError : ''))
    say(probe.npBubbleOpen === true,
      '★ 识别到歌会弹出气泡',
      'exists=' + probe.npBubbleExists + ' open=' + probe.npBubbleOpen)
    say(probe.npArtistOnOwnLine === true,
      '★ 作者名字**换行**（歌名一行、作者一行）',
      '歌名中心y=' + probe.npTitleCenterY + '  作者中心y=' + probe.npArtistCenterY +
      '  ' + JSON.stringify(probe.npTitleText) + ' / ' + JSON.stringify(probe.npArtistText))
    say(probe.npTitleIsCentered === true && probe.npArtistIsCentered === true,
      '★ 歌名和作者**每一行都居中**（左右边距对称 + text-align:center）',
      '歌名=' + JSON.stringify(probe.npTitleCentered) + '  作者=' + JSON.stringify(probe.npArtistCentered))
    say(probe.npTextFits === true,
      '★ 长歌名/长作者也**全部留在气泡里**（自动缩字号，不裁切不溢出）',
      '横向溢出=' + probe.npTextOverflowX + 'px  纵向溢出=' + probe.npTextOverflowY +
      'px  缩放到=' + probe.npScale)
    say(probe.npTextInsideBubble === true,
      '★ 文字块整体落在泡泡主体范围内（不压描边、不飘到尾巴上）',
      '文字=' + JSON.stringify(probe.npTextRect) + '  主体=' + JSON.stringify(probe.npShapeRect))
    say(probe.npHiddenAfterHide === true,
      '★ 关掉开关后气泡立刻收起', String(probe.npHiddenAfterHide))

    // ========================================================================
    // 【新功能】识别歌词
    // ========================================================================
    // —— 纯函数：LRC 解析 / 挑歌 / 取当前句（确定性，不依赖网络）——
    try {
      const L = lyricsModRef
      if (!L || !L.parseLrc) {
        say(false, '★ 歌词：lyrics 模块没导出 parseLrc', 'lyricsModRef=' + !!L)
      } else {
        const src = ['[ti:测试]', '[ar:某人]', '[00:00.02]第一句', '[00:05.50][00:10.00]重复句', '[00:12.25]', '[00:15.00]<00:15.00>逐字<00:16.00>标签', '不是时间轴的行'].join('\n')
        const p = L.parseLrc(src)
        const okParse = p.length === 4 && p[0].t === 0.02 && p[0].text === '第一句' &&
          p[1].t === 5.5 && p[2].t === 10 && p[3].t === 15 && p[3].text === '逐字标签'
        say(okParse,
          '★ 歌词：LRC 解析正确（跳过元数据行、一行多标签都保留、去掉逐字标签、丢空行）',
          JSON.stringify(p))
        say(L.lineAt(p, 0) === '第一句' && L.lineAt(p, 5.6) === '重复句' && L.lineAt(p, 11) === '重复句' &&
            L.lineAt(p, 9999) === '逐字标签' && L.lineAt([], 5) === null,
          '★ 歌词：按播放位置取当前句正确（含越界回落 / 空歌词）',
          'pos0=' + JSON.stringify(L.lineAt(p, 0)) + ' pos5.6=' + JSON.stringify(L.lineAt(p, 5.6)) +
          ' pos11=' + JSON.stringify(L.lineAt(p, 11)) + ' pos9999=' + JSON.stringify(L.lineAt(p, 9999)))
        // 相似度：必须能把"毫不相关"和"同一个歌的不同版本"分开
        const cands = [
          { mid: 'a', name: '青花瓷 (Live)', singers: ['周杰伦'] },
          { mid: 'b', name: '青花瓷', singers: ['周杰伦'] },
        ]
        const best = L.pickBest(cands, '青花瓷', '周杰伦')
        const bad = L.pickBest([{ mid: 'x', name: '这首歌', singers: ['祁隆'] }], '这首歌根本不存在zzzqqq', '没人')
        say(best && best.song.mid === 'b',
          '★ 歌词：同名不同版本时优先选**原版**（Live 版不会抢走）',
          JSON.stringify(best))
        say(bad && bad.score < 50,
          '★ 歌词：毫不相关的搜索结果会被判低分 → 宁可不显示，也不显示**别人的歌词**',
          '相关度=' + (bad && bad.score))
        // 纯音乐占位行：实测本机放的纯音乐，QQ音乐只给一句
        // 「此歌曲为没有填词的纯音乐，请您欣赏」——那是音源方的说明，不是歌词
        const ph = L.isPlaceholderOnly ? L.isPlaceholderOnly([{ t: 0, text: '此歌曲为没有填词的纯音乐，请您欣赏' }]) : null
        const notPh = L.isPlaceholderOnly ? L.isPlaceholderOnly([{ t: 0, text: '素胚勾勒出青花笔锋浓转淡' }, { t: 5, text: '瓶身描绘的牡丹一如你初妆' }]) : null
        say(ph === true && notPh === false,
          '★ 歌词：纯音乐的占位说明会被识破（当作"没有歌词"，退回歌名/作者版式；真歌词绝不误伤）',
          '占位=' + ph + ' 真歌词=' + notPh)
      }
    } catch (err) {
      say(false, '歌词纯函数自检抛异常', err && err.message)
    }

    // —— 真实网络：QQ音乐（这个功能本来就要联网，所以这条断言就是它的真实前提）——
    try {
      const L = lyricsModRef
      const ly = L && L.createLyrics ? L.createLyrics({ log }) : null
      if (!ly) {
        say(false, '★ 歌词：createLyrics 不可用')
      } else {
        const r = await ly.fetch('青花瓷', '周杰伦', 199)   // 199s = 《青花瓷》真实时长，兼测时长闸
        say(r && r.lines && r.lines.length > 10 && r.source !== 'none',
          '★ 歌词：能从歌词源（酷狗/QQ/网易云任一）取到带时间轴的歌词',
          'source=' + (r && r.source) + ' 句数=' + (r && r.lines && r.lines.length) +
          ' 匹配=' + (r && r.matched) + ' 首句=' + JSON.stringify(r && r.lines && r.lines[0]))
        const nf = await ly.fetch('这首歌根本不存在zzzqqq', '没人')
        say(nf && nf.lines.length === 0 && nf.source === 'none',
          '★ 歌词：查不到时老实返回空（不拿别的歌糊弄）',
          'source=' + (nf && nf.source) + ' 句数=' + (nf && nf.lines.length))
      }
    } catch (err) {
      say(false, '歌词真实接口自检抛异常（网络不可用？）', err && err.message)
    }

    // —— 菜单两行开关 + 歌词"一句接一句" ——
    say(probe.lyRowCount === 2 && probe.lyRowBelowSong === true,
      '★ 菜单里「识别歌词」开关在「识别歌曲和作者」**正下方**',
      '行数=' + probe.lyRowCount + ' 标签=' + JSON.stringify(probe.lyLabels) + ' 紧邻=' + probe.lyRowBelowSong)
    say(probe.lyHasCheckbox === true && probe.lyApiExists === true,
      '★ 「识别歌词」是独立开关，preload 链路接通',
      '复选框=' + probe.lyHasCheckbox + ' api=' + probe.lyApiExists)
    say(probe.lyEnableResult && probe.lyEnableResult.ok === true && probe.lyEnabledAfterOn === true &&
        probe.lyDisableResult && probe.lyDisableResult.ok === true && probe.lyEnabledAfterOff === false,
      '★ 「识别歌词」能开能关（主进程侧状态跟着变）',
      '开=' + JSON.stringify(probe.lyEnableResult) + ' 读回=' + probe.lyEnabledAfterOn +
      '  关=' + JSON.stringify(probe.lyDisableResult) + ' 读回=' + probe.lyEnabledAfterOff +
      (probe.lyError ? '  err=' + probe.lyError : ''))
    // —— 核心：同一个气泡，播放位置一变就换句 ——
    say(probe.lyLineAt0 === '第一句歌词' && probe.lyLineAt55 === '第二句歌词' && probe.lyLineAt102 === '第三句歌词',
      '★ 歌词**一句接一句**：播放位置 0s / 5.5s / 10.2s 分别显示第 1 / 2 / 3 句',
      '0s=' + JSON.stringify(probe.lyLineAt0) + ' 5.5s=' + JSON.stringify(probe.lyLineAt55) +
      ' 10.2s=' + JSON.stringify(probe.lyLineAt102))
    say(probe.lyHeadText === '测试歌名 · 测试歌手',
      '★ 歌词模式下气泡上边仍标出「歌名 · 作者」', JSON.stringify(probe.lyHeadText))
    say(probe.lyCentered === true,
      '★ 歌词那一行也**居中**', JSON.stringify(probe.lyRect))
    say(probe.lyFits === true,
      '★ 歌词也**留在气泡里**（不裁切不溢出）', JSON.stringify(probe.lyOverflow))

    // ========================================================================
    // 【新功能】「笑一下」贴图
    // ========================================================================
    say(probe.laughLoaded === true && probe.laughImgStatus === 200,
      '★ 「笑一下」贴图模块已加载，笑图能取到（/whale-sprite-laugh.png）',
      'loaded=' + probe.laughLoaded + '  HTTP ' + probe.laughImgStatus)
    say(String(probe.laughSrcDuring || '').indexOf('whale-sprite-laugh') >= 0 &&
        probe.laughSrcAfter === probe.laughSrcBefore &&
        (!probe.laughDesired || probe.laughSrcAfter === probe.laughDesired),
      '★ 触发后换成笑图，**2 秒后还原成变化前那张**（且等于形象状态机此刻本该显示的那张）',
      JSON.stringify(probe.laughSrcBefore) + ' → ' + JSON.stringify(probe.laughSrcDuring) +
      ' → ' + JSON.stringify(probe.laughSrcAfter) +
      '  本该显示=' + JSON.stringify(probe.laughDesired) +
      (probe.laughError ? '  err=' + probe.laughError : ''))
    say(probe.laughSrcAfterDouble === probe.laughSrcBefore,
      '★ 2 秒内连续触发两次，最终仍还原成**最初**那张（不会把笑图当原图存下来）',
      '最初=' + JSON.stringify(probe.laughSrcBefore) + ' 后=' + JSON.stringify(probe.laughSrcAfterDouble))
    say(Array.isArray(probe.laughBalanceMismatch) && probe.laughBalanceMismatch.length === 0,
      '★ 余额 <5 / <1 / ==0 三个阈值各触发一次、不重复；回到阈值以上会复位',
      JSON.stringify(probe.laughBalanceLog))
    say(probe.laughOnSuccess === true,
      '★ 偷吃**成功**（碗正常放下、没被打断）→ 触发笑', 'fired=' + probe.laughOnSuccess)
    say(probe.laughOnSpill === false,
      '★ 偷吃**被打断**（碗被打翻）→ **不**触发笑', 'fired=' + probe.laughOnSpill)
    say(probe.laughOnAbort === false,
      '★ 刚举碗就被收掉（没吃到嘴）→ **不**触发笑', 'fired=' + probe.laughOnAbort)
    say(probe.laughGrainHiddenDuring === true && probe.laughGrainHiddenAfter === false &&
        probe.laughGrainShownAfter === true,
      '★ 米粒图和贴图**同步**：笑图出现时米粒同时消失，贴图恢复时米粒同时出现',
      '笑图期间按住=' + probe.laughGrainHiddenDuring + ' 恢复后按住=' + probe.laughGrainHiddenAfter +
      ' 恢复后米粒露着=' + probe.laughGrainShownAfter)
    say(probe.laughGrainReshown === true && probe.laughGrainReshownGone === false,
      '★ 笑的过程中 rice 自己把米粒收掉了 → 恢复贴图时补回来，并按 grainMs 自己收掉（不会永远挂着）',
      '恢复后露着=' + probe.laughGrainReshown + ' 再等 grainMs 后=' + probe.laughGrainReshownGone)

    // ========================================================================
    // 【新功能】内置泡泡图
    // ========================================================================
    say(probe.bimgOk === true && probe.bimgMineCount === 41,
      '★ 内置泡泡图：清单接口里有那 41 张（原 24 + 新 17），且都标了 builtin（客户端显示「内置图」、不给删）',
      '总项数=' + probe.bimgTotal + ' 我们的=' + probe.bimgMineCount +
      '  前 4 个=' + JSON.stringify((probe.bimgMineIds || []).slice(0, 4)) +
      '  后 4 个=' + JSON.stringify((probe.bimgMineIds || []).slice(-4)) +
      (probe.bimgError ? '  err=' + probe.bimgError : ''))
    say(probe.bimgOkCount === 41 && (probe.bimgBad || []).length === 0,
      '★ 41 张图逐个取一遍：全部 200、Content-Type 是 image/*、且字节确实是图片',
      '成功=' + probe.bimgOkCount + '/41' + ((probe.bimgBad || []).length ? '  失败=' + JSON.stringify(probe.bimgBad) : ''))
    say(probe.bimgBuiltinsFirst === true,
      '★ 内置图排在清单最前面（没打乱客户端「内置图在前、用户图在后」的顺序）',
      'builtinsFirst=' + probe.bimgBuiltinsFirst)
    // —— 用户要求："桌宠设置里新图跟前面的 24 张放一块" ——
    //    也就是清单里必须是「先 24 张、紧接着 17 张」这样连在一起，
    //    而不是散开或被别人插在中间。
    const FIRST24 = ['bimg_big_coming','bimg_curse','bimg_dadeyaolaile','bimg_dead_fish','bimg_deepsleep','bimg_dsh','bimg_evaluable','bimg_fat_fish','bimg_go_to_agi','bimg_hajimi','bimg_kaidian','bimg_keai','bimg_mama','bimg_more_modal','bimg_no-money','bimg_not_care','bimg_ojingjing','bimg_ojj','bimg_push','bimg_push_one_fat_fish','bimg_unvaluable','bimg_update','bimg_virus','bimg_yupian']
    const NEW17 = ['bimg_dance','bimg_daquan','bimg_fanxiangzapen','bimg_finish','bimg_laowu','bimg_many_zapen','bimg_meili','bimg_meiyong','bimg_nongni','bimg_not_laughing','bimg_pig','bimg_sixseven','bimg_touken','bimg_violate','bimg_weiji','bimg_youyu','bimg_zapen']
    const ids = probe.bimgMineIds || []
    const head24 = ids.slice(0, 24).join(',')
    const tail17 = ids.slice(24).join(',')
    say(head24 === FIRST24.join(',') && tail17 === NEW17.join(','),
      '★ 新图跟前面的 24 张**放在一块**：清单里是「先 24 张、紧接着 17 张」连着排，中间没有别人',
      '前 24=' + (head24 === FIRST24.join(',') ? '一致' : JSON.stringify(ids.slice(0, 24))) +
      ' 后 17=' + (tail17 === NEW17.join(',') ? '一致' : JSON.stringify(ids.slice(24))))
    say(probe.bimgCtOk === true,
      '★ 24 张图的 Content-Type 和**真实文件头**一致（其中 15 张其实是 JPEG，文件名却是 .png）',
      (probe.bimgCtBad || []).length ? JSON.stringify(probe.bimgCtBad) : '全部一致')
    say(probe.bimgKeepCount === 2 && probe.bimgKeepOk === 2,
      '★ 挂件自带的两张内置图（petpet / money1）没被我们弄坏',
      '找到=' + probe.bimgKeepCount + ' 可取=' + probe.bimgKeepOk)
    say(probe.bimgUiMaskOpen === true && probe.bimgUiBuiltinTags >= 43,
      '★ 客户端 UI 层：挂件「资源管理」里能看到它们，且标成「内置图」（41 + 自带 2）',
      '面板打开=' + probe.bimgUiMaskOpen + ' 「内置图」标签数=' + probe.bimgUiBuiltinTags +
      ' 名字命中=' + probe.bimgUiNameHit + '/41' +
      (probe.bimgUiError ? '  err=' + probe.bimgUiError : ''))

    // ========================================================================
    // 「偷吃白饭」原生小标签：从第一帧就不可点
    // ========================================================================
    say(probe.chipDisplay === 'none' && probe.chipRuleInShellCss === true,
      '★ 偷吃白饭的原生小标签是 display:none，且**隐藏规则在外壳样式表里**（第一帧生效，不等那 4 秒定时器）',
      'display=' + probe.chipDisplay + ' 规则在 shell.css=' + probe.chipRuleInShellCss +
      ' 也在别处=' + probe.chipRuleInOtherCss +
      (probe.chipError ? '  err=' + probe.chipError : ''))
    say(probe.chipIsHitTarget === false,
      '★ 它不是命中目标 —— 点它那块位置不会把偷吃白饭菜单弹出来（这就是用户报的"偶尔弹出"）',
      'chip 矩形=' + JSON.stringify(probe.chipRect) + ' 是命中目标=' + probe.chipIsHitTarget)

    // ========================================================================
    // 【新功能】默认泡泡序列里的「随机图片」气泡
    // ========================================================================
    // ① 静态：默认序列里确实有一个 randimg，池子是那 41 张
    try {
      const src = fs.readFileSync(path.join(ROOT, 'vendor/whale/assets/whale-widget.js'), 'utf8')
      const s = src.indexOf('var BUBBLE_DEFAULT_ITEMS = [')
      const e = src.indexOf('\n];', s)
      const arr = (s >= 0 && e > s) ? src.slice(s, e) : ''
      const hasRand = /"type":\s*"randimg"/.test(arr)
      const bimgN = (arr.match(/"bimg_/g) || []).length
      out_bimgDefault = { hasRandimg: hasRand, bimgRefs: bimgN }
      // 池子里 41 张 + 原版那张 petpet（在 choice 的某个选项里）= 42
      say(hasRand && bimgN >= 42,
        '★ 默认泡泡序列里有一个「随机图片」气泡，池子就是那 41 张内置图',
        'randimg=' + hasRand + ' 池子里的 bimg_ 引用数=' + bimgN + '（41 张 + 原版 petpet）')
    } catch (err) {
      say(false, '默认泡泡序列静态检查失败', err && err.message)
    }
    // ② 运行时：点她 → 点泡泡往后翻，气泡里真的抽出了那 24 张里的某一张
    say(probe.bbOurs > 0,
      '★ 实际点着看：气泡里真的抽出了这 24 张里的图（默认就会自动出现，不用手动选）',
      '出现过 ' + probe.bbOurs + ' 次，其中不同的 ' + probe.bbDistinctOurs + ' 张；' +
      '序列=' + JSON.stringify(probe.bbSeenIds) +
      (probe.bbError ? '  err=' + probe.bbError : ''))

    // —— 完整链路端到端：喂一行"酷狗在播"的假数据，看气泡里到底出现了什么 ——
    // 这一段必须在这里做（不能在渲染进程探针里）：注入发生在**主进程**，
    // 而且要走完 IPC 才算数。本机没装播放器，这是唯一能验整条链的办法。
    try {
      // ① 渲染进程：把开关打开、清掉旧气泡
      await win.webContents.executeJavaScript(`(function(){
        try { localStorage.setItem('dshpet-now-playing','1') } catch(e){}
        if (window.__dshpetNowPlaying) { window.__dshpetNowPlaying.hide(); }
        // ⚠️ 上一段泡泡测试可能把**挂件自己的泡泡**留在屏幕上 —— np 气泡按
        //    "不叠泡泡"的设计会等它收起（最长 8s），本用例 900ms 就采样，
        //    会被它憋住。这里直接把它关掉。
        try {
          var wb = document.querySelector('.dshwv-pop')
          if (wb) wb.classList.remove('dshwv-pop-open')
        } catch(e){}
        return true
      })()`)
      if (nowPlaying) { try { nowPlaying.setEnabled(true) } catch (e) {} }
      await sleep(300)
      // ② 主进程：注入一行与 gsmtc.ps1 输出**同格式**的假数据
      const fakeLine = JSON.stringify({
        ok: true,
        sessions: [
          { app: 'SLBrowser', title: '干扰项：浏览器视频', artist: '', album: '', status: 'Playing' },
          { app: 'KuGou.exe', title: '青花瓷', artist: '周杰伦', album: '我很忙', status: 'Playing' },
        ],
      })
      if (nowPlaying && nowPlaying.__testLine) nowPlaying.__testLine(fakeLine)
      await sleep(900)
      // ③ 渲染进程：读气泡里实际显示的内容
      const got = await win.webContents.executeJavaScript(`(function(){
        var p = document.querySelector('.dshpet-np-pop')
        var t = document.querySelector('.dshpet-np-title')
        var a = document.querySelector('.dshpet-np-artist')
        var tb = document.querySelector('.dshpet-np-text')
        return {
          open: !!(p && p.classList.contains('dshpet-np-open')),
          title: t ? t.textContent : null,
          artist: a ? a.textContent : null,
          titleY: t ? Math.round(t.getBoundingClientRect().top) : null,
          artistY: a ? Math.round(a.getBoundingClientRect().top) : null,
          overflowY: tb ? (tb.scrollHeight - tb.clientHeight) : null,
          overflowX: tb ? (tb.scrollWidth - tb.clientWidth) : null,
        }
      })()`)
      say(got.open === true && got.title === '青花瓷' && got.artist === '周杰伦',
        '★ 端到端：主进程识别到「酷狗在播青花瓷/周杰伦」→ 经 IPC → 气泡里正是它（浏览器干扰项被忽略）',
        JSON.stringify(got))
      say(got.artistY > got.titleY,
        '★ 端到端气泡里作者仍在**下一行**', '歌名y=' + got.titleY + ' 作者y=' + got.artistY)
      say(got.overflowX <= 1 && got.overflowY <= 1,
        '★ 端到端气泡里文字没有溢出', 'x=' + got.overflowX + ' y=' + got.overflowY)
      // 收尾：关掉开关 + 清掉假状态
      if (nowPlaying) nowPlaying.setEnabled(false)
      await win.webContents.executeJavaScript(`(function(){
        try { localStorage.setItem('dshpet-now-playing','0') } catch(e){}
        if (window.__dshpetNowPlaying) window.__dshpetNowPlaying.hide()
        return true
      })()`)
      await sleep(200)
    } catch (err) {
      say(false, '识别歌曲端到端自检抛异常', err && err.message)
    }

    // —— 【桌宠版】唱歌那一行的音乐控件 ——
    say(probe.songOldNoteGone === true,
      '★ 「歌放在 songs/ 文件夹里」那行文字已删掉', '已删=' + probe.songOldNoteGone)
    say(probe.songFolderBtn === '选择音乐…' && probe.songDefBtn === '默认',
      '★ 音乐行有「选择音乐…」「默认」两个按钮（和音效那套同款）',
      JSON.stringify(probe.songFolderBtn) + ' / ' + JSON.stringify(probe.songDefBtn))
    say(probe.songSelExists === true && probe.songListHiddenBefore === true,
      '★ 按钮下面有选择栏，且默认收起',
      '选择栏=' + probe.songSelExists + ' 初始收起=' + probe.songListHiddenBefore +
      ' 当前显示=' + JSON.stringify(probe.songSelLabel))
    say(probe.songListShownAfter === true && probe.songListBelowSel === true,
      '★ 点选择栏在它**下面**展开二级菜单',
      '展开=' + probe.songListShownAfter + ' 在下方=' + probe.songListBelowSel)
    say(probe.songItemCount >= 1 && (probe.songItemNames || []).some(function (n) {
      return String(n).indexOf('let-me-go') >= 0
    }), '★ 二级菜单读到了 songs 文件夹里的音频', JSON.stringify(probe.songItemNames))
    // ★ 核心：选哪首就唱哪首（靠"让 rice 取到的歌单只剩这一首"实现）
    say(Array.isArray(probe.songsAfterPick) && probe.songsAfterPick.length === 1 &&
        probe.songsAfterPick[0] === probe.songPickedFile,
      '★ 选某一首之后，rice 取到的歌单只剩那一首（= 选哪首就唱哪首，不是随机）',
      '选中 ' + JSON.stringify(probe.songPickedName) + ' → 歌单 ' + JSON.stringify(probe.songsAfterPick) +
      (probe.songsAfterPickError ? '  err=' + probe.songsAfterPickError : ''))
    say(Array.isArray(probe.songsAfterRandom) && probe.songsAfterRandom.length >= 1 &&
        String(probe.songLabelBackToRandom || '').indexOf('随机') >= 0,
      '★ 二级菜单置顶的「🎲 随机播放」能切回随机（歌单恢复成全部）',
      '随机时歌单 ' + JSON.stringify(probe.songsAfterRandom) + '  标签 ' + JSON.stringify(probe.songLabelBackToRandom))
    say(typeof probe.songSelLabelAfter === 'string' &&
        probe.songSelLabelAfter !== probe.songSelLabel && probe.songListClosedAfterPick === true,
      '★ 点二级菜单里的音频就切换了音乐，并收起菜单',
      JSON.stringify(probe.songSelLabel) + ' → ' + JSON.stringify(probe.songSelLabelAfter) +
      '  收起=' + probe.songListClosedAfterPick + (probe.songError ? '  err=' + probe.songError : ''))

    say(probe.riceClosedByOutsideClick === true,
      '★ 点空白处能关掉米粒面板',
      '关闭成功=' + probe.riceClosedByOutsideClick)
    say(probe.interactiveWhilePanelOpen === true,
      '★ 面板开着时整窗接收鼠标事件（否则点击落不到页面上、永远关不掉）',
      'evaluate(5,5)=' + probe.interactiveWhilePanelOpen)
    // 稳定性判据：数**变化次数**，不是数"有几个不同取值"。
    // 面板刚打开时会归位一次（正常），振荡的特征是**一直**在变。
    // 所以：看后半段 6 次采样里变了几次，≤1 就算稳。
    const tail = (probe.ricePanelSamples || []).slice(-6)
    let changes = 0
    for (let i = 1; i < tail.length; i++) if (tail[i] !== tail[i - 1]) changes++
    say(tail.length >= 4 && changes <= 1,
      '★ 面板位置稳定（后半段 6 次采样里变化 ≤1 次，不会来回跳）',
      '变化 ' + changes + ' 次；样本 ' + JSON.stringify(tail.slice(0, 2)) + '…' +
      JSON.stringify(tail.slice(-2)))
    // 避让必须真的生效：面板右边缘要在鲸鱼菜单左边缘的左边
    const rpr = probe.ricePanelRect || {}
    const wmr = probe.whaleMenuRect || {}
    say(!!rpr.l && !!wmr.l && rpr.l + rpr.w <= wmr.l + 1,
      '★ 面板确实让开了鲸鱼菜单（右边缘在菜单左边缘左侧）',
      '面板右=' + (rpr.l + rpr.w) + '  菜单左=' + wmr.l)
    say(true, '诊断：面板/鲸鱼菜单的位置',
      '面板=' + JSON.stringify(probe.ricePanelRect) + '  鲸鱼菜单=' + JSON.stringify(probe.whaleMenuRect))

    // —— 位置接管不能再走 CSS 自定义属性（那会让整棵子树样式重算 → 拖动卡顿）——
    say(probe.physInlineImportant === true,
      '★ 位置用行内 !important 的 left/top 写（和挂件原生拖动同一种写法）',
      'priority=' + probe.physLeftPriority + '  left=' + probe.physLeftValue)
    say(probe.physNoCustomProp === true,
      '★ 没有用 CSS 自定义属性（--dshpet-px 会继承 → 全子树样式重算 → 卡顿）',
      '--dshpet-px=' + JSON.stringify(probe.physCustomProp))

    say(true, '诊断：窗口几何', JSON.stringify(probe.winGeom))

    // —— 可达范围：立绘要能贴到屏幕左上角 ——
    const tla = probe.topLeftArtRect || {}
    say(tla.l <= 2 && tla.t <= 2,
      '★ 拖到最左上时立绘能贴住 (0,0)（屏幕顶部没有拖不到的死区）',
      '立绘左上=' + JSON.stringify(tla) + '  phys=' + JSON.stringify(probe.topLeftPhys) +
      (probe.topLeftError ? '  err=' + probe.topLeftError : ''))

    // —— 朝向：拖到左半边必须翻转 ——
    say(probe.flippedAfterLeftDrag === true,
      '★ 拖到屏幕左半边后她翻转了朝向（dshwv-left 已加上）',
      String(probe.flippedAfterLeftDrag))
    // ⚠️ 这一条原来是"翻转后 artOffset.dx 必须和未翻转一致"——
    //    **那个假设本身就是 bug 的来源**：翻转会真的改变立绘相对盒子的偏移
    //    （未翻转 152 / 已翻转 0），硬把它"还原"成 152 会让 bounds.left 恒为 -152，
    //    而翻转后 art.left 其实等于 box.left —— 于是她能露到屏幕左边外面 152px
    //    （用户报的"拖到左边一翻转就跑到桌面外边"）。
    //    正确的判据是：**把盒子范围换算到"立绘空间"后，两种朝向必须一致**，
    //    也就是她在两种朝向下能到达的**位置**完全相同、且都在工作区内。
    const aof = probe.artOffsetAfterFlip || {}
    const aon = probe.artOffset || {}
    const bof = probe.boundsAfterFlip || {}
    const bon = probe.physBounds || {}
    const artSpace = (a, b) => (a && b && isFinite(a.dx) && isFinite(b.left))
      ? { left: b.left + a.dx, right: b.right + a.dx, bottom: b.bottom + a.dy }
      : null
    const asF = artSpace(aof, bof)
    const asN = artSpace(aon, bon)
    say(!!asF && !!asN &&
        Math.abs(asF.left - asN.left) < 2 && Math.abs(asF.right - asN.right) < 2,
      '★ 翻转前后，**立绘能到达的范围完全一致**（换算到立绘空间后逐项相等）',
      '翻转后=' + JSON.stringify(asF) + '  未翻转=' + JSON.stringify(asN) +
      '  dx(翻转/未翻转)=' + Math.round(aof.dx || 0) + '/' + Math.round(aon.dx || 0))
    say(!!asF && !!asN && asF.left >= -1 && asN.left >= -1,
      '★ 翻转后立绘左边界仍在屏幕内（不会露到桌面外）',
      '翻转后立绘空间左界=' + (asF && Math.round(asF.left)) + '  未翻转=' + (asN && Math.round(asN.left)))

    // —— 拖动是 1:1 跟手（两种模式同一条路径）——
    say(probe.dragDx === -100 && probe.dragDy === 0,
      '★ 拖动 1:1 跟手（合成拖动 -100px，她正好跟着走 -100px）',
      'dx=' + probe.dragDx + ' dy=' + probe.dragDy + (probe.dragError ? '  err=' + probe.dragError : ''))
    say(probe.dragDraggingFlag === true && probe.dragFlagCleared === true,
      '拖动标记在拖中置位、松手清除（shell.js 靠它让开布局）',
      '拖中=' + probe.dragDraggingFlag + ' 松手后=' + probe.dragFlagCleared)
    say(probe.dragModeAfter === null,
      '慢速松手不会抛（低于 500px/s 阈值 → 原地放下）', String(probe.dragModeAfter))

    // —— 启动位置：一定在桌面右下角 ——
    const ss = probe.startState || {}
    const sb = probe.startBounds || {}
    say(!!ss.pos && Math.abs(ss.pos[0] - sb.right) < 2 && Math.abs(ss.pos[1] - sb.bottom) < 2,
      '★ 启动时她在桌面右下角（立绘右下角贴住屏幕右下角）',
      'pos=' + JSON.stringify(ss.pos) + '  期望≈[' + Math.round(sb.right) + ',' + Math.round(sb.bottom) + ']')
    // 落盘的记录必须指向"右下角"（锚点 right/bottom、离边 0）。
    // 注意：探针跑到这里时，start() 已经把她摆好并落盘了一次 —— 所以 key 是存在的，
    // 要断言的是**内容**是右下角，而不是"key 不存在"。
    say((function () {
      try {
        var a = JSON.parse(probe.storedPos || 'null')
        if (!a) return false
        // vDist 是"离**窗口**下沿的距离"（挂件恢复时用的就是 window.innerHeight）。
        // 窗口现在盖住整屏，而她要停在任务栏**上面**，所以 vDist 正常就应该是
        // "任务栏高度"（本例 1152-1104=48），不是 0。
        var taskbar = (probe.screenInfo && probe.screenInfo.h - probe.screenInfo.availH) || 0
        return a.hAnchor === 'right' && a.vAnchor === 'bottom' &&
          a.hDist === 0 && Math.abs(a.vDist - taskbar) <= 2
      } catch (e) { return false }
    })(), '★ 位置记录指向"任务栏上面的右下角"（hDist=0，vDist=任务栏高度）', String(probe.storedPos))

    // —— 米粒入口：要是个"被边框框住"的按钮 ——
    say(probe.riceRowBoxed === true,
      '★ 菜单里的「偷吃白饭」有边框框住（和原来那个浮动标签一个观感）',
      'border=' + probe.riceRowBorder + '  radius=' + probe.riceRowRadius)
    say(probe.ricePanelShiftFn === true,
      '面板避让函数已就绪（会往左让开鲸鱼菜单）', String(probe.ricePanelShiftFn))

    // —— 夹取：越界值必须被拉回界内 ——
    const pb2 = probe.physBounds || {}
    const cl = probe.clampFarLeft || []
    const cr = probe.clampFarRight || []
    say(Math.abs(cl[0] - pb2.left) < 1 && Math.abs(cl[1] - pb2.top) < 1,
      '★ 弹簧过冲后会被拉回界内（左上越界 → 夹回 bounds）',
      '(-99999,-99999) → (' + Math.round(cl[0]) + ',' + Math.round(cl[1]) + ')')
    say(Math.abs(cr[0] - pb2.right) < 1 && Math.abs(cr[1] - pb2.bottom) < 1,
      '★ 右下越界同样被夹回', '(99999,99999) → (' + Math.round(cr[0]) + ',' + Math.round(cr[1]) + ')')

    // —— 可移动范围：立绘必须能贴到屏幕四边 ——
    // 背景：挂件按"盒子"夹取，而立绘只占盒子右下 59.45%，盒子左上方多出约 152px 空区。
    //      按盒子夹 → 立绘永远够不到屏幕顶/左（用户报的"上面一整块拖不上去"）。
    const ao = probe.artOffset || {}
    const pb = probe.physBounds || {}
    const vpx = probe.viewport || {}
    say(ao.dx > 0 && ao.dy > 0, '确认盒子比立绘大（左上多出空白）',
      '立绘偏移 (' + Math.round(ao.dx) + ',' + Math.round(ao.dy) + ')  立绘 ' + Math.round(ao.w) + '×' + Math.round(ao.h))
    say(near(pb.top, -ao.dy, 1), '★ 立绘上边缘能贴到屏幕顶（盒子取负值，正常）',
      'bounds.top=' + Math.round(pb.top) + '  应≈' + (-Math.round(ao.dy)))
    say(near(pb.left, -ao.dx, 1), '★ 立绘左边缘能贴到屏幕左',
      'bounds.left=' + Math.round(pb.left) + '  应≈' + (-Math.round(ao.dx)))
    // 右/下边界要对齐**工作区**（availW/availH），不是整屏 —— 右下要停在任务栏上沿
    const siW = (probe.screenInfo && probe.screenInfo.availW) || vpx.w
    const siH = (probe.screenInfo && probe.screenInfo.availH) || vpx.h
    say(near(pb.right + ao.dx + ao.w, siW, 1) && near(pb.bottom + ao.dy + ao.h, siH, 1),
      '★ 立绘右/下边缘能贴到**工作区**右/下（右下停在任务栏上沿）',
      '右=' + Math.round(pb.right + ao.dx + ao.w) + '/' + siW + '  下=' + Math.round(pb.bottom + ao.dy + ao.h) + '/' + siH)

    // —— 真跑一次抛掷（"乱飞"的端到端回归）——
    const tm = probe.throwMid || {}
    const te = probe.throwEnd || {}
    const tb = probe.throwBounds || {}
    const tr2 = probe.throwEndRect
    say(tm.mode === 'throw', '抛掷中：1.2 秒时仍在飞（mode=throw）', JSON.stringify(tm))
    say(te.mode === null, '★ 抛掷能停下来（4.5 秒后 mode=null，没有无限弹跳）', JSON.stringify(te))
    // 落定后立绘必须完整在屏幕内（盒子可以超出，因为立绘只占右下角）
    const aok = probe.artOffset || {}
    const artL = tr2 ? tr2.l + aok.dx : -1
    const artT = tr2 ? tr2.t + aok.dy : -1
    say(!!tr2 && artL >= -2 && artL + aok.w <= tb.w + 2 && artT >= -2 && artT + aok.h <= tb.h + 2,
      '★ 最终停住时立绘完整在屏幕内（不会跑到屏幕外）',
      tr2 ? ('立绘 x∈[' + Math.round(artL) + ',' + Math.round(artL + aok.w) + '] y∈[' + Math.round(artT) + ',' + Math.round(artT + aok.h) + ']  屏幕 ' + tb.w + '×' + tb.h) : 'n/a')

    // 再探一次宿主：确认服务在窗口活着的时候也正常
    const r = await fetch(`http://127.0.0.1:${server.port}/dsh-whale/size.json`)
    say(r.ok, '窗口运行中宿主接口仍可用', 'HTTP ' + r.status)

    // —— 打包相关的两条：asar 是只读归档，路径读不出来时表现很隐蔽 ——
    //   ① 托盘图标：nativeImage.createFromPath 读 asar 内的 ico
    //   ② 设置页：loadFile 读 asar 内的 html
    //   这两条在开发模式下永远通过（走的是真实文件系统），只有打包后才可能暴露。
    try {
      const icon = trayIcon()
      const size = icon.getSize()
      say(!icon.isEmpty(), '托盘图标可加载（asar 内路径）', size.width + 'x' + size.height)
    } catch (err) {
      say(false, '托盘图标加载抛错', err && err.message)
    }
    for (const rel of ['renderer/settings.html', 'renderer/index.html', 'renderer/shell.js', 'assets/icon.ico']) {
      let okFile = false
      try { okFile = fs.statSync(path.join(ROOT, rel)).size > 0 } catch (err) {}
      say(okFile, '打包内文件可读：' + rel)
    }
  } catch (err) {
    // 聚焦模式用 throw {__done:true} 跳出那堆很慢的断言，直接进汇总
    if (!(err && err.__done)) say(false, '自检过程抛异常', err && err.message)
  }

  const bad = results.filter((r) => !r.ok)
  const summary = `自检：通过 ${results.length - bad.length} / 失败 ${bad.length}`
  lines.push('', summary)
  console.log('\n' + summary)
  flush()
  quitting = true
  app.exit(bad.length ? 1 : 0)
}

// ---------------------------------------------------------------------------
// 聚焦探针：排查"偶发"的交互 bug
// ---------------------------------------------------------------------------
// 完整自检里有一段 11.5 秒的抛掷仿真、还有一堆拖拽用例，跑一轮要一分钟。
// 而"有时候点了没反应"这类 bug 必须**反复试很多次**才撞得上 ——
// 每轮等一分钟根本迭代不动。所以这里给一个只跑单条探针的入口：
//     PET_SELFTEST=1 PET_FOCUS=rice-click electron .
// 它复用同一套"等页面加载 + 等挂件初始化"的流程，只跳过后面的慢段落。
async function runFocusProbe() {
  // —— 小鲸鱼挂件 0.3.10 的几项修复/新增，逐条验 ——
  if (FOCUS === 'v310') {
    return await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const q = (s) => document.querySelector(s)
      const qa = (s) => Array.prototype.slice.call(document.querySelectorAll(s))
      const checks = []
      const add = (ok, label, extra) => checks.push({ ok: !!ok, label, extra })
      const out = {}

      // ① 版本号：宿主必须已经在报 0.3.16
      try {
        for (const u of ['/dsh-whale/usage.json', '/dsh-whale/usage', '/dsh-whale/balance.json']) {
          const r = await fetch(u, { cache: 'no-store' })
          if (r.status !== 200) continue
          const d = await r.json()
          if (d && d.version) { out.version = String(d.version); out.versionUrl = u; break }
        }
      } catch (e) {}
      add(out.version === '0.3.16',
        '★ 宿主已经在报 0.3.16（确认新代码真的生效了，不是还在跑旧文件）',
        'version=' + JSON.stringify(out.version) + ' 来源=' + out.versionUrl)

      // ② 「音效」总开关：必须在「音量」那一行里，且默认是开的
      out.diagMenus = qa('.dshwv-menu').length
      out.diagRanges = qa('.dshwv-range').length
      out.diagChecks = qa('input.dshwv-check').length
      out.diagMenuRows = qa('.dshwv-menu-row').length
      out.diagMenuText = (q('.dshwv-menu') ? String(q('.dshwv-menu').textContent || '').slice(0, 120) : '')
      out.diagRangeParents = qa('.dshwv-range').map((el) => {
        const p = el.parentNode
        return p ? String(p.className || p.tagName) : '?'
      })
      const range = (function () {
        // ⚠️ 菜单里有两个 range：先出现的是「大小」。要按**标签文字**找「音量」那一行，
        //    不能直接取第一个 .dshwv-range（第一版就是这么找错的）。
        for (const r of qa('.dshwv-menu-row')) {
          if (!r.querySelector('.dshwv-range')) continue
          const t = String(r.textContent || '')
          if (t.indexOf('音量') >= 0) return r.querySelector('.dshwv-range')
        }
        return null
      })()
      const row = range ? range.closest('.dshwv-menu-row') : null
      const toggle = row ? row.querySelector('input.dshwv-check') : null
      out.soundToggleFound = !!toggle
      out.soundToggleChecked = toggle ? toggle.checked : null
      out.soundToggleTitle = toggle ? String(toggle.title || '') : ''
      add(!!toggle && toggle.checked === true,
        '★ 新增的「音效」总开关在「音量」那一行里，默认是开的',
        '找到=' + !!toggle + ' 开着=' + out.soundToggleChecked +
        ' 说明=' + JSON.stringify(out.soundToggleTitle.slice(0, 40)))

      // ③ 音量拉到 0 **不再**自动关音效（改成开关说了算）
      if (range && toggle) {
        const oldV = range.value
        range.value = '0'
        range.dispatchEvent(new Event('input', { bubbles: true }))
        range.dispatchEvent(new Event('change', { bubbles: true }))
        await sleep(200)
        out.toggleAfterVol0 = toggle.checked
        add(toggle.checked === true,
          '★ 音量拉到 0，音效开关**仍然是开的**（不再由音量派生"静音"）',
          '音量=0 之后开关=' + out.toggleAfterVol0)
        // 再把开关关掉 → 必须立刻静音（状态落到开关上）
        toggle.checked = false
        toggle.dispatchEvent(new Event('change', { bubbles: true }))
        await sleep(200)
        out.offAfterUncheck = toggle.checked === false
        add(toggle.checked === false,
          '★ 关掉开关能真正关掉（不再依赖音量）', '开关=' + toggle.checked)
        // 复原
        toggle.checked = true
        toggle.dispatchEvent(new Event('change', { bubbles: true }))
        range.value = oldV
        range.dispatchEvent(new Event('change', { bubbles: true }))
        await sleep(150)
      }

      // ④ 雾面/毛玻璃：根节点上不该有任何"画底"的通道
      const rootEl = q('.dshwv-root')
      if (rootEl) {
        const cs = getComputedStyle(rootEl)
        out.rootBgImage = cs.backgroundImage
        out.rootBackdrop = cs.backdropFilter || cs.webkitBackdropFilter || 'none'
        out.rootFilter = cs.filter
        out.rootBgColor = cs.backgroundColor
        const clean = (out.rootBgImage === 'none') &&
          (out.rootBackdrop === 'none') && (out.rootFilter === 'none')
        add(clean,
          '★ 挂件方块不再是雾面：根节点没有背景图 / backdrop-filter / filter（0.3.10 的壁纸修复）',
          'background-image=' + out.rootBgImage + ' backdrop-filter=' + out.rootBackdrop +
          ' filter=' + out.rootFilter + ' bg-color=' + out.rootBgColor)
      }

      // ⑤ 光标不再写 document.body.style.cursor（0.3.10 的"点一下卡一下"修复）
      const img = q('img.dshwv-img')
      if (img && rootEl) {
        const r = img.getBoundingClientRect()
        const cx = Math.round(r.left + r.width * 0.45), cy = Math.round(r.top + r.height * 0.5)
        const tgt = document.elementFromPoint(cx, cy) || document.body
        const mk = (t, e2) => new PointerEvent(t, Object.assign({
          bubbles: true, cancelable: true, clientX: cx, clientY: cy,
          button: 0, pointerType: 'mouse', pointerId: 77, isPrimary: true }, e2 || {}))
        tgt.dispatchEvent(mk('pointerdown', { buttons: 1 }))
        await sleep(80)
        out.bodyCursorDuringPress = String(document.body.style.cursor || '')
        out.rootCursorClass = rootEl.className
        document.dispatchEvent(mk('pointerup', { buttons: 0 }))
        tgt.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }))
        await sleep(250)
        out.bodyCursorAfter = String(document.body.style.cursor || '')
        const clsOk = /dshwv-cursor-grab|dshwv-cursor-grabbing/.test(rootEl.className)
        add(out.bodyCursorDuringPress === '' && out.bodyCursorAfter === '',
          '★ 光标不再写到 document.body 上（那会让 Blink 失效整棵文档树样式 → 点一下卡一下）',
          '按下时 body.cursor=' + JSON.stringify(out.bodyCursorDuringPress) +
          ' 抬手后=' + JSON.stringify(out.bodyCursorAfter))
        add(clsOk,
          '★ 光标改由挂件自己的类承担（.dshwv-cursor-grab / -grabbing 出现在根节点上）',
          'root.class=' + JSON.stringify(out.rootCursorClass.slice(0, 90)))
      }

      // ⑥ --dshw-vx/--dshw-vy 写在 root 上，不写 <html>（写 <html> 会让整棵子树样式失效）
      if (rootEl) {
        const onRoot = String(rootEl.style.getPropertyValue('--dshw-vx') || '')
        const onHtml = String(document.documentElement.style.getPropertyValue('--dshw-vx') || '')
        out.vxOnRoot = onRoot
        out.vxOnHtml = onHtml
        add(onHtml === '',
          '★ 泡泡定位变量 --dshw-vx 写在挂件根节点上，**没有**写到 <html> 上（0.3.10 的卡顿修复）',
          'root 上=' + JSON.stringify(onRoot) + ' <html> 上=' + JSON.stringify(onHtml))
      }

      // ⑦ 音频：首选走"片段路由"，老的声音组路由仍在（当备用）
      const st = async (u) => { try { const r = await fetch(u, { cache: 'no-store' }); return r.status } catch (e) { return 0 } }
      out.audioFrag = await st('/dsh-whale/audio-fragment.wav?id=ya1')
      out.audioLegacy = await st('/dsh-whale/sound/press.mp3?set=duck')
      add(out.audioFrag === 200 && out.audioLegacy === 200,
        '★ 音频两条链路都通：首选"片段路由" 200，备用"声音组路由"也还在 200（互为备胎）',
        'audio-fragment.wav?id=ya1 → ' + out.audioFrag + '；sound/press.mp3?set=duck → ' + out.audioLegacy)

      // ⑧ 下拉能正常展开（0.3.10 修的"点了没反应"）——
      //    任务结束音效那个自绘下拉在 v720 之后收进了「自定义提示」窗口，
      //    而那个窗口**带遮罩**（正是当初把下拉整层盖住的那个场景），
      //    所以这里先把窗口打开，再验下拉能不能展开、能不能点中选项。
      try {
        let wrap = null
        for (const b of qa('.dshwv-menu button')) {
          if (String(b.textContent || '').trim() === '自定义提示') { b.click(); break }
        }
        await sleep(500)
        const win = q('.dshwv-turncostmask') || q('.dshwv-confirmmask') || q('.dshwv-menu')
        out.dropWinFound = !!win
        wrap = win ? win.querySelector('.dshwv-custwrap') : null
        if (!wrap) wrap = q('.dshwv-custwrap')
        out.dropFound = !!wrap
        out.dropWrapLabel = wrap ? String((wrap.textContent || '')).slice(0, 30) : ''
        if (wrap) {
          const btn = wrap.querySelector('.dshwv-custbtn')
          const dmenu = wrap.querySelector('.dshwv-custmenu')
          out.dropLabel = String((btn && btn.textContent) || '').slice(0, 30)
          out.dropBtnDisabled = btn ? btn.disabled : null
          out.dropBtnVisible = !!(btn && btn.offsetParent)
          out.dropMenuInWrap = !!dmenu
          if (btn) btn.click()
          await sleep(300)
          // 下拉打开后会**被移到 document.body** 下，所以要看全局，不能只看 wrap 里
          const anyOpen = qa('.dshwv-rgbmenu.dshwv-rgbopen')
          out.dropAnyOpen = anyOpen.length
          out.dropOpenEl = anyOpen.length ? String(anyOpen[0].className) : ''
          out.dropMenuParent = dmenu && dmenu.parentNode ? String(dmenu.parentNode.className || dmenu.parentNode.tagName) : ''
          out.dropOpen = !!(dmenu && dmenu.classList.contains('dshwv-rgbopen'))
          // ⚠️ 下拉一旦展开就会被**移到 document.body** 下（dshwDropOpen 里干的），
          //    所以"展开后"的菜单要去全局找，不能在 wrap 里找 ——
          //    第一版就是因此在 wrap 里查了个 null，误判成"没展开"。
          const live = anyOpen.length ? anyOpen[0] : dmenu
          const opts = live ? live.querySelectorAll('.dshwv-rgbopt') : []
          out.dropOpen = !!live
          out.dropOpts = opts.length
          if (live && opts.length) {
            const o = opts[Math.min(2, opts.length - 1)]
            const or = o.getBoundingClientRect()
            const hit = document.elementFromPoint(or.left + or.width / 2, or.top + or.height / 2)
            out.dropHitIsOption = !!(hit && (hit === o || o.contains(hit) || live.contains(hit)))
            out.dropZ = String(getComputedStyle(live).zIndex)
            const maskEl = q('.dshwv-turncostmask') || q('.dshwv-confirmmask') || q('.dshwv-bubmask')
            out.dropMaskZ = maskEl ? String(getComputedStyle(maskEl).zIndex) : ''
            add(out.dropOpen && out.dropHitIsOption === true,
              '★ 带遮罩的窗口里，自绘下拉能正常展开、且能点中选项（0.3.10 修的"点了没反应"）',
              '下拉=' + JSON.stringify(out.dropLabel) + ' 展开=' + out.dropOpen +
              ' 选项数=' + out.dropOpts + ' 该点上的元素属于下拉=' + out.dropHitIsOption +
              ' 下拉 z-index=' + out.dropZ + ' 遮罩 z-index=' + out.dropMaskZ)
          } else {
            add(false, '下拉没能展开（0.3.10 的"点了没反应"修复可能没生效）',
              'open=' + out.dropOpen + ' opts=' + out.dropOpts + ' 找到=' + out.dropFound)
          }
          try { if (btn) btn.click() } catch (e) {}
        } else {
          add(false, '没找到任何自绘下拉，这条验不了', '窗口=' + out.dropWinFound)
        }
      } catch (e) { out.dropErr = String(e && e.message) }

      out.checks = checks
      return out
    })()`)
  }
  // —— 多桌宠：菜单「退出桌宠」+ 体积碰撞弹开 ——
  // 这条探针**要在主进程里跑**：它要同时操作两只窗口（第二只自己的页面也要验）。
  if (FOCUS === 'multi-pet') {
    const checks = []
    const add = (ok, label, extra) => checks.push({ ok: !!ok, label, extra })
    const out = {}
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const waitLoad = async (w) => {
      if (!w || w.isDestroyed()) return false
      await new Promise((resolve) => {
        if (!w.webContents.isLoading()) return resolve()
        w.webContents.once('did-finish-load', resolve)
        setTimeout(resolve, 15000)
      })
      return true
    }
    try {
      // ① 开第二只（multi-pet 模式下它会真的加载页面）
      const w2 = spawnPet('自检')
      out.spawned = !!w2
      add(!!w2 && pets.length === 2, '前置：能开出第二只桌宠（共 2 只）', 'count=' + pets.length)
      if (w2) {
        await waitLoad(w2)
        // 等挂件初始化 + pet-collide 起来（和第一只同样的节奏）
        await sleep(7000)

        // ①b **新开出来的那只，落座位置不能和已有的重合** ——
        //     用户要求："桌宠出现的位置也不能重合，必须在已有桌宠位置的范围外出现，
        //     可以在已有桌宠位置的范围外、桌面范围内的随机范围出现。"
        //     这里量的是**它实际落成的位置**（不是算法算出来的那个点），
        //     而且顺带验一下"确实落在桌面（工作区）范围内"。
        {
          const rr = await win.webContents.executeJavaScript('window.petApi.petDebugRects()')
          const a = rr && rr.rects && rr.rects[0], b = rr && rr.rects && rr.rects[1]
          const ov = !!(a && b && a.w && b.w &&
            a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)
          out.spawnRects = { first: a, second: b }
          out.spawnOverlap = ov
          // 两个都必须完整落在桌面里（工作区 = 2048×1104，这里用整屏 2048×1152 判）
          const inDesk = (r) => !!(r && r.x >= -2 && r.y >= -2 && r.x + r.w <= 2050 && r.y + r.h <= 1154)
          out.spawnInDesk = { first: inDesk(a), second: inDesk(b) }
          add(ov === false && out.spawnInDesk.first === true && out.spawnInDesk.second === true,
            '★ 新开的那只**实际落成**的位置不和已有的重合，且两只都在桌面范围内',
            '第一只=' + JSON.stringify(a) + ' 第二只=' + JSON.stringify(b) +
            ' 重合=' + ov + ' 都在桌面内=' + JSON.stringify(out.spawnInDesk))
        }

        // ② 身份：第一只 isExtra=false、第二只 isExtra=true
        const info1 = await win.webContents.executeJavaScript('window.petApi.petInfo()')
        const info2 = await w2.webContents.executeJavaScript('window.petApi.petInfo()')
        out.info1 = info1
        out.info2 = info2
        add(info1 && info1.isExtra === false && info2 && info2.isExtra === true,
          '★ 身份分得清：第一只 isExtra=false、第二只 isExtra=true',
          '第一只=' + JSON.stringify(info1) + ' 第二只=' + JSON.stringify(info2))

        // ③ 菜单项：第二只有「退出桌宠」，第一只没有
        const row2 = await w2.webContents.executeJavaScript(
          '!!document.querySelector(".dshwv-menu .dshpet-quit-btn")')
        const row1 = await win.webContents.executeJavaScript(
          '!!document.querySelector(".dshwv-menu .dshpet-quit-btn")')
        out.quitRowSecond = row2
        out.quitRowFirst = row1
        add(row2 === true && row1 === false,
          '★ 只有多开出来的那只菜单里有「退出桌宠」，第一只没有',
          '第二只有=' + row2 + ' 第一只有=' + row1)

        // ④ 碰撞：把两只摆成**完全重合**（最难的一种），看它们会不会自己分开。
        //    这是"新开一只时两只初始位置一模一样"的真实场景。
        const rectsOf = async () => {
          const r = await win.webContents.executeJavaScript('window.petApi.petDebugRects()')
          return r.rects
        }
        // 先把第二只挪到和第一只完全一样的位置
        const before = await rectsOf()
        out.rectsBefore = before
        if (before && before[0] && before[1]) {
          const dx = before[0].x - before[1].x
          const dy = before[0].y - before[1].y
          await w2.webContents.executeJavaScript(
            'window.__dshpetPhysics.nudge(' + dx + ',' + dy + ')')
          await sleep(1200)   // 上报 + 判定 + 推开 + 再上报
          const after = await rectsOf()
          out.rectsAfter = after
          const a = after && after[0], b = after && after[1]
          const overlapNow = !!(a && b && a.w && b.w &&
            a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)
          out.overlapAfter = overlapNow
          if (overlapNow) {
            try {
              out.deepDiag = JSON.parse(await w2.webContents.executeJavaScript(
                'JSON.stringify({ diag: window.__dshpetPhysics._solidDiag(),' +
                ' peers: window.__dshpetCollide._peers() })'))
            } catch (e) { out.deepDiagErr = String(e && e.message) }
          }
          add(overlapNow === false,
            '★ 体积碰撞：把两只摆成完全重合后，它们自己分开了（不再相交）',
            '推之前=' + JSON.stringify(before && before[1]) + ' 推之后=' +
            JSON.stringify(a) + ' / ' + JSON.stringify(b) + ' 仍相交=' + overlapNow)
          // 分开之后必须**留在工作区内**（nudge 走的是同一套夹取）
          // ⚠️ 口径要对上：_bounds() 是**盒子(physPos)坐标**，而立绘矩形是屏幕坐标，
          //    两者差一个立绘偏移（152）。所以这里拿 _state().pos 去比，别拿立绘比。
          const bnd = await w2.webContents.executeJavaScript('window.__dshpetPhysics._bounds()')
          const st2 = await w2.webContents.executeJavaScript('window.__dshpetPhysics._state()')
          const pos = (st2 && st2.pos) || null
          const inBounds = !!(pos && bnd && pos[0] >= bnd.left - 2 && pos[1] >= bnd.top - 2 &&
            pos[0] <= bnd.right + 2 && pos[1] <= bnd.bottom + 2)
          out.bounds = bnd
          out.posAfter = pos
          out.inBounds = inBounds
          add(inBounds, '★ 弹开之后仍被夹在工作区内（没被推出屏幕）',
            '盒子位置=' + JSON.stringify(pos) + ' 工作区=' + JSON.stringify(bnd))
        }

        // ④b **实体**：一直往里挤，全程不许有任何重合，也不许穿过去。
        //     用户的原话："桌宠是有实体的，不能穿过另一个桌宠，只要碰到边缘的位置
        //     就会互相弹开，不是都重合到一起了才弹开，完全不能有互相重合的部分。"
        //     所以这里把它**一步步往对方身体里挤**（每步 12px，共 14 步），
        //     每一步都量一次 —— 只要有一拍出现重合，或者它跑到了对方另一侧（穿过去了），
        //     这条就红。这是"实体"和"叠很深再弹开"最本质的区别。
        {
          const rr = await rectsOf()
          const r1 = rr && rr[0], r2 = rr && rr[1]
          if (r1 && r1.w && r2 && r2.w) {
            // 先把它挪到第一只的**正左边、刚好贴着**
            const startX = r1.x - r2.w - 2
            await w2.webContents.executeJavaScript(
              'window.__dshpetPhysics.nudge(' + (startX - r2.x) + ',' + (r1.y - r2.y) + ')')
            await sleep(500)
            const base = await rectsOf()
            const b2 = base && base[1]
            let overlapSamples = 0
            let passedThrough = false
            const trail = []
            for (let i = 0; i < 14; i++) {
              await w2.webContents.executeJavaScript('window.__dshpetPhysics.nudge(12,0)')
              await sleep(120)
              const cur = await rectsOf()
              const a = cur && cur[0], b = cur && cur[1]
              if (!a || !b || !a.w || !b.w) continue
              const ov = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
              if (ov) overlapSamples++
              if ((b.x + b.w / 2) > (a.x + a.w / 2) + 1) passedThrough = true
              // 出问题时把"当时实体约束看到的是什么"也记下来
              if (ov) {
                const st = await w2.webContents.executeJavaScript(
                  'JSON.stringify({ diag: window.__dshpetPhysics._solidDiag(),' +
                  ' mine: (window.__dshpetCollide._peers()||[])[0]||null})')
                trail.push('★' + JSON.stringify({ a: a, b: b, st: JSON.parse(st || '{}') }))
                if (overlapSamples === 1) out.solidDiagFirst = JSON.parse(st || '{}')
              } else if (i % 3 === 0) trail.push(Math.round(b.x))
            }
            out.solidOverlapSamples = overlapSamples
            out.solidPassedThrough = passedThrough
            out.solidTrail = trail
            out.solidBase = b2
            add(overlapSamples === 0 && passedThrough === false,
              '★ **实体**：一路往对方身体里挤，全程没有任何一拍重合，也没穿过去',
              '重合采样=' + overlapSamples + '/14  穿过去=' + passedThrough +
              '  它的 x 轨迹=' + JSON.stringify(trail) +
              '  起点 x=' + (b2 && Math.round(b2.x)) + '  对方 x=' + Math.round(r1.x) +
              '（对方宽 ' + Math.round(r1.w) + '）')
          }
        }

        // ④b2 实体约束真的在工作：第二只要能收到同伴的矩形
        {
          const ev = await w2.webContents.executeJavaScript(
            'JSON.stringify({ peers: (window.__dshpetCollide._peers()||[]).length,' +
            ' last: (window.__dshpetPhysics._solid().last||null) })')
          out.solidState = ev
          const o = JSON.parse(ev || '{}')
          add(o.peers > 0,
            '★ 第二只**收到了**其它桌宠的矩形（实体约束靠它工作）',
            'peers=' + o.peers + ' 上次合法位置=' + JSON.stringify(o.last))
        }

        // ④c **新桌宠的落座位置不能和已有的重叠**。
        //     用户要求："桌宠出现的位置也不能重合，必须在已有桌宠位置的范围外出现，
        //     可以在已有桌宠位置的范围外、桌面范围内的随机范围出现。"
        {
          const pick = await win.webContents.executeJavaScript('window.petApi.petDebugPickSpot()')
          out.pickSpot = pick
          const sp = pick && pick.spot
          let bad = false
          if (sp && pick.used) {
            for (const u of pick.used) {
              if (sp.x < u.x + u.w && u.x < sp.x + sp.w &&
                  sp.y < u.y + u.h && u.y < sp.y + sp.h) { bad = true; break }
            }
          }
          add(!!sp && bad === false,
            '★ 落座算法挑的位置不和任何已有桌宠重叠（而且都在桌面内）',
            '挑到=' + JSON.stringify(sp) + ' 已有=' + JSON.stringify(pick && pick.used) +
            ' 重叠=' + bad)
        }

        // ⑤ 音效/动画真的被触发过（数一数日志里的"撞上了 → 推开"）
        await sleep(400)
        const logTxt = await w2.webContents.executeJavaScript('String(1)')
        out.logProbe = logTxt

        // ⑥ 「退出桌宠」：第二只自己关掉自己，第一只必须活着
        const closeRes = await w2.webContents.executeJavaScript('window.petApi.closeSelf()')
        await sleep(900)
        out.closeRes = closeRes
        out.countAfter = pets.length
        out.secondAlive = !w2.isDestroyed()
        out.firstAlive = !win.isDestroyed()
        add(closeRes && closeRes.ok === true && out.secondAlive === false &&
            out.firstAlive === true && pets.length === 1,
          '★ 「退出桌宠」只关掉自己那一只，第一只完好无损',
          '返回=' + JSON.stringify(closeRes) + ' 第二只还在=' + out.secondAlive +
          ' 第一只还在=' + out.firstAlive + ' 剩余=' + pets.length)

        // ⑦ 第一只不该能"退出自己"（它不是多开的）—— 防止把托盘指着的那只关掉
        const firstTry = await win.webContents.executeJavaScript('window.petApi.closeSelf()')
        out.firstCloseTry = firstTry
        add(firstTry && firstTry.ok === false && !win.isDestroyed(),
          '★ 第一只调「退出桌宠」会被拒绝（托盘/热键都指着它，不能从菜单关掉）',
          '返回=' + JSON.stringify(firstTry) + ' 第一只还在=' + !win.isDestroyed())
      }
    } catch (err) {
      add(false, '多桌宠探针抛异常', err && err.message)
    }
    out.checks = checks
    return out
  }
  // —— 点她若干次，看气泡里到底出没出那 24 张里的某一张 ——
  if (FOCUS === 'bimg-bubble') {
    return await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const q = (s) => document.querySelector(s)
      const checks = []
      const add = (ok, label, extra) => checks.push({ ok: !!ok, label, extra })
      const out = { seen: [], imgSrcs: [] }
      const img = q('img.dshwv-img')
      const r = img.getBoundingClientRect()
      const cx = Math.round(r.left + r.width * 0.45)
      const cy = Math.round(r.top + r.height * 0.5)
      const tgt = document.elementFromPoint(cx, cy) || document.body
      const mk = (type, extra) => new PointerEvent(type, Object.assign({
        bubbles: true, cancelable: true, clientX: cx, clientY: cy,
        button: 0, pointerType: 'mouse', pointerId: 901, isPrimary: true,
      }, extra || {}))
      // ⚠️ 关键：**点她是"从队列开头开始"，点泡泡才是"往后推进一项"**
      //    （whaleClick 里：bubbleSeqIdx<=1 时只续时；推进挂在泡泡自己的 click 上）。
      //    第一版只点她，于是永远停在队列第 0 项，一条图都看不到。
      const clickHer = async () => {
        tgt.dispatchEvent(mk('pointerdown', { buttons: 1 }))
        await sleep(30)
        document.dispatchEvent(mk('pointerup', { buttons: 0 }))
        tgt.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }))
        await sleep(320)
      }
      const clickBubble = async () => {
        const b = q('.dshwv-pop')
        if (!b) return false
        b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        await sleep(320)
        return true
      }
      await clickHer()
      for (let i = 0; i < 18; i++) {
        const m = q('.dshwv-mimg')
        const src = m ? String(m.getAttribute('src') || '') : ''
        const txt = q('.dshwv-text') ? String(q('.dshwv-text').textContent || '').slice(0, 20) : ''
        out.seen.push((src ? src.replace('/dsh-whale/bubble-img.png?id=', '') : '-') + '|' + txt)
        if (src) out.imgSrcs.push(src)
        // 泡泡关了就先点她重新开一轮，再继续推进
        if (!q('.dshwv-pop.dshwv-pop-open')) await clickHer()
        else await clickBubble()
      }
      const ours = out.seen.filter((s) => /^bimg_(big_coming|curse|dadeyaolaile|dead_fish|deepsleep|dsh|evaluable|fat_fish|go_to_agi|hajimi|kaidian|keai|mama|more_modal|no-money|not_care|ojingjing|ojj|push|push_one_fat_fish|unvaluable|update|virus|yupian)\\|/.test(s))
      out.oursCount = ours.length
      add(out.oursCount > 0,
        '★ 连点她 18 次，气泡里**真的出现了这 24 张中的某一张**（默认序列里新加的那个「随机图片」气泡）',
        '出现次数=' + out.oursCount + '  逐次=' + JSON.stringify(out.seen))
      out.checks = checks
      return out
    })()`)
  }
  // —— 24 张内置图：浏览器**到底能不能解码显示** ——
  // 只验"fetch 拿到 200 字节"是不够的：字节回来了不等于浏览器画得出来。
  if (FOCUS === 'bimg-load') {
    return await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const q = (s) => document.querySelector(s)
      const checks = []
      const add = (ok, label, extra) => checks.push({ ok: !!ok, label, extra })
      const out = { rows: [] }
      const r = await fetch('/dsh-whale/bubble-imgs.json', { cache: 'no-store' })
      const d = await r.json()
      const mine = (d.images || []).filter((im) => im.builtin === true && String(im.id).indexOf('bimg_') === 0 &&
        im.id !== 'bimg_petpet' && im.id !== 'bimg_money1')
      const load = (url) => new Promise((resolve) => {
        const im = new Image()
        let done = false
        const fin = (ok, why) => { if (!done) { done = true; resolve({ ok: ok, why: why, w: im.naturalWidth, h: im.naturalHeight }) } }
        im.onload = () => fin(im.naturalWidth > 0, 'load')
        im.onerror = () => fin(false, 'error')
        setTimeout(() => fin(false, 'timeout'), 8000)
        im.src = url
      })
      let okN = 0
      const bad = []
      for (const im of mine) {
        // 顺带记一下服务端声明的类型，和真实字节对不上时很关键
        let ct = ''
        try { const rr = await fetch(im.url, { cache: 'no-store' }); ct = rr.headers.get('content-type') || '' } catch (e) {}
        const res = await load(im.url)
        out.rows.push({ id: im.id, ct: ct, ok: res.ok, why: res.why, w: res.w, h: res.h })
        if (res.ok) okN++
        else bad.push(im.id + '(' + res.why + ', ct=' + ct + ')')
      }
      out.okCount = okN
      out.total = mine.length
      out.bad = bad
      add(okN === mine.length,
        '★ 24 张内置图在浏览器里**全部能解码显示**',
        '成功=' + okN + '/' + mine.length + (bad.length ? '  失败=' + JSON.stringify(bad) : ''))
      // 顺带：自带那两张（gif）作为对照
      const ctl = await load('/dsh-whale/bubble-img.png?id=bimg_petpet')
      out.petpet = { ok: ctl.ok, w: ctl.w, h: ctl.h }

      // —— 再验一层：**资源管理面板里的缩略图有没有真的画出来** ——
      // 光"能解码"不等于"用户看得见"：面板里的 <img> 可能被隐藏/尺寸为 0。
      try {
        const menu = q('.dshwv-menu')
        let openBtn = null
        if (menu) {
          const btns = menu.querySelectorAll('button')
          for (let i = 0; i < btns.length; i++) {
            if (String(btns[i].textContent || '').trim() === '管理') { openBtn = btns[i]; break }
          }
        }
        if (openBtn) {
          openBtn.click()
          await sleep(1200)
          const mask = q('.dshwv-resmask')
          const thums = mask ? mask.querySelectorAll('img.dshwv-resthum') : []
          out.thumbTotal = thums.length
          const badT = []
          let okT = 0
          for (let i = 0; i < thums.length; i++) {
            const t = thums[i]
            const src = String(t.getAttribute('src') || '')
            if (src.indexOf('bimg_') < 0) continue
            const painted = t.complete && t.naturalWidth > 0 && t.clientWidth > 0 && t.clientHeight > 0
            if (painted) okT++
            else badT.push(src.split('id=')[1] + '(nat=' + t.naturalWidth + ',cw=' + t.clientWidth + ',complete=' + t.complete + ')')
          }
          out.thumbOk = okT
          out.thumbBad = badT
          add(okT >= 26,
            '★ 资源管理面板里 26 张缩略图**都真的画出来了**（不是空占位）',
            '画出来=' + okT + '/' + out.thumbTotal + (badT.length ? '  没画出来=' + JSON.stringify(badT) : ''))
          mask.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
          await sleep(300)
        }
      } catch (e) { out.thumbErr = String(e && e.message) }

      out.checks = checks
      return out
    })()`)
  }
  // —— 「偷吃白饭」原生小标签（.dshrice-chip）：必须**从第一帧就不可点** ——
  // 用户报的"打开桌宠时偶尔弹出偷吃白饭菜单"就是它：它平时只是 opacity:0
  // （不是 display:none）+ pointer-events:auto，而且 .dshwv-body:hover 会让它变可见。
  if (FOCUS === 'rice-chip') {
    return await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const q = (s) => document.querySelector(s)
      const checks = []
      const add = (ok, label, extra) => checks.push({ ok: !!ok, label, extra })
      const out = {}
      const chip = q('.dshrice-chip')
      const body = q('.dshwv-body')
      add(!!chip && !!body, '前置：小标签和她的方块都在', 'chip=' + !!chip + ' body=' + !!body)
      if (!chip || !body) { out.checks = checks; return out }

      // ① 现在（修好之后）：必须是 display:none —— 既看不见，也不吃点击
      const cs = getComputedStyle(chip)
      out.display = cs.display
      out.pointerEvents = cs.pointerEvents
      const rc = chip.getBoundingClientRect()
      out.rect = { l: Math.round(rc.left), t: Math.round(rc.top), w: Math.round(rc.width), h: Math.round(rc.height) }
      const at = (rc.width && rc.height) ? document.elementFromPoint(rc.left + rc.width / 2, rc.top + rc.height / 2) : null
      out.elemAtChip = at ? (at.tagName + '.' + String(at.className || '').slice(0, 40)) : 'null(没有尺寸/在视口外)'
      out.chipIsHitTarget = !!(at && at.classList && at.classList.contains('dshrice-chip'))
      add(out.display === 'none',
        '★ 小标签是 display:none（不是靠 opacity:0 藏 —— 那样"看不见但能点"）',
        'display=' + out.display + ' pointer-events=' + out.pointerEvents)
      add(out.chipIsHitTarget === false,
        '★ 它现在**不是**命中目标（点那个位置不会落到它身上）',
        '该点上的元素=' + out.elemAtChip)
      // 外壳那条规则必须真的在样式表里（而不是只靠 rice-entry.js 那 4 秒后才跑的）
      let inShellCss = false
      try {
        for (const sheet of document.styleSheets) {
          let rules = null
          try { rules = sheet.cssRules } catch (e) { continue }
          for (const r of rules) {
            if (r.selectorText === '.dshrice-chip' && /display:\\s*none/.test(r.style && r.cssText || '')) inShellCss = true
          }
        }
      } catch (e) {}
      out.rulePresent = inShellCss
      add(inShellCss, '★ 隐藏规则在外壳样式表里（index.html 第一帧就加载，不依赖模块启动时序）',
        'found=' + inShellCss)

      // ② 反向对照：**模拟修复前**（把 display 改回 block、opacity 0），
      //    证明这条路真的能把菜单弹出来 —— 否则这条断言就是空过。
      chip.style.setProperty('display', 'block', 'important')
      chip.style.setProperty('opacity', '0', 'important')
      await sleep(200)
      const rc2 = chip.getBoundingClientRect()
      const at2 = document.elementFromPoint(rc2.left + rc2.width / 2, rc2.top + rc2.height / 2)
      out.negElemAtChip = at2 ? (at2.tagName + '.' + String(at2.className || '').slice(0, 40)) : 'null'
      out.negChipIsHit = !!(at2 && at2.classList && at2.classList.contains('dshrice-chip'))
      out.negOpacity = getComputedStyle(chip).opacity
      // 而且鼠标一进她的方块，它还会变可见（.dshwv-body:hover 那条）
      let hoverOpacity = null
      try {
        body.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
        hoverOpacity = getComputedStyle(chip).opacity
      } catch (e) {}
      out.negHoverOpacity = hoverOpacity
      const menuBefore = !!q('.dshrice-menu.dshrice-open')
      chip.click()
      await sleep(400)
      const menuAfter = !!q('.dshrice-menu.dshrice-open')
      out.negMenuOpened = !menuBefore && menuAfter
      add(out.negChipIsHit === true && out.negMenuOpened === true,
        '★ 反向对照：把它改回"修复前"的样子后，它确实是**看不见却能点**的命中目标，一点就把偷吃白饭菜单弹出来',
        '该点上的元素=' + out.negElemAtChip + ' opacity=' + out.negOpacity +
        ' 鼠标进方块后 opacity=' + out.negHoverOpacity +
        ' 点之前菜单开着=' + menuBefore + ' 点之后=' + menuAfter)
      // 收拾干净
      try {
        if (menuAfter) { const c = q('.dshrice-chip'); if (c) c.click(); await sleep(300) }
        chip.style.removeProperty('display')
        chip.style.removeProperty('opacity')
      } catch (e) {}
      await sleep(200)
      out.restoredDisplay = getComputedStyle(chip).display
      out.restoredMenuOpen = !!q('.dshrice-menu.dshrice-open')
      out.checks = checks
      return out
    })()`)
  }
  // —— 用户新丢进 vendor/whale/assets 的那些图，运行时到底能不能取到 ——
  if (FOCUS === 'whale-assets') {
    return await win.webContents.executeJavaScript(`(async () => {
      const checks = []
      const add = (ok, label, extra) => checks.push({ ok: !!ok, label, extra })
      const out = {}
      const names = ['hajimi.png','keai.png','curse.jpg','dead_fish.jpg','no-money.jpg','virus.jpg','push.png','yupian.png','dsh.jpg','fat_fish.jpg']
      const urls = []
      for (const n of names) {
        urls.push('/dsh-whale/' + n)
        urls.push('/dsh-whale/assets/' + n)
      }
      out.status = {}
      let anyOk = 0
      for (const u of urls) {
        let s = 0
        try { const r = await fetch(u, { cache: 'no-store' }); s = r.status } catch (e) { s = 0 }
        out.status[u] = s
        if (s === 200) anyOk++
      }
      // 顺带看看内置泡泡图那两张（它们是**硬编码清单**里的）
      out.builtin = {}
      for (const u of ['/dsh-whale/bubble-img.png?id=bimg_petpet', '/dsh-whale/bubble-img.png?id=bimg_money1']) {
        let s = 0
        try { const r = await fetch(u, { cache: 'no-store' }); s = r.status } catch (e) { s = 0 }
        out.builtin[u] = s
      }
      add(true, '（诊断）新丢进 vendor/whale/assets 的图能不能直接取到',
        '试了 ' + urls.length + ' 个 URL，200 的有 ' + anyOk + ' 个；内置泡泡图=' + JSON.stringify(out.builtin))
      out.checks = checks
      return out
    })()`)
  }
  // —— 米粒图和贴图的同步：笑的时候一起消失、恢复的时候一起出现 ——
  if (FOCUS === 'laugh-grain') {
    return await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const q = (s) => document.querySelector(s)
      const checks = []
      const add = (ok, label, extra) => checks.push({ ok: !!ok, label, extra })
      const out = {}
      const LS = window.__dshpetLaughSprite
      const grain = q('.dshrice-grain')
      const img = q('img.dshwv-img')
      if (!LS || !grain) { add(false, '模块或米粒元素不存在', 'LS=' + !!LS + ' grain=' + !!grain); out.checks = checks; return out }
      // 停掉眨眼，避免它插进来干扰贴图判断
      const expI = window.__dshpetWhaleExp && window.__dshpetWhaleExp._internal
      if (expI && expI.blinkPause) expI.blinkPause()
      out.grainMs = LS.grainMs()
      const src = () => String(img.getAttribute('src') || '')
      const setGrain = async (cls) => { grain.className = cls; await sleep(180) }

      // ① 米粒正露着 → 笑：米粒**同时**消失；2 秒后**同时**出现
      await setGrain('dshrice-grain dshrice-grain-show')
      const srcBefore = src()
      LS.laugh('t1')
      await sleep(260)
      out.t1_hiddenDuring = LS.grainHidden()
      out.t1_srcDuring = src()
      add(out.t1_hiddenDuring === true && out.t1_srcDuring.indexOf('laugh') >= 0,
        '① 笑的时候：贴图换成笑图 **且米粒图同时消失**',
        '笑图=' + JSON.stringify(out.t1_srcDuring) + ' 米粒被按住=' + out.t1_hiddenDuring)
      await sleep(2200)
      out.t1_hiddenAfter = LS.grainHidden()
      out.t1_shownAfter = LS.grainShown()
      out.t1_srcAfter = src()
      add(out.t1_hiddenAfter === false && out.t1_shownAfter === true && out.t1_srcAfter === srcBefore,
        '① 2 秒后：贴图恢复 **且米粒图同时出现**',
        '贴图=' + JSON.stringify(out.t1_srcAfter) + ' 米粒被按住=' + out.t1_hiddenAfter + ' 米粒露着=' + out.t1_shownAfter)

      // ② 米粒本来就没露 → 笑的时候照样"按住"（笑图期间米粒一律不露，
      //    这样万一这 2 秒里 rice 又让米粒冒出来也不会穿帮），恢复后也不该冒出来
      await setGrain('dshrice-grain')
      LS.laugh('t2')
      await sleep(260)
      out.t2_hiddenDuring = LS.grainHidden()
      await sleep(2200)
      out.t2_shownAfter = LS.grainShown()
      add(out.t2_hiddenDuring === true && out.t2_shownAfter === false,
        '② 米粒本来没露时：笑图期间仍按住不露，恢复后也不会凭空冒出来',
        '笑图期间按住=' + out.t2_hiddenDuring + ' 恢复后露着=' + out.t2_shownAfter)

      // ③ 笑的过程中 rice 自己的计时器到点把米粒收掉 → 恢复时要补回来，并再停 grainMs
      await setGrain('dshrice-grain dshrice-grain-show')
      LS.laugh('t3')
      await sleep(300)
      grain.className = 'dshrice-grain'          // 模拟 rice 的计时器到点
      await sleep(1900)
      out.t3_shownAfterRestore = LS.grainShown()
      add(out.t3_shownAfterRestore === true,
        '③ 笑的过程中 rice 把米粒收掉了 → 恢复贴图时**补回来**（仍然同时出现）',
        '恢复后米粒露着=' + out.t3_shownAfterRestore)
      await sleep(LS.grainMs() + 600)
      out.t3_shownLater = LS.grainShown()
      add(out.t3_shownLater === false,
        '③ 补回来的米粒会按 grainMs（' + LS.grainMs() + 'ms）自己收掉，不会永远挂着',
        '再等 grainMs 后露着=' + out.t3_shownLater)

      // 收尾
      LS.restore(); await sleep(300)
      await setGrain('dshrice-grain')
      if (expI && expI.blinkResume) expI.blinkResume()
      out.checks = checks
      return out
    })()`)
  }
  // —— 「笑一下」贴图：偷吃成功 + 余额 <5 / <1 / ==0，换图 2 秒后还原 ——
  if (FOCUS === 'laugh') {
    return await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const q = (s) => document.querySelector(s)
      const checks = []
      const add = (ok, label, extra) => checks.push({ ok: !!ok, label, extra })
      const out = {}
      const LS = window.__dshpetLaughSprite
      const img = () => q('img.dshwv-img')
      const src = () => String(img().getAttribute('src') || '')

      out.imgStatus = 0
      try { const r = await fetch('/whale-sprite-laugh.png', { cache: 'no-store' }); out.imgStatus = r.status } catch (e) {}
      add(out.imgStatus === 200, '★ 笑图能通过外壳路由取到（/whale-sprite-laugh.png）', 'HTTP ' + out.imgStatus)
      add(!!LS, '★ laugh-sprite 模块已加载', 'loaded=' + !!LS)
      if (!LS) { out.checks = checks; return out }

      // ① 换图 → 2 秒后**还原成变化前那张**
      await sleep(400)
      const before = src()
      out.srcBefore = before
      LS.laugh('自检')
      await sleep(250)
      out.srcDuring = src()
      out.showingDuring = LS.isShowing()
      add(out.srcDuring.indexOf('whale-sprite-laugh') >= 0,
        '★ 触发后贴图立刻换成笑图', JSON.stringify(out.srcDuring))
      await sleep(2100)
      out.srcAfter = src()
      add(out.srcAfter === before,
        '★ 2 秒后还原成"变化前那张"（不是停在新图上）',
        '前=' + JSON.stringify(before) + ' 中=' + JSON.stringify(out.srcDuring) + ' 后=' + JSON.stringify(out.srcAfter))

      // ② 2 秒内重复触发：恢复的仍应是**最初**那张
      const b2 = src()
      LS.laugh('自检-1'); await sleep(900)
      LS.laugh('自检-2'); await sleep(200)
      const during2 = src()
      await sleep(2200)
      const after2 = src()
      add(after2 === b2 && during2.indexOf('whale-sprite-laugh') >= 0,
        '★ 2 秒内连续触发两次，最终仍还原成最初那张',
        '最初=' + JSON.stringify(b2) + ' 中=' + JSON.stringify(during2) + ' 后=' + JSON.stringify(after2))

      // ③ 余额三个阈值：各自只触发一次，回到阈值以上能复位
      LS.restore(); await sleep(300)
      const seq = [
        { v: 10,  want: 0, why: '余额充足' },
        { v: 4.9, want: 1, why: '<5' },
        { v: 4.5, want: 0, why: '仍在<5' },
        { v: 0.9, want: 1, why: '<1' },
        { v: 0.5, want: 0, why: '仍在<1' },
        { v: 0,   want: 1, why: '==0' },
        { v: 0,   want: 0, why: '仍为0' },
        { v: 50,  want: 0, why: '回到充足' },
        { v: 4.9, want: 1, why: '复位后再降' },
      ]
      const firedLog = []
      const mism = []
      for (const c of seq) {
        LS.restore(); await sleep(120)
        LS.feedBalance(c.v)
        await sleep(150)
        const showing = LS.isShowing()
        firedLog.push({ v: c.v, fired: showing, why: c.why })
        if ((c.want === 1) !== showing) mism.push({ v: c.v, want: c.want, got: showing, why: c.why })
        LS.restore(); await sleep(120)
      }
      out.balanceSeq = firedLog
      add(mism.length === 0,
        '★ 余额 <5 / <1 / ==0 各触发一次、不重复；回到阈值以上会复位',
        mism.length ? JSON.stringify(mism) : JSON.stringify(firedLog.map(f => f.v + (f.fired ? '→笑' : '→不笑'))))

      // ④ 偷吃成功 vs 被打断：按 rice 的类变化序列喂给它
      LS.restore(); await sleep(200)
      const bowl = q('.dshrice-bowl')
      const grain = q('.dshrice-grain')
      add(!!bowl && !!grain, '★ 碗和米粒元素都在（判定依赖它们）', 'bowl=' + !!bowl + ' grain=' + !!grain)
      const setCls = async (el, cls) => { el.className = cls; await sleep(90) }
      if (bowl && grain) {
        const base = 'dshrice-bowl'
        // 成功：举碗 → 嘴上出现米粒 → 碗放下（没有 spill/head）
        await setCls(bowl, base)
        await setCls(grain, 'dshrice-grain')
        await setCls(bowl, base + ' dshrice-up')
        await setCls(grain, 'dshrice-grain dshrice-grain-show')
        await setCls(bowl, base)
        await sleep(300)
        out.successFired = LS.isShowing()
        add(out.successFired === true, '★ 偷吃成功（碗正常放下、没被打断）→ 触发笑', 'fired=' + out.successFired)
        LS.restore(); await sleep(250)
        // 被打断：举碗 → 米粒 → 碗被打翻 → 碗收走
        await setCls(bowl, base)
        await setCls(grain, 'dshrice-grain')
        await setCls(bowl, base + ' dshrice-up')
        await setCls(grain, 'dshrice-grain dshrice-grain-show')
        await setCls(bowl, base + ' dshrice-up dshrice-spill')
        await setCls(bowl, base)
        await sleep(300)
        out.spillFired = LS.isShowing()
        add(out.spillFired === false, '★ 被打断（碗被打翻）→ 不触发笑', 'fired=' + out.spillFired)
        LS.restore(); await sleep(250)
        // 举碗后马上被收掉（没出现米粒）→ 不算成功
        await setCls(bowl, base)
        await setCls(grain, 'dshrice-grain')
        await setCls(bowl, base + ' dshrice-up')
        await setCls(bowl, base)
        await sleep(300)
        out.abortFired = LS.isShowing()
        add(out.abortFired === false, '★ 刚举碗就被收掉（没吃到嘴）→ 不触发笑', 'fired=' + out.abortFired)
        LS.restore()
      }

      LS.restore(); await sleep(300)
      out.finalSrc = src()
      out.checks = checks
      return out
    })()`)
  }
  // —— 拖到左边一翻转就出界？把"翻转"这一步单独量出来 ——
  if (FOCUS === 'left-flip') {
    const out = { checks: [] }
    const add = (ok, label, extra) => out.checks.push({ ok: !!ok, label, extra })
    const js = (code) => win.webContents.executeJavaScript(code)
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const info = await js(`(function(){ return { w: screen.availWidth, h: screen.availHeight } })()`)
    out.env = info
    const snap = () => js(`(function(){
      var root = document.querySelector('.dshwv-root')
      var img = document.querySelector('img.dshwv-img')
      var rr = root.getBoundingClientRect(), ir = img.getBoundingClientRect()
      return {
        flipped: root.classList.contains('dshwv-left'),
        box: { l: Math.round(rr.left), t: Math.round(rr.top), w: Math.round(rr.width), h: Math.round(rr.height) },
        art: { l: Math.round(ir.left), t: Math.round(ir.top), r: Math.round(ir.right), b: Math.round(ir.bottom), w: Math.round(ir.width), h: Math.round(ir.height) },
        artOffset: window.__dshpetPhysics ? window.__dshpetPhysics._artOffset() : null,
        bounds: window.__dshpetPhysics ? window.__dshpetPhysics._bounds() : null,
        styleLeft: root.style.getPropertyValue('left'),
      }
    })()`)

    // ① 把她放到屏幕中间（不贴边），然后**只翻转**，看立绘视觉位置会不会横移
    await js(`(function(){
      var p = window.__dshpetPhysics
      p.setEnabled(false)
      return true
    })()`)
    await sleep(200)
    // 用合成拖动把她放到中间偏右
    const dragTo = async (tx, ty) => {
      const r0 = await js(`(function(){ var r=document.querySelector('img.dshwv-img').getBoundingClientRect(); return {l:r.left,t:r.top,w:r.width,h:r.height} })()`)
      const sx = Math.round(r0.l + r0.w / 2), sy = Math.round(r0.t + r0.h / 2)
      await js(`(function(){
        var el = document.elementFromPoint(${sx}, ${sy}) || document.body
        var mk = function(t,x,y,b){ return new PointerEvent(t,{bubbles:true,cancelable:true,clientX:Math.round(x),clientY:Math.round(y),button:0,buttons:b,pointerType:'mouse',pointerId:601,isPrimary:true}) }
        el.dispatchEvent(mk('pointerdown', ${sx}, ${sy}, 1))
        return true
      })()`)
      for (let i = 1; i <= 8; i++) {
        const x = sx + (tx - sx) * i / 8, y = sy + (ty - sy) * i / 8
        await js(`(function(){
          document.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,clientX:${Math.round(x)},clientY:${Math.round(y)},button:0,buttons:1,pointerType:'mouse',pointerId:601,isPrimary:true}))
          return true
        })()`)
        await sleep(60)
      }
      await js(`(function(){
        document.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,clientX:${Math.round(tx)},clientY:${Math.round(ty)},button:0,buttons:0,pointerType:'mouse',pointerId:601,isPrimary:true}))
        return true
      })()`)
      await sleep(700)
    }

    // 中间位置：只翻转向，量横移
    await dragTo(1000, 600)
    const midBefore = await snap()
    out.midBefore = midBefore
    await js(`(function(){
      var root = document.querySelector('.dshwv-root')
      root.classList.toggle('dshwv-left')
      if (window.__dshpetPhysics) { window.__dshpetPhysics._clampRendered() }
      return true
    })()`)
    await sleep(400)
    const midAfter = await snap()
    out.midAfter = midAfter
    out.flipShiftPx = midAfter.art.l - midBefore.art.l
    add(true, '（诊断）中间位置只翻转向时立绘横移多少',
      '翻转前 art.l=' + midBefore.art.l + '（flipped=' + midBefore.flipped + '）→ 翻转后 art.l=' + midAfter.art.l +
      '（flipped=' + midAfter.flipped + '）  横移=' + out.flipShiftPx + 'px' +
      '  artOffset=' + JSON.stringify(midAfter.artOffset) + '  bounds=' + JSON.stringify(midAfter.bounds))

    // ② 关键：把她拖到最左边（会翻转），看立绘有没有出界
    for (const mode of [false, true]) {
      await js(`window.__dshpetPhysics.setEnabled(${mode}); true`)
      await sleep(200)
      const tag = mode ? '物理开' : '物理关'
      await dragTo(-3000, 600)
      const s1 = await snap()
      out['left_' + tag] = s1
      add(s1.art.l >= -1,
        '★ [' + tag + '] 拖到最左边（已翻转）后，立绘左边缘不出界',
        'art.l=' + s1.art.l + '  flipped=' + s1.flipped + '  box=' + JSON.stringify(s1.box) +
        '  artOffset=' + JSON.stringify(s1.artOffset) + '  bounds=' + JSON.stringify(s1.bounds))
      // 再往左上角拖
      await dragTo(-3000, -3000)
      const s2 = await snap()
      out['topleft_' + tag] = s2
      add(s2.art.l >= -1 && s2.art.t >= -1,
        '★ [' + tag + '] 拖到左上角后，立绘左/上边缘不出界',
        'art=' + JSON.stringify(s2.art) + ' flipped=' + s2.flipped)
    }

    // ③ 用户报的是"**一翻转**就跑出桌面外边"——那多半是**过程**中的一瞬间，
    //    只看起点和终点会漏掉。所以拖动全程用 40ms 采样盯着她的立绘矩形，
    //    记录最小值/最大值和任何一次越界。
    for (const mode of [false, true]) {
      const tag = mode ? '物理开' : '物理关'
      await js(`(function(){
        window.__dshpetPhysics.setEnabled(${mode})
        var m = window.__flipMon = { minL: 99999, maxR: -99999, minT: 99999, maxB: -99999, samples: 0, violations: [], flips: 0, lastFlip: null }
        if (window.__flipMonTimer) clearInterval(window.__flipMonTimer)
        window.__flipMonTimer = setInterval(function () {
          var root = document.querySelector('.dshwv-root')
          var img = document.querySelector('img.dshwv-img')
          // ⚠️ 量之前把行内 transform / transition 摘掉再量。
          //    getBoundingClientRect **含 transform**，而"点她"/"被砸到头"会给立绘挂
          //    一个 squash（scale(1.10,.88)）—— 带着它量出来的矩形会**临时变宽**
          //    （223 → 235），于是"左边缘越界 2px"这种**纯动画造成的**假象会被算成越界。
          //    夹取用的是布局位置，这里口径要一致。只摘行内的：根节点那个翻转在 class 上。
          var saved = []
          var el = img
          while (el && el !== root && el.style) {
            if (el.style.transform) {
              saved.push([el, el.style.transform, el.style.transition])
              el.style.transition = 'none'; el.style.transform = 'none'
            }
            el = el.parentNode
          }
          var r = img.getBoundingClientRect()
          for (var i = 0; i < saved.length; i++) {
            saved[i][0].style.transform = saved[i][1]
            saved[i][0].style.transition = saved[i][2]
          }
          var f = root.classList.contains('dshwv-left')
          if (m.lastFlip === null) m.lastFlip = f
          else if (m.lastFlip !== f) { m.lastFlip = f; m.flips++ }
          m.samples++
          m.minL = Math.min(m.minL, r.left); m.maxR = Math.max(m.maxR, r.right)
          m.minT = Math.min(m.minT, r.top);  m.maxB = Math.max(m.maxB, r.bottom)
          if (r.left < -1 || r.top < -1 || r.right > screen.availWidth + 1 || r.bottom > screen.availHeight + 1) {
            if (m.violations.length < 12) m.violations.push({ l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) })
          }
        }, 40)
        return true
      })()`)
      await sleep(200)
      await dragTo(1000, 700)
      await dragTo(-3000, 700)
      await sleep(600)
      const mon = await js(`(function(){
        clearInterval(window.__flipMonTimer)
        var m = window.__flipMon
        return { minL: Math.round(m.minL), maxR: Math.round(m.maxR), minT: Math.round(m.minT), maxB: Math.round(m.maxB), samples: m.samples, violations: m.violations, flips: m.flips }
      })()`)
      out['monitor_' + tag] = mon
      add(mon.violations.length === 0 && mon.minL >= -1 && mon.minT >= -1 &&
          mon.maxR <= info.w + 1 && mon.maxB <= info.h + 1,
        '★ [' + tag + '] 从右拖到左（含翻转）**全程**没有一刻越出工作区',
        '采样=' + mon.samples + ' 次  翻转次数=' + mon.flips +
        '  立绘范围 l≥' + mon.minL + ' t≥' + mon.minT + ' r≤' + mon.maxR + ' b≤' + mon.maxB +
        '  工作区=' + info.w + '×' + info.h +
        '  越界样本=' + JSON.stringify(mon.violations))
    }
    await js('window.__dshpetPhysics.setEnabled(true); true')
    return out
  }
  // —— 彩蛋（egg-1.png / egg-2.png）到底能不能用 ——
  if (FOCUS === 'egg') {
    const out = { checks: [] }
    const add = (ok, label, extra) => out.checks.push({ ok: !!ok, label, extra })
    const js = (code) => win.webContents.executeJavaScript(code)
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    // 自检模式本来不显示窗口；这里**特意显示**，才能验"真键盘能不能到页面"
    try { win.showInactive(); await sleep(1200) } catch (e) { out.showErr = String(e && e.message) }
    out.visible = (() => { try { return win.isVisible() } catch (e) { return null } })()

    const r1 = await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const q = (s) => document.querySelector(s)
      const checks = []
      const add = (ok, label, extra) => checks.push({ ok: !!ok, label, extra })
      const out = {}
      out.imgStatus = {}
      for (const n of ['egg-1', 'egg-2']) {
        try { const r = await fetch('/dsh-rice/' + n + '.png', { cache: 'no-store' }); out.imgStatus[n] = r.status }
        catch (e) { out.imgStatus[n] = 0 }
      }
      add(out.imgStatus['egg-1'] === 200 && out.imgStatus['egg-2'] === 200,
        '★ 两张彩蛋图都能取到（/dsh-rice/egg-1.png、egg-2.png）', JSON.stringify(out.imgStatus))
      const els = document.querySelectorAll('.dshrice-egg')
      out.eggEls = []
      for (let i = 0; i < els.length; i++) {
        out.eggEls.push({ src: els[i].getAttribute('src'), naturalW: els[i].naturalWidth, display: getComputedStyle(els[i]).display })
      }
      add(els.length === 2 && out.eggEls.every(e => e.naturalW > 0 && e.display !== 'none'),
        '★ 两个彩蛋元素都在 DOM 里，且图片**真的解码成功**', JSON.stringify(out.eggEls))
      // 触发逻辑本身（合成方向键）
      const img = q('img.dshwv-img')
      const r = img.getBoundingClientRect()
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: Math.round(r.left + r.width/2), clientY: Math.round(r.top + r.height/2) }))
      await sleep(120)
      const before = Array.from(els).map(e => e.classList.contains('dshrice-egg-show'))
      for (const k of ['ArrowUp','ArrowRight','ArrowDown','ArrowDown','ArrowDown']) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
        await sleep(60)
      }
      await sleep(600)
      const after = Array.from(document.querySelectorAll('.dshrice-egg')).map(e => e.classList.contains('dshrice-egg-show'))
      out.egg1Triggered = after.some((v, i) => v && !before[i])
      add(out.egg1Triggered, '★ 方向键序列 ↑→↓↓↓ 能触发 egg-1（逻辑本身是通的）',
        '触发前=' + JSON.stringify(before) + ' 触发后=' + JSON.stringify(after))

      // 彩蛋实际画在哪：应该在她额头附近（eggLeftPct 57 / eggTopPct 28）
      try {
        const e0 = document.querySelectorAll('.dshrice-egg')[0]
        const ir = img.getBoundingClientRect()
        const er = e0.getBoundingClientRect()
        out.eggRect = { l: Math.round(er.left), t: Math.round(er.top), w: Math.round(er.width), h: Math.round(er.height) }
        out.artRect = { l: Math.round(ir.left), t: Math.round(ir.top), w: Math.round(ir.width), h: Math.round(ir.height) }
        // 图标中心应落在立绘的水平中偏右、垂直靠上（额头）
        const cx = er.left + er.width / 2, cy = er.top + er.height / 2
        out.eggCenterRel = {
          xPct: Math.round((cx - ir.left) / ir.width * 100),
          yPct: Math.round((cy - ir.top) / ir.height * 100),
        }
        add(cx >= ir.left - 5 && cx <= ir.right + 5 && cy >= ir.top - 5 && cy <= ir.bottom + 5 && er.width > 0,
          '★ 彩蛋图标画在她**身上**（额头附近），不是飘在屏幕外',
          '图标=' + JSON.stringify(out.eggRect) + '  立绘=' + JSON.stringify(out.artRect) +
          '  相对位置=' + JSON.stringify(out.eggCenterRel) + '%')
      } catch (e) { out.eggRectErr = String(e && e.message) }

      out.checks = checks
      return out
    })()`)
    out.renderer = r1
    for (const c of r1.checks) add(c.ok, c.label, c.extra)

    // —— 关键：真键盘能不能到页面 ——
    out.hasFocusBeforeClick = await js('document.hasFocus()')
    // —— 用**真实 OS 鼠标**点她一下 ——
    // sendInputEvent 是"直接注入渲染进程"，它**不会激活窗口**，
    // 所以合成点击测不出"点一下能不能拿到键盘焦点"。必须用真的光标 + 真的按键。
    const rr = await js(`(function(){ var r=document.querySelector('img.dshwv-img').getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)} })()`)
    out.clickAt = rr
    try {
      const { execFileSync } = require('node:child_process')
      const ps = [
        'Add-Type -Namespace W -Name U -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern bool GetCursorPos(out System.Drawing.Point p); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,uint e);\' -ReferencedAssemblies System.Drawing',
        '$p = New-Object System.Drawing.Point',
        '[void][W.U]::GetCursorPos([ref]$p)',
        'Write-Output ("BEFORE " + $p.X + " " + $p.Y)',
        '[void][W.U]::SetCursorPos(' + rr.x + ',' + rr.y + ')',
        'Start-Sleep -Milliseconds 600',
        '[W.U]::mouse_event(0x0002,0,0,0,0)',
        'Start-Sleep -Milliseconds 80',
        '[W.U]::mouse_event(0x0004,0,0,0,0)',
        'Start-Sleep -Milliseconds 300',
        '[void][W.U]::SetCursorPos($p.X,$p.Y)',
        'Write-Output "CLICKED"',
      ].join('; ')
      out.realClickOut = execFileSync('powershell.exe', ['-NoProfile', '-NoLogo', '-Command', ps], { encoding: 'utf8', timeout: 20000 }).trim()
    } catch (e) { out.realClickErr = String(e && e.message) }
    await sleep(600)
    out.hasFocusAfterClick = await js('document.hasFocus()')
    out.isFocusedWin = (() => { try { return win.isFocused() } catch (e) { return null } })()

    // 真键盘注入（OS 级）：先确保窗口获得焦点，再发方向键
    try { win.focus(); await sleep(400) } catch (e) { out.focusErr = String(e && e.message) }
    out.hasFocusAfterWinFocus = await js('document.hasFocus()')
    // 清掉之前合成触发的显示状态，重新来一遍"只用真键盘"
    await js(`(function(){
      document.querySelectorAll('.dshrice-egg').forEach(function(e){ e.classList.remove('dshrice-egg-show') })
      return true
    })()`)
    await sleep(200)
    const img2 = await js(`(function(){ var r=document.querySelector('img.dshwv-img').getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)} })()`)
    win.webContents.sendInputEvent({ type: 'mouseMove', x: img2.x, y: img2.y })   // 武装
    await sleep(200)
    for (const k of ['Up', 'Right', 'Down', 'Down', 'Down']) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k })
      win.webContents.sendInputEvent({ type: 'char', keyCode: k })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k })
      await sleep(70)
    }
    await sleep(700)
    out.realKeyTriggered = await js(`(function(){
      return Array.from(document.querySelectorAll('.dshrice-egg')).map(function(e){ return e.classList.contains('dshrice-egg-show') })
    })()`)
    add(out.realKeyTriggered && out.realKeyTriggered.some(Boolean),
      '★ **真键盘**方向键也能触发彩蛋（说明窗口拿得到键盘焦点）',
      '触发结果=' + JSON.stringify(out.realKeyTriggered) +
      '  点击后hasFocus=' + out.hasFocusAfterClick +
      '  win.focus()后hasFocus=' + out.hasFocusAfterWinFocus +
      '  win.isFocused=' + out.isFocusedWin)
    try { win.hide() } catch (e) {}
    return out
  }
  // —— 兜底夹取：**强行**把她写到任务栏下面 / 屏幕外，看她会不会自己回来 ——
  // 模拟"某条绕过夹取的路"（挂件自己按整屏挪她、或接管让路时它自己拖）：
  // 直接往 .dshwv-root 的 style 里写越界坐标（挂件就是这么写的）。
  if (FOCUS === 'clamp-guard') {
    const out = { checks: [] }
    const add = (ok, label, extra) => out.checks.push({ ok: !!ok, label, extra })
    const js = (code) => win.webContents.executeJavaScript(code)
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const info = await js(`(function(){ return { w: screen.availWidth, h: screen.availHeight, sw: screen.width, sh: screen.height } })()`)
    out.env = info
    const artRect = () => js(`(function(){
      var r = document.querySelector('img.dshwv-img').getBoundingClientRect()
      return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) }
    })()`)

    // 用"整屏"口径算出一个必然越界的坐标（挂件就是这么算的：
    // 盒子 bottom 可以到 window.innerHeight = 整屏高，于是立绘底边落到任务栏下面）
    const cases = [
      { name: '写到任务栏下面（盒子 bottom = 整屏高）', left: '1673px', top: '900px' },
      { name: '写到屏幕右侧之外', left: '1900px', top: '729px' },
      { name: '写到屏幕左上之外', left: '-400px', top: '-400px' },
      { name: '写到整屏最底（模拟挂件按 innerHeight 夹取）', left: '1673px', top: (info.sh - 610) + 'px' },
    ]
    for (const c of cases) {
      await js(`(function(){
        var root = document.querySelector('.dshwv-root')
        root.style.setProperty('left', ${JSON.stringify(c.left)}, 'important')
        root.style.setProperty('top', ${JSON.stringify(c.top)}, 'important')
        return true
      })()`)
      await sleep(500)
      const a = await artRect()
      out[c.name] = a
      add(a.b <= info.h + 1 && a.r <= info.w + 1 && a.l >= -1 && a.t >= -1,
        '★ 强行' + c.name + ' → 500ms 内被夹回工作区内',
        '立绘=' + JSON.stringify(a) + '  工作区=' + info.w + '×' + info.h + '  整屏高=' + info.sh)
    }

    // 再验一次：面板开着（我们的接管会主动让路）时，兜底仍然生效
    try {
      await js('window.__dshpetWhaleExp && window.__dshpetWhaleExp.openPanel(); true')
      await sleep(300)
      await js(`(function(){
        var root = document.querySelector('.dshwv-root')
        root.style.setProperty('left', '1673px', 'important')
        root.style.setProperty('top', '1140px', 'important')
        return true
      })()`)
      await sleep(500)
      const a2 = await artRect()
      out.panelOpenCase = a2
      add(a2.b <= info.h + 1,
        '★ [形象面板开着] 强行写到任务栏下面 → 仍被夹回',
        '立绘=' + JSON.stringify(a2) + '  工作区高=' + info.h)
      await js('window.__dshpetWhaleExp && window.__dshpetWhaleExp.closePanel(); true')
      await sleep(200)
    } catch (e) { out.panelErr = String(e && e.message) }

    // 最后把她放回右下角，别影响别的用例
    await js(`(function(){
      if (window.__dshpetPhysics) { var b = window.__dshpetPhysics._bounds(); window.__dshpetPhysics._clampRendered(); }
      return true
    })()`)
    await sleep(300)
    return out
  }
  // —— 用**真实注入的 OS 级鼠标事件**拖她（sendInputEvent），而不是合成 DOM 事件 ——
  // 合成事件走的是"直接 dispatch"，绕过了浏览器真实的手势/指针捕获逻辑；
  // 用户报的"能拖到任务栏下面/屏幕外面"必须用真事件才可能复现。
  if (FOCUS === 'drag-real') {
    const out = { checks: [] }
    const add = (ok, label, extra) => out.checks.push({ ok: !!ok, label, extra })
    const js = (code) => win.webContents.executeJavaScript(code)
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const artRect = () => js(`(function(){
      var img = document.querySelector('img.dshwv-img')
      var root = document.querySelector('.dshwv-root')
      if (!img) return null
      // ⚠️ 量之前把行内 transform / transition 摘掉。
      //    getBoundingClientRect **含 transform**，而"点她"/"被砸到头"会给立绘挂
      //    一个 squash（scale(1.10,.88)）—— 带着它量出来的矩形会**临时变宽**
      //    （223 → 235），于是"左边缘越界 2px"这种**纯动画造成的**假象会被算成越界。
      //    夹取用的是布局位置（drag-physics 里就是这么量的），这里口径要一致。
      //    只摘行内的：根节点那个翻转来自 class，摘了朝向就错了。
      var saved = []
      var el = img
      while (el && el !== root && el.style) {
        if (el.style.transform) {
          saved.push([el, el.style.transform, el.style.transition])
          el.style.transition = 'none'; el.style.transform = 'none'
        }
        el = el.parentNode
      }
      var r = img.getBoundingClientRect()
      for (var i = 0; i < saved.length; i++) {
        saved[i][0].style.transform = saved[i][1]
        saved[i][0].style.transition = saved[i][2]
      }
      return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) }
    })()`)
    const info = await js(`(function(){
      return { w: screen.availWidth, h: screen.availHeight, sw: screen.width, sh: screen.height,
               iw: window.innerWidth, ih: window.innerHeight }
    })()`)
    out.env = info
    const send = (ev) => { try { win.webContents.sendInputEvent(ev) } catch (e) { out.sendErr = String(e && e.message) } }
    const steps = 14

    for (const mode of [false, true]) {
      await js(`window.__dshpetPhysics.setEnabled(${mode}); true`)
      await sleep(300)
      const tag = mode ? '物理开' : '物理关'
      const r0 = await artRect()
      const cx = Math.round((r0.l + r0.r) / 2)
      const cy = Math.round((r0.t + r0.b) / 2)
      // 先移上去（让渲染进程把窗口切成可交互），再按下
      send({ type: 'mouseMove', x: cx, y: cy })
      await sleep(250)
      send({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 })
      await sleep(120)
      // 一路拖到屏幕右下角之外
      for (let i = 1; i <= steps; i++) {
        send({ type: 'mouseMove', x: Math.round(cx + (2600 - cx) * i / steps), y: Math.round(cy + (1700 - cy) * i / steps) })
        await sleep(60)
      }
      // 拖的过程中问一句：是不是我们的模块在接管？
      out['handled_' + tag] = await js('window.__dshpetDragging === true')
      send({ type: 'mouseUp', x: 2600, y: 1700, button: 'left', clickCount: 1 })
      await sleep(800)
      const br = await artRect()
      out['br_' + tag] = br
      add(br.b <= info.h + 1,
        '★ [' + tag + '] 真实鼠标往右下拖到底：立绘底边不越过任务栏上沿(' + info.h + ')',
        '底边=' + br.b + ' 右=' + br.r + '  工作区=' + info.w + '×' + info.h + '  整屏=' + info.sw + '×' + info.sh +
        '  我们的模块在接管=' + out['handled_' + tag])
      add(br.r <= info.w + 1,
        '★ [' + tag + '] 真实鼠标往右下拖到底：立绘右边缘不越出屏幕',
        '右=' + br.r + ' 工作区右=' + info.w)
      // 再拖到左上角之外
      const r1 = await artRect()
      const c1x = Math.round((r1.l + r1.r) / 2), c1y = Math.round((r1.t + r1.b) / 2)
      send({ type: 'mouseMove', x: c1x, y: c1y })
      await sleep(200)
      send({ type: 'mouseDown', x: c1x, y: c1y, button: 'left', clickCount: 1 })
      await sleep(120)
      for (let i = 1; i <= steps; i++) {
        send({ type: 'mouseMove', x: Math.round(c1x + (-2000 - c1x) * i / steps), y: Math.round(c1y + (-1200 - c1y) * i / steps) })
        await sleep(60)
      }
      send({ type: 'mouseUp', x: -2000, y: -1200, button: 'left', clickCount: 1 })
      await sleep(800)
      const tl = await artRect()
      out['tl_' + tag] = tl
      add(tl.l >= -1 && tl.t >= -1,
        '★ [' + tag + '] 真实鼠标往左上拖到底：立绘左/上边缘不越出屏幕',
        '左=' + tl.l + ' 上=' + tl.t)
    }
    // —— 关键场景：**面板开着的时候**。我们的接管在面板打开时会主动让路
    //    （怕吞掉面板上的点击），于是拖动交给挂件自己做 ——
    //    而挂件是按"盒子 vs window.innerHeight(整屏 1152)"夹的，会漏到任务栏下面。
    try {
      await js('window.__dshpetWhaleExp && window.__dshpetWhaleExp.openPanel(); true')
      await sleep(400)
      const panelOpen = await js(`(function(){
        var p = document.querySelector('.dshpet-exp-panel')
        return !!(p && getComputedStyle(p).display !== 'none')
      })()`)
      out.panelOpen = panelOpen
      const r2 = await artRect()
      const c2x = Math.round((r2.l + r2.r) / 2), c2y = Math.round((r2.t + r2.b) / 2)
      send({ type: 'mouseMove', x: c2x, y: c2y })
      await sleep(250)
      send({ type: 'mouseDown', x: c2x, y: c2y, button: 'left', clickCount: 1 })
      await sleep(120)
      for (let i = 1; i <= steps; i++) {
        send({ type: 'mouseMove', x: Math.round(c2x + (2600 - c2x) * i / steps), y: Math.round(c2y + (1700 - c2y) * i / steps) })
        await sleep(60)
      }
      const handled2 = await js('window.__dshpetDragging === true')
      send({ type: 'mouseUp', x: 2600, y: 1700, button: 'left', clickCount: 1 })
      await sleep(800)
      const bp = await artRect()
      out.panelOpenDrag = bp
      out.handledPanelOpen = handled2
      add(bp.b <= info.h + 1,
        '★ [面板开着] 往右下拖到底：立绘底边**也不越过任务栏上沿**(' + info.h + ')',
        '底边=' + bp.b + '  我们的模块在接管=' + handled2 + '  面板开着=' + panelOpen +
        (bp.b > info.h + 1 ? '  ← 漏了 ' + (bp.b - info.h) + 'px（挂件按整屏夹取）' : ''))
      await js('window.__dshpetWhaleExp && window.__dshpetWhaleExp.closePanel(); true')
      await sleep(300)
    } catch (e) { out.panelErr = String(e && e.message) }

    await js('window.__dshpetPhysics.setEnabled(true); true')
    return out
  }
  // —— 拖动范围：物理开/关两种模式下，把她往四个方向拖到底，量立绘最终落在哪 ——
  if (FOCUS === 'drag-bounds') {
    return await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const q = (s) => document.querySelector(s)
      const checks = []
      const add = (ok, label, extra) => checks.push({ ok: !!ok, label, extra })
      const out = {}
      const img = () => q('img.dshwv-img')
      const artRect = () => { const r = img().getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) } }
      const work = () => ({ w: screen.availWidth, h: screen.availHeight, x: screen.availLeft || 0, y: screen.availTop || 0, sw: screen.width, sh: screen.height })
      out.work = work()

      // 慢慢拖到指定目标点（慢速 => 物理开着时松手不抛，两种模式可比）
      async function dragTo(tx, ty) {
        const r0 = img().getBoundingClientRect()
        const sx = Math.round(r0.left + r0.width / 2)
        const sy = Math.round(r0.top + r0.height / 2)
        const mk = (type, x, y, extra) => new PointerEvent(type, Object.assign({
          bubbles: true, cancelable: true, clientX: Math.round(x), clientY: Math.round(y),
          button: 0, pointerType: 'mouse', pointerId: 501, isPrimary: true,
        }, extra || {}))
        const tgt = document.elementFromPoint(sx, sy) || document.body
        tgt.dispatchEvent(mk('pointerdown', sx, sy, { buttons: 1 }))
        const N = 10
        for (let i = 1; i <= N; i++) {
          document.dispatchEvent(mk('pointermove', sx + (tx - sx) * i / N, sy + (ty - sy) * i / N, { buttons: 1 }))
          await sleep(70)
        }
        document.dispatchEvent(mk('pointerup', tx, ty, { buttons: 0 }))
        await sleep(700)
      }

      for (const mode of [false, true]) {
        if (window.__dshpetPhysics) window.__dshpetPhysics.setEnabled(mode)
        await sleep(300)
        const tag = mode ? '物理开' : '物理关'
        // 右下角（最容易跑到任务栏下面）
        await dragTo(4000, 4000)
        const br = artRect(); const w1 = work()
        out['br_' + tag] = br
        add(br.b <= w1.h + 1,
          '★ [' + tag + '] 往右下拖到底：立绘底边不越过**任务栏上沿**（' + w1.h + '）',
          '底边=' + br.b + '  右=' + br.r + '  工作区=' + w1.w + '×' + w1.h + '  整屏=' + w1.sw + '×' + w1.sh)
        add(br.r <= w1.w + 1,
          '★ [' + tag + '] 往右下拖到底：立绘右边缘不越出屏幕',
          '右=' + br.r + ' 工作区右=' + w1.w)
        // 左上角
        await dragTo(-3000, -3000)
        const tl = artRect()
        out['tl_' + tag] = tl
        add(tl.l >= -1 && tl.t >= -1,
          '★ [' + tag + '] 往左上拖到底：立绘左/上边缘不越出屏幕',
          '左=' + tl.l + ' 上=' + tl.t)
      }

      // 物理开着时再补一发"用力往下甩"，看抛掷会不会把她甩到任务栏下面
      if (window.__dshpetPhysics) {
        window.__dshpetPhysics.setEnabled(true)
        await sleep(300)
        const r0 = img().getBoundingClientRect()
        const sx = Math.round(r0.left + r0.width / 2)
        const sy = Math.round(r0.top + r0.height / 2)
        const mk = (type, x, y, extra) => new PointerEvent(type, Object.assign({
          bubbles: true, cancelable: true, clientX: Math.round(x), clientY: Math.round(y),
          button: 0, pointerType: 'mouse', pointerId: 502, isPrimary: true,
        }, extra || {}))
        ;(document.elementFromPoint(sx, sy) || document.body).dispatchEvent(mk('pointerdown', sx, sy, { buttons: 1 }))
        // 快速往右下甩（每步大、间隔短 => 速度大）
        for (let i = 1; i <= 6; i++) {
          document.dispatchEvent(mk('pointermove', sx + i * 300, sy + i * 260, { buttons: 1 }))
          await sleep(16)
        }
        document.dispatchEvent(mk('pointerup', sx + 1800, sy + 1560, { buttons: 0 }))
        await sleep(14000)          // 等它自己静止（原程序参数下最长约 10 秒）
        const th = artRect(); const w2 = work()
        out.throw = th
        add(th.b <= w2.h + 1 && th.r <= w2.w + 1,
          '★ [物理开] 用力往右下甩、等它静止后：仍在工作区内',
          '立绘=' + JSON.stringify(th) + ' 工作区=' + w2.w + '×' + w2.h)
      }

      if (window.__dshpetPhysics) window.__dshpetPhysics.setEnabled(true)
      out.checks = checks
      return out
    })()`)
  }
  // —— 真·端到端：拿本机**真的在播**的歌验歌词同步 ——
  // 这台机器上 echo-music 正在放歌（GSMTC 里有 title/artist/pos），
  // 所以这条探针是唯一能验证"真播放器 → 歌词 → 气泡 → 跟着音乐换句"的路径。
  // 没有歌在播时会明确报出来（而不是假装通过）。
  if (FOCUS === 'lyrics-live') {
    return await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const q = (s) => document.querySelector(s)
      const checks = []
      const add = (ok, label, extra) => checks.push({ ok: !!ok, label, extra })
      const out = {}
      const NP = window.__dshpetNowPlaying
      if (!NP) { add(false, '识别歌曲模块没加载', ''); out.checks = checks; return out }

      // 打开两个开关
      try { localStorage.setItem('dshpet-now-playing', '1') } catch (e) {}
      try { localStorage.setItem('dshpet-now-lyrics', '1') } catch (e) {}
      if (window.petApi.nowPlayingSet) await window.petApi.nowPlayingSet(true)
      if (window.petApi.nowPlayingLyricsSet) await window.petApi.nowPlayingLyricsSet(true)

      // 等主进程识别到歌 + 取回歌词（最多 25 秒）
      let st = null
      for (let i = 0; i < 50; i++) {
        await sleep(500)
        st = NP.lyricState()
        if (st.state === 'ready') break
      }
      out.lyricState = st
      out.bubbleOpen = !!(q('.dshpet-np-pop') && q('.dshpet-np-pop').classList.contains('dshpet-np-open'))
      out.head = NP.lyricHead()
      out.line0 = NP.lyricLine()
      // ⚠️ **本机有没有在放歌是完全不可控的。**
      //    没有歌在播时（播放器关了/没开），这个探针**什么都验不了** ——
      //    那不是"功能坏了"，但也不能假装通过。所以分三种情况如实报：
      //      · 没有歌            → 明确说明"跳过"（不是通过，也不是失败）
      //      · 有歌、有歌词      → 验"一句接一句"
      //      · 有歌、没歌词      → 验它老实退回歌名/作者版式
      const noSong = !st || (st.state === 'none' && st.count === 0)
      out.noSong = noSong
      if (noSong) {
        add(true, '（当前没有在播的目标播放器 —— 实时歌词验证**跳过**，这不是通过也不是失败）',
          'lyricState=' + JSON.stringify(st) + '  气泡=' + out.bubbleOpen)
        try {
          if (window.petApi.nowPlayingLyricsSet) await window.petApi.nowPlayingLyricsSet(false)
          if (window.petApi.nowPlayingSet) await window.petApi.nowPlayingSet(false)
          NP.hide()
          localStorage.setItem('dshpet-now-playing', '0')
          localStorage.setItem('dshpet-now-lyrics', '0')
        } catch (e) {}
        out.checks = checks
        return out
      }
      const gotLyrics = !!(st && st.state === 'ready' && st.count > 1)
      out.gotLyrics = gotLyrics
      add(st && (st.state === 'ready' || st.state === 'notfound' || st.state === 'none'),
        '★ 真播放器（本机正在放的那首歌）识别成功，歌词状态明确',
        'state=' + (st && st.state) + ' 句数=' + (st && st.count) +
        ' 气泡上边=' + JSON.stringify(out.head) + ' 当前句=' + JSON.stringify(out.line0))
      if (!gotLyrics) {
        // 没有可用歌词 → 必须是"歌名 / 作者"两行版式，而不是占位说明
        add(out.head && out.head.indexOf(' · ') < 0,
          '★ 这首没有可用歌词 → 气泡退回**歌名/作者**版式（不显示"纯音乐"占位说明）',
          '歌名行=' + JSON.stringify(out.head) + ' 第二行=' + JSON.stringify(out.line0))
      }

      // 采 9 秒，看歌词是不是**真的在往下走**（一句接一句）
      const samples = []
      for (let i = 0; i < 18; i++) {
        samples.push({ t: NP.lyricState().pos, line: NP.lyricLine() })
        await sleep(500)
      }
      const distinct = []
      for (const s of samples) if (!distinct.length || distinct[distinct.length - 1] !== s.line) distinct.push(s.line)
      out.sampleCount = samples.length
      out.distinctLines = distinct
      out.posFrom = samples[0] && samples[0].t
      out.posTo = samples[samples.length - 1] && samples[samples.length - 1].t
      add(distinct.length >= 2 || !gotLyrics,
        gotLyrics ? '★ 歌词**一句接一句**地在走（9 秒内确实换过句）'
                  : '（这首没歌词，跳过"换句"断言）',
        '换过 ' + distinct.length + ' 句: ' + JSON.stringify(distinct.slice(0, 5)))
      add(out.posTo > out.posFrom,
        '★ 播放位置在推进（歌词靠它对齐）',
        'pos ' + (out.posFrom && out.posFrom.toFixed(2)) + 's → ' + (out.posTo && out.posTo.toFixed(2)) + 's')
      add(out.bubbleOpen === true, '★ 歌词模式下气泡保持显示', 'open=' + out.bubbleOpen)

      // 收尾
      if (window.petApi.nowPlayingLyricsSet) await window.petApi.nowPlayingLyricsSet(false)
      if (window.petApi.nowPlayingSet) await window.petApi.nowPlayingSet(false)
      NP.hide()
      try { localStorage.setItem('dshpet-now-playing', '0') } catch (e) {}
      try { localStorage.setItem('dshpet-now-lyrics', '0') } catch (e) {}
      out.checks = checks
      return out
    })()`)
  }
  // —— 反向对照：把修补撤掉，验证"这条断言真的会红" ——
  // 一个永远为绿的断言等于没测。这里临时摘掉 .dshpet-rangerow（等于回到旧行为），
  // 把面板压窄，看「分钟」是不是真的会掉到下一行。
  if (FOCUS === 'layout-neg') {
    return await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const q = (s) => document.querySelector(s)
      const checks = []
      const add = (ok, label, extra) => checks.push({ ok: !!ok, label, extra })
      const out = {}
      const chip = q('.dshrice-chip')
      if (chip && !q('.dshrice-menu.dshrice-open')) { chip.click(); await sleep(600) }
      const panel = q('.dshrice-menu.dshrice-open')
      if (!panel) { add(false, '面板没打开', ''); out.checks = checks; return out }
      let row = null
      const rows = panel.querySelectorAll('.dshrice-row')
      for (let i = 0; i < rows.length; i++) { if ((rows[i].textContent || '').indexOf('最少隔') >= 0) { row = rows[i]; break } }
      if (!row) { add(false, '没找到「最少隔」那一行', ''); out.checks = checks; return out }
      const grp = row.closest('.dshrice-grp')
      if (grp && !grp.classList.contains('dshrice-grp-open')) {
        const gh = grp.querySelector('.dshrice-grp-h')
        if (gh) { gh.click(); await sleep(350) }
      }
      await sleep(200)
      const measure = () => {
        const kids = []
        for (let i = 0; i < row.children.length; i++) {
          const el = row.children[i]
          const r = el.getBoundingClientRect()
          if (!r.width && !r.height) continue
          kids.push({ cls: String(el.className || '') || el.tagName, cy: Math.round(r.top + r.height / 2) })
        }
        const cys = kids.map((k) => k.cy)
        return { kids, spread: cys.length >= 2 ? (Math.max.apply(null, cys) - Math.min.apply(null, cys)) : -1 }
      }
      out.withFix = measure()
      // 摘掉修补 → 回到 rice 的原始行为
      row.classList.remove('dshpet-rangerow')
      await sleep(150)
      panel.style.width = '190px'; panel.style.maxWidth = '190px'
      await sleep(300)
      out.withoutFix = measure()
      out.overflowWithoutFix = row.scrollWidth > row.clientWidth + 1
      // 还原
      panel.style.width = ''; panel.style.maxWidth = ''
      row.classList.add('dshpet-rangerow')
      add(out.withFix.spread === 0, '有修补时：同一行', '中心差=' + out.withFix.spread + ' ' + JSON.stringify(out.withFix.kids))
      add(out.withoutFix.spread > 0, '★ 反向对照：摘掉修补、压窄到 190px 后，「分钟」**真的会掉到下一行**（说明断言不是空过）',
        '中心差=' + out.withoutFix.spread + ' ' + JSON.stringify(out.withoutFix.kids) + ' 溢出=' + out.overflowWithoutFix)
      out.checks = checks
      return out
    })()`)
  }
  if (FOCUS === 'rice-click') {
    return await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const q = (s) => document.querySelector(s)
      const checks = []
      const add = (ok, label, extra) => checks.push({ ok: !!ok, label, extra })
      const out = {}
      const rectOf = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } }

      // —— 关掉拖动物理（用户报的就是这条路径；旧自检永远强制它开着，所以从没测过）——
      if (window.__dshpetPhysics) window.__dshpetPhysics.setEnabled(false)
      await sleep(300)
      out.physicsEnabled = window.__dshpetPhysics ? window.__dshpetPhysics.isEnabled() : null
      add(out.physicsEnabled === false, '前置：拖动物体已关闭', 'enabled=' + out.physicsEnabled)

      // —— 黑匣子：记录"面板矩形变化"和"她位置变化"，用来抓那一瞬间的位移 ——
      const flight = []
      const t0 = Date.now()
      const rec = (kind, detail) => { flight.push({ t: Date.now() - t0, kind, detail }); if (flight.length > 400) flight.shift() }
      let lastPanelRect = null
      let lastImgRect = null
      const watch = setInterval(() => {
        const p = q('.dshrice-menu.dshrice-open')
        const pr = rectOf(p)
        const ir = rectOf(q('img.dshwv-img'))
        if (pr && (!lastPanelRect || pr.l !== lastPanelRect.l || pr.t !== lastPanelRect.t)) {
          rec('panel-move', (lastPanelRect ? lastPanelRect.l + ',' + lastPanelRect.t + ' -> ' : '') + pr.l + ',' + pr.t)
        }
        if (ir && (!lastImgRect || ir.l !== lastImgRect.l || ir.t !== lastImgRect.t)) {
          rec('whale-move', (lastImgRect ? lastImgRect.l + ',' + lastImgRect.t + ' -> ' : '') + ir.l + ',' + ir.t)
        }
        lastPanelRect = pr; lastImgRect = ir
      }, 40)
      // 事件黑匣子：谁在什么时候被点了
      const evLog = []
      for (const type of ['pointerdown', 'pointerup', 'click']) {
        document.addEventListener(type, (e) => {
          const t = e.target
          evLog.push({
            t: Date.now() - t0, type,
            x: e.clientX, y: e.clientY,
            target: t ? (t.tagName + '.' + String(t.className || '').split(' ').slice(0, 2).join('.')) : 'null',
            inPanel: !!(t && t.closest && t.closest('.dshrice-menu')),
          })
          if (evLog.length > 200) evLog.shift()
        }, true)
      }

      // —— 打开桌宠菜单（真实点击，不是 .click()）——
      const mkEv = (type, x, y, extra) => new PointerEvent(type, Object.assign({
        bubbles: true, cancelable: true, clientX: x, clientY: y,
        button: 0, pointerType: 'mouse', pointerId: 300, isPrimary: true,
      }, extra || {}))
      const realClick = async (el, jitter) => {
        const r = el.getBoundingClientRect()
        const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2)
        const tgt = document.elementFromPoint(x, y) || el
        tgt.dispatchEvent(mkEv('pointerdown', x, y, { buttons: 1 }))
        await sleep(60)
        if (jitter) document.dispatchEvent(mkEv('pointermove', x + jitter, y, { buttons: 1 }))
        await sleep(60)
        document.dispatchEvent(mkEv('pointerup', x, y, { buttons: 0 }))
        tgt.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }))
        return { x, y, tgt }
      }
      const mbtn = q('.dshwv-menu-btn')
      if (mbtn) await realClick(mbtn)
      await sleep(600)
      out.menuOpen = !!(q('.dshwv-menu') && q('.dshwv-menu').classList.contains('dshwv-menu-open'))
      add(out.menuOpen, '前置：桌宠菜单已打开', 'open=' + out.menuOpen)

      // —— 点「偷吃白饭」那一行开面板（真实点击）——
      const riceRow = q('.dshpet-rice-row')
      if (riceRow) await realClick(riceRow)
      await sleep(700)
      const panel = q('.dshrice-menu.dshrice-open')
      out.panelOpened = !!panel
      add(out.panelOpened, '前置：米粒面板已打开', 'panel=' + !!panel)
      if (!panel) { clearInterval(watch); out.checks = checks; return out }

      // —— 关键实验：在面板里"真实地点一下控件"，看按下和抬起之间面板有没有挪窝 ——
      const boxes = panel.querySelectorAll('input[type=checkbox]')
      const target = boxes[0] || panel.querySelector('button')
      out.targetDesc = target ? (target.tagName + '.' + String(target.className || '')) : null
      const tr = target.getBoundingClientRect()
      const tx = Math.round(tr.left + tr.width / 2), ty = Math.round(tr.top + tr.height / 2)
      out.pressPoint = { x: tx, y: ty }
      out.panelAtPress = rectOf(panel)
      out.whaleAtPress = rectOf(q('img.dshwv-img'))
      const before = target && target.type === 'checkbox' ? target.checked : null

      const tgtEl = document.elementFromPoint(tx, ty) || target
      out.elementAtPress = tgtEl.tagName + '.' + String(tgtEl.className || '').slice(0, 40)
      const mark = flight.length
      tgtEl.dispatchEvent(mkEv('pointerdown', tx, ty, { buttons: 1 }))
      // 真实用户按下到抬起之间会停顿几十~一百多毫秒 —— 这期间 rice 的 700ms
      // 重摆 / 入口的 150ms 让位 / 她自己的瞬移都可能把面板挪走。
      await sleep(140)
      out.panelAtClick = rectOf(panel)
      out.whaleAtClick = rectOf(q('img.dshwv-img'))
      const tgtNow = document.elementFromPoint(tx, ty)
      out.elementAtClick = tgtNow ? (tgtNow.tagName + '.' + String(tgtNow.className || '').slice(0, 40)) : null
      out.sameElement = !!(tgtNow && (tgtNow === tgtEl || (tgtEl.contains && tgtEl.contains(tgtNow)) || (tgtNow.contains && tgtNow.contains(tgtEl))))
      document.dispatchEvent(mkEv('pointerup', tx, ty, { buttons: 0 }))
      tgtEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: tx, clientY: ty }))
      await sleep(250)
      out.panelStillOpen = !!q('.dshrice-menu.dshrice-open')
      out.valueChanged = before === null ? null : (target.checked !== before)
      out.flight = flight.slice(mark)
      out.events = evLog.slice(-14)

      clearInterval(watch)
      const dPanel = (out.panelAtPress && out.panelAtClick)
        ? (Math.abs(out.panelAtClick.l - out.panelAtPress.l) + Math.abs(out.panelAtClick.t - out.panelAtPress.t)) : -1
      out.panelDriftDuringPress = dPanel
      add(dPanel === 0, '★ 按下→抬起之间米粒面板**没有挪窝**（挪了就会点空）',
        '位移=' + dPanel + 'px  按下时=' + JSON.stringify(out.panelAtPress) + '  抬起时=' + JSON.stringify(out.panelAtClick))
      add(out.sameElement === true, '★ 抬起时指针底下还是同一个控件', JSON.stringify(out.elementAtPress) + ' → ' + JSON.stringify(out.elementAtClick))
      add(out.valueChanged === true, '★ 这一下点击真的生效了（控件状态变了）', 'before/after 变了=' + out.valueChanged)
      add(out.panelStillOpen === true, '★ 点完面板还开着（没被误关）', 'open=' + out.panelStillOpen)
      out.checks = checks
      return out
    })()`)
  }
  return { checks: [{ ok: false, label: '未知的 PET_FOCUS：' + FOCUS }] }
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------
// 单实例：再开一次就把已有窗口显示出来，不叠第二只
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // ⚠️ 这里以前是"把第一只叫出来"。改成**再开一只** ——
  //    「打开桌宠」按钮就是靠这个实现的：它启动一个新进程，
  //    新进程拿不到单实例锁 → 立刻退出 → 老进程收到 second-instance → 我们开新窗口。
  //    好处是不用改"用户双击 exe"的行为（双击也变成多开一只，符合直觉）。
  app.on('second-instance', () => {
    try { spawnPet('second-instance') } catch (err) { log('多开失败', err && err.message) }
  })

  app.whenReady().then(async () => {
    log('=== 大肥鱼桌宠启动 ===', '数据目录', DATA_DIR)
    let port = 0
    try {
      port = await bootHost()
    } catch (err) {
      log('宿主启动失败', err)
    }
    petPort = port          // 记住端口 —— 「打开桌宠」再开新窗口时要用
    makePetWindow(port, true)
    if (SELFTEST) { runSelfTest(); return }
    buildTray()

    try {
      screen.on('display-metrics-changed', reposition)
      screen.on('display-added', reposition)
      screen.on('display-removed', reposition)
    } catch (err) {}
  })

  // 桌宠常驻：关掉所有窗口也不退出
  app.on('window-all-closed', () => {})
  app.on('before-quit', () => {
    quitting = true
    try { turns && turns.stop() } catch (err) {}
    // 必须显式收掉：常驻的 PowerShell 是**子进程**，主进程退出它不一定跟着走，
    // 留下一个没人管的 powershell.exe 会一直轮询媒体会话。
    try { nowPlaying && nowPlaying.stop() } catch (err) {}
    try { fsWatch && fsWatch.stop() } catch (err) {}
    try { shim && shim.disposeAll() } catch (err) {}
    try { server && server.stop() } catch (err) {}
    log('=== 退出 ===')
  })
}
