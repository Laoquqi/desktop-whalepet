// ============================================================================
// dsh-rice-widget —— 「偷吃白饭」独立插件 · 宿主半边
// ============================================================================
// 和 dsh-whale-widget 的关系：**只读它的公开 HTTP 接口，不碰它的任何文件**。
//   GET /dsh-whale/balance.json     → { todayUsage, ... }
//   GET /dsh-whale/last-turn.json   → { seq, amount, ... }
// 由客户端脚本取回后 POST 到这里；本半边负责记账，客户端只负责画面。
//
// 为什么账要记在宿主而不是页面里：
//   1. 跨页面刷新不丢 —— 否则「页面没开时攒下的那笔」会被直接扔掉（旧补丁的老毛病）
//   2. 不依赖平台的用量延迟 —— turnCredit 可以跨多次轮询结转
//   3. 关掉浏览器再打开，她该吃的那碗还在（而且会一次补上，像趁你不在偷吃了好几口）
// ============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const name = 'dsh-rice-widget'

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

// —— 可调参数 ——
// 全部可以用 ~/.dsh/.dsh-rice-config.json 覆盖（键名与此处一致），
// 也可以用 POST /dsh-rice/config 在线改。**改完不用动代码。**
const DEFAULT_CONFIG = {
  // 起吃线：留给「本地逐轮算」和「平台按小时分桶」之间的小误差。
  // 没有它的话，只要本地把某一轮算便宜了一分钱，她就会每轮都吃一口。
  minExternal: 0.1,
  // 回落超过这个数才算跨天归零；更小的回落只是平台重算/分桶微调，
  // 不能借机把已经攒着的量丢掉，否则小额消耗永远攒不到起吃线。
  rolloverDrop: 1,
  // 分档：< tier1Below → 1 口；< tier2Below → 2 口；否则 → bitesMax 口
  tier1Below: 0.5,
  tier2Below: 2,
  bitesMax: 3,
  // 客户端轮询间隔、以及每一口的节奏（毫秒）
  pollMs: 3000,
  // 560 = 实机调过的节奏。320 是旧补丁的值，偏急。
  stepMs: 560,
  // 扒完之后那粒饭在嘴角停留多久（毫秒）
  grainMs: 1750,
  // —— 随机偷吃 ——
  // 开：**不再每轮都吃**，而是每次"结算一轮"的时候掷一次骰子；没掷中就攒着，
  //     下次掷中时**一起吃**（金额更大 → bitesFor 自然给更多口）。
  // 关：老规矩 —— 每一轮当场吃。这一项默认开：
  //     少几次、每次更实在，比"每轮都扒一口"更不像打卡，也没那么烦。
  randomSteal: true,
  // 掷中的概率（百分比 0~100）。**界面上那个数就是这个数**（和音量一个规矩）。
  stealChancePct: 50,
  // —— 开工时自动唱一首 ——
  // DSH 每次开始处理一轮（`turn/start`）就是一个"她开工了"的时刻。
  // 宿主订阅那个事件，再把信号转给页面（页面里的音频只能由页面自己放）。
  // 开：她开工时自己唱一首。默认开、而且有下面的最小间隔兜着 —— 不然你每发一条消息她都唱。
  autoSingOn: true,
  // 两次自动唱歌之间**至少**隔多少分钟（0 = 不限制，每轮都唱）。
  // 「至少」是关键：不是"每 N 分钟唱一次"，而是"没隔够 N 分钟就不唱"。
  autoSingMin: 5,
  // —— 余额不足时放一首歌（"雨爱"那种）——
  // 判据**不是我定的数**：它读鲸鱼自己的「余额预警」（`usage-settings.json` 里的
  // `alert.on` / `alert.below`），于是"余额不足"这件事只有一个真身 ——
  // 用户要改线，就在鲸鱼面板里改那一个数字，我们下次打开就跟着变。
  // **两边都开才响**：鲸鱼那条预警开着 **且** 这一项开着。
  // 时机：**每打开一个 DSH 页面只判一次、最多放一次** —— 不是实时警报，
  // 所以页面里把余额花到线下也不会响，下次打开才响（见 README「余额警报音」）。
  alarmOn: true,
  // 放哪一首：**alarm/ 目录里的文件名**（和 songs/ 是两套，互不混入）。
  // 默认这一首是**随包发的**（群主给的通用音效，0.36 MB，短）—— 于是开箱就有声音，
  // 不会出现"功能在、但没配置等于没有"。想换成自己的：把文件丢进 alarm/，
  // 在面板「放哪首」里选（自己的文件**不随包发**）。
  // ⚠️ 那首歌其实是 MP4 容器（`ftyp`），只是文件名写成 .mp3 —— 无所谓：
  //    路由是按**文件头**嗅 Content-Type 的（见 artType），扩展名只说谎给白名单看。
  alarmSong: '冰冰冰.mp3',
  // —— 版面：全部是相对鲸鱼容器 .dshwv-body 的百分比 ——
  // 这套东西画在**别人的立绘**上：分辨率、姿势、角色数都不由我们决定，
  // 所以位置不能写死。换了立绘，就按自己那张调这几个数。
  bowlLeft: 71, bowlTop: 75.4, bowlWidth: 33, bowlHeight: 21.5,
  // —— 碗和碗里的饭，用图片 ——
  // 三张都是 196×196、**预先对齐好的**：饭在下、空碗叠在上面，合起来就是"一碗饭"。
  // 饭分波峰/波谷两张 —— 峰时段一口吃掉的钱更多，那碗就该更丰盛。
  // 「现在是峰还是谷」**不用我们自己算**：鲸鱼的 balance.json 里就有 isPeak。
  // 任何一张取不到，就整组退回下面那个内联 SVG 画的碗 —— 插件因此仍然自足、可发布。
  // 空字符串 = 用内联 SVG。
  bowlImage: '/dsh-rice/bowl.png',
  foodPeakImage: '/dsh-rice/food-peak.png',
  foodValleyImage: '/dsh-rice/food-valley.png',
  // ⚠️ grainLeft / grainTop 指的是**整簇米的中心**（客户端有 translate(-50%,-50%)），
  // 不是左上角 —— 所以改 grainWidth 时位置不会跑掉。
  // 这组值是**在真实立绘上一点点调出来的**（原本是 75.9 / 85.3，偏右偏高）。
  grainLeft: 73, grainTop: 85.4,
  // grainWidth 是**整簇**的宽度（不是单粒米）；高宽比见客户端，跟着"用哪张图"走。
  //
  // grainMinPx 是**可选的下限，默认 0 = 关闭**。
  // ⚠️ 默认必须是 0：一旦设成 16，鲸鱼缩小的时候百分比宽度会低于它，
  // 于是米粒被钉在 16px 不动 —— **和鲸鱼脱钩，相对就成了贴在脸上的巨物**。
  // 鲸鱼小的时候米粒本来就该小，那才是对的。真想要下限的人可以自己设。
  grainWidth: 10, grainMinPx: 0,
  // 米粒用哪张图。**默认是作者画的那张**（art/rice.png，随包发布、已获授权）；
  // 留空则退回客户端内置的圆形兜底。
  // 用户在面板里点「选择图片…」时，这个值会变成一段 data URI。
  grainImage: '/dsh-rice/rice.png',
  // 咀嚼的旋转轴 —— 就是"她低头那一下"绕的那个点。
  // 86% 往下大约是她下颌线的位置，所以增大/减小它会显得头在抬或低。
  // （面板里不放它：它不像位置那样需要反复试，配置里能手改就够了。）
  chewOriginX: 50, chewOriginY: 86,
  // 米粒那一簇的旋转角度（度）。**有些角色是抬着头/歪着头的**，
  // 嘴的朝向和默认立绘不一样，米粒就得跟着转 —— 否则看着像贴歪了。
  grainRotate: 0,
  // —— 彩蛋：连续按 ↑ → ↓ ↓ ↓（《绝地潜兵 2》呼叫飞鹰 500KG 的指令）——
  // 她的头顶会弹出 500KG 的图标，同时缩一下脖子。
  // 纯客户端行为：不新增路由、不改账目、不联网。
  eggOn: true,
  // 指令输完之后，**等多久才让图标出现、她才挨那一下**（毫秒）。
  // 存在的理由：最后一下按键的"滴"声会被"图标弹出 + 打击音效"盖住 ——
  // 往后推一点，那一下才听得清。
  //
  // 具体多少取决于那个音效有多长，而**它有多长测不出来**：
  // MediaRecorder 生成的 WebM 不写 Duration 元素（按直播流封装），
  // EBML 里扫不出真实长度（试过，扫出来是垃圾值）。所以这个数做成可调，不猜。
  eggLeadMs: 300,
  // 图标的大小与位置 —— **三个都是相对"她自己那张图"的百分比**。
  //
  // ⚠️ 参照系是 `.dshwv-img`（她的图片），**不是 `.dshwv-body`**。
  // 因为 .dshwv-body 的边长是 clamp(122px, min(100vw,100vh)*0.28*scale, 625px) ——
  // 它会随视口、缩放、以及 clamp 边界而变，用它当参照系，图标会到处漂。
  // （这个坑是被余额气泡暴露出来的：气泡一出现，落点就跑了。）
  //
  //   eggLeftPct 57     横向，50 = 图片中线；57 是实机定下来的（偏右一点）
  //   eggTopPct  28     纵向，28 ≈ 她的额头
  //   eggIconPct 19     图标宽度占图片宽度的比例
  //
  // ⚠️ **这三个不在 LAYOUT_KEYS 里，也就是不按角色存。**
  // 理由：米粒必须对准"嘴"这个解剖位置，所以只能每个角色各调一遍；
  // 而图标只要"压在她身上"就够了 —— **对齐精度要求不同，存储粒度就可以不同。**
  //
  // ⚠️ **面板里故意没有它的调参入口。** 菜单上多一个「图标」按钮，
  // 等于告诉用户"这里藏了东西" —— 彩蛋就不成其为彩蛋了。
  // （要再调的话：把 client.js 里 `var target = 'grain'` 临时改成 `'egg'`，
  //   图标就会在面板开着时常显，调完再改回来。）
  eggIconPct: 19,
  eggLeftPct: 57, eggTopPct: 28,
  // —— 吃饭的音效 ——
  // 只在"最后放下碗"那一拍响**一次**（不是背景音），**音量随口数变大**。
  // 这不是装饰，是信息：你光靠听就知道这顿吃得多不多。
  //
  // riceSound 和米粒图一样**用户可以自己换**：面板里选一个音频文件，
  // 会被读成 data URI 存进配置。空字符串 = 不响。
  // ⚠️ 它**不在 LAYOUT_KEYS 里**，也就是不按角色存 ——
  // 米粒图按角色是因为它要对准"嘴"那个位置；而音效是"她吃饭的声音"，
  // 和头长什么样无关。按角色存只会让人换个角色就得重选一次音效。
  riceSound: '/dsh-rice/nang.weba',
  // 总开关。**和鲸鱼自己的音效开关是两层** —— 用户在哪一层关掉都算数。
  // 这一层同时管**两个**音效（每口一声、以及碗落地那一声）：
  // 它的意思就是"她吃饭的时候别出声"，那两声都属于这件事。
  riceSoundOn: true,
  // 音量。**刻度就是用户看到的那个：0~10，默认 5。**
  // 存 0~10 而不是 0~1，是因为配置文件是给人看的 ——
  // 文件里写 0.5、界面上显示 5，那就成了两个东西，迟早对不上。
  // 实际用的是 vol/10，再乘鲸鱼自己的 vol（所以调鲸鱼的总音量仍然管用）。
  riceSoundVol: 5,
  // 碗被打翻、扣到地上那一声（**只有"抓到她偷吃"才会响**，不是每顿都有）。
  // 音效这条路上它是第二个源，但**不另开一套开关和音量** ——
  // 上面那两个就是"她吃饭时的声音"，这一声属于同一件事；
  // 真嫌它比每口那声吵，就换一个文件（面板里能选，和吃饭音效一样）。
  dropSound: '/dsh-rice/drop-bowl.webm',
  // —— 「碗飞到头上去」——
  // 两条路都能到那儿：
  //   ① **点她抓到**（打断她吃饭）时掷一次骰子，中了就直接扣头顶，没中就照旧倒扣在旁边；
  //   ② **吃饭时输入彩蛋炸弹** —— 必定扣头顶。
  // ① 的意义是"不知道彩蛋的人也能撞见"，所以它得**小**：撞见才算惊喜，常见就成了日常。
  // `0` = 关掉这条路（只留彩蛋那条必定触发）。
  // ⚠️ **它只在配置文件里**：面板上故意没有滑杆 —— 这是个一次性定下来的手感，
  //    摆一条滑杆等于天天问用户"你要不要更常见一点"，而答案基本是"不要"。
  //    真要改就改 ~/.dsh/.dsh-rice-config.json 里的这个键（或 POST /dsh-rice/config）。
  headChancePct: 70,
  // —— 「扣在头顶」的落点 ——
  // 坐标和 bowlLeft/bowlTop **同一套**：x 是碗的**中心**、y 是碗的**上边**（都相对 .dshwv-body）。
  // ⚠️ 它按角色存（在 LAYOUT_KEYS 里）—— 每个角色的头顶位置不同，
  //    而且立绘只占容器**右下 59.45%** 那个方块，所以这几个数不能凭感觉写。
  // 面板「位置微调」里选「头顶」就能调（**选中时碗会停在落点上给你看**，挪一下动一下）。
  // ⚠️ 这组数是**调出来的**：当初按比例估的 43/23 实测差了近 30 个点 —— 这类落点别猜。
  headLeft: 75,
  headTop: 51,
  // —— 按角色各存一份版面覆盖值 ——
  // 键是角色 id（默认角色就是 'default'），值是上面那些版面键的子集。
  // 0.3.0 起鲸鱼支持多角色，而**不同角色的头部角度可能完全不同** ——
  // 换一个角色，碗和米粒就得重调一遍。
  // 客户端会从鲸鱼图片的 src 里读出当前角色并上报，所以 POST 进来的版面值
  // 会自动落到这里 —— **用户不需要知道"角色"这个概念：在哪个角色上调，就存给哪个角色。**
  perRole: {},
}

