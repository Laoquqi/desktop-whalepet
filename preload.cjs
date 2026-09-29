// 预加载脚本（CommonJS —— Electron 的 preload 用 CJS 最稳）
// 只暴露必要的几个方法，渲染进程拿不到 Node。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('petApi', {
  // 自检模式标记（PET_SELFTEST=1）：渲染进程靠它跳过"会把桌宠到处乱飞"的动作
  // （连点生气时的 toss），免得自检里位置/面板类断言被搅乱。
  selftest: !!process.env.PET_SELFTEST,
  getPort: () => ipcRenderer.invoke('pet:port'),
  getDataDir: () => ipcRenderer.invoke('pet:data-dir'),
  // 鼠标是否穿透由渲染进程按"指针在不在挂件上"决定
  setInteractive: (on) => ipcRenderer.send('pet:set-interactive', !!on),
  // 小窗口架构：渲染进程的物理位置（屏幕坐标）驱动窗口移动
  moveWindow: (p) => ipcRenderer.send('pet:move-window', p),
  // 诊断：IPC 监听器数量。
  // ⚠️ ipcRenderer.on 注册的监听器**不会随页面重载自动清掉**（同一个渲染进程），
  //    所以任何"重载页面"的开关都会让监听器越积越多 —— 一次操作触发 N 次重载，
  //    重载又加 N 个……直接雪崩。这个接口就是用来盯这件事的。
  debugIpcCounts: () => {
    try {
      return {
        dragPhysics: ipcRenderer.listenerCount('pet:drag-physics'),
        resetPos: ipcRenderer.listenerCount('pet:reset-pos'),
        forcePassthrough: ipcRenderer.listenerCount('pet:force-passthrough'),
        nowPlaying: ipcRenderer.listenerCount('pet:now-playing'),
      }
    } catch (err) { return { error: String(err && err.message) } }
  },
  // 托盘里的「强制鼠标穿透」开关（逃生口）
  onForcePassthrough: (fn) => ipcRenderer.on('pet:force-passthrough', (e, on) => { try { fn(on) } catch (err) {} }),
  // 托盘里的「拖动物理」开关（与挂件 ☰ 菜单里那一项是同一个值）
  onDragPhysics: (fn) => ipcRenderer.on('pet:drag-physics', (e, on) => { try { fn(on) } catch (err) {} }),
  resetPos: () => ipcRenderer.send('pet:reset-pos'),
  // 重载页面 —— 必须走主进程（渲染进程的 location.reload() 在本应用里无效，见 main.cjs 说明）
  reload: () => ipcRenderer.send('pet:reload'),
  // 用系统默认浏览器打开本机链接（主进程侧有白名单校验）
  openExternal: (url) => ipcRenderer.send('pet:open-external', String(url || '')),
  // 「打开 dsh 网页端」：端口不能写死（不同机器不同），由主进程探测后打开。
  // 返回 { ok, port, url } 或 { ok:false, reason }。
  openDshWeb: (opts) => ipcRenderer.invoke('pet:open-dsh-web', opts || {}),
  // 「选择音乐…」→ 打开桌宠自己的 songs 文件夹（路径由主进程拼，渲染进程不传路径）
  openSongsFolder: () => ipcRenderer.send('pet:open-songs-folder'),
  // 「角色」那一行的「选择图片…」→ 系统图片选择框（默认落在 Screenshots），
  // 返回 { ok, name, dataUrl } —— 用 data URL 免得渲染进程再操心 file:// 限制
  pickImage: () => ipcRenderer.invoke('pet:pick-image'),
  // 开机自启（可开关）
  autostartGet: () => ipcRenderer.invoke('pet:autostart-get'),
  autostartSet: (on) => ipcRenderer.invoke('pet:autostart-set', !!on),
  // 多桌宠：「打开桌宠」再开一只；没有数量限制
  spawnPet: () => ipcRenderer.invoke('pet:spawn'),
  petCount: () => ipcRenderer.invoke('pet:count'),
  // 自检用：看各只上报的立绘矩形
  petDebugRects: () => ipcRenderer.invoke('pet:debug-rects'),
  // —— 拖文件"吃掉" ——
  // ⚠️ Electron 44 已经**移除**了 File.path，取本地路径必须用 webUtils。
  //    拿不到就返回空串（调用方会当成"不是本地文件"忽略）。
  filePathOf: (f) => {
    try {
      const { webUtils } = require('electron')
      return (webUtils && webUtils.getPathForFile) ? webUtils.getPathForFile(f) : ''
    } catch (err) { return '' }
  },
  // 只统计 + 记录，**不碰文件本身**（主进程侧也只 stat，不删不移）
  eatFiles: (paths) => ipcRenderer.invoke('pet:eat-files', paths),
  eatStats: () => ipcRenderer.invoke('pet:eat-stats'),
  // 自检用：跑一次落座算法
  petDebugPickSpot: () => ipcRenderer.invoke('pet:debug-pick-spot'),
  // 这一只自己的信息（是不是多开出来的）—— 「退出桌宠」菜单项按它决定显不显示
  petInfo: () => ipcRenderer.invoke('pet:info'),
  // 「退出桌宠」：关掉发起这一只自己
  closeSelf: () => ipcRenderer.invoke('pet:close-self'),
  // 自检收尾：收掉多开的
  closeExtraPets: () => ipcRenderer.invoke('pet:close-extra'),
  // 把**立绘**在屏幕上的矩形报给主进程（主进程靠它算相撞）
  reportRect: (r) => ipcRenderer.send('pet:report-rect', r),
  // 主进程判定和另一只撞上了时回调（边沿触发，只在刚碰上的那一下）
  // ⚠️ info 里带着**对方的矩形** —— 往哪边弹开要靠它算。
  onCollide: (fn) => ipcRenderer.on('pet:collide', (e, info) => { try { fn(info) } catch (err) {} }),
  // 主进程广播来的**其它桌宠的立绘矩形**（每 40ms 一次，内容变了才发）。
  // 渲染进程靠它做**事前**的实体约束：任何一次位置写入只要会和同伴重叠就当场被挡住。
  onPeers: (fn) => ipcRenderer.on('pet:peers', (e, list) => { try { fn(list) } catch (err) {} }),
  // 新桌宠的落座位置（主进程挑好的、不和别人重叠的点）
  onSetPos: (fn) => ipcRenderer.on('pet:set-pos', (e, d) => { try { fn(d) } catch (err) {} }),
  // 桌宠只数变化（主进程推）—— 只有一只时前端可以完全不做碰撞相关开销
  onPetCount: (fn) => ipcRenderer.on('pet:count-changed', (e, n) => { try { fn(n) } catch (err) {} }),
  // 让路恢复后主进程要求"重新评估鼠标穿透"。
  // 必须由主进程主动要求：渲染端自己有个 lastInteractive 缓存，
  // 值没变就不重发 —— 而窗口 hide/show 之后实际状态可能已经不一致，
  // 两边都以为"没变"就永远卡住（用户报的"全屏视频进出后点不了"）。
  onReevalInteractive: (fn) => ipcRenderer.on('pet:reeval-interactive', () => { try { fn() } catch (err) {} }),
  // 全屏让路：主进程要在 260ms 后 hide，先让渲染端把画面淡出
  onFadeOut: (fn) => ipcRenderer.on('pet:fade-out', () => { try { fn() } catch (err) {} }),
  // 主进程碰撞世界下发的冲量 + 位置分离（20Hz）
  onImpulse: (fn) => ipcRenderer.on('pet:impulse', (e, d) => { try { fn(d) } catch (err) {} }),
  // 桌宠互撞的冲量转发：撞人的那只把自己该给同伴的份额发过来，
  // 主进程按窗口 id 转交给对方 —— 事件驱动，无轮询延迟。
  peerImpulse: (p) => ipcRenderer.send('pet:peer-impulse', p),
  // 落好座了 → 主进程可以显示这只窗口了
  notifyPlaced: () => ipcRenderer.send('pet:placed'),
  // 「识别歌曲和作者」：开关走主进程（它要常驻跑 PowerShell 轮询媒体会话）
  nowPlayingSet: (on) => ipcRenderer.invoke('pet:now-playing-set', !!on),
  nowPlayingGet: () => ipcRenderer.invoke('pet:now-playing-get'),
  // 「识别歌词」：识别歌曲的下一级开关
  nowPlayingLyricsSet: (on) => ipcRenderer.invoke('pet:now-playing-lyrics-set', !!on),
  nowPlayingLyricsGet: () => ipcRenderer.invoke('pet:now-playing-lyrics-get'),
  // 主进程识别到"正在播放的歌"就推过来；null = 没有在播 / 关掉了
  onNowPlaying: (fn) => ipcRenderer.on('pet:now-playing', (e, info) => { try { fn(info) } catch (err) {} }),
  onResetPos: (fn) => ipcRenderer.on('pet:reset-pos', () => { try { fn() } catch (e) {} }),
  log: (msg) => ipcRenderer.send('pet:log', String(msg)),

  credStatus: () => ipcRenderer.invoke('pet:cred-status'),
  credSet: (v) => ipcRenderer.invoke('pet:cred-set', v),
  closeSettings: () => ipcRenderer.send('pet:close-settings'),
  quit: () => ipcRenderer.send('pet:quit'),
})
