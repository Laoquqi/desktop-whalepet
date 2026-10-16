// ============================================================================
// dsh-rice-widget —— 「偷吃白饭」独立插件 · 客户端脚本
// ============================================================================
// 这段脚本是**真插件**的客户端半边，拥有完整 DOM 权限（不是动态插件沙箱），
// 所以它能自己创建碗、自己往鲸鱼的容器里塞、自己给鲸鱼那张图加咀嚼类。
//
// 它与 dsh-whale-widget 的唯一耦合点：
//   · 读取 /dsh-whale/balance.json 和 /dsh-whale/last-turn.json（公开路由）
//   · 找到鲸鱼的容器（优先 .dshwv-body，退化为鲸鱼图片的父元素）
//   · 给鲸鱼图片临时加一个 .dshrice-chew 类
// 任何一处失效，碗最多是不出现或咀嚼不动，不会把鲸鱼弄坏。
//
// 记账在宿主半边（见 lib/index.js），这里只管画面。
// ============================================================================

(function () {
  if (window.__dshRiceLoaded) return
  window.__dshRiceLoaded = true

  var POLL_MS = 3000
  var WATCH_MS = 700

  // —— 唱歌时上下晃的幅度和节奏 ——
  // **慢一点很重要**：快晃像在发抖，慢晃才像"跟着歌轻轻摇"。
  // 而且晃的是整个容器，动的东西比只晃立绘时多得多（她、碗、米粒、标签、气泡一起动），
  // 所以同一个幅度看起来会更明显 —— 节奏一快就显急。
  // 想调就改这两个数：一个来回多久、晃多大（相对容器高度的百分比）。
  var SING_BOB_MS = 1600
  var SING_BOB_PCT = 1

  // —— 「抓到了」那段：碗被打翻、扣到地上的节奏 ——
  // 六个停靠点写在下面的 @keyframes dshrice-spill 里，而**落碗那一声必须和视觉同一拍**。
  // 所以"整段多久"和"几成处撞地"只在这里定义一次，CSS 和 JS 都引它 ——
  // 两边各写各的，改一处忘一处，声音就会逐渐飘掉（而且是没人报错的那种飘）。
  //   70% = "下落越来越快"和"回稳"的接缝，也就是碗**碰到地面**那一刻。
  var SPILL_MS = 620
  var SPILL_HIT_PCT = 0.7

  // —— 「被炸到头上」那一段：碗被掀上去、翻过来、扣在她头顶 ——
  // 它和上面那段是**两套落点**：抓现行还是倒扣在嘴边偏左，只有被炸到才上头顶。
  // 弧线更长（她嘴边在容器 ~75% 处，头顶在 ~23% 处，是一条往上 2.4 个碗高的抛线），
  // 所以整段也更久一点。
  //
  // ⚠️ **节奏比落点更容易做坏**（第一版就是这么坏的，用户说"不连贯"）：当时的毛病是
  //    24% 就爬完了 62% 的高度、最高点拖到 52%，而 74% 之后只剩 5% 碗高的晃动 ——
  //    看起来就是"猛地一跳 → 慢慢飘 → 砸上去 → 定住不动"。三点都反物理。
  //    现在按抛线重排：**爬升 34%、落下 34%（同样时长、落差更大 = 更快）、剩下 32% 全给"压一下再回稳"**，
  //    而且那三段各自声明缓动（上升减速、下落加速、压下去再弹回来）。
  //    想调手感就动下面这几个数，别的都不用碰。
  var HEAD_MS = 900
  var HEAD_HIT_PCT = 0.68     // 撞击点 = "下落越来越快"和"压实回稳"的接缝
  var HEAD_APEX_X = 0.86      // 最高点在水平方向走到几成
  var HEAD_APEX_UP = 58       // 最高点比落点高多少（**碗高的百分比**）
  var HEAD_IMPACT_UP = 6      // 第一下碰到头顶时比最终落点高多少（碗高百分比）
  var HEAD_ROCK_DOWN = 5      // 撞上之后往下压多少（碗高百分比）—— 这个数太小就会像"定住了"

  // ---------------------------------------------------------------- 样式 ----
  var CSS = [
    '.dshrice-bowl{position:absolute;left:70%;top:73.4%;width:33%;height:21.5%;pointer-events:none;opacity:0;transform:translate(-50%,150%);transition:transform .26s cubic-bezier(.34,1.5,.64,1),opacity .18s ease;z-index:5}',
    '.dshrice-bowl svg{display:block;width:100%;height:100%;overflow:visible}',
    // 碗的两层图片：**饭在下、空碗在上**，两张预先对齐过，叠起来就是"一碗饭"。
    // 用 object-fit:contain —— 盒子由面板调，图不该被拉变形。
    '.dshrice-bowl-food,.dshrice-bowl-img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:none;pointer-events:none}',
    // 图片模式：显示两层图、藏起内联 SVG。图取不到时不加这个类，就退回 SVG。
    '.dshrice-bowl.dshrice-bowl-pic .dshrice-bowl-food,.dshrice-bowl.dshrice-bowl-pic .dshrice-bowl-img{display:block}',
    '.dshrice-bowl.dshrice-bowl-pic svg{display:none}',
    '.dshrice-bowl.dshrice-up{opacity:1;transform:translate(-50%,0)}',
    '.dshrice-bowl.dshrice-nom{transform:translate(-50%,-7%) rotate(-5deg)}',
    // —— 「抓到了！」：饭碗被打翻 ——
    // 六拍：**弹起来 → 翻过去 → 落在旁边倒扣着 → 停住**。
    //   · 碗里的饭**在点下去的那一瞬间就没了**（图片那层 + 内联 SVG 里那组），
    //     因为饭已经到她嘴上了 —— 米粒那组会在同一拍冒出来，那就是"证据"。
    //   · 落点在**她嘴边偏左**，倒扣着躺在那儿，直到该消失的时候（见 catchEating）。
    //   · `forwards` 把最后那一帧留住，所以它就那么扣着，不会滑回原位。
    //   · **飞得矮**：最高点只比起点高 74px（约 0.7 个碗高）。飞高了像"抛"，矮一点才像"被打翻"。
    //
    // ⚠️ 1. **旋转轴必须用元素中心（默认的 50% 50%），不能用碗底。**
    //    轴放在碗底时，绕它转 θ 会**把碗身整体推向右上** ——
    //    位移是 `(H/2·sinθ, −H/2·cosθ)`，θ 在 0~180° 之间时**横向恒为正**（实测最多 +54px）。
    //    于是哪怕 translate 一路往左拉，前几拍看起来仍然是"往右上飞"，最后才甩到左下角。
    //    轴放在中心，旋转本身不产生位移，下面那串 translate 就是**真实的飞行轨迹**。
    //
    // ⚠️ 2. **每一拍都要单独声明缓动，不能一条 animation-timing-function 管全场。**
    //    它是**按"两个关键帧之间"生效**的，不是管整段 ——
    //    所以给它一个 ease-in-out，等于把这段飞行切成五小段、每段各自"慢起慢收"，
    //    看起来就是一跳一跳、还带停顿。（这一条是用户一眼看出来的。）
    //    这里按物理来分：弹出快起慢收 → 上升匀速 → 下落越来越快 → 落地 → 轻轻回稳。
    //    （每个停靠点的 translate 都按轴的约定算过：% 相对碗自己的宽/高。
    //      想让弧线更平/更高就改这六个点，改完它自己就是一条抛物线。）
    '@keyframes dshrice-spill{' +
      '0%{transform:translate(-50%,0) rotate(0deg);animation-timing-function:cubic-bezier(.2,.7,.4,1)}' +            // 在她嘴前 → 弹出
      '20%{transform:translate(-61%,-57%) rotate(-38deg);animation-timing-function:linear}' +                      // 上升
      '45%{transform:translate(-74%,-68%) rotate(-112deg);animation-timing-function:cubic-bezier(.55,0,.85,.6)}' +  // 最高处 → 下落（越来越快）
      '70%{transform:translate(-91%,-30%) rotate(-170deg);animation-timing-function:cubic-bezier(.3,0,.5,1)}' +     // 落地
      '88%{transform:translate(-103%,4%) rotate(-186deg);animation-timing-function:ease-out}' +                     // 回稳
      '100%{transform:translate(-102%,0) rotate(-180deg)}}',                                                        // 停住：倒扣在旁边
    // ✅ 70% 那个点 = **撞地**（下落越来越快 → 回稳的接缝），
    //    「碗落地」那一声就卡在这一拍上：时点是 SPILL_MS * SPILL_HIT_PCT（见文件顶上那两行）。
    //    ⚠️ 别把声音放在 100%（停住）—— 视觉上它 70% 就已经砸在地上了，
    //    放在 100% 会听起来"声音比动作晚半拍"，最难调的就是这种。
    '.dshrice-bowl.dshrice-spill{opacity:1;transform-origin:50% 50%;animation:dshrice-spill ' +
      (SPILL_MS / 1000) + 's linear forwards}',
    // —— 碗一翻过来，**里面那口饭当场就没了** ——
    // 两个类共用这两条（spill = 被点翻，head = 被炸到头上）：
    // 饭是"已经被她吃掉/扣在地上"的，翻着的碗里还扣着一坨饭是这个功能最刺眼的错。
    // ⚠️ 两个选择器都要写全 —— 只写 spill 那条的后果，就是"被炸到头顶时饭还挂在碗下面"
    //    （实测被用户一眼看出来）。图片那层和内联 SVG 那组都得盖住。
    '.dshrice-bowl.dshrice-spill .dshrice-bowl-food,.dshrice-bowl.dshrice-head .dshrice-bowl-food{opacity:0;transition:opacity .08s ease}',
    '.dshrice-bowl.dshrice-spill .dshrice-bowl-rice,.dshrice-bowl.dshrice-head .dshrice-bowl-rice{opacity:0;transition:opacity .08s ease}',
    // 该消失的时候：**这一条和米粒是同一拍加的**（见 catchEating），所以两者一起淡掉。
    // 没有它的话，去掉 dshrice-up 会让它按基础样式滑回原位再淡出 —— 那就不像"扣在那儿"了。
    '.dshrice-bowl.dshrice-spill.dshrice-gone{opacity:0;transition:opacity .3s ease}',
    // 收尾：嘴角沾着**几粒米**（鲸鱼插件作者的意见：照她立绘上那几个"馋"的白泡来）。
    //   · left/top 指的是**整簇的中心**（下面那句 translate(-50%,-50%)），改大小位置不跑
    //   · **不画描边** —— 作者觉得深色太突兀；但白米粒落在她偏白的脸上会糊掉，
    //     所以留了一层极淡的灰色投影当"边"。那是它还能被看见的唯一原因。
    //   · box-shadow 换成 filter:drop-shadow —— 前者跟盒子走，后者跟**形状**走
    //   · ⚠️ z-index 必须**低于碗**（碗是 5）：米粒要在碗还挡着嘴的时候就出现，
    //     藏到碗后面，等碗落下去正好露出来。压在碗之上就会变成"浮在碗上的一把米"。
    '.dshrice-grain{position:absolute;left:75.9%;top:85.3%;width:7%;aspect-ratio:200/110;min-width:16px;pointer-events:none;opacity:0;transform:translate(-50%,-50%) scale(.3);transition:opacity .18s ease,transform .24s cubic-bezier(.34,1.56,.64,1);z-index:4;filter:drop-shadow(0 1px 1.5px rgba(120,135,165,.35))}',
    // 用 art/rice.png 时：图铺满整簇，内置 SVG 藏起来（grainImage 为空则反过来）
    '.dshrice-grain{background-size:contain;background-repeat:no-repeat;background-position:center}',
    '.dshrice-grain svg{display:block;width:100%;height:100%;overflow:visible}',
    '.dshrice-grain.dshrice-hasimg svg{display:none}',
    '.dshrice-grain.dshrice-grain-show{opacity:1;transform:translate(-50%,-50%) scale(1)}',
    // 咀嚼：只在加类时声明 transition/transform，平时完全不碰鲸鱼自己的 transform。
    // 咀嚼：用**独立的 translate/scale 属性**，不是 transform ——
    // 这样即使鲸鱼自己给 img 设了内联 transform（拖动、缩放、左右翻转），
    // 两者也会叠加，而不会被我这条规则盖掉。
    // （和米粒的 rotate 是同一个道理：独立属性和 transform 互不干扰。）
    '.dshwv-img.dshrice-chew{transition:translate .13s ease,scale .13s ease;transform-origin:50% 86%;translate:0 1.8%;scale:1.02 .955}',
    // 唱歌时她轻轻上下晃 —— 不然"唱歌"就只剩"在放音乐"了。
    //
    // ⚠️ **晃的是 .dshwv-body（整个挂件容器），不是那张立绘。**
    //    这是跟鲸鱼自己学的：它按下她的时候就是给 body 加
    //    `transform:scaleY(.88) scaleX(1.05)`（源码里的 SQUISH），
    //    所以"碰她的时候嘴角那几粒米跟着一起缩"。
    //    米粒和碗都是**按 body 的百分比定位**的 —— 只有晃 body，它们才会跟着她一起动、
    //    始终贴在她嘴上；晃立绘的话它们钉在原地：她上下晃、嘴角的米不动，一眼就散了。
    //    两边动的属性也不冲突：鲸鱼在 body 上用的是 `transform`，
    //    我们动**独立的 translate 属性**，按规范叠加。
    //    而且咀嚼在立绘上、晃动在容器上 —— **不同元素、各动各的，谁也不会压掉谁**。
    // 幅度和节奏见上面的 SING_BOB_PCT / SING_BOB_MS —— 两个都能直接改。
    // 节奏是固定的 idle 晃，**不跟节拍**（没有可靠的节拍信息，硬凑只会对不上）。
    '@keyframes dshrice-sing{0%,100%{translate:0 0}50%{translate:0 ' + SING_BOB_PCT + '%}}',
    '.dshwv-body.dshrice-singing{animation:dshrice-sing ' + (SING_BOB_MS / 1000) + 's ease-in-out infinite}',
    // 开关标签：**平时完全透明，鼠标够到时才亮**。
    // 这之所以可行，全靠下面那句 pointer-events:auto —— 它自己接得住 hover，
    // 所以"藏起来"不再等于"够不着"。（修 auto 之前，这个设计是做不到的。）
    // ⚠️ 鲸鱼的 .dshwv-root 是 pointer-events:none 的"穿透层"，子元素默认收不到鼠标事件，
    // 必须显式 auto。旧版能出现，只是因为你恰好悬停到鲸鱼自己的 ☰ 按钮（那个是 auto），
    // 它的 hover 冒泡到祖先才让 .dshwv-body:hover 成立；一离开按钮就断了。
    '.dshrice-chip{position:absolute;right:5%;top:5%;font:11px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;padding:2px 6px;border-radius:7px;background:rgba(32,49,112,.75);color:#fff;opacity:0;transition:opacity .18s ease;cursor:pointer;z-index:20;pointer-events:auto;user-select:none;-webkit-user-select:none}',
    // 两种方式都能让它现身：悬停到标签自己，或悬停到鲸鱼/气泡上（冒泡到 .dshwv-body）。
    '.dshrice-chip:hover,.dshwv-body:hover .dshrice-chip{opacity:.95}',
    '.dshrice-chip.dshrice-off{background:rgba(120,124,138,.7)}',
    '.dshrice-chip.dshrice-off::after{content:"（已关）"}',

    // ---------------------------------------------------------- 设置面板 ----
    // 点标签打开。样式照着鲸鱼自己那套菜单的调子做（白底、蓝字、圆角），
    // 但**完全是我自己的元素** —— 不碰它的 DOM。
    // 面板是 position:fixed，而且**挂在 document.body 上**（不在鲸鱼容器里）——
    // 因为鲸鱼会给自己套 transform（左右翻转 .dshwv-left、拖拽），
    // 而**带 transform 的祖先会成为 fixed 的包含块**：那样面板就会跟着她跑、还会被裁掉。
    // 挂在 body 上就与这些都无关。
    // z-index 必须高过鲸鱼的 9999，否则会被她的立绘盖住。
    // 位置不给默认值 —— 由 placeMenu() 按实测像素算（贴着她、再被视口夹住）。
    '.dshrice-menu{position:fixed;left:0;top:0;width:252px;max-width:calc(100vw - 24px);box-sizing:border-box;background:rgba(255,255,255,.97);border:1px solid rgba(32,49,112,.35);border-radius:10px;padding:10px 12px;color:#203170;font:12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.18);z-index:10000;pointer-events:auto;display:none;color-scheme:light;max-height:calc(100vh - 24px);overflow-y:auto;overscroll-behavior:contain}',
    '.dshrice-menu.dshrice-open{display:block}',
    // —— 分组（可折叠）——
    // 一组 = 一件事。加新功能就是往 PANEL 里加一行或加一组，不用再碰这些样式。
    // 箭头是纯装饰，用 ::after 画就行，不占 DOM。
    '.dshrice-menu .dshrice-grp{border-top:1px solid rgba(32,49,112,.25);margin-top:6px}',
    '.dshrice-menu .dshrice-grp:first-child{border-top:0;margin-top:0}',
    '.dshrice-menu button.dshrice-grp-h{display:flex;align-items:center;width:100%;background:none;border:0;border-radius:0;padding:7px 0;font-weight:600;color:#203170;text-align:left}',
    '.dshrice-menu button.dshrice-grp-h:hover{background:none;color:#12225a}',
    '.dshrice-menu button.dshrice-grp-h::after{content:"▶";margin-left:auto;font-size:10px;opacity:.7;transition:transform .15s ease}',
    '.dshrice-menu .dshrice-grp.dshrice-grp-open button.dshrice-grp-h::after{transform:rotate(90deg)}',
    '.dshrice-menu .dshrice-grp-b{display:none;padding-bottom:3px}',
    '.dshrice-menu .dshrice-grp.dshrice-grp-open .dshrice-grp-b{display:block}',
    // 页脚：**常驻在面板底部**。保存/重置永远够得着 ——
    // 不管哪一组是展开的、也不管面板内部滚到哪儿。
    '.dshrice-menu .dshrice-foot{position:sticky;bottom:0;display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:6px;padding:7px 0 2px;background:#fff;border-top:1px solid rgba(32,49,112,.25)}',
    // 唱歌按钮：图标 + 文字。
    // ⚠️ 图标是**子元素**而不是 background-image —— 因为按下时要把图标刷白，
    //    而 filter 只能作用在元素上，刷不了背景图。
    //    代价是点击时 e.target 可能是那个 <img>，所以：
    //      · 图标自己 pointer-events:none（点在它身上等于点在按钮上）
    //      · 点击处理器也换成了 closest('button')（见下）
    '.dshrice-menu button.dshrice-sing{display:inline-flex;align-items:center;gap:4px}',
    '.dshrice-menu button.dshrice-sing img{width:14px;height:14px;display:block;object-fit:contain;pointer-events:none}',
    // 「被按住了」= 深底 + 图标刷白 + 陷进去一点。三个一起才读得出来。
    '.dshrice-menu button.dshrice-sing.dshrice-on img{filter:brightness(0) invert(1)}',
    '.dshrice-menu button.dshrice-sing.dshrice-on{box-shadow:inset 0 2px 4px rgba(0,0,0,.4);transform:translateY(1px)}',
    // flex-wrap 是保险：万一以后又往一行里塞多了，它会换行而不是溢出到菜单外面
    '.dshrice-menu .dshrice-row{display:flex;align-items:center;gap:6px;margin:5px 0;flex-wrap:wrap}',
    '.dshrice-menu .dshrice-mut{color:#7c88ad;font-size:11px;margin-left:auto;transition:opacity .3s ease}',
    // 结果提示：显示一会儿就淡出，别让它一直挂着 ——
    // 常挂会让人以为"已经定稿了"，反而不敢继续改。
    '.dshrice-menu .dshrice-hint{min-width:66px;text-align:right}',
    '.dshrice-menu .dshrice-mut.dshrice-q{margin-left:0;cursor:help}',
    '.dshrice-menu button{border:1px solid rgba(32,49,112,.28);background:#eef2fb;color:#203170;border-radius:6px;padding:3px 8px;font-size:12px;cursor:pointer;line-height:1.3}',
    '.dshrice-menu button:hover{background:#dfe7f8}',
    '.dshrice-menu button.dshrice-on{background:#203170;border-color:#203170;color:#fff}',
    '.dshrice-menu button.dshrice-save{background:#2f6b46;border-color:#3f8a5c;color:#fff}',
    '.dshrice-menu button.dshrice-try{background:#8a5a1f;border-color:#a9702a;color:#fff}',
    // 下拉行（目前只有"余额警报音"）：跟着按钮那套配色走，别让裸的 <select> 显得像外来控件。
    // max-width + ellipsis：警报音的文件名可能很长，不能把面板撑宽。
    '.dshrice-menu select.dshrice-sel{border:1px solid rgba(32,49,112,.28);background:#eef2fb;color:#203170;border-radius:6px;padding:3px 6px;font-size:12px;font-family:inherit;max-width:150px}',
    '.dshrice-menu select.dshrice-sel:hover{background:#dfe7f8}',
    // 正在调米粒的位置/角度时才让它常显 —— 否则调的时候看不见它，等于瞎调。
    // 和显隐动画不冲突：两边都是"让它可见"，谁赢都一样。
    // ⚠️ 它**不是"面板开着就常显"** —— 那等于每次开面板、甚至她唱歌的时候，
    //    嘴角那把米都挂在那儿；而她唱歌时是**整张立绘在晃**、米粒钉在原地不动，
    //    看着就像坏了。到底该不该常显，见 syncTuneHold()。
    '.dshrice-grain.dshrice-hold{opacity:1;transform:translate(-50%,-50%) scale(1)}',

    // ---------------------------------------------------------------- 彩蛋 ----
    // 图标是**实心方形图**（深底 + 粉边），所以给了个圆角 ——
    // 不然贴在她头上就是一个生硬的方块。加了白描边和阴影，让它像"浮在上面"。
    // 而彩蛋本来就该看起来像外来物：它要的是被认出来，不是不突兀。
    '.dshrice-egg{position:absolute;transform:translate(-50%,-50%) scale(.4);opacity:0;border-radius:22%;pointer-events:none;z-index:25;box-shadow:0 0 0 2px rgba(255,255,255,.9),0 3px 10px rgba(0,0,0,.28);transition:opacity .16s ease,transform .16s cubic-bezier(.2,1.5,.5,1)}',
    '.dshrice-egg.dshrice-egg-show{opacity:1;transform:translate(-50%,-50%) scale(1)}',
    // 面板里选中「图标」时让它常显 —— 否则你只能在彩蛋触发的 1.4 秒里调它，
    // 那点时间根本来不及按九宫格。
    '.dshrice-egg.dshrice-egg-hold{opacity:1;transform:translate(-50%,-50%) scale(1)}',
    '.dshrice-pad{display:grid;grid-template-columns:repeat(3,1fr);gap:3px;margin:4px 0}',
    '.dshrice-pad button{padding:3px 0;text-align:center}',
    '.dshrice-pad .dshrice-blank{visibility:hidden}',
    '.dshrice-menu input[type=checkbox]{width:15px;height:15px;accent-color:#203170;cursor:pointer}',
    '.dshrice-menu .dshrice-num{font-variant-numeric:tabular-nums;color:#536ba9}',
  ].join('\n')

  var styleEl = document.createElement('style')
  styleEl.textContent = CSS
  document.head.appendChild(styleEl)

  // 版面覆盖层：上面那份静态样式里的位置是"默认立绘"的值，这里按配置覆盖。
  // 后插入的 <style> 在同等特异性下胜出，所以不需要 !important；
  // 单独分一层的好处是改版面时不用重建整张表。
  var layoutEl = document.createElement('style')
  document.head.appendChild(layoutEl)
  function renderLayout() {
    layoutEl.textContent = [
      // 碗：用图片时它是 196×196 的方图，所以高度交给 aspect-ratio；
      // 用内联 SVG 时用调好的高度百分比（那张图是 200:130 的横比例）。
      // 这和米粒图那条是同一个道理：盒子的比例必须跟着"里面装的是什么"走。
      '.dshrice-bowl{left:' + lay.bowlLeft + '%;top:' + lay.bowlTop + '%;width:' + lay.bowlWidth + '%;' +
        (lay.bowlImage ? 'height:auto;aspect-ratio:1/1' : 'height:' + lay.bowlHeight + '%') + '}',
      // 米粒那一簇：只给宽度，高度由 aspect-ratio 推出来 ——
      // 因为作者示意里它是"左右摊开的一条"，比例写死才不会在别人手里摊成方块。
      // min-width 兜住下限，高度会跟着比例一起变大。
      // 旋转用**独立的 rotate 属性**，不是 transform —— 因为 transform 被显隐动画占着
      // （translate(-50%,-50%) scale(…)）。两者按规范叠加，互不干扰。
      // 有些角色是抬着头/歪着头的，嘴的朝向和默认立绘不同，这一簇米就得跟着转。
      // 盒子比例跟着"用哪张图"走：
      //   内置圆形 → 正方形（不然圆会被压成椭圆）
      //   自定义图 → 200:110（作者那张本来就是横着摊开的一条）
      // 这一步是"白色圆形看着变扁"的真正原因 —— 不是形状画错了，是盒子比例不对。
      '.dshrice-grain{left:' + lay.grainLeft + '%;top:' + lay.grainTop + '%;width:' + lay.grainWidth + '%;aspect-ratio:' + (lay.grainImage ? '200/110' : '1/1') + ';min-width:' + lay.grainMinPx + 'px;rotate:' + (lay.grainRotate || 0) + 'deg}',
      '.dshwv-img.dshrice-chew{transform-origin:' + lay.chewOriginX + '% ' + lay.chewOriginY + '%}',
      // 彩蛋图标不在这里 —— 它的位置和大小是**按实测像素**算的，见 placeEgg()。
      // 因为它必须锚定"她自己那张图"，而不能锚定 .dshwv-body（那是个会变的正方形）。
    ].join('\n')
    // 碗那两层图也跟着重画 —— 挂在 renderLayout 的末尾，
    // 是因为"要不要用图片、用哪一碗饭"都取决于 lay，而 renderLayout 是所有路径的必经之地。
    // （它内部按 key 早退，所以重复调用是空闲的。）
    renderBowlArt()
  }

  // 彩蛋图标：**锚定在她自己的图片上，不是 .dshwv-body。**
  // .dshwv-body 的边长是 clamp(122px, min(100vw,100vh)*0.28*scale, 625px) ——
  // 它会随视口、缩放、以及 clamp 撞到边界而变，所以相对它的百分比会漂。
  // 她的图片（.dshwv-img）才是"就是她"的那个盒子。
  // ⚠️ 三个值现在都是**相对她的图片**的百分比：
  //    eggLeftPct 横向（50 = 图片中线）
  //    eggTopPct  纵向（28 ≈ 她的额头）
  //    eggIconPct 图标宽度占图片宽度的比例
  function placeEgg() {
    if (!EGGS.length) return
    var img = whaleImg()
    var body = whaleBody()
    if (!img || !body) return
    var i = img.getBoundingClientRect()
    var b = body.getBoundingClientRect()
    if (!i.width || !b.width) return
    // body 可能带 transform（拖动/吸附会用到），所以把屏幕像素换算回它的局部像素
    var k = body.offsetWidth ? (b.width / body.offsetWidth) : 1
    if (!k) k = 1
    var left = (((i.left - b.left) + i.width * ((lay.eggLeftPct || 50) / 100)) / k) + 'px'
    var top = (((i.top - b.top) + i.height * ((lay.eggTopPct || 28) / 100)) / k) + 'px'
    var w = ((i.width * ((lay.eggIconPct || 19) / 100)) / k) + 'px'
    // 所有彩蛋图标都停在同一个位置（她的额头上），所以一起摆
    EGGS.forEach(function (egg) {
      if (!egg.el || egg.el.style.display === 'none') return
      egg.el.style.left = left
      egg.el.style.top = top
      egg.el.style.width = w
    })
  }

  // ---------------------------------------------------------------- 元素 ----
  // 画序就是遮挡关系：碗身 → 碗口 → 整圈碗沿 → 米饭（把后半圈碗沿盖掉）
  // → 米粒 → 只把"近处那半圈碗沿"重新压回米饭之上。
  // 最后这半圈给的是立体感：近处的碗沿本来就该挡在饭前面。
  // 若把整圈碗沿画在米饭之后，蓝色描边就会像一根线从米饭上穿过去。
  var bowlEl = document.createElement('div')
  bowlEl.className = 'dshrice-bowl'  // 三层，从下往上：**内联 SVG（兜底）→ 饭 → 空碗**。
  // 图片那两张是 196×196、预先对齐好的，叠起来就是"一碗饭"。
  // 没配图、或图取不到时，图片层隐藏，只剩内联 SVG —— 插件因此仍然自足、可发布。
  var bowlFoodEl = document.createElement('img')
  bowlFoodEl.className = 'dshrice-bowl-food'
  bowlFoodEl.alt = ''
  var bowlImgEl = document.createElement('img')
  bowlImgEl.className = 'dshrice-bowl-img'
  bowlImgEl.alt = ''
  bowlEl.innerHTML = '<svg viewBox="0 0 200 130" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M16 76 H184 C180 108, 154 122, 100 122 C46 122, 20 108, 16 76 Z" fill="#3b5aa8"/>' +
    '<ellipse cx="100" cy="76" rx="84" ry="12" fill="#e8eefb"/>' +
    '<ellipse cx="100" cy="76" rx="84" ry="12" fill="none" stroke="#2b4485" stroke-width="3"/>' +
    // 米饭单独包一组：打翻饭碗的时候要能**只让它消失**（饭撒了，碗是空的）。
    // 顺序不能动 —— 白色那团必须在碗口描边之后、近处碗沿之前。
    '<g class="dshrice-bowl-rice">' +
    '<path d="M34 80 C40 41, 160 41, 166 80 Z" fill="#ffffff"/>' +
    '<circle cx="78" cy="62" r="3.2" fill="#e6ecf9"/>' +
    '<circle cx="118" cy="54" r="2.8" fill="#e6ecf9"/>' +
    '<circle cx="99" cy="48" r="2.4" fill="#e6ecf9"/>' +
    '</g>' +
    '<path d="M16 76 A84 12 0 0 0 184 76" fill="none" stroke="#2b4485" stroke-width="3" stroke-linecap="round"/>' +
    '</svg>'
  bowlEl.appendChild(bowlFoodEl)
  bowlEl.appendChild(bowlImgEl)

  var grainEl = document.createElement('div')
  grainEl.className = 'dshrice-grain'
  // 几粒米，**左右摊开**在嘴应该在的位置 —— 照作者那张示意图的布置。
  // 三个要点：
  //   · 偏圆（长短轴只差一成多），不是细长的米粒 —— 他是要"圆钝的小白点"
  //   · **不画描边** —— 白色靠极淡的投影从脸上浮出来就够
  //   · 大小和角度各不相同，彼此错开 —— 才像"沾上去的"，不像"贴上去的图标"
  // 整簇重心落在 viewBox 正中，这样 left/top 指中心就等于是指这簇米。
  // 内置的兜底形状：**就一个白色圆形**（回到最早那版）。
  // 中间试过更"像米"的版本 —— 两端收尖的梭形、四粒米左右摊开 ——
  // 但那种一眼就看得出是"设计过的图形"，落在别人的立绘上反而最扎眼。
  // 一个柔和的白点最不抢戏。真正像米的是 art/rice.png 那张，那条路走 grainImage。
  grainEl.innerHTML = '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
    '<circle cx="50" cy="50" r="48" fill="#ffffff"/>' +
    '</svg>'

  // 先"试装"再启用：图取不到就退回内置 SVG。
  // 这样即使别人根本没放 art/rice.png，米粒也不会凭空消失 ——
  // 一个可选的美术不该让功能失效。
  var artOk = null
  function renderGrainArt() {
    var img = lay.grainImage
    if (!img) {
      grainEl.style.backgroundImage = ''
      grainEl.classList.remove('dshrice-hasimg')
      artOk = null
      return
    }
    if (artOk === img) return
    var probe = new Image()
    probe.onload = function () {
      artOk = img
      grainEl.style.backgroundImage = 'url("' + img + '")'
      grainEl.classList.add('dshrice-hasimg')
    }
    probe.onerror = function () {
      artOk = null
      grainEl.style.backgroundImage = ''
      grainEl.classList.remove('dshrice-hasimg')
      console.error('[dsh-rice] 米粒图取不到，已退回内置 SVG：' + img)
    }
    probe.src = img
  }

  // —— 碗的两层图片（饭 + 空碗）——
  // 和米粒图同一套思路：**任何一张取不到，就整组退回内联 SVG**，不让功能失效。
  // 饭用哪一张由 isPeak 决定 —— 而 isPeak 是鲸鱼自己在 balance.json 里给的，
  // 我们不算峰谷时刻（那样它一改定价日历我们就过时了）。
  var peakNow = null          // null = 还没拿到；true = 峰；false = 谷
  var bowlArtKey = null       // 记着"现在这两层图装的是什么"，避免重复探
  function setPeak(v) {
    if (v === peakNow) return
    peakNow = v
    renderBowlArt()
  }
  function renderBowlArt() {
    var bowl = lay.bowlImage
    var food = (peakNow === true) ? lay.foodPeakImage : lay.foodValleyImage
    if (!bowl || !food) {
      // 没配图 → 用内联 SVG
      bowlEl.classList.remove('dshrice-bowl-pic')
      bowlArtKey = null
      return
    }
    var key = bowl + '|' + food
    if (key === bowlArtKey) return
    var pending = 2
    var failed = false
    var done = function () {
      pending--
      if (pending > 0) return
      if (failed) {
        bowlEl.classList.remove('dshrice-bowl-pic')     // 退回 SVG
        bowlArtKey = null
        console.error('[dsh-rice] 碗或饭的图取不到，已退回内置 SVG')
      } else {
        bowlEl.classList.add('dshrice-bowl-pic')
        bowlArtKey = key
      }
    }
    var probeBowl = new Image()
    probeBowl.onload = done
    probeBowl.onerror = function () { failed = true; done() }
    probeBowl.src = bowl
    var probeFood = new Image()
    probeFood.onload = done
    probeFood.onerror = function () { failed = true; done() }
    probeFood.src = food
    // 先挂上去 —— 两层图只有在 .dshrice-bowl-pic 生效时才可见，所以不会闪
    bowlFoodEl.src = food
    bowlImgEl.src = bowl
  }

  var chipEl = document.createElement('div')
  chipEl.className = 'dshrice-chip'
  chipEl.textContent = '🍚 偷吃白饭'

  // ------------------------------------------------------------ 设置面板 ----
  // 点标签打开。**整个面板由下面那份数据结构生成** ——
  // 加一个新功能 = 往 PANEL 里加一行或加一组，不用再写标记、也不用再去接线。
  // 草稿制：改的都是本地值，**点保存才写回宿主**，不满意点重置；
  // 刷新页面等于放弃草稿。
  // 存给哪个角色由宿主根据上报的角色决定，所以面板里不需要"选角色"。
  //
  // 作者画的那张米粒图，作为默认素材随包发布（已获授权）。
  // 空字符串 = 退回内置圆形 —— 所以就算这张图丢了，米粒也不会消失。
  var RICE_DEFAULT = '/dsh-rice/rice.png'
  // 吃饭音效自带的那个（实机截取的游戏原声）。空字符串 = 不响。
  var RICE_SOUND_DEFAULT = '/dsh-rice/nang.weba'
  // 碗被打翻、扣到地上那一声（约 2.3 秒：一声"咣"加一段滚动的余音）。
  // 只在「抓到她偷吃」时响 —— 正常吃完是把碗放下，不是打翻。
  // 和上面那个一样**用户可以自己换**（面板里选一个音频文件）。
  var DROP_SOUND_DEFAULT = '/dsh-rice/drop-bowl.webm'
  // 碗的两层图（都是 196×196、预先对齐）。空字符串 = 用内联 SVG。
  var BOWL_DEFAULT = '/dsh-rice/bowl.png'
  var FOOD_PEAK_DEFAULT = '/dsh-rice/food-peak.png'
  var FOOD_VALLEY_DEFAULT = '/dsh-rice/food-valley.png'

  // —— 面板长什么样 ——
  // 行的类型（type）与它需要的字段：
  //   check   开关          {key, label, note?}
  //   targets 调哪一个      {items:[{id,label}]}
  //   dpad    九宫格
  //   size    大小          {label}
  //   steps   每次移动多少  {label, tip, marks:[…]}
  //   rotate  旋转          {label, per, only}       only = 只在调某个目标时显示
  //   asset   换素材        {key, label, def, accept, empty?, store?}
  //   range   刻度滑杆      {key, label, min, max, step, store?, showIf?}
  //   note    一句说明      {text}
  // ⚠️ store:'sound' 的行写进音效草稿；store:'chance' 的写进随机偷吃草稿
  //    （两者都**不按角色存**）；其余素材行写进 lay（**按角色存**）——
  //    这条必须和 LAYOUT_KEYS 保持一致。
  // showIf = 只在某个勾选框打开时才显示这一行（比如概率之于随机偷吃开关）。
  var PANEL = [
    {
      id: 'switch', title: '开关', open: true,
      rows: [
        { type: 'check', key: 'riceOn', label: '偷吃白饭', note: 'role' },
        // 音效开关和主开关是一对，放一起才好对照。
        // （关掉偷吃白饭时她根本不进吃的那套逻辑，所以音效也不会响；
        //   这个开关管的是"吃的时候要不要出声"。）
        { type: 'check', key: 'soundOn', label: '音效开关' },
        // 随机偷吃：勾上之后她**不再每轮都吃**，而是每次结算一轮掷一次骰子；
        // 没掷中就攒着，下次一起吃（那一顿口数自然更多）。
        { type: 'check', key: 'randomSteal', label: '随机偷吃', tip: '不再每轮都吃：掷中了才吃，没掷中就攒到下次一起吃' },
        // 概率只在打开随机偷吃时才有意义 —— 关掉这一行就藏起来（showIf）。
        { type: 'range', key: 'stealChancePct', label: '概率', min: 0, max: 100, step: 5, store: 'chance', showIf: 'randomSteal', unit: '%' },
        // ⚠️ 这里**故意没有**「飞头顶」那条滑杆（"点她抓到之后碗往哪儿落"的概率）。
        // 它是个一次性定下来的手感：撞见才算惊喜，常见就成了日常 ——
        // 摆一条滑杆等于天天问用户"要不要更常见一点"，而答案基本是"不要"。
        // 值仍然可调，只是退回配置文件那一层（和 pollMs / stepMs 一样）。
      ],
    },
    {
      id: 'layout', title: '位置微调（方向键也行）', open: true,
      rows: [
        // ⚠️ 这里**故意没有「图标」按钮**。
        // 菜单上多一个「图标」，等于告诉用户"这里藏了东西"—— 彩蛋就不成其为彩蛋了。
        // 它的调参能力还在（见下面 pairOf / sizeKeyOf 的 egg 分支，
        // 以及 renderPanel 里的 egg-hold）：需要时往 items 里加一项即可。
        // 「头顶」**可以摆在面板上**，它和彩蛋不是一回事：
        // 这条落点现在"点她抓到"也有机会走到（见 headChancePct），而且换个角色必须重调 ——
        // 藏着一个用户根本调不了的参数，比剧透更糟。
        { type: 'targets', items: [{ id: 'grain', label: '米粒' }, { id: 'bowl', label: '碗' }, { id: 'head', label: '头顶' }] },
        { type: 'dpad' },
        { type: 'size', label: '大小' },
        // 「每次移动多少」—— 原来叫"步长"，还和"大小"挤在同一行，结果被挤出菜单外面了。
        // 现在拆成独立一行，名字也改成看得懂的说法，那个问号有悬停说明。
        { type: 'steps', label: '每次移动', tip: '每按一次方向键（或点一次九宫格）移动多少个百分点', marks: [0.1, 0.5, 2] },
        // 旋转：**只有调米粒时才有意义** —— 有些角色是抬着头的，嘴的朝向和默认立绘不同。
        // 碗不需要转（它靠位置和大小就够），下巴也不该在这里出现。
        { type: 'rotate', label: '旋转', per: 5, only: 'grain' },
        { type: 'note', text: '调米粒时它才常显' },
      ],
    },
    {
      id: 'art', title: '素材 · 米粒与碗', open: false,
      rows: [
        // 每一张素材都是同一行：选一个文件 → 读成 data URI 存进配置。
        // 用 data URI 而不是"把文件放进 art/ 目录"：用户不该为了换张图去碰文件系统。
        // 米粒图留空 = 内置圆形；碗和饭留空 = 内置矢量碗。
        { type: 'asset', key: 'grainImage', label: '米粒图', def: RICE_DEFAULT, accept: 'image/*', empty: '内置圆形' },
        { type: 'asset', key: 'bowlImage', label: '碗', def: BOWL_DEFAULT, accept: 'image/*', empty: '内置图形' },
        { type: 'asset', key: 'foodPeakImage', label: '波峰饭', def: FOOD_PEAK_DEFAULT, accept: 'image/*', empty: '内置图形' },
        { type: 'asset', key: 'foodValleyImage', label: '波谷饭', def: FOOD_VALLEY_DEFAULT, accept: 'image/*', empty: '内置图形' },
      ],
    },
    {
      id: 'sound', title: '音效', open: false,
      rows: [
        // 吃饭音效：**和米粒图一样可以换**，只不过选的是音频文件。
        // （开关不在这里 —— 它和主开关是一对，放在"开关"那组。）
        { type: 'asset', key: 'riceSound', label: '吃饭音效', def: RICE_SOUND_DEFAULT, accept: 'audio/*', store: 'sound' },
        // 碗落地那一声：**也可以换**，和上一条同一个做法（选文件 → 读成 data URI）。
        // 它只在「抓到她偷吃」的时候响 —— 那一顿本来就不吃了，所以不会和每口那声撞车。
        { type: 'asset', key: 'dropSound', label: '碗落地', def: DROP_SOUND_DEFAULT, accept: 'audio/*', store: 'drop' },
        { type: 'note', text: '每口一声 · 抓到她时落碗一声（音量共用）' },
        // 音量刻度 0~10 —— **界面上这个数就是配置里那个数**。
        // 它对**两个**音效都管用：它管的是"她吃饭时的声音"，而落碗那一声属于同一件事。
        { type: 'range', key: 'riceSoundVol', label: '音量', min: 0, max: 10, step: 1, store: 'sound' },
      ],
    },
    {
      id: 'sing', title: '唱歌', open: false,
      rows: [
        // 开工自动唱：宿主订阅 DSH 的「回合开始」，页面每次轮询顺手把它捎回来。
        // 之所以要绕这一圈：音频只有页面自己能放，宿主推不动，只能报时。
        { type: 'check', key: 'autoSing', label: '开工时唱一首', tip: '你在 DSH 里开始干活时她自动唱一首；她一开始吃饭就停下来（想听完就点下面的「留住」）' },
        // 间隔只在自动唱打开时才有意义 —— 关掉就藏起来（showIf）。
        // 0 分钟 = 每个回合都唱。
        { type: 'range', key: 'autoSingMin', label: '最少隔', min: 0, max: 60, step: 1, store: 'autosing', showIf: 'autoSing', unit: '分钟' },
        { type: 'note', text: '歌放在 songs/ 文件夹里' },
        // —— 余额警报音 ——
        // 判据不是我定的数：读鲸鱼自己的「余额预警」，两边都开才响（见 maybeAlarm）。
        { type: 'check', key: 'alarmOn', label: '余额不足时放一首', tip: '余额 ≤ 鲸鱼那条「余额预警」的线时放一首。两边都要开：鲸鱼那条预警 + 这一项。每打开一次页面最多放一次' },
        { type: 'select', key: 'alarmSong', label: '放哪首', store: 'alarm', showIf: 'alarmOn', empty: '（不放）', preview: '试听',
          tip: '从 alarm/ 文件夹里选一首。它和「唱歌」用的 songs/ 是两套，不会混在一起' },
        { type: 'note', text: '警报音放在 alarm/ 文件夹里（和 songs/ 分开）' },
      ],
    },
  ]
  // 页脚常驻在面板底部：保存/重置永远够得着，不用管哪一组展开着。
  // 放的都"立刻做一件事"的按钮（设置类的在组里）。
  var PANEL_FOOT = [
    // 唱歌：icon 是子元素（见样式里那段），label 会随状态在「唱歌 / 停止」之间变。
    {
      id: 'sing', label: '唱歌', cls: 'dshrice-sing', icon: '/dsh-rice/song.png',
      title: '放一首歌（再点一下停止）· 歌放在插件目录的 songs/ 文件夹里，多首随机唱一首',
    },
    { id: 'try', label: '试吃', cls: 'dshrice-try', title: '跑一次完整的动画，并告诉你音效为什么没响' },
    { id: 'save', label: '保存', cls: 'dshrice-save' },
    { id: 'reset', label: '重置', cls: 'dshrice-reset' },
  ]

  var menuEl = document.createElement('div')
  menuEl.className = 'dshrice-menu'

  // 选本地文件用：**一个共享的隐藏 input**（不是每种素材各一个）。
  // 点哪一行的「选择…」就临时把 accept 换成那一行要的类型，选完读成 data URI。
  var fileEl = document.createElement('input')
  fileEl.type = 'file'
  fileEl.style.display = 'none'
  var pendingAsset = null      // 这次文件框是替哪一行开的

  // —— 草稿 ——
  // 音效那几项**不按角色存**，所以不在 lay 里，是单独一份草稿。
  var draftSound = RICE_SOUND_DEFAULT
  var draftSoundOn = true
  var draftSoundVol = 5
  var snapshotSound = RICE_SOUND_DEFAULT
  var snapshotSoundOn = true
  var snapshotSoundVol = 5
  // 碗落地那一声也是草稿（同样不按角色存）：它和音效是同一类东西，
  // 只是"哪一行读哪份草稿"由 store 区分（sound / drop）。
  var draftDrop = DROP_SOUND_DEFAULT
  var snapshotDrop = DROP_SOUND_DEFAULT
  // 随机偷吃那两项也是草稿（和音效一样不按角色存）。
  // 它们是**纯宿主行为** —— 客户端只负责摆到面板上、再捎回去保存。
  var draftRandomSteal = true
  var draftChancePct = 50
  var snapshotRandomSteal = true
  var snapshotChancePct = 50
  // 自动唱歌那两项同理：纯宿主行为（宿主报时、页面放歌），也是草稿制的。
  var draftAutoSing = true
  var draftAutoSingMin = 5
  var snapshotAutoSing = true
  var snapshotAutoSingMin = 5
  // 余额警报那两项（开关 + 放哪一首）。同一个理由：不按角色存，草稿制。
  // ⚠️ **开关只管我们这一半** —— 真正响还要鲸鱼那条「余额预警」开着（见 maybeAlarm）。
  var draftAlarmOn = true
  var draftAlarmSong = ''
  var snapshotAlarmOn = true
  var snapshotAlarmSong = ''

  // 生成器查到的元素都收在这里。renderPanel 只认 refs ——
  // 于是"面板长什么样"和"面板怎么变"是两件事，加一行不用改 renderPanel。
  var refs = {
    checks: {}, notes: {}, nums: {},
    targets: [], steps: [], assets: [], ranges: [], only: [],
    // 下拉选择行（目前只有"余额警报音"一行）：{row, sel}
    selects: [],
    // showIf：某一行"只在某个开关打开时才显示"（比如概率滑杆之于随机偷吃）。
    // 和 only 是两回事：only 跟着"当前在调米粒还是碗"走，showIf 跟着某个勾选框走。
    showIf: [],
    hint: null,
    sing: null,        // 页脚那个唱歌按钮（{btn, label}）
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text !== undefined && text !== null) n.textContent = text
    return n
  }
  function rowEl(cls) { return el('div', 'dshrice-row' + (cls ? ' ' + cls : '')) }
  function btn(cls, text) { var b = el('button', cls); b.type = 'button'; if (text) b.textContent = text; return b }

  function buildRow(r) {
    var n, i, b
    if (r.type === 'check') {
      n = rowEl()
      var lab = el('label')
      var cb = el('input')
      cb.type = 'checkbox'
      cb.setAttribute('data-check', r.key)
      refs.checks[r.key] = cb
      lab.appendChild(cb)
      lab.appendChild(document.createTextNode(' ' + r.label))
      if (r.tip) lab.title = r.tip
      n.appendChild(lab)
      if (r.note) {
        var nt = el('span', 'dshrice-mut')
        refs.notes[r.note] = nt
        n.appendChild(nt)
      }
      return n
    }
    if (r.type === 'targets') {
      n = rowEl()
      for (i = 0; i < r.items.length; i++) {
        b = btn('dshrice-t', r.items[i].label)
        b.setAttribute('data-t', r.items[i].id)
        refs.targets.push(b)
        n.appendChild(b)
      }
      return n
    }
    if (r.type === 'dpad') {
      n = el('div', 'dshrice-pad')
      var cells = [
        [-1, -1, '↖'], [0, -1, '↑'], [1, -1, '↗'],
        [-1, 0, '←'], [0, 0, ''], [1, 0, '→'],
        [-1, 1, '↙'], [0, 1, '↓'], [1, 1, '↘'],
      ]
      for (i = 0; i < cells.length; i++) {
        if (!cells[i][2]) { n.appendChild(btn('dshrice-blank', '·')); continue }
        b = btn(null, cells[i][2])
        b.setAttribute('data-dx', cells[i][0])
        b.setAttribute('data-dy', cells[i][1])
        n.appendChild(b)
      }
      return n
    }
    if (r.type === 'size') {
      n = rowEl()
      n.appendChild(document.createTextNode(r.label + ' '))
      b = btn(null, '−'); b.setAttribute('data-size', '-1'); n.appendChild(b)
      var num = el('span', 'dshrice-num')
      refs.nums.size = num
      n.appendChild(num)
      b = btn(null, '＋'); b.setAttribute('data-size', '1'); n.appendChild(b)
      return n
    }
    if (r.type === 'steps') {
      n = rowEl()
      var q = el('span', 'dshrice-mut dshrice-q', r.label)
      if (r.tip) q.title = r.tip
      n.appendChild(q)
      for (i = 0; i < r.marks.length; i++) {
        b = btn('dshrice-s', String(r.marks[i]))
        b.setAttribute('data-step', String(r.marks[i]))
        refs.steps.push(b)
        n.appendChild(b)
      }
      n.appendChild(el('span', 'dshrice-mut', '%'))
      return n
    }
    if (r.type === 'rotate') {
      n = rowEl('dshrice-rotrow')
      n.appendChild(document.createTextNode(r.label + ' '))
      b = btn(null, '−'); b.setAttribute('data-rot', '-1'); n.appendChild(b)
      var rnum = el('span', 'dshrice-num')
      refs.nums.rot = rnum
      n.appendChild(rnum)
      b = btn(null, '＋'); b.setAttribute('data-rot', '1'); n.appendChild(b)
      n.appendChild(el('span', 'dshrice-mut', r.per + '°／次'))
      if (r.only) {
        n.setAttribute('data-only', r.only)
        refs.only.push(n)
      }
      return n
    }
    if (r.type === 'asset') {
      n = rowEl()
      n.appendChild(document.createTextNode(r.label + ' '))
      b = btn(null, r.accept.indexOf('audio') === 0 ? '选择音频…' : '选择图片…')
      b.setAttribute('data-asset', r.key)
      n.appendChild(b)
      b = btn(null, '默认')
      b.title = '换回插件自带的那个'
      b.setAttribute('data-assetdef', r.key)
      n.appendChild(b)
      var nm = el('span', 'dshrice-mut')
      refs.assets.push({ row: r, name: nm })
      n.appendChild(nm)
      return n
    }
    if (r.type === 'range') {
      n = rowEl()
      n.appendChild(document.createTextNode(r.label + ' '))
      var rg = el('input')
      rg.type = 'range'
      rg.min = String(r.min)
      rg.max = String(r.max)
      rg.step = String(r.step)
      rg.setAttribute('data-range', r.key)
      var vnum = el('span', 'dshrice-num')
      refs.ranges.push({ row: r, input: rg, num: vnum })
      n.appendChild(rg)
      n.appendChild(vnum)
      if (r.unit) n.appendChild(el('span', 'dshrice-mut', r.unit))
      // 只在某个勾选框打开时才显示 —— 交给 renderPanel 每次统一判
      if (r.showIf) refs.showIf.push({ el: n, key: r.showIf })
      return n
    }
    if (r.type === 'note') {
      n = rowEl()
      n.appendChild(el('span', 'dshrice-mut dshrice-q', r.text))
      return n
    }
    if (r.type === 'select') {
      // 从"服务器给的名单里挑一个"（目前只有余额警报音）。
      // 之所以要下拉框而不是文件选择框：音频文件走 data URI 会把配置撑到几 MB，
      // 而配置**每轮轮询都会整个传一遍** —— 那是致命开销。所以音频一律"放目录里、选名字"。
      n = rowEl()
      n.appendChild(document.createTextNode(r.label + ' '))
      var sel = el('select', 'dshrice-sel')
      sel.setAttribute('data-select', r.key)
      if (r.tip) sel.title = r.tip
      var entry = { row: r, sel: sel }
      refs.selects.push(entry)
      n.appendChild(sel)
      // 试听：不试听就没法知道"这首到底是哪个文件"，而警报要等到余额低才响。
      // ⚠️ 它是个**开关**（试听 ↔ 停止），不是一个只往前走的按钮 ——
      //    用户点它放出来的东西，必须能用同一个按钮停掉。按钮上写什么就得是什么。
      if (r.preview) {
        var pb = btn(null, r.preview)
        pb.title = '放出来听听是哪首（再点一下停）· 不会保存'
        pb.setAttribute('data-alarmpreview', r.key)
        entry.previewBtn = pb
        entry.previewLabel = r.preview
        n.appendChild(pb)
      }
      if (r.showIf) refs.showIf.push({ el: n, key: r.showIf })
      return n
    }
    return rowEl()
  }

  function buildPanel() {
    for (var g = 0; g < PANEL.length; g++) {
      var grp = PANEL[g]
      var box = el('div', 'dshrice-grp' + (grp.open ? ' dshrice-grp-open' : ''))
      box.setAttribute('data-grp', grp.id)
      var head = btn('dshrice-grp-h', grp.title)
      head.setAttribute('data-g', grp.id)
      box.appendChild(head)
      var bodyBox = el('div', 'dshrice-grp-b')
      for (var i = 0; i < grp.rows.length; i++) bodyBox.appendChild(buildRow(grp.rows[i]))
      box.appendChild(bodyBox)
      menuEl.appendChild(box)
    }
    var foot = el('div', 'dshrice-foot')
    for (var f = 0; f < PANEL_FOOT.length; f++) {
      var it = PANEL_FOOT[f]
      var fb = btn(it.cls)
      var lab = el('span', null, it.label)
      if (it.icon) {
        // 图标放在文字前面。**pointer-events:none** —— 否则点在图标上时
        // e.target 是那个 <img>，按钮就"点空了"（处理器里另有一层 closest 兜底）。
        var ic = el('img')
        ic.src = it.icon
        ic.alt = ''
        ic.setAttribute('aria-hidden', 'true')
        // 图取不到（比如 npm 版没带这张、或者从 file:// 打开）就**安静地不显示** ——
        // 别在按钮上留一个裂图标。按钮本身（文字）照样能用。
        ic.addEventListener('error', function () { ic.style.display = 'none' })
        fb.appendChild(ic)
      }
      fb.appendChild(lab)
      if (it.title) fb.title = it.title
      foot.appendChild(fb)
      if (it.id === 'sing') refs.sing = { btn: fb, label: lab, title: it.title || '' }
    }
    refs.hint = el('span', 'dshrice-mut dshrice-hint')
    foot.appendChild(refs.hint)
    menuEl.appendChild(foot)
    menuEl.appendChild(fileEl)      // 隐藏的文件选择框跟着面板走
  }
  buildPanel()
  var mHint = refs.hint

  var riceOn = true
  var timers = []

  // 可调参数：真实值来自宿主（~/.dsh/.dsh-rice-config.json），这里是兜底默认。
  // ⚠️ 这组必须和 lib/index.js 里 DEFAULT_CONFIG 保持一致 ——
  // 两边不一致时，配置取不到的瞬间画面会跳一下。
  // 版面的那几项是**在真实立绘上一点点调出来的**，不是算出来的。
  var cfg = {
    tier1Below: 0.5, tier2Below: 2, bitesMax: 3,
    pollMs: 3000, stepMs: 560, grainMs: 1750,
    // 随机偷吃：开 = 不再每轮都吃（掷中才吃，没掷中攒到下次一起吃）；关 = 老规矩。
    // 这两项**只在宿主半边用得上** —— 客户端只是把它们放到面板上、捎回去保存。
    randomSteal: true,
    stealChancePct: 50,
    // 开工时自动唱一首。宿主订阅 DSH 的 turn/start，页面每次轮询 observe 时
    // 顺手把"最近一次开工的时刻"捎回来（**不额外发请求**）——
    // 音频只能由页面自己放，所以宿主只能"报时"，不能推。
    autoSingOn: true,
    autoSingMin: 5,
    bowlLeft: 71, bowlTop: 75.4, bowlWidth: 33, bowlHeight: 21.5,
    // 碗的两层图（饭 + 空碗，都是 196×196、预先对齐）。
    // 饭分波峰/波谷 —— 峰时段一口吃掉的钱更多，那碗就该更丰盛。
    // 哪一张由鲸鱼的 isPeak 决定；任一取不到就整组退回内联 SVG。
    // 空字符串 = 用内联 SVG。它们按角色存（换个角色可以换一套碗）。
    // 默认值只写一份（上面那几个常量），面板里的「默认」按钮和这里指的是同一个值。
    bowlImage: BOWL_DEFAULT,
    foodPeakImage: FOOD_PEAK_DEFAULT,
    foodValleyImage: FOOD_VALLEY_DEFAULT,
    grainLeft: 73, grainTop: 85.4, grainWidth: 10, grainMinPx: 0,
    grainImage: RICE_DEFAULT,   // 兜底默认：作者画的那张（随包发布，已获授权）
    grainRotate: 0,
    // 彩蛋：连着按 ↑ → ↓ ↓ ↓ 触发。布尔值单独接 —— 它走的是"要不要这功能"，
    // 而不是"她多大"。
    eggOn: true,
    // 指令输完之后延迟多久才弹图标 + 挨那一下。存在的理由：
    // 最后一下按键的"滴"声会被"图标弹出 + 打击音效"盖住，往后推一点才听得清。
    // 数值取决于音效多长，而它测不出来（MediaRecorder 的 WebM 不写 Duration），
    // 所以它是可调的，不是算出来的。
    eggLeadMs: 300,
    // 实机调出来的三个值 —— 和 lib/index.js 保持一致。
    // ⚠️ **它们是相对"她自己那张图"的百分比**，不是相对 .dshwv-body ——
    // 后者是个会随视口/缩放变化的正方形，用它当参照系位置会漂。
    // **也不按角色存**（不在 LAYOUT_KEYS 里）：图标只要"压在她身上"就行，
    // 不像米粒那样必须对准嘴。面板里也故意没有入口 —— 多一个按钮就等于剧透。
    eggIconPct: 19,
    eggLeftPct: 57, eggTopPct: 28,
    // —— 吃饭的音效 ——
    // 只在"最后放下碗"那一刻响**一次**，**音量随口数变大**。
    // 这不是装饰，是信息：光靠听就知道这顿吃得多不多。
    // 和米粒图一样用户能自己换（面板里选一个音频文件 → 读成 data URI）；
    // 空字符串 = 不响。**不按角色存** —— 它和"她长什么样"无关。
    riceSound: RICE_SOUND_DEFAULT,
    riceSoundOn: true,
    // 碗被打翻、扣到地上那一声。**不按角色存**，理由和上面那条一样。
    // 它是字符串，所以和图片一样单独接（不在 CFG_KEYS 那串数字键里）。
    dropSound: DROP_SOUND_DEFAULT,
    // 音量刻度 0~10（默认 5）—— **和用户看到的是同一个数**。
    // 它是数字，所以 CFG_KEYS 那套通用拷贝就能把它带过来。
    riceSoundVol: 5,
    // —— 余额警报音 ——
    // 判据不是我定的数：读鲸鱼自己的「余额预警」（usage-settings.json 的 alert.on/below），
    // 于是"余额不足"只有一个真身，用户改线只改鲸鱼那一个数字。
    // **两边都开才响**：alarmOn && 鲸鱼的 alert.on。
    alarmOn: true,
    // 放 alarm/ 目录里的哪一首。**和 songs/ 是两套**。
    // 默认那一首是随包发的（群主的通用音效）—— 开箱就有声音；自己的文件不随包发。
    // 它和 dropSound 一样是字符串，所以和图片一样单独接（不在 CFG_KEYS 那串数字键里）。
    alarmSong: '冰冰冰.mp3',
    chewOriginX: 50, chewOriginY: 86,
    // —— 「扣在头顶」的落点 ——
    // 坐标和 bowlLeft/bowlTop 同一套（x = 碗的中心、y = 碗的上边，都相对 .dshwv-body）。
    // ⚠️ 它**按角色存**（在 LAYOUT_KEYS 里）—— 每个角色的头顶位置都不一样，
    //    而且立绘只占容器右下 59.45% 那个方块，所以这几个数不能凭感觉写。
    // 面板里选「头顶」就能调（选中时碗会停在落点上给你看，挪一下动一下）。
    // ⚠️ 这组数是**调出来的**：当初按比例估的 43/23 实测差了近 30 个点。
    headLeft: 75, headTop: 51,
    // 点她抓到（打断吃饭）时，碗**直接飞头顶**的机会（百分比 0~100）。
    // 存在的理由：不知道彩蛋的人也该有机会撞见这一幕 —— 所以它小（10%）。
    // 彩蛋炸弹那条路**必定**触发，不看这个数。`0` = 只留彩蛋那条。
    // **面板里没有这一项**：这个数是要定下来的手感，不是天天要拧的旋钮；
    // 真要改就改配置文件（和 pollMs / stepMs 一样）。
    headChancePct: 70,
  }
  var CFG_KEYS = [
    'tier1Below', 'tier2Below', 'bitesMax', 'pollMs', 'stepMs', 'grainMs',
    'bowlLeft', 'bowlTop', 'bowlWidth', 'bowlHeight',
    'grainLeft', 'grainTop', 'grainWidth', 'grainMinPx', 'grainRotate',
    // 「扣在头顶」的落点：数字，走通用拷贝。
    // **注意它同时在 LAYOUT_KEYS 里**（按角色存）—— 这两件事不冲突：
    // CFG_KEYS 管的是"从宿主取回来"，LAYOUT_KEYS 管的是"这东西要不要分角色"。
    'headLeft', 'headTop',
    // 点她抓到之后"碗直接飞头顶"的概率。**不按角色存**（跟长相无关，是行为）。
    'headChancePct',
    'eggIconPct', 'eggLeftPct', 'eggTopPct',
    // eggLeadMs 也在这里：它要从宿主传过来。但它**不在 LAYOUT_KEYS 里** ——
    // 那是"延迟多久"，和角色长什么样无关。
    'eggLeadMs',
    // 音效音量也是数字，同样走通用拷贝；同样不按角色存
    'riceSoundVol',
    // 随机偷吃的概率也是数字，同样走通用拷贝；**不按角色存**（她偷不偷吃跟长相无关）
    'stealChancePct',
    // 自动唱歌的最小间隔（分钟）。也是数字，同样走通用拷贝；同样不按角色存。
    'autoSingMin',
    'chewOriginX', 'chewOriginY',
  ]
  // —— 按角色各存一份版面 ——
  // 0.3.0 起鲸鱼支持多角色，而**不同角色的头部角度可能完全不同** ——
  // 换个角色，碗和米粒就得重调。客户端从鲸鱼图片的 src 里就能读出当前角色：
  //   默认角色 → image.png          其它角色 → role-image.png?id=<角色id>
  // 于是"在哪个角色上调，就存给哪个角色"这句话可以全自动成立 ——
  // **用户不需要知道"角色"这个概念。**
  // ⚠️ 彩蛋那三个**不在**这里 —— 它们不按角色存。
  // 米粒要对准"嘴"这个解剖位置，只能每个角色各调一遍；
  // 图标只要压在她身上就行 —— 对齐精度要求不同，存储粒度就可以不同。
  var LAYOUT_KEYS = [
    'bowlLeft', 'bowlTop', 'bowlWidth', 'bowlHeight',
    // 碗那三张图也在按角色存的范围内 —— 换个角色可以换一套碗，
    // 和 grainImage 是同一个道理。
    'bowlImage', 'foodPeakImage', 'foodValleyImage',
    'grainLeft', 'grainTop', 'grainWidth', 'grainImage', 'grainRotate',
    'chewOriginX', 'chewOriginY',
    // 「被炸到头上」的落点（它按角色存，理由同碗与米粒：
    //  每个角色的头顶在哪儿都不一样 —— 见 headLeft/headTop 那段注释）
    'headLeft', 'headTop',
  ]
  var lay = {}          // 当前角色**生效**的版面（全局值被角色覆盖之后的结果）
  var roleNow = ''

  function activeRole() {
    // **首选 localStorage['dshw-role']** —— 那是鲸鱼自己在 applyRole() 里写下的，
    // 是权威来源，而且完全不依赖 DOM 结构。
    //
    // 血的教训：之前只看图片的 src，结果在某个自定义角色上判断失败、
    // 一直被当成默认角色 —— 于是"保存"全落进了全局，
    // **把默认角色的版面也一起改掉了**。用权威来源就不会有这类误判。
    try {
      var saved = window.localStorage.getItem('dshw-role')
      if (saved) return saved
    } catch (err) {}
    // 退路：从图片的 src 里认（老版本或 localStorage 不可用时）
    var img = whaleImg()
    if (!img) return null
    var src = img.getAttribute('src') || ''
    var m = /role-image\.png\?id=([^&]+)/.exec(src)
    return m ? decodeURIComponent(m[1]) : 'default'
  }

  function renderChipTitle() {
    if (!chipEl) return
    chipEl.title = '偷吃白饭：点击开关　·　当前角色 ' + (roleNow || '?') +
      (roleNow && roleNow !== 'default' ? '（改版面只存给这个角色）' : '（改版面存回全局）')
  }

  function resolveRole() {
    var rid = activeRole() || 'default'
    var over = (cfg.perRole && cfg.perRole[rid]) || {}
    for (var i = 0; i < LAYOUT_KEYS.length; i++) {
      var k = LAYOUT_KEYS[i]
      lay[k] = (over[k] !== undefined) ? over[k] : cfg[k]
    }
    roleNow = rid
    renderChipTitle()
    return rid
  }

  // 换了角色就重算并重绘 —— 由下面的 watch 循环每 700ms 调一次，所以切换是自动生效的。
  // 拿到 null（找不到她）就什么都不做：那多半只是她在重建 DOM，不是真的换角色。
  function roleChanged() {
    var now = activeRole()
    if (!now || now === roleNow) return false
    resolveRole()
    renderLayout()
    renderGrainArt()
    return true
  }

  function applyCfg(next) {
    if (!next || typeof next !== 'object') return
    cfgSeen = true      // 配置到过 —— 余额警报的判定要等这个（见 maybeAlarm 的调用处）
    for (var i = 0; i < CFG_KEYS.length; i++) {
      var v = next[CFG_KEYS[i]]
      if (typeof v === 'number' && isFinite(v)) cfg[CFG_KEYS[i]] = v
    }
    // 图是字符串，不在上面那串数字键里，单独接
    if (typeof next.grainImage === 'string') cfg.grainImage = next.grainImage
    // 碗那三张图也是字符串，同样单独接
    if (typeof next.bowlImage === 'string') cfg.bowlImage = next.bowlImage
    if (typeof next.foodPeakImage === 'string') cfg.foodPeakImage = next.foodPeakImage
    if (typeof next.foodValleyImage === 'string') cfg.foodValleyImage = next.foodValleyImage
    // 开关是布尔，同样不在那串数字键里 —— 漏掉这行的后果是"配置里改了没用"
    if (typeof next.eggOn === 'boolean') cfg.eggOn = next.eggOn
    if (typeof next.riceSoundOn === 'boolean') cfg.riceSoundOn = next.riceSoundOn
    if (typeof next.randomSteal === 'boolean') cfg.randomSteal = next.randomSteal
    if (typeof next.autoSingOn === 'boolean') cfg.autoSingOn = next.autoSingOn
    // 余额警报：一个布尔、一个字符串 —— 都不在那串数字键里，各接各的。
    // 漏掉这行的后果和 grainImage 那次一样："配置文件里改了没用"。
    if (typeof next.alarmOn === 'boolean') cfg.alarmOn = next.alarmOn
    // 音效路径/数据也是字符串
    if (typeof next.riceSound === 'string') cfg.riceSound = next.riceSound
    if (typeof next.dropSound === 'string') cfg.dropSound = next.dropSound
    // 余额警报音：也是字符串（一个 alarm/ 里的文件名）
    if (typeof next.alarmSong === 'string') cfg.alarmSong = next.alarmSong
    // perRole 是"每个角色一份覆盖值"的对象，整块接过来
    if (next.perRole && typeof next.perRole === 'object') cfg.perRole = next.perRole

    // ⚠️ 面板开着的时候**绝不能重算 lay** —— lay 同时是"当前生效值"和"面板里的草稿"，
    // 而轮询每几秒就来一次，重算会把用户正在调的位置冲掉，
    // 症状就是"移动之后过一会儿自己弹回原位"。
    // 关掉面板后的下一次轮询自然会重新对齐（那时草稿已经保存或放弃了）。
    if (menuOpen) return

    resolveRole()
    renderLayout()
    renderGrainArt()
  }

  function renderChip() {
    chipEl.classList.toggle('dshrice-off', !riceOn)
  }

  // ------------------------------------------------------ 面板的交互 ----
  var menuOpen = false
  var target = 'grain'     // grain | bowl | chew
  var step = 0.5
  var snapshot = null      // 打开面板那一刻的版面值 —— "重置"就是回到它

  // 面板里的元素由 buildPanel() 生成并收进 refs，这里不再逐个 querySelector ——
  // 加一行只改 PANEL，不用再来这里补一句。

  // ---------------------------------------------------------------- 彩蛋 ----
  // 两个指令、两张图标。**做成一张表** —— 再加第三个只是加一行。
  // 图取不到就彻底不出现：不弹裂图、不报错，安静地当没这回事。
  // （两张都是游戏素材，只放本地 art/，不进发布包 —— 见 README。）
  //
  // 打击感刻意做得不同：
  //   500KG 是一发 —— 图标一亮，她缩一下
  //   380mm 火力网是持续轰击 —— 图标亮得久，她连着缩好几下
  var EGGS = [
    {
      src: '/dsh-rice/egg-1.png',
      seq: ['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowDown', 'ArrowDown'],
      ms: 1400, hits: 1,
    },
    {
      src: '/dsh-rice/egg-2.png',
      seq: ['ArrowRight', 'ArrowDown', 'ArrowUp', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowDown'],
      ms: 3000, hits: 6,
    },
  ]
  EGGS.forEach(function (egg) {
    var el = document.createElement('img')
    el.className = 'dshrice-egg'
    el.alt = ''
    el.src = egg.src
    el.addEventListener('error', function () { el.style.display = 'none' })
    egg.el = el
    egg.timer = null
  })
  // 她"被砸中"的时候放一声 —— **用鲸鱼自己的按压音效，走它公开的路由**。
  // 不碰它的内部代码，而且**尊重用户自己的设置**：他关了音效就不响，音量跟着他调。
  // 设置只取一次并缓存，不会每挨一下就问一遍。
  var whaleSound = null        // null = 还没取过；false = 取不到，以后不再试
  function withSoundSettings(cb) {
    if (whaleSound !== null) { cb(whaleSound); return }
    fetch('/dsh-whale/size.json').then(function (r) { return r.json() }).then(function (s) {
      whaleSound = s || false
      cb(whaleSound)
    }).catch(function () { whaleSound = false })
  }
  function hitSound() {
    var play = function (s) {
      if (!s || s.sound === false) return
      try {
        var a = new Audio('/dsh-whale/sound/press.mp3?set=' + encodeURIComponent(s.soundSet || 'duck'))
        a.volume = (typeof s.vol === 'number') ? s.vol : 0.4
        var p = a.play()
        if (p && p.catch) p.catch(function () {})
      } catch (err) {}
    }
    withSoundSettings(play)
  }

  // —— 方向键的"滴"声 ——
  // 每按一下方向键响一下（在"碰过她"的窗口内，和彩蛋同一道门）。
  // 这一声不是装饰：**它让"输入被记住了"变成听得见的反馈**。
  // 绝地潜兵里输入指令时也是每按一下响一声 —— 所以它本身就是那个梗的一部分。
  //
  // ⚠️ 必须**预加载 + currentTime=0 + play()**。
  // 每次都 new Audio 或 fetch 的话，第一次按下的延迟会明显到听得出来。
  // ⚠️ 也**不能"等设置取回来才响"** —— 那样第一声会晚。
  //    所以：设置已经知道就按它放；还不知道就先用默认音量放，同时后台把设置取回来。
  var tickEl = null
  function ensureTick() {
    if (tickEl) return tickEl
    try {
      tickEl = new Audio('/dsh-rice/arrow-tick.weba')
      tickEl.preload = 'auto'
    } catch (err) { tickEl = false }
    return tickEl
  }
  function playTick() {
    if (whaleSound && whaleSound.sound === false) return        // 他静音了，就别响
    if (whaleSound === null) withSoundSettings(function () {})  // 后台把设置取回来
    var el = ensureTick()
    if (!el) return
    try {
      var base = (whaleSound && typeof whaleSound.vol === 'number') ? whaleSound.vol : 0.4
      el.volume = Math.max(0, Math.min(1, base * 0.55))  // 比"被砸中"轻：它是 UI 反馈
      el.currentTime = 0
      var p = el.play()
      if (p && p.catch) p.catch(function () {})
    } catch (err) {}
  }

  // —— 吃饭的音效 ——
  // **每吃一口响一次**（不是只在收尾响一声）。
  // 音量 = **用户设的 0~10 刻度** × 0.1 × 鲸鱼自己的 vol ——
  // 所以调鲸鱼的总音量仍然管用，而这里那个数是"她自己"的音量。
  //   3 / 10 × 鲸鱼的 0.4 = 实际 0.12
  // 和方向键那声共用同一套规矩：预加载 + currentTime=0 + 尊重鲸鱼的静音设置。
  // 也**和米粒图一样可以被用户换掉**（面板里选一个音频，存成 data URI）。
  //
  // ⚠️ 实测：音效比两口之间的间隔（stepMs 560ms）**短**，
  //    所以每一声都是完整的、不叠加 —— 节奏干净是"声 → 静 → 声"。
  //    （我一开始按 5 KB 的体积估它 0.6~1.2 秒，估错了；实际码率更高、长度更短。）
  //
  // 音量刻度**就是用户看到的那个：0~10**（默认 5）。存 0~10 而非 0~1，
  // 是因为配置文件是给人看的 —— 文件里写 0.5、界面显示 5 就成了两个东西，迟早对不上。
  function riceVolume() {
    var v = (typeof cfg.riceSoundVol === 'number' && isFinite(cfg.riceSoundVol)) ? cfg.riceSoundVol : 5
    return Math.max(0, Math.min(10, v)) / 10
  }
  // —— 两声共用同一套播放机制 ——
  // 「每口一声」和「碗落地」是同一种东西：一小段音频、同一个音量刻度、同一个总开关。
  // 所以"按源缓存元素 → 套音量 → 按下去"这三步只写一次，两边只是源不同。
  // （两个元素而不是一个：落碗那一声不该把正在响的一口掐掉。）
  function newClip() { return { el: null, src: null, bad: false } }
  // 返回 true = 按下去了（不代表一定出声，浏览器可能拦，见下）。
  function playClip(clip, src) {
    if (!src) return false
    // 换了源就得重建元素 —— 预加载过的旧元素里装的是旧声音
    if (!clip.el || clip.src !== src) {
      try {
        clip.el = new Audio(src)
        clip.el.preload = 'auto'
        clip.bad = false
        // ⚠️ **只有"加载失败"才算坏（error 事件）。**
        //    早先 play() 被拒也置 bad，而那是"浏览器还没允许出声"，不是文件的问题 ——
        //    后果：页面上还没点过任何东西时吃了一口，**这一整局就再也听不到吃饭声了**，
        //    而且试吃还会报"音频文件取不到"，把人往错的方向带。现在被拦只当这一声没响，
        //    下一口照样试（用户一点页面，它就又能响了）。
        clip.el.addEventListener('error', function () { clip.bad = true })
        clip.src = src
      } catch (err) { clip.el = null; return false }
    }
    if (clip.bad) return false
    try {
      var base = (whaleSound && typeof whaleSound.vol === 'number') ? whaleSound.vol : 0.4
      clip.el.volume = Math.max(0, Math.min(1, base * riceVolume()))
      clip.el.currentTime = 0
      var p = clip.el.play()
      if (p && p.catch) p.catch(function () {})     // 被拦住：不出声，但**不记仇**
    } catch (err) { return false }
    return true
  }
  var riceClip = newClip()
  var dropClip = newClip()

  // **返回"没响的原因"，响了就返回空字符串。**
  // 存在的理由：没声音的时候用户完全不知道为什么 —— 开关关了？音量 0？
  // 文件坏了？还是鲸鱼那边静音了？四个原因，零个提示。
  // 试吃按钮会把这句显示出来，所以它是**排查**用的，不是"确认"用的。
  function playRiceSound() {
    if (!cfg.riceSoundOn) return '音效开关关着'
    if (!cfg.riceSound) return '没有选择音频文件'
    if (riceVolume() === 0) return '音量是 0'
    if (whaleSound && whaleSound.sound === false) return '鲸鱼插件那边把音效关掉了'
    if (whaleSound === null) withSoundSettings(function () {})
    if (!playClip(riceClip, cfg.riceSound)) {
      return riceClip.el ? '音频文件取不到（art/ 里有它吗？改过文件之后重启过吗？）' : '音频元素建不起来'
    }
    return ''
  }
  // 碗被打翻、扣到地上那一声。规矩和上面那声一样（同一个开关、同一个刻度），
  // 只是它不需要"为什么没响"的诊断 —— 它不在试吃那条路上，没人会去按它。
  function playDropSound() {
    if (!cfg.riceSoundOn) return
    if (!cfg.dropSound) return
    if (riceVolume() === 0) return
    if (whaleSound && whaleSound.sound === false) return
    if (whaleSound === null) withSoundSettings(function () {})
    playClip(dropClip, cfg.dropSound)
  }

  // 她缩一下脖子 —— 复用咀嚼那套变换，不新增 CSS
  function flinch() {
    var img = whaleImg()
    if (!img) return
    img.classList.add('dshrice-chew')
    setTimeout(function () { img.classList.remove('dshrice-chew') }, 280)
    hitSound()
  }
  function fireEgg(egg) {
    if (!egg || !egg.el || egg.el.style.display === 'none') return
    placeEgg()          // 先按实测像素摆好再显示 —— 免得第一帧出现在错的地方
    egg.el.classList.add('dshrice-egg-show')
    for (var h = 0; h < egg.hits; h++) {
      setTimeout(flinch, Math.round(h * (egg.ms / (egg.hits + 1))))
    }
    if (egg.timer) clearTimeout(egg.timer)
    egg.timer = setTimeout(function () {
      egg.el.classList.remove('dshrice-egg-show')
    }, egg.ms)
    // —— 正在吃饭的时候被炸到：碗会被掀上去扣在她头顶 ——
    // 这是"彩蛋里套彩蛋"：那两串方向键本来是打她的，而**她饭碗正举着**的时候，
    // 挨这一下碗就飞了 —— 所以不需要新指令，也不需要新按钮。
    // （不在吃的时候照旧：只有爆炸和她那一下哆嗦。）
    if (eating) bowlToHead()
  }

  // 提示文字统一从这里写：设了毫秒数就会在到点后淡出、再清空。
  // 所有写提示的地方都必须走它 —— 否则残留的定时器会把新的提示一起清掉。
  var hintTimer = null
  function setHint(text, ms) {
    if (hintTimer) { clearTimeout(hintTimer); hintTimer = null }
    if (!text) { mHint.textContent = ''; mHint.style.opacity = ''; return }
    mHint.textContent = text
    mHint.style.opacity = '1'
    if (!ms) return
    hintTimer = setTimeout(function () {
      hintTimer = null
      mHint.style.opacity = '0'                       // 先淡出（.3s 的过渡）
      setTimeout(function () {
        if (!hintTimer) mHint.textContent = ''        // 期间没有新提示才清空
      }, 320)
    }, ms)
  }

  function pairOf(t) {
    if (t === 'bowl') return ['bowlLeft', 'bowlTop']
    if (t === 'chew') return ['chewOriginX', 'chewOriginY']
    if (t === 'egg') return ['eggLeftPct', 'eggTopPct']
    // 「头顶」**在面板里**（和「图标」不一样，理由写在 PANEL 那段）：
    // 这条落点"点她抓到"也有机会走到，而且换个角色必须重调 ——
    // 藏着一个用户根本调不了的参数，比剧透更糟。
    if (t === 'head') return ['headLeft', 'headTop']
    return ['grainLeft', 'grainTop']
  }
  function sizeKeyOf(t) {
    if (t === 'bowl') return 'bowlWidth'
    if (t === 'chew') return null
    if (t === 'egg') return 'eggIconPct'
    // 「头顶」只有位置，没有大小 —— 返回 null 让「大小」那一行失效，
    // 否则它会去改米粒的宽度（默认分支是 grainWidth），那是错的。
    if (t === 'head') return null
    return 'grainWidth'
  }

  // —— 素材/滑杆的取值 ——
  // 同一个 key 可能在 lay 里（按角色存），也可能在音效草稿里（不按角色存）。
  // 这两种存放方式只在 store 上有区别，所以整段逻辑只写一次。
  function assetEntry(key) {
    for (var i = 0; i < refs.assets.length; i++) {
      if (refs.assets[i].row.key === key) return refs.assets[i]
    }
    return null
  }
  function assetGet(r) {
    if (r.store === 'sound') return draftSound
    if (r.store === 'drop') return draftDrop
    var v = lay[r.key]
    return (v === undefined || v === null) ? '' : v
  }
  function assetSet(r, v) {
    if (r.store === 'sound') { draftSound = v; draftSoundOn = true; return }
    if (r.store === 'drop') { draftDrop = v; return }
    lay[r.key] = v
  }
  // 显示成一句人话，而不是一串路径（更别说是 data URI 那种几万字符）
  function assetName(r) {
    if (r.store !== 'drop' && !draftSoundOn) return '已关'
    var v = assetGet(r)
    if (!v) return r.empty || '内置'
    return (v === r.def) ? '自带' : '自定义'
  }
  function rangeGet(r) {
    if (r.store === 'sound') return draftSoundVol
    if (r.store === 'chance') return draftChancePct
    if (r.store === 'autosing') return draftAutoSingMin
    return (typeof cfg[r.key] === 'number') ? cfg[r.key] : r.min
  }
  function rangeSet(r, v) {
    if (r.store === 'sound') { draftSoundVol = v; return }
    if (r.store === 'chance') { draftChancePct = v; return }
    if (r.store === 'autosing') { draftAutoSingMin = v; return }
    cfg[r.key] = v
  }

  // —— 下拉行（"从服务器给的名单里挑一个"）——
  // 名单是 songs.json 里 alarm 那一份（见 loadSongs）。
  // ⚠️ 音频**不能**像图片那样存成 data URI：配置每轮轮询都会整个传一遍，
  //    几 MB 的歌塞进去就是每 3 秒搬一次。所以音频一律"放目录里、只存文件名"。
  function selectValue(r) {
    if (r.store === 'alarm') return draftAlarmSong
    return String(cfg[r.key] || '')
  }
  function selectSet(r, v) {
    if (r.store === 'alarm') { draftAlarmSong = v; return }
    cfg[r.key] = v
  }
  function selectOptions(r) {
    if (r.store === 'alarm') return alarmList
    return []
  }
  function fillSelect(entry) {
    var r = entry.row
    var list = selectOptions(r)
    // 选项只在"名单变了"的时候重建 —— 每次 renderPanel 都重建会把用户正在拉的下拉关掉。
    var sig = list.map(function (o) { return o.file }).join('\u0000')
    if (entry.sig !== sig) {
      entry.sig = sig
      entry.sel.textContent = ''
      var none = el('option', null, r.empty || '（无）')
      none.value = ''
      entry.sel.appendChild(none)
      for (var i = 0; i < list.length; i++) {
        var o = el('option', null, list[i].name)
        o.value = list[i].file
        entry.sel.appendChild(o)
      }
    }
    var v = selectValue(r)
    // 选了一个已经不在名单里的文件（删了/改名了）—— 明说"不在目录里"，
    // 而不是悄悄跳回第一项（那会让人以为保存错了）。
    var has = (v === '')
    for (var j = 0; j < list.length; j++) { if (list[j].file === v) has = true }
    var ghost = entry.sel.querySelector('option[data-ghost]')
    if (!has) {
      if (!ghost) {
        ghost = el('option', null, '')
        ghost.setAttribute('data-ghost', '1')
        entry.sel.appendChild(ghost)
      }
      ghost.value = v
      ghost.textContent = v + '（不在目录里）'
    } else if (ghost) {
      entry.sel.removeChild(ghost)
    }
    entry.sel.value = v
  }

  function renderPanel() {
    refs.checks.riceOn.checked = riceOn
    refs.checks.soundOn.checked = draftSoundOn
    if (refs.checks.randomSteal) refs.checks.randomSteal.checked = draftRandomSteal
    if (refs.checks.autoSing) refs.checks.autoSing.checked = draftAutoSing
    // ⚠️ **每个勾选框都必须在这里被画一遍** —— 漏一个的后果就是"界面在骗人"：
    //    `<input type=checkbox>` 的默认 DOM 状态是未勾选，于是刷新之后它显示成"关着"，
    //    而配置里其实是开着的（用户会以为功能坏了、或者以为刚才那次播放把它关掉了）。
    //    这条真漏过一次（alarmOn）—— 所以 panel-shape 探针现在会逐个核对，见那条断言。
    if (refs.checks.alarmOn) refs.checks.alarmOn.checked = draftAlarmOn
    if (refs.notes.role) refs.notes.role.textContent = roleNow === 'default' ? '默认角色' : '角色专属'
    // showIf：这一行只在某个勾选框打开时才显示。
    // （比如"概率"之于"随机偷吃" —— 关掉随机之后那个滑杆是纯噪声。）
    for (var s = 0; s < refs.showIf.length; s++) {
      var cb = refs.checks[refs.showIf[s].key]
      refs.showIf[s].el.style.display = (cb && cb.checked) ? '' : 'none'
    }
    var sk = sizeKeyOf(target)
    if (refs.nums.size) refs.nums.size.textContent = sk ? String(Math.round(lay[sk] * 10) / 10) : '—'
    if (refs.nums.rot) refs.nums.rot.textContent = Math.round(lay.grainRotate || 0) + '°'
    // 只对某个目标有意义的行（旋转对碗没意义）—— 藏起来，
    // 免得看着像"碗也能转"。（哪一行藏由数据里的 only 决定。）
    for (var i = 0; i < refs.only.length; i++) {
      refs.only[i].style.display = (refs.only[i].getAttribute('data-only') === target) ? '' : 'none'
    }
    for (var j = 0; j < refs.targets.length; j++) {
      refs.targets[j].classList.toggle('dshrice-on', refs.targets[j].getAttribute('data-t') === target)
    }
    for (var k = 0; k < refs.steps.length; k++) {
      refs.steps[k].classList.toggle('dshrice-on', Number(refs.steps[k].getAttribute('data-step')) === step)
    }
    for (var a = 0; a < refs.assets.length; a++) {
      refs.assets[a].name.textContent = assetName(refs.assets[a].row)
    }
    for (var q = 0; q < refs.selects.length; q++) {
      fillSelect(refs.selects[q])
      // 试听那个按钮跟着"警报在不在放"翻字：正在放 → 「停止」。
      // 一个按钮管两件事，但**同一时刻只写它会做的那一件**。
      var sb = refs.selects[q].previewBtn
      if (sb) {
        var want = alarmPlaying ? '停止' : refs.selects[q].previewLabel
        if (sb.textContent !== want) sb.textContent = want
        sb.classList.toggle('dshrice-on', !!alarmPlaying)
        sb.title = alarmPlaying ? '停下这首（试听和余额警报都是它）' : '放出来听听是哪首（再点一下停）· 不会保存'
      }
    }
    for (var g = 0; g < refs.ranges.length; g++) {
      var rr = refs.ranges[g]
      var v = Math.max(rr.row.min, Math.min(rr.row.max, rangeGet(rr.row)))
      // **界面上这个数就是配置里那个数** —— 不做任何换算，否则迟早对不上。
      rr.input.value = String(v)
      rr.num.textContent = String(v)
    }
    // 选中「图标」时让它常显，否则根本没法调（它平时只在彩蛋那几秒里出现）。
    // 和米粒同一个道理：**正在调它**才让它显示。
    // （面板里没有「图标」这个目标 —— 多一个按钮就等于剧透；这条留给需要时用。）
    EGGS.forEach(function (egg) {
      if (egg.el) egg.el.classList.toggle('dshrice-egg-hold', target === 'egg')
    })
    // 「正在调的那个东西」该不该显示、碗该摆成什么姿态 —— 全交给它一处判。
    // （放在这儿还有个作用：**方向键挪一下就要重摆一次**，不然碗不会跟着动。）
    syncTuneHold()
  }

  function nudge(dx, dy) {
    var p = pairOf(target)
    lay[p[0]] = Math.round((lay[p[0]] + dx * step) * 100) / 100
    lay[p[1]] = Math.round((lay[p[1]] + dy * step) * 100) / 100
    renderLayout()
    renderPanel()
  }

  function resize(d) {
    var k = sizeKeyOf(target)
    if (!k) return
    if (k === 'bowlWidth') {
      // 碗要锁住 200:130 的比例，否则会拉扁
      var ratio = lay.bowlHeight / lay.bowlWidth
      lay.bowlWidth = Math.max(2, Math.round((lay.bowlWidth + d * step) * 100) / 100)
      lay.bowlHeight = Math.round(lay.bowlWidth * ratio * 100) / 100
    } else {
      lay[k] = Math.max(1, Math.round((lay[k] + d * step) * 100) / 100)
    }
    renderLayout()
    renderPanel()
  }

  function openMenu() {
    menuOpen = true
    snapshot = {}
    for (var i = 0; i < LAYOUT_KEYS.length; i++) snapshot[LAYOUT_KEYS[i]] = lay[LAYOUT_KEYS[i]]
    // 音效那几项不在 LAYOUT_KEYS 里（不按角色存），单独取草稿和快照
    draftSound = cfg.riceSound || ''
    draftSoundOn = cfg.riceSoundOn !== false
    draftSoundVol = (typeof cfg.riceSoundVol === 'number') ? cfg.riceSoundVol : 5
    draftDrop = (typeof cfg.dropSound === 'string') ? cfg.dropSound : DROP_SOUND_DEFAULT
    snapshotSound = draftSound
    snapshotSoundOn = draftSoundOn
    snapshotSoundVol = draftSoundVol
    snapshotDrop = draftDrop
    // 随机偷吃那两项同理：不按角色存，也是草稿制的
    draftRandomSteal = cfg.randomSteal !== false
    draftChancePct = (typeof cfg.stealChancePct === 'number') ? cfg.stealChancePct : 50
    snapshotRandomSteal = draftRandomSteal
    snapshotChancePct = draftChancePct
    // 自动唱歌同理
    draftAutoSing = cfg.autoSingOn !== false
    draftAutoSingMin = (typeof cfg.autoSingMin === 'number') ? cfg.autoSingMin : 5
    snapshotAutoSing = draftAutoSing
    snapshotAutoSingMin = draftAutoSingMin
    // 余额警报同理：开关 + 放哪一首
    draftAlarmOn = cfg.alarmOn !== false
    draftAlarmSong = (typeof cfg.alarmSong === 'string') ? cfg.alarmSong : ''
    snapshotAlarmOn = draftAlarmOn
    snapshotAlarmSong = draftAlarmSong
    // 顺手把两份名单取回来（她唱的歌 + 警报音）—— 这样"往 alarm/ 里丢一首、
    // 打开面板就能选"，不用刷新页面、也不用重启。
    loadSongs(function () { if (menuOpen) renderPanel() })
    setHint('')
    menuEl.classList.add('dshrice-open')
    renderPanel()
    // 米粒该不该常显，统一由 syncTuneHold 判 —— 面板开着**不等于**该显示它。
    syncTuneHold()
    // 先渲染再摆放：摆放要读实测高度，此时才量得准。
    placeMenu()
  }
  function closeMenu() {
    menuOpen = false
    menuEl.classList.remove('dshrice-open')
    // 试听是你为了"听一下"才放的：关面板 = 你看完了，就把那首停掉。
    // ⚠️ **真的余额提醒不停** —— 那个是提醒，关面板去看余额是自然的下一步。
    if (alarmPlaying && alarmPreview) stopAlarm()
    // menuOpen 已经是 false 了，所以这一句会把"停给你看的碗/常显的米粒"一起收回去。
    syncTuneHold()
    EGGS.forEach(function (egg) {
      if (egg.el) egg.el.classList.remove('dshrice-egg-hold')
    })
  }

  // —— 米粒要不要常显 ——
  // 判据：**她静止、而且你正在调它**才显示。四个条件缺一不可：
  //   · 面板开着
  //   · 「位置微调」那一组是展开的（收起的时候你根本没在调）
  //   · 当前目标是「米粒」（选「碗」的时候它只是碍事 —— 和「旋转」那一行同一个道理）
  //   · 她**没在唱歌**
  // 最后那条是用户报上来的：米粒是钉在鲸鱼容器上的，而她唱歌时是**整张立绘在上下晃**，
  // 米粒跟不上、就那么挂在嘴角 —— 看起来像坏了。
  function layoutGroupOpen() {
    for (var gi = 0; gi < PANEL.length; gi++) {
      if (PANEL[gi].id === 'layout') return PANEL[gi].open !== false
    }
    return false
  }
  // 三个目标共用同一个判据（面板开着 + 那一组展开着 + 目标就是它 + 她没在唱）。
  function tuneHoldOn(t) {
    return !!menuOpen && !singing && layoutGroupOpen() && target === t
  }
  // 碗在"调参预览"里的姿态：端着 / 扣在头顶；null = 收回去（恢复由类和各段动画说了算）。
  // ⚠️ 「碗」和「头顶」用的是**同一个碗**，只是姿态不同 ——
  //    碗平时是**隐形**的（只有端起来才显形），所以调它必须让它显形，否则就是盲调
  //    （这一条是用户报上来的："选择碗的位置微调时看不到碗"）。
  function tuneBowlMode() {
    if (!menuOpen || singing || eating || !layoutGroupOpen()) return null
    if (target === 'head') return 'head'
    if (target === 'bowl') return 'bowl'
    return null
  }
  // 扣着的碗里没有饭（和真播时那条规则一致，否则会以为"碗里还有米饭"那个 bug 又回来了）
  function setBowlFoodOpacity(v) {
    var els = bowlEl.querySelectorAll('.dshrice-bowl-food,.dshrice-bowl-rice')
    for (var i = 0; i < els.length; i++) els[i].style.opacity = v
  }
  function parkBowl(mode) {
    if (!mode && !bowlParked) return          // 本来就没停着，别白动 DOM
    if (mode === bowlParked && !mode) return
    bowlParked = mode
    if (!mode) {
      bowlEl.style.transform = ''
      bowlEl.classList.remove('dshrice-up')
      setBowlFoodOpacity('')
      return
    }
    bowlEl.classList.add('dshrice-up')
    if (mode === 'head') {
      var p = headPoint(lay)
      bowlEl.style.transform = 'translate(' + p.ax + '%,' + p.ay + '%) rotate(-180deg)'
      setBowlFoodOpacity('0')
    } else {
      // 端着的样子：位置就是它平时的位置（由 .dshrice-up 那个类给），
      // 所以这里**只清 inline transform**，绝不能自己写一个 —— 那会和动画抢。
      bowlEl.style.transform = ''
      setBowlFoodOpacity('')                 // 端着的时候饭要在（那就是"一碗饭"）
    }
  }
  function syncTuneHold() {
    grainEl.classList.toggle('dshrice-hold', tuneHoldOn('grain'))
    // 每次几何一变（方向键挪、改大小）都要重新摆一次 —— "挪一下、它动一下"就是靠这里。
    parkBowl(tuneBowlMode())
  }

  // —— 面板摆在哪儿 ——
  // 两条硬要求：
  //   ① **不许压在她身上。** 鲸鱼"拖动"和"点一下弹余额"都只在**按到她身上**时才触发
  //      （它内部有一张逐像素的 alpha 命中图，那张图整个落在立绘矩形里），
  //      她自己的 ☰ 按钮也在立绘矩形的右上角。
  //      —— 所以面板压上去 = 拖不动、点不出气泡、☰ 也点不到，两边交互打架。
  //   ② **收起/展开不许换地方。** 所以"放哪边"只看几何，**不看当前高度**；
  //      高度不够时让它**在内部滚**，而不是换个位置。
  //
  // 做法：列几个候选位，**每个候选都自带"这样放能有多高"** ——
  // 于是"选它"就等于"不压到她"。按优先级试，第一个够用的就是它。
  // 面板挂在 document.body 上，所以鲸鱼自己的 transform / 缩放都不影响这套换算。
  var MENU_GAP = 8
  var MENU_PAD = 12
  // ⚠️ **首选永远是"整个方块上方"**（她上方那块空地）——
  // 那里既没有她，也没有余额气泡，是最干净的位置。
  // 只有那块地真的矮到没法用时（鲸鱼放到最大、屏幕又矮），才换到旁边/下方。
  // 宁可面板变矮、在里面滚，也不换到会挡住余额气泡的位置上去。
  var MENU_MIN_ABOVE = 120
  var MENU_MIN_H = 140       // 实在没地方时的最小可用高度（内部滚）
  function placeMenu() {
    if (!menuOpen) return
    // ⚠️ **几何要从"不晃的那个盒子"上量**，见 whaleBoxes() 那段注释。
    //    唱歌时 .dshwv-body 自己在上下晃，直接量它会得到一份跟着抖的坐标 ——
    //    面板每 700ms 重摆一次，于是它的高度跟着她的晃动一跳一跳，
    //    顶边却钉在原地："菜单没动，可菜单里那一行在上下抽"就是这么来的。
    var g = whaleBoxes()
    if (!g) return
    var b = g.b
    var i = g.i
    var vw = window.innerWidth
    var vh = window.innerHeight
    var mw = menuEl.offsetWidth || 252
    var maxH = Math.max(MENU_MIN_H, vh - MENU_PAD * 2)

    // ⚠️ **别用"临时把 max-height 放开、量完再收回去"的办法量高度。**
    //    那一步会让面板瞬间高过内容 → 滚动范围归零 → 浏览器把 scrollTop 夹回 0；
    //    再收回 max-height 也回不来了。而 watch() 每 700ms 重摆一次，
    //    于是"往下翻着看"的人会被反复弹回最上面。
    //    scrollHeight 直接就是"内容有多高"，和 max-height 无关，一次读到位。
    var wantH = menuEl.scrollHeight || menuEl.offsetHeight || 0

    var leftOfHer = i.left - MENU_GAP - mw
    // 每个候选：放哪（left / ref 基准线）、在基准线上方还是下方、那一边还剩多少高度
    var cands = [
      // ① **整个方块上方** —— 余额气泡、立绘、她的 ☰，一次全躲开。首选。
      { left: b.right - mw, ref: b.top, above: true, avail: b.top - MENU_GAP - MENU_PAD, min: MENU_MIN_ABOVE },
      // ② 她旁边（左边）—— 面板右边缘落在立绘左边缘之外，横向就不重叠了
      { left: leftOfHer, ref: i.top, above: false, avail: maxH, min: 0, fit: leftOfHer >= MENU_PAD },
      // ③ 她下方 —— 她被人拖到屏幕顶部时走这条
      { left: i.right - mw, ref: i.bottom, above: false, avail: vh - i.bottom - MENU_GAP - MENU_PAD, min: MENU_MIN_H },
    ]
    var pick = null
    for (var ci = 0; ci < cands.length; ci++) {
      var c = cands[ci]
      if (c.fit === false) continue          // 放不下（会被夹回来、于是压到她）
      var avail = Math.min(maxH, c.avail)
      if (avail < c.min) continue
      pick = {
        left: c.left,
        top: c.above ? (c.ref - MENU_GAP - Math.min(wantH, avail)) : c.ref,
        cap: avail,
      }
      break
    }
    if (!pick) {
      // ④ 三边都没地方（鲸鱼放到最大 + 屏幕又矮又窄）：认了 ——
      //    尽量多留一点高度，夹进视口，允许压到她。
      var capFallback = Math.max(MENU_MIN_H, Math.min(maxH, b.top - MENU_GAP - MENU_PAD))
      pick = { left: b.right - mw, top: b.top - MENU_GAP - Math.min(wantH, capFallback), cap: capFallback }
    }

    // 值没变就**一个字都不写** —— 每 700ms 无脑重设一次样式，是上面那个
    // "滚动条弹回顶"同类问题的温床：能不动 DOM 就不动。
    var nextMax = Math.round(pick.cap) + 'px'
    if (menuEl.style.maxHeight !== nextMax) menuEl.style.maxHeight = nextMax
    var mh = Math.min(wantH, pick.cap)
    var left = Math.max(MENU_PAD, Math.min(pick.left, vw - mw - MENU_PAD))
    var top = Math.max(MENU_PAD, Math.min(pick.top, vh - mh - MENU_PAD))
    if (top < MENU_PAD) top = MENU_PAD
    var nextLeft = Math.round(left) + 'px'
    var nextTop = Math.round(top) + 'px'
    if (menuEl.style.left !== nextLeft) menuEl.style.left = nextLeft
    if (menuEl.style.top !== nextTop) menuEl.style.top = nextTop
  }

  // 标签：点它开合面板（不再是直接开关 —— 开关搬进面板里了）
  chipEl.addEventListener('click', function (e) {
    e.stopPropagation()
    if (menuOpen) closeMenu(); else openMenu()
  })

  refs.checks.riceOn.addEventListener('change', function () {
    riceOn = refs.checks.riceOn.checked
    renderChip()
    if (!riceOn) stopEating()
    try {
      fetch('/dsh-rice/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ riceOn: riceOn }),
      })
    } catch (err) {}
  })
  // 音效开关是草稿：点保存才写回（和音量、音效文件一个规矩）
  refs.checks.soundOn.addEventListener('change', function () {
    draftSoundOn = refs.checks.soundOn.checked
    if (draftSoundOn) previewSound(draftSound)
    renderPanel()
  })
  // 随机偷吃开关也是草稿。它是**纯宿主行为**，客户端只是把它捎回去保存 ——
  // 所以这里除了记草稿、顺手更新一下"概率那一行显不显示"，没别的事可做。
  refs.checks.randomSteal.addEventListener('change', function () {
    draftRandomSteal = refs.checks.randomSteal.checked
    renderPanel()
  })
  // 开工自动唱也是草稿（同样不按角色存）。保存才写回磁盘，和别的草稿一个规矩；
  // 但"要不要唱"当场就要认账 —— 见 autoSingWanted()。
  if (refs.checks.autoSing) refs.checks.autoSing.addEventListener('change', function () {
    draftAutoSing = refs.checks.autoSing.checked
    renderPanel()
  })
  // 余额警报的开关同样是草稿。它只关我们这一半 ——
  // 真正响还要鲸鱼那条「余额预警」开着（见 maybeAlarm）。
  if (refs.checks.alarmOn) refs.checks.alarmOn.addEventListener('change', function () {
    draftAlarmOn = refs.checks.alarmOn.checked
    renderPanel()
  })
  // 下拉行（警报音）：换了只改草稿，**点保存才写回** —— 和素材行同一个规矩。
  for (var si = 0; si < refs.selects.length; si++) {
    (function (entry) {
      entry.sel.addEventListener('change', function () {
        selectSet(entry.row, entry.sel.value)
        setHint('记得点「保存」', 2500)
      })
    })(refs.selects[si])
  }

  // 滑杆：拖的时候只更新读数，**松手才试听一声** ——
  // 不然 input 事件会在拖动过程中连响几十次。
  for (var ri = 0; ri < refs.ranges.length; ri++) {
    (function (rr) {
      rr.input.addEventListener('input', function () {
        rangeSet(rr.row, parseInt(rr.input.value, 10) || 0)
        rr.num.textContent = rr.input.value
      })
      rr.input.addEventListener('change', function () {
        rangeSet(rr.row, parseInt(rr.input.value, 10) || 0)
        rr.num.textContent = rr.input.value
        // 拖音量松手试听一声 —— 两个音效共用一个刻度，所以听哪个都行（听每口那声）
        if (rr.row.store === 'sound' && draftSoundOn) previewSound(draftSound)
      })
    })(refs.ranges[ri])
  }

  menuEl.addEventListener('click', function (e) {
    e.stopPropagation()
    // ⚠️ 用 closest 往上找按钮，而不是要求 e.target 就是按钮 ——
    // 因为按钮里可能带子元素（比如唱歌按钮的图标）。
    // 但**必须再确认它在这个面板里**：不确认的话，点在面板空白处会一路
    // 往上找到页面上别的按钮上去。
    var b = e.target && e.target.closest ? e.target.closest('button') : null
    if (!b || !menuEl.contains(b)) return
    // 分组开合。高度变了，得重新夹一次视口。
    var g = b.getAttribute('data-g')
    if (g) {
      var box = b.parentElement
      if (box) box.classList.toggle('dshrice-grp-open')
      // **同时写回数据** —— 数据是真身，DOM 上的类只是它的投影。
      // （syncTuneHold 要问"位置微调那一组开着吗"，问的是数据。）
      var nowOpen = box ? box.classList.contains('dshrice-grp-open') : false
      for (var gi = 0; gi < PANEL.length; gi++) {
        if (PANEL[gi].id === g) PANEL[gi].open = nowOpen
      }
      syncTuneHold()
      placeMenu()
      return
    }
    // 唱歌：点一下开始，再点一下停
    if (b.classList.contains('dshrice-sing')) { toggleSing(); return }
    // 警报音试听：**不动配置**，只是把当前选中的那首放出来听一句
    var apk = b.getAttribute('data-alarmpreview')
    if (apk) { previewAlarm(); return }
    // 换素材：选一个文件 / 换回默认
    var ak = b.getAttribute('data-asset')
    if (ak) {
      var ae = assetEntry(ak)
      if (ae) pickAsset(ae.row)
      return
    }
    var ad = b.getAttribute('data-assetdef')
    if (ad) {
      var de = assetEntry(ad)
      if (de) {
        assetSet(de.row, de.row.def)
        renderLayout(); renderGrainArt(); renderPanel()
        if (de.row.store === 'sound') previewSound(draftSound)
        setHint('已切回默认素材', 3000)
      }
      return
    }
    var t = b.getAttribute('data-t')
    var dx = b.getAttribute('data-dx')
    var dy = b.getAttribute('data-dy')
    var sz = b.getAttribute('data-size')
    var st = b.getAttribute('data-step')
    var rt = b.getAttribute('data-rot')
    if (t) { target = t; renderPanel(); syncTuneHold(); return }
    if (b.classList.contains('dshrice-try')) {
      // 试吃：跑一次完整的动画（碗浮上来、扒三口、落下、露米粒）。
      // 顺手也是"没事让她吃着玩"的按钮 —— 它只画动画，不碰账。
      // **传 true = 绕过主开关**：关掉偷吃白饭之后，它照样能拿来对位置、听音效。
      //
      // 歌**不停**：她一边唱一边偷吃是看得见的（晃动在容器上、咀嚼在立绘上，互不干扰），
      // 吃饭那几声则由 eatRice 里的 duckSong 负责"让音乐让一让"，不是把音乐掐掉。
      eatRice(4.8, true)
      return
    }
    if (dx !== null && dy !== null) { nudge(Number(dx), Number(dy)); return }
    if (sz !== null) { resize(Number(sz)); return }
    if (st !== null) { step = Number(st); renderPanel(); return }
    if (rt !== null) {
      lay.grainRotate = Math.round(((lay.grainRotate || 0) + Number(rt) * 5) * 10) / 10
      renderLayout(); renderPanel(); return
    }
    if (b.classList.contains('dshrice-reset')) {
      if (snapshot) for (var i = 0; i < LAYOUT_KEYS.length; i++) lay[LAYOUT_KEYS[i]] = snapshot[LAYOUT_KEYS[i]]
      draftSound = snapshotSound
      draftSoundOn = snapshotSoundOn
      draftSoundVol = snapshotSoundVol
      draftDrop = snapshotDrop
      draftRandomSteal = snapshotRandomSteal
      draftChancePct = snapshotChancePct
      draftAutoSing = snapshotAutoSing
      draftAutoSingMin = snapshotAutoSingMin
      draftAlarmOn = snapshotAlarmOn
      draftAlarmSong = snapshotAlarmSong
      renderLayout(); renderGrainArt(); renderPanel()
      setHint('已回到打开时的值', 3000)
      return
    }
    if (b.classList.contains('dshrice-save')) {
      var patch = {}
      for (var j = 0; j < LAYOUT_KEYS.length; j++) patch[LAYOUT_KEYS[j]] = lay[LAYOUT_KEYS[j]]
      // 音效那几项不在 LAYOUT_KEYS 里（不按角色存），但要能从这里保存 ——
      // 所以单独带上。它们的草稿是 draftSound / draftSoundOn / draftSoundVol。
      patch.riceSound = draftSound
      patch.riceSoundOn = draftSoundOn
      patch.riceSoundVol = draftSoundVol
      // 碗落地那一声也单独带上（同样不按角色存）
      patch.dropSound = draftDrop
      // 随机偷吃那两项也一样：不在 LAYOUT_KEYS 里（不按角色存），单独带上
      patch.randomSteal = draftRandomSteal
      patch.stealChancePct = draftChancePct
      // 开工自动唱那两项同理
      patch.autoSingOn = draftAutoSing
      patch.autoSingMin = draftAutoSingMin
      // 余额警报那两项也带上（同样不按角色存）
      patch.alarmOn = draftAlarmOn
      patch.alarmSong = draftAlarmSong
      setHint('保存中…')
      try {
        fetch('/dsh-rice/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        }).then(function (r) { return r.json() }).then(function (res) {
          var to = res && res.savedTo
          // 4 秒后淡出 —— 存完还想接着改的人，不该被一句常挂的提示挡着
          setHint(to && to !== 'default' ? '已存给该角色' : '已存为全局', 4000)
        }).catch(function () { setHint('保存失败', 6000) })
      } catch (err) { setHint('保存失败', 6000) }
    }
  })

  // —— 换素材：米粒图 / 碗 / 波峰饭 / 波谷饭 / 吃饭音效 ——
  // **五张素材走同一段代码**，因为它们本来就是同一件事：换一张图、或换一个声音。
  // 想再加一个可换的素材 = 往 PANEL 里加一行 asset，这里一个字都不用改。
  // 用 data URI 而不是"把文件放进 art/ 目录"：用户不该为了换张图去碰文件系统。
  function pickAsset(r) {
    pendingAsset = r
    fileEl.accept = r.accept
    // 清空 value —— 否则同一个文件选第二次不会触发 change
    fileEl.value = ''
    fileEl.click()
  }
  fileEl.addEventListener('click', function (e) { e.stopPropagation() })
  fileEl.addEventListener('change', function () {
    var r = pendingAsset
    var f = fileEl.files && fileEl.files[0]
    pendingAsset = null
    if (!r || !f) return
    var fr = new FileReader()
    fr.onload = function () {
      assetSet(r, String(fr.result))
      // 米粒图和碗的比例都跟着"用哪张图"走，所以要连版面一起重画
      renderLayout()
      renderGrainArt()
      renderPanel()
      // 音效 / 碗落地：**选完就试听** —— 比"保存后再去听"少一轮来回
      if (r.store === 'sound') previewSound(draftSound)
      if (r.store === 'drop') previewSound(draftDrop)
      setHint('选好了，点保存生效', 4000)
    }
    fr.onerror = function () { setHint('读文件失败', 5000) }
    fr.readAsDataURL(f)
  })

  // 试听：临时放一下，不走缓存的那个元素 —— 免得把正在用的源换掉。
  // **音量用草稿值**，不然拖完滑杆试听还是旧音量，等于白调。
  function previewSound(src) {
    if (!src) return
    try {
      var a = new Audio(src)
      var base = (whaleSound && typeof whaleSound.vol === 'number') ? whaleSound.vol : 0.4
      a.volume = Math.max(0, Math.min(1, base * (Math.max(0, Math.min(10, draftSoundVol)) / 10)))
      var p = a.play()
      if (p && p.catch) p.catch(function () {})
    } catch (err) {}
  }

  // ---------------------------------------------------------------- 唱歌 ----
  // 「唱歌」= 放一首歌，再点一下停。
  // 歌单来自宿主扫的 `<插件根>/songs/` 文件夹：**把歌丢进去就行** ——
  // 不用改文件名（文件名就是歌名）、不用填路径、也不用重启（宿主每次请求都重扫）。
  // 一首就唱那首，多首随机一首。
  // 刻意**不做进度条**：那会让一个"逗她玩"的按钮变成一个播放器，
  // 而这里真正需要的只有两件事 —— 开始、停。
  var songList = null        // null = 还没取过；数组 = 取回来的歌单
  // 余额警报音那份名单（alarm/ 目录）。**和歌单分开存** ——
  // 「唱歌」永远只认 songs，警报只认这一份，两套列表不可能互相混进去。
  var alarmList = []
  var songAudio = null
  var songAudioUrl = ''      // 记着元素里装的是哪首 —— 同一首就不重设 src
  var singing = false
  // 这一首是不是"开工自动"唱的。自动唱的**她一开吃就停**（见 eatRice）；
  // 手动点的不停 —— 那是用户自己要听的，只压小、不掐断。
  var songAuto = false
  var songNowName = ''       // 正在放的那首叫什么（「留住」时要把标题写回去）
  var lastSongUrl = ''       // 用来避免"随机到连着两遍同一首"

  // —— 她在唱歌的时候吃饭，歌要让一让 ——
  // 吃饭那几声（每一口一声）会被音乐盖住，而"她一边唱一边偷吃"又是个值得看/听的组合，
  // 所以**不掐歌，改成临时压小**：吃饭那几下里歌降到 25%，完了自己回来。
  // （早先的做法是"点试吃就把歌停掉" —— 那是为了保住试吃的诊断能力，
  //   但代价是你再也看不到这个组合了。压小两全：既听得见那几声，歌也没断。）
  var SONG_DUCK = 0.25
  var duckTimer = null
  function songBaseVolume() {
    return (whaleSound && typeof whaleSound.vol === 'number') ? whaleSound.vol : 0.4
  }
  function applySongVolume(scale) {
    if (!songAudio) return
    try { songAudio.volume = Math.max(0, Math.min(1, songBaseVolume() * scale)) } catch (err) {}
  }
  function duckSong(ms) {
    applySongVolume(SONG_DUCK)
    if (duckTimer) clearTimeout(duckTimer)
    duckTimer = setTimeout(function () {
      duckTimer = null
      applySongVolume(1)
    }, ms)
  }
  function unduckSong() {
    if (duckTimer) { clearTimeout(duckTimer); duckTimer = null }
    applySongVolume(1)
  }

  function singBtnOn(on) {
    if (!refs.sing) return
    refs.sing.btn.classList.toggle('dshrice-on', !!on)
    // 三个状态，不是一个开关：
    //   没在唱 → 「唱歌」
    //   自动在唱 → 「留住」（点它是**接管**，不是停 —— 见 keepSing）
    //   手动在唱 → 「停止」
    // 按钮上写什么，点下去就得是什么，否则用户会以为坏了。
    refs.sing.label.textContent = !on ? '唱歌' : (songAuto ? '留住' : '停止')
  }
  function stopSing() {
    singing = false
    songAuto = false
    if (songAudio) { try { songAudio.pause() } catch (err) {} }
    unduckSong()          // 别留一个还没到点的"把音量还回去"
    singBtnOn(false)
    if (refs.sing) refs.sing.btn.title = refs.sing.title
    // 晃的是**容器**（见样式那段注释）—— 米粒和碗都挂在它下面，所以它们会跟着一起停。
    var body = whaleBody()
    if (body) body.classList.remove('dshrice-singing')
    syncTuneHold()      // 她不晃了，米粒可以回来了（如果这会儿正在调它）
  }
  function loadSongs(cb) {
    // ⚠️ **只能回调一次。** 下面两个 then 都会走到 cb；
    // 万一 cb 自己抛了（比如浏览器不给建 Audio 元素），那个异常会掉进 .catch 里
    // 让 cb 再跑一遍 —— 于是"唱一次"变成"唱两次"。用 once 把它掐死。
    var done = false
    var once = function () { if (done) return; done = true; cb() }
    fetch('/dsh-rice/songs.json', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (d) {
        songList = (d && d.songs) || []
        // 顺手把警报音那份名单也拿回来（同一条路由、一次请求）——
        // 于是"往 alarm/ 里丢一首，打开面板就能选"，不用刷新也不用重启。
        alarmList = (d && d.alarm) || []
        once()
      })
      .catch(function () { songList = []; alarmList = []; once() })
  }
  function pickSong() {
    if (!songList || !songList.length) return null
    if (songList.length === 1) return songList[0]
    // 多首时**别连着唱同一首** —— "随机"不等于"可以连着重复"
    for (var i = 0; i < 8; i++) {
      var s = songList[Math.floor(Math.random() * songList.length)]
      if (s.url !== lastSongUrl) return s
    }
    return songList[0]
  }
  // viaAuto = 这是"开工自动唱"，不是用户点的。
  // 区别**只在于要不要说话**：自动唱是顺便唱一首，用户没在等它，
  // 所以没歌、静音、被浏览器拦住 —— 一律安静收场（顶多在控制台留一句）。
  // 手动点的时候必须说话：点了没反应又不给理由，用户只会以为按钮坏了。
  function startSing(viaAuto) {
    var auto = !!viaAuto
    // 警报还在放 → 别开新歌（警报优先度最高）。手动的要说一句，自动的安静收场。
    // 提示里**指出去哪儿停** —— 只说"还在放"等于让人干瞪眼。
    if (alarmPlaying) {
      if (!auto) setHint('余额警报还在放（面板里点「停止」）', 5000)
      return
    }
    // **每次都重新取歌单** —— 于是"往 songs/ 里丢一首，直接点就能唱"，
    // 不用刷新页面。请求很小（就是一串文件名），本地往返可以忽略。
    var go = function () {
      var s = pickSong()
      if (!s) { if (!auto) setHint('songs/ 里还没有歌', 6000); return }
      // 尊重鲸鱼自己的静音开关 —— 和"被砸中"、"吃饭"一个规矩。
      if (whaleSound && whaleSound.sound === false) {
        if (!auto) setHint('鲸鱼那边把音效关掉了', 6000)
        return
      }
      if (whaleSound === null) withSoundSettings(function () {})
      if (!songAudio) {
        // 建元素也要兜住 —— 建不起来就说一声，别让上面那个 once 白转一圈
        try {
          songAudio = new Audio()
          songAudio.preload = 'auto'
          // 放完自己收回去 —— 否则按钮会一直"按着"，而它写着"停止"却已经没声了
          songAudio.addEventListener('ended', function () { stopSing() })
          songAudio.addEventListener('error', function () {
            // songAuto 是"此刻在放的是不是自动那首" —— 自动唱放不出来就安静收场
            if (!songAuto) setHint('这首歌放不出来（格式？文件坏了？）', 8000)
            stopSing()
          })
        } catch (err) {
          songAudio = null
          if (!auto) setHint('音频元素建不起来', 6000)
          return
        }
      }
      if (songAudioUrl !== s.url) { songAudio.src = s.url; songAudioUrl = s.url }
      // 音量就用**鲸鱼自己那个 vol**（默认 0.4）—— 不去另开一套音量，
      // 于是"把挂件声音调小"对她唱歌一样管用。
      applySongVolume(1)
      try { songAudio.currentTime = 0 } catch (err) {}
      var p = null
      try { p = songAudio.play() } catch (err) {}
      if (p && p.catch) p.catch(function () {
        // 自动唱被浏览器拦住是**规则，不是坏了**：页面还没有过任何交互时就不许出声。
        // 这种情况不该打扰正在干活的人，留一句 console 就够了。
        if (auto) console.warn('[dsh-rice] 开工自动唱被浏览器拦住了（页面还没有过交互）')
        else setHint('浏览器拦住了播放，再点一下试试', 6000)
        stopSing()
      })
      singing = true
      songAuto = auto
      songNowName = s.name
      singBtnOn(true)
      if (refs.sing) {
        refs.sing.btn.title = auto
          ? '开工自动唱的这首：点一下留住（留住了她开吃也不停）'
          : '正在唱：' + s.name + '（再点一下停止）'
      }
      var body = whaleBody()
      if (body) body.classList.add('dshrice-singing')
      if (!auto) setHint('♪ ' + s.name, 4000)
      lastSongUrl = s.url
      syncTuneHold()    // 她开始晃了 —— 米粒跟上不，那就别挂了
    }
    loadSongs(go)
  }
  // —— 自动唱的那首，点一下 = **留住**，不是停 ——
  // 这是有意的：那首歌是"你没要求、她顺手唱的"，所以你可能正听得入神，
  // 那一下**不该把你正在听的东西掐掉**。留住之后它就变成"手动那首"：
  // 她开吃也不停（只压小），再点一下才是停（那时按钮已经写着「停止」）。
  // 换句话说：点一下 = "这首归我了"，点两下 = 别放了。
  function keepSing() {
    songAuto = false
    singBtnOn(true)      // 标签跟着从「留住」变「停止」
    if (refs.sing) refs.sing.btn.title = '正在唱：' + songNowName + '（再点一下停止）'
    setHint('留住了：她开吃也不会停', 3000)
  }
  function toggleSing() {
    if (!singing) { startSing(false); return }
    if (songAuto) { keepSing(); return }
    stopSing()
  }

  // —— 余额不足时放一首（"雨爱"那种）——
  // 判据**不是我定的数，也不新增一个数**：读鲸鱼自己的「余额预警」
  // （`/dsh-whale/usage-settings.json` 里的 `alert.on` / `alert.below`）。
  // 于是"余额不足"只有一个真身 —— 用户要改线，就在鲸鱼面板里改那一个数字，
  // 我们下次打开页面就跟着变。**两边都开才响**（它的 alert.on + 我们的 alarmOn）。
  //
  // 时机：**每打开一次页面只判一次、最多放一次**（sessionStorage 记着）。
  //   · 同一个标签页刷新**不重复放**（调试时不用听十遍）；
  //   · 新开标签页 / 重开桌面客户端才算"打开 DSH"。
  //   所以它不是实时警报：页面里把余额花到线下**不会**响，下次打开才响。
  //
  // 优先级：**高于「唱歌」**（包括已经"留住"的那首）—— 警报是警报，歌是歌。
  // 音量：仍然只用鲸鱼那个 vol（音量只有一处真身）；但它有自己的开关，
  //   不挂在「音效开关」上 —— 有人关了吃饭声，却正是想要这个提醒。
  // ⚠️ 键名带 `-fired`：它存的是"**这一局放过了**"。
  //   早先那版存的是"判过了"（含义不同）—— 所以**改名**，让旧构建留下的标记自然失效，
  //   否则升级之后那个标签页会带着一个陈旧的"已判"标记、这一局再也不会响。
  var ALARM_ONCE_KEY = 'dshrice-alarm-fired'
  var alarmAudio = null
  var alarmUrlNow = ''
  var alarmPlaying = false
  // 这一次是"你点出来的试听"还是"真的余额提醒"。
  // 唯一的区别：**关面板时试听会停，真提醒不会** ——
  // 提醒响了、你关掉面板去看余额，是件很自然的事，不该顺手把它掐了。
  var alarmPreview = false
  var alarmGestureArmed = false
  // 这一局**已经放过了** —— 于是不再判、不再读（sessionStorage 让它跨刷新也成立）。
  // ⚠️ 注意它是"放过"而不是"判过"：判过但没到线的话，下一次余额下降还要再判
  //   （用户最早那条 A4：「只在余额下降时才读取」—— 见下面 poll 里那段注释）。
  var alarmFired = false
  // 上一次看到的余额。**只在它下降时才再判一次** —— 这就是"读得极少"的那条规矩。
  var alarmSeenBal = null
  // 配置有没有到过。**判定必须等它** —— 否则"配置还没读到"会被当成"没设警报音"，
  // 于是这一局白白错过（而且 sessionStorage 已经置位，刷新也补不回来）。
  var cfgSeen = false
  // sessionStorage 在隐私模式/沙箱里可能直接抛异常 —— 抛了就当成"没放过"
  // （宁可多放一次，也不能让整个页面脚本起不来）。
  try { alarmFired = sessionStorage.getItem(ALARM_ONCE_KEY) === '1' } catch (err) {}
  function alarmSongNow() {
    return (typeof cfg.alarmSong === 'string') ? cfg.alarmSong : ''
  }
  // 我们这一半的条件（开关 + 有歌）。**鲸鱼那一半要读了才知道** —— 见 maybeAlarm。
  function alarmWanted() {
    return cfg.alarmOn !== false && !!alarmSongNow()
  }
  function alarmUrl(file) {
    return '/dsh-rice/song?f=' + encodeURIComponent(file) + '&kind=alarm'
  }
  function applyAlarmVolume() {
    // 和唱歌共用同一个音量来源（鲸鱼的 vol）—— 不另开一套。
    if (!alarmAudio) return
    try { alarmAudio.volume = Math.max(0, Math.min(1, songBaseVolume())) } catch (err) {}
  }
  function alarmEl() {
    if (alarmAudio) return alarmAudio
    try {
      alarmAudio = new Audio()
      alarmAudio.preload = 'auto'
      // 放完/出错都要**把状态收回来并重画按钮** ——
      // 否则那个按钮会一直写着「停止」，而它已经没声了（按钮在骗人）。
      alarmAudio.addEventListener('ended', function () { alarmDone() })
      // 文件被删了/格式不对 —— **必须说出来**。警报静默失败是最糟的一种失败。
      alarmAudio.addEventListener('error', function () {
        alarmPlaying = false
        alarmPreview = false
        if (menuOpen) renderPanel()
        setHint('警报音放不出来（alarm/ 里还有这个文件吗？）', 8000)
      })
    } catch (err) { alarmAudio = null }
    return alarmAudio
  }
  function alarmDone() {
    alarmPlaying = false
    alarmPreview = false
    if (menuOpen) renderPanel()
  }
  // 停下来。**试听和"余额警报"用的是同一个停止动作** ——
  // 放出来的东西必须能停，而最该停它的地方就是放出它的那个按钮（见 previewAlarm）。
  function stopAlarm() {
    if (!alarmPlaying) return
    alarmPlaying = false
    alarmPreview = false
    if (alarmAudio) { try { alarmAudio.pause() } catch (err) {} }
    if (menuOpen) renderPanel()
    setHint('已停', 2000)
  }
  // below = 触发它的那条线（试听时传 null，提示语就不提余额）
  function fireAlarm(file, below, viaGesture) {
    var ae = alarmEl()
    if (!ae) return
    // 警报压过唱歌 —— 「留住」那首也一样让位（这是"留住"唯一的例外，README 里写着）
    if (singing) stopSing()
    var url = alarmUrl(file)
    if (alarmUrlNow !== url) { ae.src = url; alarmUrlNow = url }
    applyAlarmVolume()
    try { ae.currentTime = 0 } catch (err) {}
    var p = null
    try { p = ae.play() } catch (err) {}
    alarmPlaying = true
    // 记着这次是"你点出来的试听"还是"真的余额提醒" —— 两者的区别只有一个：
    // **关面板时试听会停，真提醒不会**（提醒响了，你关面板去看余额是正常的）。
    alarmPreview = (below === null)
    // 按钮那一刻就该翻成「停止」（不等下一轮 renderPanel）
    if (menuOpen) renderPanel()
    // 说清楚"为什么会有这一首" —— 否则用户只会觉得莫名其妙
    if (below === null) setHint('♪ ' + file.replace(/\.[^.]+$/, '') + '（再点一下停）', 4000)
    else setHint('余额不足（≤ ¥' + below + '）：放一首给你听', 9000)
    if (p && p.catch) p.catch(function () {
      // 被浏览器拦住是**规则，不是坏了**（页面还没被点过时不许出声）。
      // ⚠️ 但警报**不能像自动唱那样静默跳过**：它是个提醒。
      // 所以先挂到"你第一次动手"上补一次，连那次都不行才明说。
      alarmPlaying = false
      alarmPreview = false
      if (menuOpen) renderPanel()
      setHint('')
      if (viaGesture) setHint('余额不足，想放歌但浏览器不让出声（点一下页面再试）', 9000)
      else armAlarmGesture(file, below)
    })
  }
  function armAlarmGesture(file, below) {
    if (alarmGestureArmed) return
    alarmGestureArmed = true
    var go = function () {
      document.removeEventListener('pointerdown', go, true)
      document.removeEventListener('keydown', go, true)
      // 期间可能被关掉/换了歌 —— 补放之前再问一次"还要不要"
      if (!alarmWanted()) return
      fireAlarm(alarmSongNow(), below, true)
    }
    document.addEventListener('pointerdown', go, true)
    document.addEventListener('keydown', go, true)
  }
  // 判一次：这个余额够不够"到线"。
  // **打开时调一次，之后每次余额下降再调一次**（见 poll 里那段注释）。
  // ⚠️ 置位（"这一局放过了"）只在**真的到线**的时候做 ——
  //    判过但没到线，下一次下降还要再判，这正是用户最早那条 A4 的意思。
  function maybeAlarm(total) {
    if (alarmFired) return
    if (!alarmWanted()) return
    // 余额是本来就取的；这里多出来的只有这一次 usage-settings.json。
    fetch('/dsh-whale/usage-settings.json', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (d) {
        var al = d && d.settings && d.settings.alert
        if (!al) return                                    // 鲸鱼那边没这条设置 → 当没这回事
        if (al.on === false) return                        // 它关着 → 我们也不放（两边都开才响）
        var below = (typeof al.below === 'number' && isFinite(al.below)) ? al.below : null
        if (below === null) return
        // 语义照抄它自己的界面文案：「余额 ≤ 设定值 时提醒」
        if (!(total <= below)) return
        alarmFired = true
        try { sessionStorage.setItem(ALARM_ONCE_KEY, '1') } catch (err) {}
        fireAlarm(alarmSongNow(), below, false)
      })
      .catch(function () {})   // 读不到 = 当这功能不存在（不弹错、更不放歌）
  }
  // 试听：**和判定无关**（不看余额、不看鲸鱼那条开关），只是让你知道选的是哪首。
  // 它同时是**停止按钮** —— 正在放的时候点它 = 停（不然你放出来就没法收场，
  // 尤其换成一整首歌当警报音的时候）。
  function previewAlarm() {
    if (alarmPlaying) { stopAlarm(); return }
    var f = selectValue({ store: 'alarm' })
    if (!f) { setHint('还没选警报音（把文件放进 alarm/ 就会出现在上面那份名单里）', 6000); return }
    // 尊重鲸鱼自己的静音开关 —— 和唱歌同一个规矩
    if (whaleSound && whaleSound.sound === false) { setHint('鲸鱼那边把音效关掉了', 6000); return }
    if (whaleSound === null) withSoundSettings(function () {})
    fireAlarm(f, null, true)
  }

  // —— 开工自动唱：宿主报时，页面自己放 ——
  // 音频**只有页面自己能放**（浏览器规矩），宿主推不动，所以只能反过来：
  //   宿主订阅 DSH 的 turn/start，把"最近一次开工是什么时候"记成一个时间戳；
  //   页面**搭自己的轮询**把它取回来 —— observe 的响应里多带一个 beat 字段，
  //   **一次额外请求都不发**。
  //
  // 为什么不单开一条 /dsh-rice/beat 去轮询（曾经就是这么写的）：
  //   页面本来每 3 秒（pollMs）就要 POST 一次 observe，捎一个数字是 0 次额外请求；
  //   单独轮询就得每 500ms 问一次 = **每分钟多 120 次请求**（实测每次约 0.26ms：
  //   常年 0.05% 的一个核，外加页面每秒两次 fetch + JSON 解析 —— 而那是画她动画的同一个线程）。
  // 代价只有一个：最多晚一个轮询周期才唱，而"你发完消息到 DSH 真正开工"本来就不止一秒。
  //
  // 间隔（最低隔几分钟才唱）由宿主判 —— 客户端只管"有没有新的一次开工"。
  // 于是同一个值只有一处真身，页面刷新/多标签也不会各自算一遍。
  function autoSingWanted() {
    // 面板开着时以**草稿**为准：刚把勾去掉、她还在唱，看着就像坏了。
    // （不能靠改 cfg 图快 —— 配置轮询每几秒会把 cfg 冲回去，
    //   那正是"移动之后自己弹回原位"那类 bug 的成因。）
    return menuOpen ? draftAutoSing : (cfg.autoSingOn !== false)
  }
  var singBeatSeen = -1       // 已经认过的开工时刻（-1 = 还没取过任何值）
  function maybeAutoSing(at, hasEats) {
    if (typeof at !== 'number' || !at) return
    var seen = singBeatSeen
    if (at > singBeatSeen) singBeatSeen = at
    if (at <= seen) return                     // 没有新的一次开工
    if (!autoSingWanted()) return
    // 页面在后台就别唱了：放出来也没人看，还会白占一个音频通道。
    if (document.hidden) return
    // 太旧的不认：刷新页面 / 从后台切回来时，宿主那儿存的还是上一次开工的时刻，
    // 把几分钟前那次补唱一遍是莫名其妙的。
    // **这一条同时顶替了"第一次拿到的只当基线"** —— 页面刚打开时 seen 是 -1，
    // 于是"新开工"和"旧开工"全靠时间新旧来分，不用再单独记一次基线。
    // 上限**跟着轮询周期走**：把「轮询间隔」调到几十秒的人，否则会永远等不到（静默失效）。
    // ⚠️ 这里必须防一手"周期还没定下来"：`Math.max(20000, undefined * 2)` 是 NaN，
    //    而 `Date.now() - at > NaN` 恒为 false —— 那会让"太旧的不认"**静默失效**，
    //    症状是页面刚打开就为她几分钟前那次开唱起来。宁可退回默认值。
    var cadence = (typeof pollMsNow === 'number' && pollMsNow > 0) ? pollMsNow : 3000
    var fresh = Math.max(20000, cadence * 2)
    if (Date.now() - at > fresh) return
    // 正在唱、或者她正在吃饭，就跳过这一次 —— 唱歌和吃饭不该叠在一起。
    if (singing || eating) return
    // 这一轮的响应里就带着"该吃饭了"：别唱了又立刻停（那会是一声很短的杂音）。
    if (hasEats) return
    startSing(true)
  }

  // 点面板/标签**以外**的地方就关掉 —— 和鲸鱼那套菜单的习惯一致。
  // 面板自己的点击已经在上面 stopPropagation 了，所以这里只会收到"外面"的点击。
  document.addEventListener('click', function (e) {
    if (!menuOpen) return
    if (menuEl.contains(e.target) || chipEl.contains(e.target)) return
    closeMenu()
  })

  // —— 彩蛋：方向键指令 ——
  //   500KG    ↑ → ↓ ↓ ↓
  //   380mm    → ↓ ↑ ↑ ← ↓ ↓
  // 两条防误触是必须的，而且理由不同：
  //   ① 面板开着时不生效 —— 那时候方向键正在微调米粒位置，两个功能会打架
  //   ② 输入框里不生效 —— 用户正在打字时按方向键，绝不该触发彩蛋
  // 再加一个 800ms 的短超时：连续方向键也会出现在翻页之类的操作里，
  // 但那样不会在 800ms 内一个不差地按完一整条指令。
  // 指令越长越难误触 —— 380mm 那条有七下，基本不可能撞上。
  var ARROW_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']
  var eggBuf = []
  var eggLast = 0
  var eggArmedUntil = 0
  function inEditable(el) {
    if (!el) return false
    var tag = (el.tagName || '').toLowerCase()
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true
  }
  // —— "碰过她" = "我现在在跟她玩" ——
  // 之后一小段时间内，方向键算是给她的，即使输入框是聚焦的。
  //
  // 这条解决一个很别扭的现象：**DSH 的输入框默认是聚焦的**，
  // 于是"输入框里按方向键不触发彩蛋"这条防误触，会让彩蛋**在页面刚打开时完全失效** ——
  // 只有点过面板、焦点移开之后才管用。用户会以为"彩蛋坏了"。
  //
  // ⚠️ 不能用 hover 判断：鲸鱼的根是 pointer-events:none，
  // **鼠标压在她身上根本不产生任何事件**。所以只能自己算几何命中。
  document.addEventListener('mousemove', function (e) {
    if (Date.now() < eggArmedUntil) return          // 已经武装好了就别重复算
    // **鼠标在面板上时不算"碰过她"。**
    // 否则你在面板上点几下参数，就等于宣示"我在跟她玩" —— 而那份武装会留 4 秒，
    // 关掉面板之后方向键会莫名其妙开始滴、甚至把彩蛋敲出来。
    // （面板压在她身上的位置尤其容易撞上：几何命中只看坐标，不看谁在上面。）
    if (menuOpen && menuEl.contains(e.target)) return
    var img = whaleImg()
    if (!img) return
    var r = img.getBoundingClientRect()
    if (!r.width) return
    var pad = 24                                     // 不用精确压在她身上，附近就算
    if (e.clientX >= r.left - pad && e.clientX <= r.right + pad &&
        e.clientY >= r.top - pad && e.clientY <= r.bottom + pad) {
      eggArmedUntil = Date.now() + 4000
    }
  })
  document.addEventListener('keydown', function (e) {
    if (!cfg.eggOn || menuOpen) return
    var armed = Date.now() < eggArmedUntil
    // 没碰过她、而且正在输入框里 → 不抢方向键
    if (!armed && inEditable(document.activeElement)) return
    if (ARROW_KEYS.indexOf(e.key) < 0) { eggBuf = []; return }
    var now = Date.now()
    // 每按一下响一声 —— 但**只在"碰过她"的窗口内**。
    // 否则你翻页、滚列表时也会一直滴，那才是真的烦。
    if (armed) playTick()
    if (eggBuf.length && now - eggLast > 800) eggBuf = []   // 断了就重来
    eggLast = now
    // 只有本来就在窗口内才续期 —— 否则"随便按一下方向键"就等于把自己武装了，
    // 之后不管鼠标在哪，接下来的方向键都会开始滴。
    if (armed) eggArmedUntil = now + 4000
    eggBuf.push(e.key)
    // 只保留"可能匹配某条指令后缀"的那一段，别让缓冲区无限长
    var maxLen = 0
    for (var i = 0; i < EGGS.length; i++) maxLen = Math.max(maxLen, EGGS[i].seq.length)
    if (eggBuf.length > maxLen) eggBuf.shift()
    for (var j = 0; j < EGGS.length; j++) {
      var seq = EGGS[j].seq
      if (eggBuf.length >= seq.length &&
          eggBuf.slice(eggBuf.length - seq.length).join() === seq.join()) {
        eggBuf = []
        // 延后一点再让她挨打：最后一下按键的"滴"声要先响完，
        // 否则会被"图标弹出 + 打击音效"盖掉。可调，见 eggLeadMs。
        var lead = (typeof cfg.eggLeadMs === 'number' && cfg.eggLeadMs >= 0) ? cfg.eggLeadMs : 0
        setTimeout(function () { fireEgg(EGGS[j]) }, lead)
        return
      }
    }
  })

  // 面板开着时，方向键也能微调
  document.addEventListener('keydown', function (e) {
    if (!menuOpen) return
    var map = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    var d = map[e.key]
    if (!d) return
    e.preventDefault()
    nudge(d[0], d[1])
  })

  // ------------------------------------------------------------ 挂到鲸鱼 ----
  function whaleBody() {
    var b = document.querySelector('.dshwv-body')
    if (b) return b
    var img = whaleImg()
    return img && img.parentElement ? img.parentElement : null
  }
  // 找她本人 —— 用来做咀嚼（低头那一下）。
  // **首选 img.dshwv-img**：那是鲸鱼自己给她加的类名，唯一、稳定，
  // 不用管她在哪一层、也不用管 src 是什么（多角色下 src 会变）。
  // 之前从 src 反推，在自定义角色上找不到她 → 咀嚼静默失效 ——
  // 和"角色识别"是同一个根子上的错：反推不如用权威标识。
  function whaleImg() {
    return document.querySelector('img.dshwv-img') ||
           document.querySelector('img[src*="/dsh-whale/image.png"]') ||
           document.querySelector('img[src*="/dsh-whale/role-image.png"]') ||
           document.querySelector('img[src*="/dsh-whale/rua.gif"]') ||
           (function () {
             var b = document.querySelector('.dshwv-body')
             return b ? b.querySelector('img') : null
           })()
  }
  // —— 量她的位置时，锚在"不晃的那个盒子"上 ——
  // 唱歌时 `.dshwv-body` 自己在上下晃（那条 `translate` 动画，±5px 上下）。
  // 所以 `body.getBoundingClientRect()` 量出来的**纵向**坐标也在晃。
  //
  // 面板是 `position:fixed`、按视口坐标摆的，严格说"贴着她"该用**实时**坐标。但那样会踩两个坑：
  //   ① 面板每 700ms 才重摆一次 —— 拿实时坐标等于**用一个 700ms 的采样率去跟一个 1.6s 的振荡**，
  //      平滑的上下晃被采成一跳一跳；而面板的顶边恰好是被钉住的（见下面 cap 的算法），
  //      于是动的只有底边 —— 看起来就是"菜单没动，可菜单里那一行在上下抽"。
  //   ② 那 ±5px 是**临时动画**，不是"她在哪"。面板该锚在她的**静止位置**上。
  // 所以方块改用 `.dshwv-root`（body 的父节点，不参与晃动；尺寸和位置完全一样）。
  //
  // 另外两处**故意不改**：
  //   · 彩蛋图标 —— 它算的是 `i.top - b.top` 这种**差值**，晃动自己抵消掉了；
  //   · 鼠标命中判定 —— 那里比的是**光标**（实时的）和她的位置，就该用实时矩形。
  function whaleBoxes() {
    var body = whaleBody()
    if (!body) return null
    var root = document.querySelector('.dshwv-root')
    var a = (root && root.getBoundingClientRect().width)
      ? root.getBoundingClientRect()
      : body.getBoundingClientRect()
    if (!a.width) return null
    var b = { left: a.left, top: a.top, right: a.right, bottom: a.bottom, width: a.width, height: a.height }
    var i = b
    var img = whaleImg()
    if (img) {
      var ir = img.getBoundingClientRect()
      if (ir.width > 0 && ir.height > 0) {
        i = {
          left: ir.left, right: ir.right, width: ir.width, height: ir.height,
          top: b.bottom - ir.height,     // 纵向不量（那上面有晃动），从底边推
          bottom: b.bottom,
        }
      }
    }
    return { b: b, i: i }
  }
  // 面板**不进鲸鱼容器** —— 见样式那段注释：
  // 鲸鱼会给自己套 transform，而带 transform 的祖先会成为 position:fixed 的包含块，
  // 那样面板就会跟着她跑、还会被裁掉。挂在 body 上，它是"贴着视口"的。
  function attachMenu() {
    if (menuEl.parentElement !== document.body) document.body.appendChild(menuEl)
  }
  function attach() {
    attachMenu()
    var body = whaleBody()
    if (!body) return false
    if (bowlEl.parentElement !== body) {
      body.appendChild(bowlEl)
      body.appendChild(grainEl)
      body.appendChild(chipEl)
      EGGS.forEach(function (egg) {
        if (egg.el) body.appendChild(egg.el)
      })
    }
    return true
  }

  // ------------------------------------------------------------ 吃的动画 ----
  // eating = **饭碗正举着**（这一段里点她就能抓现行）。见下面的 catchEating。
  var eating = false
  var spillTimer = null
  var spillTimer2 = null
  var headStyle = null      // 「扣在头顶」那套 keyframes 的专属 <style>（见 buildHeadCss）
  var bowlParked = null      // 面板里选着「碗」/「头顶」时，碗正停在那儿给你看（null = 没停）
  function stopEating() {
    for (var i = 0; i < timers.length; i++) clearTimeout(timers[i])
    timers = []
    eating = false
    if (spillTimer) { clearTimeout(spillTimer); spillTimer = null }
    if (spillTimer2) { clearTimeout(spillTimer2); spillTimer2 = null }
    bowlEl.classList.remove('dshrice-up')
    bowlEl.classList.remove('dshrice-nom')
    bowlEl.classList.remove('dshrice-spill')
    // 「扣在头顶」那一段也要摘干净 —— 漏了它的后果是：
    // 下一顿饭碗一浮起来就自己往头顶飞（因为动画类是 forwards 留着的）。
    bowlEl.classList.remove('dshrice-head')
    bowlEl.classList.remove('dshrice-gone')
    grainEl.classList.remove('dshrice-grain-show')
    var img = whaleImg()
    if (img) img.classList.remove('dshrice-chew')
    // 吃饭被打断时也要把歌的音量还回去 —— 否则它会一直停在"被压小"的状态
    unduckSong()
    // —— 把"停给你看的碗"收回去 ——
    // 这里**强制收回**（不是重新判断）：饭一开始，碗的位置就该由这一顿的动画说了算，
    // 而面板留的那个 inline transform 优先级比 CSS 类高 —— 不收的话
    // 她会"一边吃一边把碗端在头顶上"。（下一顿饭开始时正好会走到这里。）
    parkBowl(null)
  }

  function chew(on) {
    var img = whaleImg()
    if (img) img.classList.toggle('dshrice-chew', !!on)
  }

  // 分档：一口 / 两口 / 三口。阈值走配置，所以别人可以调成自己喜欢的节奏。
  function bitesFor(a) {
    return a < cfg.tier1Below ? 1 : (a < cfg.tier2Below ? 2 : cfg.bitesMax)
  }

  // force = 绕过"偷吃白饭"开关。只有「试吃」按钮用它 ——
  // 那是个工具按钮（拿来对位置、听音效），关着开关也该能试。
  // ⚠️ 它**不绕过**「音效开关」：那个开关的意思是"别出声"，
  //    如果试吃照样响，用户会以为开关坏了。
  function eatRice(amount, force) {
    if (!riceOn && !force) return
    var a = isFinite(Number(amount)) ? Number(amount) : 0
    var bites = bitesFor(a)
    var step = cfg.stepMs
    stopEating()
    if (!attach()) return
    bowlEl.classList.add('dshrice-up')
    // 开工自动唱的那首**她一张嘴就停** —— 自动唱配的是"你还在思考"那段时间，
    // 你这边出了结果、她开始吃，那首歌的用处就没了；再唱下去只会和吃饭那几声打架。
    // （手动点的歌**不停** —— 那是用户自己要听的，只压小、不掐断，见下面的 duckSong。）
    if (songAuto) stopSing()
    // 从这一刻起就"可以被抓"了 —— 饭碗举着的时候点她就能打翻它。
    eating = true
    var soundWhy = ''      // 第一条"没响的原因" —— 试吃时显示出来，正常吃不管它
    for (var i = 0; i < bites; i++) {
      timers.push((function (d) {
        return setTimeout(function () {
          chew(true); bowlEl.classList.add('dshrice-nom')
          // **每口一声** —— 和咬下去同一拍
          var why = playRiceSound()
          if (why && !soundWhy) soundWhy = why
        }, d)
      })(260 + i * step))
      timers.push((function (d) {
        return setTimeout(function () { chew(false); bowlEl.classList.remove('dshrice-nom') }, d + 245)
      })(260 + i * step))
    }
    var end = 260 + bites * step
    // 她在唱歌的话，**把歌压小一点**，让这几声吃饭听得见（歌不断）。
    // 压到整段吃完再多留 400ms —— 最后一口的音效尾巴也要盖住。
    if (singing) duckSong(end + 400)
    // 米粒（那张图现在带嘴）**在碗还挡着的时候就出现**：提前一整口的时长，
    // 也就是"她咬最后一口"的那一刻。然后碗落下去，正好把它露出来。
    // 碗落下之后才冒出来会像弹窗；藏在碗后面再露出来，才像"吃完沾在嘴上的"。
    // 前提是米粒的 z-index 在碗之下（见上面的样式）。
    var grainAt = Math.max(0, end - step)
    timers.push(setTimeout(function () {
      bowlEl.classList.remove('dshrice-up')
      // 碗放下了 —— 这会儿已经没什么可打翻的，"抓现行"的窗口到这里结束。
      eating = false
      // 这一顿结束了，重新问一次"面板上是不是正调着碗/头顶" ——
      // 是的话把那个预览摆回来（吃饭期间它被让位给这一顿的动画了）。
      syncTuneHold()
      // 这里**不再出声** —— 改成每口一声之后，最后一口的声音已经响过了。
      // （之前是在这一拍放一声"收尾"，现在那一声由第 N 口自己负责。）
      // 但**试吃是拿来排查的**：响没响、没响是为什么，都要当场说出来。
      if (force) {
        setTimeout(function () {
          setHint(soundWhy || '音效已播放 ✓', soundWhy ? 8000 : 3000)
        }, 80)
      }
    }, end))
    timers.push(setTimeout(function () { grainEl.classList.add('dshrice-grain-show') }, grainAt))
    timers.push(setTimeout(function () { grainEl.classList.remove('dshrice-grain-show') }, grainAt + cfg.grainMs))
  }

  // —— 「抓到了！」——
  // 她正在吃的时候点她 = 抓现行：**饭碗被打翻，米粒留在嘴上**（那就是证据）。
  // 这来自群里的点子，而且它挂在一个已经存在的东西上 ——
  // 鲸鱼"点她"本来就有反应（缩一下、按压音、弹余额气泡），我们只是**顺便**打翻饭碗：
  // 所以这个反馈不需要新按钮、不需要提示文字，她自己的动作就是反馈。
  //
  // 窗口只看 `eating`（饭碗举着）。碗已经放下去了就没什么可打翻的 ——
  // 那时候点她还是鲸鱼原来的反应，不抢。
  //
  // 「碗飞出去」这件事有**两套落点**，所以下面分成三块：
  //   spillBowl   两条路共用的那一段（掐掉没吃完的、亮出嘴上的米、到点淡出、顺手放落碗声）
  //   catchEating 点她 → 倒扣在嘴边偏左（最早那套，已经实机调过）
  //   bowlToHead  吃饭时被彩蛋炸到 → 掀上头顶（落点按角色存，见 buildHeadCss）
  function spillBowl(cls, ms, hitPct) {
    eating = false
    // 还没跑完的那几口先掐掉 —— 都打翻了，就别接着吃了
    for (var i = 0; i < timers.length; i++) clearTimeout(timers[i])
    timers = []
    chew(false)
    bowlEl.classList.remove('dshrice-nom')
    // 两套动画互斥：万一上一段还没收干净，先把另一个类摘掉
    bowlEl.classList.remove(cls === 'dshrice-head' ? 'dshrice-spill' : 'dshrice-head')
    bowlEl.classList.add(cls)
    // —— 碗撞到东西那一声 ——
    // 时点 = 那段动画里"下落越来越快 → 回稳"的接缝（视觉上就是撞上的那一刻）。
    // 放进 `timers` 而不是自己一个变量：stopEating() 会把它一起清掉 ——
    // 关掉开关、或者下一顿已经开始的时候，**绝不能留一声迟到的响**。
    timers.push(setTimeout(function () { playDropSound() }, Math.round(ms * hitPct)))
    // 嘴上那几粒米 = 证据。停留时长和正常吃完一样（cfg.grainMs）。
    grainEl.classList.add('dshrice-grain-show')
    if (spillTimer) clearTimeout(spillTimer)
    // 到点了：**碗和米粒同一拍开始消失**。
    // 碗先加 dshrice-gone 原地淡掉（不然去掉 dshrice-up 会让它滑回原位再淡出，
    // 那就不像"扣在那儿"了）。
    spillTimer = setTimeout(function () {
      spillTimer = null
      grainEl.classList.remove('dshrice-grain-show')
      bowlEl.classList.add('dshrice-gone')
    }, cfg.grainMs)
    // 再等一下让淡出跑完，才把状态清干净（下次吃饭要能重新举碗）。
    if (spillTimer2) clearTimeout(spillTimer2)
    spillTimer2 = setTimeout(function () {
      spillTimer2 = null
      bowlEl.classList.remove('dshrice-up')
      bowlEl.classList.remove('dshrice-spill')
      bowlEl.classList.remove('dshrice-head')
      bowlEl.classList.remove('dshrice-gone')
    }, cfg.grainMs + 340)
  }
  function catchEating() {
    if (!eating) return false
    // —— 掷一次骰子：这次是"倒扣在旁边"还是"直接扣头顶" ——
    // 两条路都到"碗翻了"，只是落点不同：
    //   点她抓到 → 大概率倒扣在旁边，小概率（cfg.headChancePct）直接上头顶
    //   彩蛋炸弹 → 必定上头顶（见 bowlToHead）
    // 为什么给抓这条路也留一个机会：**不知道彩蛋的人也该有机会撞见这一幕**。
    // 所以它必须偏小 —— 撞见才算惊喜，常见就成了日常。
    var pct = (typeof cfg.headChancePct === 'number' && isFinite(cfg.headChancePct)) ? cfg.headChancePct : 0
    var onHead = pct > 0 && Math.random() * 100 < pct
    if (onHead) {
      headStyleEl().textContent = buildHeadCss(lay)
      spillBowl('dshrice-head', HEAD_MS, HEAD_HIT_PCT)
      return true
    }
    spillBowl('dshrice-spill', SPILL_MS, SPILL_HIT_PCT)
    return true
  }

  // —— 「被炸到头上」——
  // 吃饭的时候输入彩蛋（两个轰炸动作之一）→ 碗被掀上去，**翻过来扣在她头顶**。
  // 为什么是**另外一套 keyframes**：抓现行那条弧是"被打翻、往左飞、矮矮地扣在旁边"，
  // 而这一下要从她嘴边（容器 ~75%）一路掀到头顶（~43%），是一条更长更高的抛线 ——
  // 同一套关键帧套不出两种弧。两套是各自独立调的，改一套不会动到另一套。
  // 落点按角色存（headLeft/headTop），所以 keyframes **是算出来的**（buildHeadCss）。
  function headStyleEl() {
    if (!headStyle) {
      headStyle = document.createElement('style')
      document.head.appendChild(headStyle)
    }
    return headStyle
  }
  // 把"起点 → 落点"换算成 translate 的百分比。
  // ⚠️ translate 的百分比是相对**碗自己**的宽/高，而 bowlLeft/bowlTop/headLeft/headTop
  //    是相对容器的 —— 所以这里必须除一次碗的尺寸，不能直接把两个数相减当 translate。
  //    （这条如果写错，症状是"碗落在半路上"，而且换个大碗/小碗偏移量还会变。）
  function headPoint(l) {
    var bw = l.bowlWidth || 33
    var bh = l.bowlHeight || 21.5
    // -50% 是原本用来把碗居中的那一半，落点的 x 要在它基础上再加位移
    var ax = -50 + ((l.headLeft - l.bowlLeft) / bw) * 100
    var ay = ((l.headTop - l.bowlTop) / bh) * 100
    return { ax: ax, ay: ay, dx: ax + 50 }
  }
  function buildHeadCss(l) {
    var p = headPoint(l)
    var n = function (v) { return Math.round(v * 10) / 10 + '%' }
    var r = function (v) { return Math.round(v) + 'deg' }
    var ax = p.ax
    var dx = p.dx
    var ay = p.ay
    // 抛线：0 → 最高点（34%）→ 撞上（68%）→ 压实（84%）→ 回稳（100%）
    var apexX = -50 + dx * HEAD_APEX_X
    var apexY = ay - HEAD_APEX_UP
    return '@keyframes dshrice-head{' +
      // 起手：快（被炸飞的），但**越来越慢**（上升本来就该减速）
      '0%{transform:translate(-50%,0) rotate(0deg);animation-timing-function:cubic-bezier(.22,.68,.42,1)}' +
      // 上升途中：还在往上，但已经慢下来了
      '34%{transform:translate(' + n(apexX) + ',' + n(apexY) + ') rotate(-96deg);animation-timing-function:cubic-bezier(.5,0,.85,.6)}' +
      // 落下：**加速**（这条曲线是"慢起快落"，和上升那段正好相反）
      '68%{transform:translate(' + n(ax) + ',' + n(ay - HEAD_IMPACT_UP) + ') rotate(-172deg);animation-timing-function:cubic-bezier(.3,0,.55,1)}' +
      // 压实：撞上之后碗会往下坐一点点、角度多转一点（"扣实了"）
      '84%{transform:translate(' + n(ax) + ',' + n(ay + HEAD_ROCK_DOWN) + ') rotate(-188deg);animation-timing-function:ease-out}' +
      // 回稳：弹回来一点点，停在正 180°
      '100%{transform:translate(' + n(ax) + ',' + n(ay) + ') rotate(-180deg)}}' +
      '.dshrice-bowl.dshrice-head{opacity:1;transform-origin:50% 50%;animation:dshrice-head ' +
        (HEAD_MS / 1000) + 's linear forwards}'
  }
  function bowlToHead() {
    if (!eating) return false
    // 落点用的是**当前角色解析后**的版面（lay），和画碗用的是同一份 ——
    // 所以"在哪个角色上调的落点，就用在哪个角色上"是自动成立的。
    headStyleEl().textContent = buildHeadCss(lay)
    spillBowl('dshrice-head', HEAD_MS, HEAD_HIT_PCT)
    return true
  }
  // ⚠️ **只观察、不拦截**：不 preventDefault、也不 stopPropagation ——
  //    鲸鱼自己那套（缩一下、按压音、弹余额气泡）照常走，我们只是顺便加一个动作。
  //    capture 阶段先跑，所以饭碗是在她那一下之前就翻的，看起来是"被抓了个正着"。
  // 命中判定只用**立绘矩形**（鲸鱼那张逐像素的命中图拿不到）——
  // 所以比它自己的判定略宽松。抓她本来就该宽松一点。
  document.addEventListener('pointerdown', function (e) {
    if (!eating) return
    if (e.button !== 0 && e.pointerType === 'mouse') return      // 右键不算抓
    var img = whaleImg()
    if (!img) return
    var r = img.getBoundingClientRect()
    if (!r.width) return
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return
    catchEating()
  }, true)

  // -------------------------------------------------------------- 轮询 ----
  var busy = false

  function poll() {
    if (busy) return
    busy = true
    var obs = {}
    Promise.all([
      fetch('/dsh-whale/last-turn.json', { cache: 'no-store' })
        .then(function (r) { return r.json() }).catch(function () { return null }),
      fetch('/dsh-whale/balance.json', { cache: 'no-store' })
        .then(function (r) { return r.json() }).catch(function () { return null }),
    ]).then(function (out) {
      var lt = out[0]
      var bal = out[1]
      if (lt && typeof lt.seq === 'number') {
        obs.seq = lt.seq
        if (typeof lt.amount === 'number') obs.amount = lt.amount
      }
      if (bal && typeof bal.todayUsage === 'number') obs.todayUsage = bal.todayUsage
      // **把"鲸鱼那边今天是哪一天"一起报上去**（0.3.4 起 balance.json 里有 accounting.day）。
      // 宿主的跨天判定要用它 —— 因为 todayUsage 现在走本地账本，
      // 人工校正 / 老账迁移 / 换口径都会让它往下掉，光看"掉了"会把那几种误判成跨天。
      // `accounting` 可能是 null，所以照旧要判一下；格式也在宿主那边再验一遍。
      if (bal && bal.accounting && typeof bal.accounting.day === 'string') obs.usageDay = bal.accounting.day
      // isPeak 只在本地用（决定碗里是哪一碗饭），**不往宿主上报** ——
      // 它是鲸鱼的判断，我们只是照它换张图。
      if (bal && typeof bal.isPeak === 'boolean') setPeak(bal.isPeak)
      // —— 余额警报：打开时判一次，之后**每次余额下降**再判一次 ——
      // 用的是**本来就要取的余额**（零额外请求），加上"每次判"一次 usage-settings.json。
      // ⚠️ 这里就是用户最早那条 A4：「我们只在余额下降时才读取一次」。
      //    我当初把它删掉了（理由："既然只在打开时放，局中再读就没意义"）—— **那个前提是错的**：
      //    他真正要的场景（边干活边掉钱、甚至打断正在唱的歌）**只有"掉落时触发"才可能发生**。
      //    实测：思考过程中余额掉到线下，什么也没发生 —— 因为开页那一刻还在线之上，
      //    而当时的规则是"判过一次就再也不判"。
      // **一局最多放一次**没变（alarmFired + sessionStorage）——
      // "每掉一次钱念一遍"仍然是禁止的；变的只是"哪一刻去判"。
      // ⚠️ cfgSeen：配置没到就判的话，"还没读到 alarmSong"会被当成"没设歌"；
      //    等它到了再开始记 alarmSeenBal，免得把开页那一次判定白白丢掉。
      if (cfgSeen && bal && typeof bal.totalBalance === 'number') {
        if (alarmSeenBal === null) maybeAlarm(bal.totalBalance)                                  // 开页第一次
        else if (bal.totalBalance < alarmSeenBal && !alarmFired) maybeAlarm(bal.totalBalance)    // 掉钱了
        alarmSeenBal = bal.totalBalance
      }
      // 上报当前角色 —— 宿主靠它决定"这次的版面改动该存给谁"。
      obs.roleId = activeRole()
      if (obs.seq === undefined && obs.todayUsage === undefined) return null
      return fetch('/dsh-rice/observe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(obs),
      }).then(function (r) { return r.json() })
    }).then(function (res) {
      if (!res) return
      if (typeof res.riceOn === 'boolean' && res.riceOn !== riceOn) {
        riceOn = res.riceOn
        renderChip()
      }
      // 宿主每次都会把配置捎回来，所以改完配置下一轮就生效，不用刷新页面
      applyCfg(res.config)
      schedulePoll(cfg.pollMs)
      if (res.eat && res.eat.length) {
        for (var i = 0; i < res.eat.length; i++) {
          ;(function (amt, d) { setTimeout(function () { eatRice(amt) }, d) })(res.eat[i], i * 900)
        }
      }
      // 「开工了」也搭这一趟车回来（见 maybeAutoSing）。
      // 放在吃饭之后判：这一轮她要吃的话，就别唱了又立刻停。
      maybeAutoSing(res.beat, !!(res.eat && res.eat.length))
    }).catch(function () {}).then(function () { busy = false })
  }

  // 鲸鱼可能因为缩放/重挂而重建 DOM，所以定期确认碗还挂在它身上。
  // 顺带在这里检查角色有没有换 —— 换了就重算版面，所以切角色是自动生效的。
  function watch() {
    attach()
    var body = whaleBody()
    if (body && bowlEl.parentElement !== body) attach()
    roleChanged()
    // 视口/缩放/气泡都会让 .dshwv-body 变大小，所以这个位置得定期重算。
    // 它算的是"相对于她那张图"的位置，所以重算是廉价且安全的。
    placeEgg()
    // 面板也一样：她可能被拖动、被缩放，视口也可能变 —— 面板得跟着走，
    // 并且始终留在屏幕里。（面板关着时 placeMenu 自己会早退。）
    placeMenu()
  }

  // 轮询间隔也走配置，所以拿到配置之后要能重排（否则改大改小都得刷新页面）。
  var pollTimer = null
  var pollMsNow = POLL_MS
  function schedulePoll(ms) {
    var next = (typeof ms === 'number' && ms >= 500) ? ms : POLL_MS
    if (pollTimer !== null && next === pollMsNow) return
    if (pollTimer !== null) clearInterval(pollTimer)
    pollMsNow = next
    pollTimer = setInterval(poll, next)
  }

  renderLayout()
  resolveRole()
  renderLayout()
  attach()
  renderChip()
  setTimeout(poll, 800)
  schedulePoll(POLL_MS)
  setInterval(watch, WATCH_MS)

  // 首屏就把配置取回来——否则第一条观测会用兜底默认值。
  fetch('/dsh-rice/config', { cache: 'no-store' })
    .then(function (r) { return r.json() })
    .then(function (c) {
      if (!c) return
      if (typeof c.riceOn === 'boolean') { riceOn = c.riceOn; renderChip() }
      applyCfg(c.config)
      if (c.config && typeof c.config.pollMs === 'number') schedulePoll(c.config.pollMs)
    })
    .catch(function () {})
})()