// 哪些键算"版面"：它们**按角色各存一份**（换个角色头部角度可能完全不同）。
// 其余键 —— 节奏、阈值、停留时长、**最小像素下限**、开关 —— 与角色无关，保持全局。
//
// 判别标准：**这个值取决于"她长什么样"吗？**
//   位置、大小、旋转、米粒图、碗和饭的图 → 取决于立绘/画风 → 按角色存
//   时间、阈值、像素下限、音效          → 只取决于渲染/听觉 → 全局
//
// ⚠️ **这张表必须和 lib/client.js 里的 LAYOUT_KEYS 一字不差。**
//    两边不一致时的症状非常隐蔽：客户端以为某个键是按角色存的（于是从 perRole 里读），
//    宿主却把它当全局写 —— 结果就是"在自定义角色上换个碗的图，默认角色的碗也跟着变了"。
const LAYOUT_KEYS = [
  'bowlLeft', 'bowlTop', 'bowlWidth', 'bowlHeight',
  // 碗那三张图和 grainImage 是同一类东西：它们取决于"这个角色配什么画风"，
  // 所以换个角色可以换一整套碗。
  'bowlImage', 'foodPeakImage', 'foodValleyImage',
  'grainLeft', 'grainTop', 'grainWidth', 'grainImage', 'grainRotate',
  'chewOriginX', 'chewOriginY',
  // "被炸到头上"的落点：**一定要按角色存** ——
  // 每个角色的头在哪儿、多高都不一样，换个角色这组值就必然要重调。
  'headLeft', 'headTop',
]

// DSH 主目录：优先读环境变量 DSH_HOME，其次才退回 ~/.dsh。
// 【桌宠移植补丁 1/2】原版硬编码 os.homedir()/.dsh —— 在桌宠里会把配置写到
// 用户真实的 DSH 目录去。桌宠启动时会先设好 DSH_HOME 指向自己的数据目录，
// 这里改成读它；未设置时行为与原来完全一致。
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_FILE = path.join(DSH_HOME, '.dsh-rice-state.json')
const CONFIG_FILE = path.join(DSH_HOME, '.dsh-rice-config.json')
const PLUGIN_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_FILE = path.join(PLUGIN_ROOT, 'lib', 'client.js')
// 素材目录 <插件根>/art/。
// **哪些文件发布、哪些不发布，是逐个决定的**，不是"整个目录一起走"：
//   rice.png      —— 鲸鱼作者画的，已获授权，随包发布
//   drop-bowl.webm —— 本插件作者**自己录的**，没有别人的权利在里面，随包发布
//   其余（egg-1/egg-2/arrow-tick/nang）——《绝地潜兵 2》的素材，只在本地/群里玩，不进包
// 所以 package.json 的 files 里逐个列出来，不是写 `art`。
//
// ⚠️ 彩蛋那两个图标**故意用中性文件名**（egg-1 / egg-2）：
//    原来叫 500kg.png / 380mm.png —— 而那就是两件武器的口径，
//    等于把"别问是什么"的答案写在了文件名里。
const ART_DIR = path.join(PLUGIN_ROOT, 'assets')

// 歌单目录 <插件根>/songs/。
// **它不进 npm 包**（package.json 的 files 里没有它）—— 和 art/ 里那几张游戏素材同一个道理：
//   群友版随包带一首默认的，npm 版是空的，用户自己往里丢。
// 用户要做的只有一件事：**把歌丢进去**。
//   不用改文件名（文件名就是歌名）、不用填路径、不用重启（每次请求都重新扫目录）。
// 一首就唱那首，多首就随机一首。
const APP_DIR = process.env.DSH_PET_DIR || path.dirname(process.execPath)
const SONGS_DIR = path.join(APP_DIR, 'vendor', 'rice', 'songs')
// 余额警报音**另起一个目录**（见 DEFAULT_CONFIG 里的 alarmSong）：
// 于是"她唱的歌"和"余额警报"是两份列表，永远不可能互相混进去 ——
// 往 alarm/ 里丢一首，它不会出现在「唱歌」的随机列表里；反之亦然。
const ALARM_DIR = path.join(PLUGIN_ROOT, 'alarm')
// 认得出是音频的扩展名。**只用来决定"这个文件要不要进歌单"** ——
// Content-Type 仍然是按文件头嗅探的（见 artType），扩展名会说谎。
const SONG_EXT = new Set([
  '.webm', '.weba', '.mp3', '.m4a', '.mp4', '.ogg', '.oga', '.opus', '.wav', '.flac', '.aac',
])
// 一次 Range 最多给多少 —— 见下面放歌那条路由。
const SONG_CHUNK_MAX = 4 * 1024 * 1024

// 按**默认值的类型**来收：数字键收数字，字符串键收字符串。
// 早先这里写死了"只认 number"，于是 grainImage 这种字符串键既读不进来也写不出去 ——
// 表现就是"配置文件里改了没用、POST 也被静默忽略"。读和写两处都走这个函数。
function applyRaw(out, raw) {
  if (!raw || typeof raw !== 'object') return out
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    const v = raw[k]
    if (v === undefined || v === null) continue
    if (typeof DEFAULT_CONFIG[k] === 'number') {
      if (typeof v === 'number' && isFinite(v)) out[k] = v
    } else if (typeof DEFAULT_CONFIG[k] === 'string') {
      if (typeof v === 'string') out[k] = v
    } else if (typeof DEFAULT_CONFIG[k] === 'boolean') {
      // 开关类。**漏掉这一支的后果，和当初 grainImage 那次一模一样** ——
      // 配置文件里改了没用、POST 也被静默忽略，因为类型根本没收。
      if (typeof v === 'boolean') out[k] = v
    }
  }
  // perRole 是"每个角色一份覆盖值"的对象 —— 既不是数字也不是字符串，单独收。
  // 每份内部只保留与默认值同类型的键；坏数据一律丢掉，绝不写进配置。
  if (raw.perRole && typeof raw.perRole === 'object') {
    const pr = {}
    for (const rid of Object.keys(raw.perRole)) {
      const one = raw.perRole[rid]
      if (!one || typeof one !== 'object') continue
      const clean = {}
      for (const k of Object.keys(DEFAULT_CONFIG)) {
        if (k === 'perRole') continue
        const v = one[k]
        if (v === undefined || v === null) continue
        if (typeof DEFAULT_CONFIG[k] === 'number' && typeof v === 'number' && isFinite(v)) clean[k] = v
        else if (typeof DEFAULT_CONFIG[k] === 'string' && typeof v === 'string') clean[k] = v
        else if (typeof DEFAULT_CONFIG[k] === 'boolean' && typeof v === 'boolean') clean[k] = v
      }
      if (Object.keys(clean).length) pr[rid] = clean
    }
    out.perRole = pr
  }
  return out
}

// 读配置：缺失或字段非法都退回默认值，永远不因为一个坏字段就不工作。
function loadConfig() {
  const out = Object.assign({}, DEFAULT_CONFIG)
  try {
    applyRaw(out, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')))
  } catch (err) {}
  // 兜底：不合理的值会把界面弄坏（比如 0 口、负数间隔）
  if (!(out.bitesMax >= 1)) out.bitesMax = 1
  if (out.bitesMax > 8) out.bitesMax = 8
  if (!(out.pollMs >= 500)) out.pollMs = 500
  if (!(out.stepMs >= 80)) out.stepMs = 80
  if (!(out.minExternal >= 0)) out.minExternal = DEFAULT_CONFIG.minExternal
  // 0 是合法值（= 关闭下限），所以这里只挡负数
  if (!(out.grainMinPx >= 0)) out.grainMinPx = DEFAULT_CONFIG.grainMinPx
  if (!(out.grainMs >= 100)) out.grainMs = DEFAULT_CONFIG.grainMs
  // 概率夹在 0~100。0 是合法值（= 永远不掷中、一直攒着）—— 有点钻牛角尖，
  // 但"0 就是不吃"比"悄悄改成 5"更好懂。
  if (!(out.stealChancePct >= 0)) out.stealChancePct = DEFAULT_CONFIG.stealChancePct
  if (out.stealChancePct > 100) out.stealChancePct = 100
  if (typeof out.randomSteal !== 'boolean') out.randomSteal = DEFAULT_CONFIG.randomSteal
  // 飞头顶的概率也夹在 0~100。**0 是合法值**（= 只有彩蛋炸弹能把它炸到头上）。
  if (!(out.headChancePct >= 0)) out.headChancePct = DEFAULT_CONFIG.headChancePct
  if (out.headChancePct > 100) out.headChancePct = 100
  // 间隔夹在 0~60 分钟。0 是合法值（= 每轮都唱）。
  if (!(out.autoSingMin >= 0)) out.autoSingMin = DEFAULT_CONFIG.autoSingMin
  if (out.autoSingMin > 60) out.autoSingMin = 60
  if (typeof out.autoSingOn !== 'boolean') out.autoSingOn = DEFAULT_CONFIG.autoSingOn
  // 余额警报那两项：一个开关、一个文件名。
  // 文件名要做类型兜底 —— 配置文件里被手改成数字/null 都不该让功能崩掉，
  // 大不了就是"没设警报音"（什么都不放），和默认值一样。
  if (typeof out.alarmOn !== 'boolean') out.alarmOn = DEFAULT_CONFIG.alarmOn
  if (typeof out.alarmSong !== 'string') out.alarmSong = DEFAULT_CONFIG.alarmSong
  return out
}

function saveConfig(patch) {
  const next = Object.assign(loadConfig(), patch)
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8')
  } catch (err) {}
  return loadConfig()
}

function today() {
  const d = new Date()
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
}

// 池子里的钱统一留 4 位小数。
// 不加这一步的话，反复累加会飘出 `0.8999999999999999` 这种数 ——
// 而它会被**写进 state 文件**、还会当成"这一顿吃多少钱"发出去。
// 钱本来就是两位小数，4 位足够，多出来的全是浮点噪声。
function round4(n) {
  return Math.round(n * 1e4) / 1e4
}

function blankState() {
  return {
    riceOn: true,
    date: today(),
    usageBase: null,   // 上一轮看到的 todayUsage
    turnCredit: 0,     // DSH 自己花掉、但还没在 todayUsage 里浮出来的钱
    pool: 0,           // 攒着还没到起吃线的外部消耗
    lastSeq: 0,        // 已结算到第几轮
    totalBites: 0,
    totalAmount: 0,
    // 待吃队列：给"按需触发一次吃"用的（录演示 GIF 会反复用到）。
    // 由 POST /dsh-rice/feed 塞进来，下一次客户端轮询取走并清空。
    pending: [],
    // 客户端最近一次上报的"当前角色" —— 用来决定版面改动该存给谁。
    lastRole: '',
    // 鲸鱼那边"今天是哪一天"（balance.json 的 accounting.day，北京日历日）。
    // 跨天判定**问它**，不靠"用量数值掉了"去猜 —— 详见 observe() 里那段。
    usageDay: '',
  }
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    const s = Object.assign(blankState(), raw)
    // 跨天：基准和信誉作废（今天的计数器是新的），但**已经攒下的那碗不能扔** ——
    // 那是她昨天该吃还没吃的，得留在池子里等她吃。
    // （旧补丁在这里把 pool 也清了，于是"网页关着跨过午夜"那一整段会凭空消失。）
    if (s.date !== today()) {
      s.date = today()
      s.usageBase = null
      s.turnCredit = 0
    }
    return s
  } catch (err) {
    return blankState()
  }
}

function saveState(s) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8')
  } catch (err) {}
}

// 分档：一口 / 两口 / 三口。阈值走配置，所以别人可以调成自己喜欢的节奏。
function bitesFor(amount, cfg) {
  const a = Number(amount)
  if (!isFinite(a) || a <= 0) return 0
  const c = cfg || DEFAULT_CONFIG
  return a < c.tier1Below ? 1 : (a < c.tier2Below ? 2 : c.bitesMax)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 8192) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// ⚠️ **这里有意没有对象级 `inject: ['webServer','connection']`。**
// 对象级 inject 会把整个 apply() 推迟到那两个服务就绪之后 —— 而在**桌面端**，
// 页面注入表是**宿主启动时收集一次**的，订阅一旦晚于那次收集，
// 我们那条"把 rice.js 挂进页面"的行就**永远进不了表**：
// 症状正是"宿主半区活着（路由都在）、客户端半区从未被请求"。
// 所以 apply() 立刻执行、**第一件事就注册注入行**（它不依赖任何服务），
// 其余逻辑放进 `root.inject([...], cb)` 局部等待 —— 语义不变，但注册不再被推迟。
// （这套是照着 dsh-whale-widget 踩完 issue #152/#154 之后的写法抄的。）

// —— 桌面端（Electron）的结构化注入行 ——
// 桌面壳的 index.html 是**从安装包静态 dist 直读**的（`dsh-app://app/`），
// 永远不经过宿主的 `renderIndex()` ⇒ **`tapIndex` 在桌面端不生效**（它只在浏览器形态有效）。
// 桌面端唯一能生效的通道是 `webserver/index-inject` 推的行，经 IPC 交给页面侧逐行应用。
// 两条硬约束（鲸鱼用两次线上故障换来的）：
//   ① 用 **kind:'script'（内联行）**，不要 `script-src`：页面侧对 script-src 是
//      "加载失败即 reject 整个 boot" —— 我们的路由一旦不可用，**整个应用起不来**。
//      内联行由我们自己 createElement + 吞掉 onerror ⇒ 路由在就加载，不在就静默失败，
//      宿主永远不会因为我们起不来。
//   ② 行必须**尽早进表**（见上面那段：桌面端只收集一次）。
const CLIENT_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  'var s=document.createElement("script");s.src="/dsh-rice/rice.js";' +
  's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

// apply：**同步注册注入行** → 再把主体交给服务等待。
function apply(root) {
  const rowDisposers = []
  root.effect(() => () => { for (const d of rowDisposers) { try { d() } catch (err) {} } })
  // ① 结构化注入行（桌面端唯一通道；浏览器形态另有下面的 tapIndex，两条并存、各自去重）
  rowDisposers.push(root.on('webserver/index-inject', (table) => {
    try {
      if (!Array.isArray(table)) return
      for (const row of table) {
        if (!row) continue
        // 已经有人推过同一件事（旧版本推过 script-src、或者我们自己推过）→ 不重复
        if (row.kind === 'script-src' && row.src === '/dsh-rice/rice.js') return
        if (row.kind === 'script' && typeof row.text === 'string'
          && row.text.indexOf('/dsh-rice/rice.js') >= 0) return
      }
      table.push({ kind: 'script', placement: 'body', text: CLIENT_ROW_TEXT })
    } catch (err) {}
  }))
  // ② 其余逻辑：等齐两个服务再跑
  root.inject(['webServer', 'connection'], (ctx) => applyWithServices(ctx))
}

function applyWithServices(ctx) {
  const disposers = []
  const state = loadState()
  let cfg = loadConfig()

  // —— 浏览器信任栅栏 ——
  // `connection` 服务提供 `requestRejection(req)`，它做两层判定：
  //   ① Host / Origin 不可信（DNS 重绑定）→ 403
  //   ② 请求没带浏览器鉴权（不是从这个页面发出来的）→ 401
  //
  // ⚠️ **不套这道栅栏，接口就是"任意网页都能读写"的：**
  //   · 跨站**写**：`Content-Type: text/plain` 的 POST 属于"简单请求"，**不触发预检**，
  //     于是任何一个网页都能 POST 到 /dsh-rice/config 改你的设置；
  //   · DNS 重绑定那条路能**读**走 /dsh-rice/config —— 而里面存着用户换过的图和音频
  //     （data URI 原样存在配置里），以及 songs.json 里的歌单。
  //
  // 这条是照着鲸鱼 0.3.3 的做法补的（它对应上游 issue #92，所有 /dsh-whale/* 路由都套了）。
  // 官方插件在自定义路由里也都会先调一次。
  //
  // ⚠️ 栅栏不可用时**放行**（fail-open）并且只 warn 一次：宁可少一层防护，
  //    也不能让"碗不出现"变成"整个插件不工作"。
  function rejected(req, res) {
    try {
      const conn = ctx.get('connection') || ctx.connection
      if (!conn || typeof conn.requestRejection !== 'function') {
        if (!rejected.warned) {
          rejected.warned = true
          try { console.warn('[dsh-rice] 信任栅栏不可用：connection 服务缺失，自定义路由将放行处理') } catch (err) {}
        }
        return false
      }
      const code = conn.requestRejection(req)
      if (code === undefined || code === null || code === false) return false
      res.statusCode = typeof code === 'number' ? code : 403
      res.end()
      return true
    } catch (err) { return false }
  }
  // **统一注册入口**：所有路由都必须走它，一个都不能漏。
  // （不这么收口的话，以后加一条路由就会忘一次 —— 而"忘了"的表现是接口静默敞着，看不出来。）
  function registerRoute(route) {
    const inner = route && route.handler
    return ctx.webServer.register(Object.assign({}, route, {
      handler: async (req, res) => {
        if (rejected(req, res)) return
        return inner(req, res)
      },
    }))
  }

  // —— 开工时唱歌 ——
  // 宿主这半边只负责"记下那一刻"：音频只能由页面自己放，所以这里不推、只留一个时间戳，
  // 页面每次轮询 observe 时把它捎回去（响应里的 `beat`）。
  //
  // 事件来自 DSH 自己的会话事件流：`ctx.on('session/event', (session, event) => …)`，
  // `event.type === 'turn/start'` 就是"她刚开始处理这一轮"。鲸鱼也是靠同一条流算每轮消耗的。
  //
  // ⚠️ 两点要有数：
  //   ① 那条流是**所有会话**的，子代理/workflow 也会各发一次 turn/start ——
  //      所以会连着一串。**靠最小间隔把它们压成一次**就是想要的效果（"开工了"只唱一次）。
  //   ② 节流用的是"**至少**隔 N 分钟"，不是"每 N 分钟唱一次"：
  //      没隔够就不唱，而不是攒着到点补一次。
  let autoSingAt = 0
  disposers.push(ctx.on('session/event', (session, event) => {
    try {
      if (!event || event.type !== 'turn/start') return
      if (!cfg.autoSingOn) return
      const now = Date.now()
      const gap = Math.max(0, Number(cfg.autoSingMin) || 0) * 60000
      if (autoSingAt && now - autoSingAt < gap) return
      autoSingAt = now
    } catch (err) {}
  }))

  // 收到一次观测，决定她该吃几口。
  // obs = { seq, amount, todayUsage, usageDay, roleId }
  function observe(obs) {
    // 先把"待吃队列"里排着的取走并清空 —— 那是 POST /dsh-rice/feed 塞进来的按需触发。
    // 之所以要排队而不是直接回应，是因为动画只有页面自己发起的轮询才看得到。
    const eats = state.pending && state.pending.length ? state.pending.splice(0) : []
    const seq = Number(obs.seq) || 0
    // 记下客户端看到的角色 —— 版面改动要按角色存，靠的就是它。
    if (typeof obs.roleId === 'string' && obs.roleId && obs.roleId !== state.lastRole) {
      state.lastRole = obs.roleId
    }
    const amount = Number(obs.amount)

    // —— ① DSH 自己这一轮 ——
    // 注意：无论开关开没开都要记信誉。turnCredit 反映的是「DSH 花了多少」这个事实，
    // 它必须始终准确，否则开关一开一关就会把 DSH 自己的钱误判成外部消耗。
    // turnSettled = 这一轮是"新结算的一轮"，也是**唯一允许掷骰子的时刻**（见下面 ③）。
    let turnSettled = false
    if (seq && seq !== state.lastSeq) {
      state.lastSeq = seq
      if (isFinite(amount) && amount > 0) {
        state.turnCredit += amount
        turnSettled = true
        if (state.riceOn) {
          if (!cfg.randomSteal) eats.push(amount)     // 老规矩：这一轮当场吃
          else state.pool = round4(state.pool + amount)   // 随机模式：先进池子，吃不吃交给 ③
        }
      }
    }

    // —— ② 账号级今日用量的增量 ——
    // todayUsage 已经把 DSH 自己的消耗算在里面了，而每一轮我们已经吃过一次，
    // 所以必须先把那份扣掉（turnCredit），否则同一笔钱会被吃两次。
    // 只认真正的数字：Number(null) === 0 会把「没有这个字段」误判成「用量归零」，
    // 那会触发一次跨天归零、把攒着的量清掉。（用探针 POST 假数据时踩到过。）

    // ——— 跨天：**问鲸鱼是哪一天，不靠"数值掉了"去猜** ———
    // 0.3.4 起 balance.json 里给了 `accounting.day`（北京日历日），客户端把它捎过来。
    // 为什么必须问：从 0.3.4 起 todayUsage 走的是**本地账本**，而账本有三种情况会往下掉 ——
    //   ① 用户在鲸鱼那边做**人工余额校正**（reconcileBalance 重算当天金额）
    //   ② **老账迁移**（升级后开一个新的观测窗口，当天金额可能掉一大截）
    //   ③ 账本里没有当天行时退回 `legacy` / `events`（本地估算），数值换口径
    // 这三种**都不是跨天**。而旧代码只看"掉得够不够多（≥ rolloverDrop，默认 1 元）"，
    // 于是它们会被误判成跨天、把已经攒着的那碗偷偷清掉 ——
    // 随机偷吃默认开着之后，那碗就攒在 pool 里，撞上的概率高得多。
    //
    // 跨天的定义就是**日期变了**，所以有日期就直接用；没有（`accounting` 可能是 null）
    // 才退回旧的"掉得够多"判据。
    const obsDay = (typeof obs.usageDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(obs.usageDay)) ? obs.usageDay : ''
    const dayChanged = !!(obsDay && state.usageDay && obsDay !== state.usageDay)
    if (obsDay) state.usageDay = obsDay
    if (dayChanged) {
      // ⚠️ **跨天只作废"信誉"，不清 pool。**
      //    理由和 loadState() 里那段一样：已经攒下的那碗是她昨天该吃还没吃的，得留着。
      //    （旧补丁在跨天时把池子一起清了，于是"网页开着跨过午夜"那一整段会凭空消失 ——
      //      这里以前也犯同样的错，只是没人把它和 loadState 那段对着看。）
      state.turnCredit = 0
    }

    const n = typeof obs.todayUsage === 'number' ? obs.todayUsage : NaN
    if (isFinite(n) && n >= 0) {
      if (state.usageBase === null) {
        state.usageBase = n
      } else if (n < state.usageBase) {
        // 数值掉下来了：**重新对齐基准**（这一步无论如何都要做，
        // 否则下一轮的增量会是个巨大的负数）。
        const drop = state.usageBase - n
        state.usageBase = n
        // 没有日期可用时才退回旧判据 —— 而且同样**不清 pool**（见上面那段）。
        if (!obsDay && drop >= cfg.rolloverDrop) state.turnCredit = 0
      } else {
        const delta = n - state.usageBase
        state.usageBase = n
        const absorbed = Math.min(state.turnCredit, delta)
        state.turnCredit -= absorbed
        const external = delta - absorbed
        if (external > 0 && state.riceOn) {
          state.pool = round4(state.pool + external)
          // 随机模式下**这里不触发** —— 所有"吃"的时机都收归 ③ 那道闸门。
          // 否则外部用量会把 ③ 刚刚故意没吃的那一份顺手吃掉，攒不住。
          if (!cfg.randomSteal && state.pool >= cfg.minExternal) {
            eats.push(state.pool)
            state.pool = 0
          }
        }
      }
    }

    // —— ③ "该不该吃"的闸门（只有随机模式用得上）——
    // ⚠️ **掷骰子的时机必须是"结算一轮"，不能是"每次轮询"。**
    //    轮询 3 秒一次：池子一旦越线，若每轮询都掷，三次之内必中 ——
    //    那就等于没随机，只是把吃饭往后拖了 3~9 秒。
    //    绑在"结算一轮"上，才是"这一轮偷不偷吃"。
    if (cfg.randomSteal && turnSettled && state.riceOn && state.pool >= cfg.minExternal) {
      if (Math.random() * 100 < cfg.stealChancePct) {
        eats.push(state.pool)
        state.pool = 0
      }
      // 没掷中：**留在池子里**，下次掷中时一起吃。
      // 金额变大之后 bitesFor 自然给更多口 —— "累积到下次一起吃"就是这么实现的。
    }

    for (const a of eats) {
      state.totalBites += bitesFor(a, cfg)
      state.totalAmount += a
    }
    saveState(state)
    return {
      eat: eats,
      pool: state.pool,
      riceOn: state.riceOn,
      totalBites: state.totalBites,
      totalAmount: state.totalAmount,
      // 顺带把配置捎回去：客户端每次轮询都能拿到最新阈值与节奏，
      // 所以改完配置不用刷新页面，下一轮就生效。
      config: cfg,
      // —— 开工时唱歌的信标 ——
      // 「最近一次开工是什么时候」。**搭在这趟车上一起回去，不单开一条路由**：
      // 页面本来每轮都要 POST 一次 observe，捎一个数字是 0 次额外请求；
      // 而单独开一条 /dsh-rice/beat 让页面每 500ms 问一次，就是**每分钟多 120 次请求**
      // （实测每次约 0.26ms，也就是常年 0.05% 的一个核 + 页面每秒两次 fetch/解析）。
      // 代价只有一个：最多晚一个轮询周期（默认 3 秒）才唱 —— 而"你发完消息到 DSH 真正开工"
      // 本来就不止一秒，这点延迟感觉不出来。
      // 客户端拿它和自己的上一次比：变了、而且够新鲜，才唱（见 maybeAutoSing）。
      beat: autoSingAt,
    }
  }

  // （这里曾经有一条 `GET /dsh-rice/beat`。现在信标搭 observe 的响应回去 ——
  //   见上面 observe 返回里那个 `beat`，理由也写在那儿。）

  // —— 客户端上报观测 ——
  disposers.push(registerRoute({
    kind: 'exact',
    path: '/dsh-rice/observe',
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        const out = observe(JSON.parse(body || '{}'))
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(out))
      } catch (err) {
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
      }
    },
  }))

  // —— 开关与可调参数 ——
  // GET  返回当前生效的开关与参数（客户端靠它拿 tier / pollMs / stepMs）
  // POST 接受 { riceOn } 和任意参数覆盖，写进 ~/.dsh/.dsh-rice-config.json
  disposers.push(registerRoute({
    kind: 'exact',
    path: '/dsh-rice/config',
    handler: async (req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: true, riceOn: state.riceOn, config: cfg }))
        return
      }
      try {
        const body = await readBody(req)
        const parsed = JSON.parse(body || '{}')
        if (typeof parsed.riceOn === 'boolean') {
          state.riceOn = parsed.riceOn
          saveState(state)
        }
        // 用与读取同一套类型规则：数字键收数字，字符串键收字符串
        const patch = applyRaw({}, parsed)
        let savedTo = 'default'
        if (Object.keys(patch).length) {
          // —— 版面的改动按角色存 ——
          // 当前在非默认角色上时，版面类键写进 perRole[该角色]；其余键仍是全局的。
          // 于是用户**不需要知道"角色"这个概念**：在哪个角色上调，就存给哪个角色。
          const layout = {}, other = {}
          for (const k of Object.keys(patch)) {
            (LAYOUT_KEYS.indexOf(k) >= 0 ? layout : other)[k] = patch[k]
          }
          const rid = state.lastRole
          if (rid && rid !== 'default' && Object.keys(layout).length) {
            const pr = Object.assign({}, cfg.perRole)
            pr[rid] = Object.assign({}, pr[rid] || {}, layout)
            cfg = saveConfig(Object.assign(other, { perRole: pr }))
            savedTo = rid
          } else {
            cfg = saveConfig(patch)
          }
        }
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: true, riceOn: state.riceOn, savedTo: savedTo, config: cfg }))
      } catch (err) {
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
      }
    },
  }))

  // —— 按需喂一口（录演示 GIF 用）——
  // 因为 eat 是放在轮询响应里还给页面的，从外面 POST observe 是看不到动画的；
  // 所以这里只"排队"，等页面下一次轮询来取（最多 pollMs，默认 3 秒）。
  //   {"bites": 3}    直接指定口数
  //   {"amount": 2.5} 按分档换算成口数
  disposers.push(registerRoute({
    kind: 'exact',
    path: '/dsh-rice/feed',
    handler: async (req, res) => {
      try {
        const body = await readBody(req)
        const parsed = JSON.parse(body || '{}')
        let n = 0
        if (typeof parsed.bites === 'number' && isFinite(parsed.bites)) n = Math.round(parsed.bites)
        else if (typeof parsed.amount === 'number' && isFinite(parsed.amount)) n = bitesFor(parsed.amount, cfg)
        // **必须显式给出 bites 或 amount。**
        // 早先这里是"没给就默认 1 口"，结果一个手滑的空 POST 也会喂她一口 ——
        // 而"她吃了"应该是被明确要求的事，不该由缺省值代劳。
        if (!(n >= 1)) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: 'need {"bites":N} or {"amount":X}' }))
          return
        }
        if (n > cfg.bitesMax) n = cfg.bitesMax
        // 用一个能落进对应档位的金额来表示"吃 n 口" —— 客户端按金额自己算口数
        const amount = n <= 1
          ? cfg.tier1Below / 2
          : (n === 2 ? (cfg.tier1Below + cfg.tier2Below) / 2 : cfg.tier2Below * 1.25)
        state.pending = (state.pending || []).concat([amount])
        saveState(state)
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: true, queued: state.pending.length, bites: n, amount: amount }))
      } catch (err) {
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
      }
    },
  }))

  // —— art/ 目录里的图（可选）——
  // 每次请求都从磁盘读，所以换图只要刷新页面，不用重启。
  //
  // ⚠️ **用白名单，不做通配路由** —— 通配会把 `../` 之类的路径放进来。
  // 想加新素材就在下面加一行，显式写清楚哪个 URL 对应哪个文件。
  //
  // ⚠️ **这些文件发不发布，是各自决定的，不是"整个 art/ 目录"决定的：**
  //   art/rice.png       已获鲸鱼作者授权，随包发布（在 files 白名单里）
  //   art/drop-bowl.webm 本插件作者**自己录的**，随包发布（也在 files 里）
  //   art/egg-1.png、art/egg-2.png、art/arrow-tick.weba、art/nang.weba
  //     都是《绝地潜兵 2》的素材 —— **只在本地/群里玩，不进包**
  // 所以 package.json 的 files 里逐个列出来，不是写 `art`。
  // （彩蛋图标用中性名是有意的：原名是 500kg / 380mm，那是两件武器的口径，
  //   写在文件名里就等于把"自己找"的答案给了出去。）
  const ART_ROUTES = {
    '/dsh-rice/rice.png': 'rice.png',
    '/dsh-rice/egg-1.png': 'egg-1.png',
    '/dsh-rice/egg-2.png': 'egg-2.png',
    // 方向键的"滴"声。**它也是游戏素材，所以同样不进 npm 包。**
    '/dsh-rice/arrow-tick.weba': 'arrow-tick.weba',
    // 碗 + 波谷的饭 + 波峰的饭（三张 196×196，预先对齐）
    '/dsh-rice/bowl.png': 'bowl.png',
    '/dsh-rice/food-valley.png': 'food-valley.png',
    '/dsh-rice/food-peak.png': 'food-peak.png',
    // 吃饭的音效：只在最后放下碗时响一次，音量随口数变大。
    // 这一份是实机截取的游戏原声 —— **同样不进 npm 包**。
    '/dsh-rice/nang.weba': 'nang.weba',
    // 碗被打翻、**扣到地上**那一声（只有"抓到她偷吃"才会响）。
    // 作者自己录的（约 2.3 秒：一声"咣"加滚动的余音），**和 rice.png 一样随包发布** ——
    // 所以 npm 版也听得到这一声（而每口那声 nang.weba 是游戏素材，npm 版没有）。
    '/dsh-rice/drop-bowl.webm': 'drop-bowl.webm',
    // 「唱歌」按钮的图标（一只叼着音符的鲸鱼）。群友版随包带，npm 版不带。
    '/dsh-rice/song.png': 'song.png',
  }
  // ⚠️ **Content-Type 按文件头嗅探，不按扩展名。**
  // 因为实际发生过：一张素材曾被读图工具报成 WebP（那是转码假象）。
  // 按扩展名标类型的话，浏览器多半会自己嗅探、看着没事 ——
  // 但那是个定时炸弹，而且真出问题时排查起来非常费解。
  //
  // 这里认的格式比 art/ 实际用到的多 —— 因为 **songs/ 里放什么是用户决定的**
  // （mp3、m4a、wav、flac 都可能），而错标的类型在那条路上是必然会被踩到的。
  function artType(bytes) {
    const b = bytes
    if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
    // RIFF 是个大盒子：WAVE 是音频，WEBP 是图，靠第 8~11 字节区分。
    if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) {
      if (b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45) return 'audio/wav'
      if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
      return 'application/octet-stream'
    }
    // WebM / MKA —— EBML 头是 1A 45 DF A3。
    // ⚠️ 这个容器**本身不区分音视频**，所以不能只看扩展名 ——
    // 一首纯音频的 `.webm` 会被标成 video/webm，那是错的（歌就是这种）。
    // 正确的依据在内容里：**轨道信息就在文件开头**（Segment → Tracks），
    // 扫前 64KB 看有没有视频编码器就够，不用解析 EBML。
    if (b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
      const head = b.subarray(0, 65536).toString('latin1')
      return /V_VP8|V_VP9|V_AV1|V_MPEG4\/ISO\/AVC|V_MPEGH|V_THEORA/.test(head) ? 'video/webm' : 'audio/webm'
    }
    if (b.length > 4 && b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'audio/ogg'
    // MP3：有 ID3 标签头的，或者直接就是帧同步（11 个 1）。
    if (b.length > 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'audio/mpeg'
    // ⚠️ 裸 AAC（ADTS）也以 0xFF 开头，**必须先认它**，否则会被下面那条 MP3 规则吃掉，
    //    标成 audio/mpeg —— 那样浏览器多半就不出声了。
    //    区分点：ADTS 的第 2 字节是 1111 0x0x（layer 固定 00），MP3 的 layer 不会是 00。
    if (b.length > 2 && b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return 'audio/aac'
    if (b.length > 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'audio/mpeg'
    if (b.length > 4 && b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43) return 'audio/flac'
    // MP4 / M4A：'ftyp' 在第 4~7 字节。
    if (b.length > 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'audio/mp4'
    if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
    if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
    return 'application/octet-stream'
  }
  for (const [route, file] of Object.entries(ART_ROUTES)) {
    disposers.push(registerRoute({
      kind: 'exact',
      path: route,
      handler: (req, res) => {
        try {
          const bytes = fs.readFileSync(path.join(ART_DIR, file))
          res.writeHead(200, {
            'Content-Type': artType(bytes, file),
            'Cache-Control': 'no-store',
            'Content-Length': String(bytes.length),
          })
          res.end(bytes)
        } catch (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('art unavailable: ' + file)
        }
      },
    }))
  }

  // —— 唱歌 · 余额警报音 ——
  // 两个目录不存在就建出来：**用户得先有个地方可以丢歌**。
  // （npm 版的包里没有 songs/ 也没有 alarm/，所以这一步不是可选的。）
  try { fs.mkdirSync(SONGS_DIR, { recursive: true }) } catch (err) {}
  try { fs.mkdirSync(ALARM_DIR, { recursive: true }) } catch (err) {}

  // **每次都重新扫目录**，不在启动时做快照 ——
  // 于是"丢一首进去，刷新页面就能唱"，不用重启 dsh web。
  // 返回的是文件名数组（不是路径）—— 它是后面那条路由的白名单。
  // 两个目录用同一段代码扫：认的扩展名、过滤规则、排序都一致（见 SONG_EXT）。
  function listAudio(dir) {
    let names = []
    try { names = fs.readdirSync(dir) } catch (err) { return [] }
    const out = []
    for (const n of names) {
      if (n.startsWith('.')) continue                       // 隐藏文件（含 macOS 的 ._ 副本）
      if (!SONG_EXT.has(path.extname(n).toLowerCase())) continue
      let st
      try { st = fs.statSync(path.join(dir, n)) } catch (err) { continue }
      if (!st.isFile() || st.size === 0) continue
      out.push(n)
    }
    // 排一下序，让"歌单"每次看到的顺序是稳定的；挑哪首由客户端随机决定。
    out.sort((a, b) => a.localeCompare(b, 'zh'))
    return out
  }

  // 频谱里的歌可能是几十 MB 的无损整轨，所以**只读需要的那一段**，
  // 不为了看一眼文件头、或者发一个 Range 就把整首歌同步读进内存。
  function readHead(file, n) {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(Math.max(0, n))
      const got = fs.readSync(fd, buf, 0, buf.length, 0)
      return got === buf.length ? buf : buf.subarray(0, got)
    } finally {
      try { fs.closeSync(fd) } catch (err) {}
    }
  }
  function readRange(file, start, end) {
    const len = end - start + 1
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(len)
      const got = fs.readSync(fd, buf, 0, len, start)
      return got === len ? buf : buf.subarray(0, got)
    } finally {
      try { fs.closeSync(fd) } catch (err) {}
    }
  }

  // GET /dsh-rice/songs.json → { ok, songs:[{name,file,url}], alarm:[{name,file,url}] }
  // name 是**去掉扩展名的文件名** —— 面板上显示它，用户不需要给歌改名。
  // **一次请求给两份列表**（她唱的歌 + 余额警报音），但它们永远是两份：
  //   songs ← songs/    alarm ← alarm/    （url 上那个 kind=alarm 就是分界线）
  disposers.push(registerRoute({
    kind: 'exact',
    path: '/dsh-rice/songs.json',
    handler: (req, res) => {
      try {
        const entry = (file, kind) => ({
          name: file.replace(/\.[^.]+$/, ''),
          file,
          url: '/dsh-rice/song?f=' + encodeURIComponent(file) + (kind ? '&kind=' + kind : ''),
        })
        const songs = listAudio(SONGS_DIR).map((f) => entry(f, ''))
        const alarm = listAudio(ALARM_DIR).map((f) => entry(f, 'alarm'))
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify({ ok: true, songs, alarm }))
      } catch (err) {
        res.writeHead(500, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, songs: [], alarm: [] }))
      }
    },
  }))

  // GET /dsh-rice/song?f=<文件名>[&kind=alarm] → 音频字节
  //
  // ⚠️ **必须走白名单，不能直接 path.join(dir, f)。**
  // 后者会让 `?f=../../../.credentials.yaml` 读走机器上的任意文件 ——
  // 而这台机器上跑着 DSH。所以：**只认"刚扫出来的那份名单里有的名字"**。
  // 比对的既然是文件名本身（而不是拼出来的路径），".."、绝对路径、
  // 以及各种编码花招就都进不来了。
  // `kind=alarm` 时白名单换成 alarm/ 那份 —— 两个目录各有各的白名单，
  // 所以"警报音"读不到 songs/ 外的任何东西，反之也一样。
  disposers.push(registerRoute({
    kind: 'exact',
    path: '/dsh-rice/song',
    handler: (req, res) => {
      try {
        const q = new URL(req.url || '/', 'http://127.0.0.1').searchParams
        const isAlarm = q.get('kind') === 'alarm'
        const dir = isAlarm ? ALARM_DIR : SONGS_DIR
        const want = q.get('f') || ''
        if (!listAudio(dir).includes(want)) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end(isAlarm ? 'alarm track not found' : 'song not found')
          return
        }
        const full = path.join(dir, want)
        const total = fs.statSync(full).size
        // 只读开头一小段来嗅类型 —— **别为了看一眼文件头就把整首歌读进来**。
        // 无损整轨动辄几十 MB，那样每来一个 Range 请求都要同步读一遍。
        const type = artType(readHead(full, Math.min(65536, total)))
        // —— Range ——
        // 浏览器放音频时会带着它来。不支持 Range 的话它多半也能放，
        // 但那样它拿不到"总长度"，播放/暂停偶尔会别扭 —— 十来行，值。
        const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim())
        if (m && (m[1] !== '' || m[2] !== '')) {
          let start, end
          if (m[1] === '') {                     // bytes=-N → 最后 N 个字节
            const n = parseInt(m[2], 10) || 0
            start = Math.max(0, total - n); end = total - 1
          } else {
            start = parseInt(m[1], 10)
            end = m[2] === '' ? total - 1 : Math.min(parseInt(m[2], 10), total - 1)
          }
          if (!isFinite(start) || !isFinite(end) || start > end || start >= total) {
            res.writeHead(416, { 'Content-Range': 'bytes */' + total })
            res.end()
            return
          }
          // 一次最多给 4MB。`bytes=0-`（到文件尾）在几十 MB 的无损上是常事，
          // 照单全收就等于"整首歌读进内存 + 整包发出去"。
          // 广告了 Accept-Ranges 之后，浏览器拿到 Content-Range 会自己再来要下一段。
          if (end - start + 1 > SONG_CHUNK_MAX) end = start + SONG_CHUNK_MAX - 1
          const chunk = readRange(full, start, end)
          res.writeHead(206, {
            'Content-Type': type,
            'Content-Length': String(chunk.length),
            'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
          })
          res.end(chunk)
          return
        }
        res.writeHead(200, {
          'Content-Type': type,
          'Content-Length': String(total),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        })
        res.end(fs.readFileSync(full))
      } catch (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('song unavailable')
      }
    },
  }))

  // —— 客户端脚本本体 ——
  disposers.push(registerRoute({
    kind: 'exact',
    path: '/dsh-rice/rice.js',
    handler: (req, res) => {
      try {
        const bytes = fs.readFileSync(CLIENT_FILE)
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': String(bytes.length),
        })
        res.end(bytes)
      } catch (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('rice client unavailable: ' + String((err && err.message) || err))
      }
    },
  }))

  // —— 把脚本挂进页面 ——
  disposers.push(ctx.webServer.tapIndex((html) => {
    if (html.indexOf('/dsh-rice/rice.js') !== -1) return html
    const tag = '<script defer src="/dsh-rice/rice.js"></script>'
    if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
    return html + tag
  }))

  ctx.effect(() => () => {
    for (const d of disposers) {
      try { d() } catch (err) {}
    }
  })
}

export { name, apply }
