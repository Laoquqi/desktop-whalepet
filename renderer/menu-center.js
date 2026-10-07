// ============================================================================
// 面板拖动：挂件自带的二级/三级面板可以按住标题栏/手柄拖到屏幕任何位置
// ============================================================================
// ⚠️⚠️ **不做"自动扩窗居中"，原因（四轮实测的结论）：**
//   面板要落在屏幕正中央，桌宠窗口就必须从 900×900 扩到能跨过屏幕中心 ——
//   而窗口尺寸一变，Chromium/DWM 重建合成层，会把正在播放的视频从硬件
//   叠加层（MPO）里挤出去：用户实测"开面板后视频卡住，要点一下才恢复"。
//   "面板屏幕居中"和"菜单绝不影响视频播放"在几何上不可兼得 ——
//   按用户的硬要求（视频优先），面板**在原位置打开**（与挂件原版一致），
//   但全部**可拖动**：想要它待在哪，拖过去即可（包括拖到屏幕正中）。
//
// 覆盖对象：
//   ① 弹窗面板（「全局设置」=提示与音效设置、「按压泡泡设置」=自定义泡泡主
//      编辑、「自定义」=吸附设置等 .dshwv-bubmask/.dshwv-snapmask 系的全屏
//      遮罩 + 弹性居中卡片）→ 按住标题栏（.dshwv-bubtitle）拖动；
//   ② 三级浮层列表（角色/音效组/卡槽）→ 顶部「⠿」手柄拖动。
//   ☰ 主菜单一级不动。
//
// —— ③ 分区菜单定位（2026-10-06，用户确认的方案）——
//   ☰ 菜单不再固定在按钮上方，而是按她的**脚底**落在屏幕工作区的哪个
//   三分之一来分区摆放（全部屏幕坐标系钳制，历史教训：窗口上半截会在
//   屏幕外，窗口坐标会把东西推出屏幕顶）：
//     · 下方区 → 菜单在她**正上方**（底边贴她头顶上方 6px，即右下角
//       原版观感），水平以她居中；
//     · 上方区 → "正下方"按用户确认的贴身方案：她脚底以下在窗口外渲染
//       不出来，菜单底边贴她脚底、盖住身体前方向上展开；高度不够时
//       max-height 裁进屏幕、内容内部滚动；
//     · 中间区 → 她的右缘=窗口右缘，右侧永远没空间，菜单一律开在
//       **她的左侧**（即"有空间的一侧"），垂直方向对齐她的中心。
//   二级/三级面板（全局设置/记账/角色列表/偷吃白饭/形象与互动…）：
//   菜单开着时贴在 ☰ 菜单**左侧**打开（右侧是窗口外；左侧放不下依次试
//   菜单上方、下方，最后才允许压住菜单），绝不跑出屏幕、绝不压住菜单。
//   菜单一关就交还：清掉我们写过的行内定位，rice/形象与互动自己的跟随
//   逻辑恢复工作。用户拖过的面板与按住钉住中的偷吃白饭面板一律不碰。
//
// ⚠️ 自检（PET_SELFTEST）断言全按无面板拖动算 —— 自检模式下整个模块不干活。
// ⚠️ 不改 vendor：全部走 DOM，从外壳实现，上游合并不受影响。
(function () {
  'use strict'
  var api = window.petApi || {}
  if (api.selftest) return

  function log(m) { try { if (api.log) api.log('[面板拖动] ' + m) } catch (e) {} }

  // —— 带 !important 的定位（压住挂件随时会重写的普通行内值；只认用户拖过的）——
  function putImportant(el, x, y) {
    el.style.setProperty('left', Math.round(x) + 'px', 'important')
    el.style.setProperty('top', Math.round(y) + 'px', 'important')
    el.style.setProperty('right', 'auto', 'important')
    el.style.setProperty('bottom', 'auto', 'important')
  }
  function clampPos(x, y, w, h) {
    var maxX = Math.max(4, window.innerWidth - w - 4)
    var maxY = Math.max(4, window.innerHeight - h - 4)
    return [Math.min(Math.max(x, 4), maxX), Math.min(Math.max(y, 4), maxY)]
  }

  function ensureCss() {
    if (document.getElementById('dshpet-menu-center-css')) return
    var st = document.createElement('style')
    st.id = 'dshpet-menu-center-css'
    st.textContent = [
      '.dshpet-draggrip{display:flex;align-items:center;justify-content:center;height:16px;' +
        'margin:0 0 5px;border:1px solid rgba(32,49,112,.25);border-radius:6px;' +
        'background:rgba(32,49,112,.08);color:#203170;font-size:10px;line-height:1;' +
        'cursor:move;user-select:none;-webkit-user-select:none;touch-action:none;' +
        'flex:0 0 auto;pointer-events:auto}',
      '.dshpet-draggrip:hover{background:rgba(32,49,112,.18)}',
      '.dshpet-draggable-title{cursor:move;user-select:none;-webkit-user-select:none;touch-action:none}',

      // ============ 液态玻璃皮肤（菜单 + 按键 + 列表 + 卡片）============
      // 玻璃配方：半透明白渐变底 + backdrop 模糊提饱和 + 白高光描边 +
      // 内侧上亮下暗两道内阴影 + 大圆角；深蓝 pill 按钮带渐变与浮起反馈。
      // 全部 !important 压过挂件样式表（我们的 <style> 注入得更晚）。
      // —— ☰ 菜单盒 ——
      '.dshwv-menu{' +
        'background:linear-gradient(148deg,rgba(255,255,255,.74) 0%,rgba(238,244,255,.55) 52%,rgba(255,255,255,.64) 100%) !important;' +
        'backdrop-filter:blur(18px) saturate(1.6) !important;' +
        '-webkit-backdrop-filter:blur(18px) saturate(1.6) !important;' +
        'border:1px solid rgba(255,255,255,.68) !important;' +
        'border-radius:18px !important;' +
        'padding:12px 14px !important;' +
        'box-shadow:0 18px 50px rgba(21,36,84,.26),0 2px 8px rgba(21,36,84,.12),' +
          'inset 0 1px 0 rgba(255,255,255,.9),inset 0 -1px 0 rgba(255,255,255,.3) !important;' +
        '}',
      // 斜向高光扫过（负 z-index：垫在内容下、浮在底色上）
      '.dshwv-menu::before{content:"";position:absolute;inset:0;border-radius:inherit;' +
        'pointer-events:none;z-index:-1;' +
        'background:linear-gradient(158deg,rgba(255,255,255,.5) 0%,rgba(255,255,255,0) 36%,' +
          'rgba(255,255,255,0) 64%,rgba(255,255,255,.26) 100%)}',
      // —— 菜单行：圆角悬停高亮 ——
      '.dshwv-menu-row{margin:4px -6px !important;padding:3px 6px !important;' +
        'border-radius:10px !important;transition:background .16s ease !important;}',
      '.dshwv-menu-row:hover{background:rgba(32,49,112,.08) !important;}',
      // —— ☰ 按钮：玻璃圆角方块 ——
      '.dshwv-menu-btn{background:rgba(32,49,112,.72) !important;' +
        'backdrop-filter:blur(10px) saturate(1.4) !important;' +
        'border:1px solid rgba(255,255,255,.4) !important;border-radius:9px !important;' +
        'box-shadow:0 4px 14px rgba(21,36,84,.32),inset 0 1px 0 rgba(255,255,255,.35) !important;' +
        'transition:transform .16s ease,background .16s ease,box-shadow .16s ease !important;}',
      '.dshwv-menu-btn:hover{background:rgba(47,68,136,.85) !important;transform:scale(1.08) !important;' +
        'box-shadow:0 6px 18px rgba(21,36,84,.4) !important;}',
      // —— 深蓝 pill 按钮（全局设置/按压泡泡设置/自定义/管理/小鲸鱼记账）——
      '.dshwv-roleimport{background:linear-gradient(180deg,rgba(52,74,148,.94),rgba(32,49,112,.94)) !important;' +
        'border:1px solid rgba(255,255,255,.3) !important;border-radius:10px !important;' +
        'padding:4px 12px !important;font-weight:600 !important;' +
        'box-shadow:0 3px 8px rgba(21,36,84,.3),inset 0 1px 0 rgba(255,255,255,.28) !important;' +
        'transition:transform .16s ease,box-shadow .16s ease,filter .16s ease !important;}',
      '.dshwv-roleimport:hover{filter:brightness(1.14) !important;transform:translateY(-1px) !important;' +
        'box-shadow:0 6px 16px rgba(21,36,84,.38) !important;}',
      '.dshwv-roleimport:active{transform:translateY(0) !important;filter:brightness(.94) !important;}',
      // —— 浅色玻璃控件（音效组选择）——
      '.dshwv-audiobtn{background:rgba(255,255,255,.55) !important;' +
        'border:1px solid rgba(32,49,112,.22) !important;border-radius:10px !important;' +
        'transition:background .16s ease,transform .16s ease !important;}',
      '.dshwv-audiobtn:hover{background:rgba(255,255,255,.82) !important;' +
        'transform:translateY(-1px) !important;}',
      // —— 输入控件：统一主题色 + 玻璃底 ——
      '.dshwv-range,.dshwv-check{accent-color:#2f4488 !important;}',
      '.dshwv-number{background:rgba(255,255,255,.62) !important;' +
        'border:1px solid rgba(32,49,112,.2) !important;border-radius:8px !important;}',
      // —— 三级浮层列表（角色/音效组/卡槽）：同款玻璃 ——
      '.dshwv-rolelist,.dshwv-audiolist,.dshwv-slotlist{' +
        'background:linear-gradient(150deg,rgba(255,255,255,.8),rgba(238,244,255,.66)) !important;' +
        'backdrop-filter:blur(14px) saturate(1.5) !important;' +
        '-webkit-backdrop-filter:blur(14px) saturate(1.5) !important;' +
        'border:1px solid rgba(255,255,255,.62) !important;border-radius:14px !important;' +
        'box-shadow:0 14px 38px rgba(21,36,84,.24),inset 0 1px 0 rgba(255,255,255,.85) !important;}',
      // —— 弹窗卡片（全局设置/按压泡泡设置/自定义等）——
      '.dshwv-bubcard,.dshwv-snapwin{' +
        'background:linear-gradient(152deg,rgba(255,255,255,.88),rgba(240,245,255,.78)) !important;' +
        'backdrop-filter:blur(16px) saturate(1.4) !important;' +
        '-webkit-backdrop-filter:blur(16px) saturate(1.4) !important;' +
        'border:1px solid rgba(255,255,255,.66) !important;border-radius:16px !important;' +
        'box-shadow:0 18px 48px rgba(21,36,84,.24),inset 0 1px 0 rgba(255,255,255,.9) !important;}',
      '.dshwv-bubtitle,.dshwv-snaptitle{font-weight:700 !important;}' +
        '',

      // ============ 二级/三级菜单统一液态玻璃（第二波覆盖）============
      // 「偷吃白饭」与「形象与互动」共用 .dshrice-menu（后者整个借用该类）；
      // 「小鲸鱼记账」= 菜单内子界面 .dshwv-usage-sub + 用量记录弹窗
      // .dshwv-usage-card + 浮动面板 .dshwv-usagepanel；再加音效编辑/确认/
      // GIF/截图/重置等全部浮层与自绘下拉。配方与 ☰ 菜单同款。
      // ⚠️ .dshrice-menu / .dshwv-usagepanel 自身 overflow-y:auto，
      //    ::before 高光会随内容滚走，所以这两个的玻璃质感直接做进背景
      //    渐变里，不加伪元素；其余不滚动的卡片同理也走渐变（少一层伪
      //    元素定位风险）。
      // —— 偷吃白饭 / 形象与互动：面板盒 ——
      '.dshrice-menu{' +
        'background:linear-gradient(148deg,rgba(255,255,255,.78) 0%,rgba(238,244,255,.6) 52%,rgba(255,255,255,.68) 100%) !important;' +
        'backdrop-filter:blur(16px) saturate(1.6) !important;' +
        '-webkit-backdrop-filter:blur(16px) saturate(1.6) !important;' +
        'border:1px solid rgba(255,255,255,.66) !important;' +
        'border-radius:16px !important;' +
        'box-shadow:0 16px 44px rgba(21,36,84,.24),0 2px 8px rgba(21,36,84,.1),' +
          'inset 0 1px 0 rgba(255,255,255,.9),inset 0 -1px 0 rgba(255,255,255,.3) !important;' +
        '}',
      // 分组分隔线调淡、行悬停高亮（与 ☰ 菜单行同一手感）
      '.dshrice-menu .dshrice-grp{border-top:1px solid rgba(32,49,112,.14) !important;}',
      '.dshrice-menu .dshrice-row{border-radius:10px !important;' +
        'transition:background .16s ease !important;}',
      '.dshrice-menu .dshrice-row:hover{background:rgba(32,49,112,.08) !important;}',
      '.dshrice-menu button.dshrice-grp-h{border-radius:10px !important;' +
        'transition:background .16s ease !important;}',
      '.dshrice-menu button.dshrice-grp-h:hover{background:rgba(32,49,112,.08) !important;}',
      // 页脚（保存/重置常驻条）：从纯白改成磨砂玻璃贴片
      '.dshrice-menu .dshrice-foot{background:rgba(255,255,255,.55) !important;' +
        'backdrop-filter:blur(10px) saturate(1.4) !important;' +
        '-webkit-backdrop-filter:blur(10px) saturate(1.4) !important;' +
        'border-top:1px solid rgba(32,49,112,.14) !important;border-radius:12px !important;' +
        'padding:7px 8px 4px !important;}',
      // 面板内按钮：浅色玻璃；激活态深蓝玻璃；保存=绿玻璃、试吃=琥珀玻璃
      //（保留原语义配色，只换质感）
      '.dshrice-menu button{background:rgba(255,255,255,.6) !important;' +
        'border:1px solid rgba(32,49,112,.2) !important;border-radius:9px !important;' +
        'transition:background .16s ease,transform .16s ease,box-shadow .16s ease !important;}',
      '.dshrice-menu button:hover{background:rgba(255,255,255,.9) !important;}',
      // 彩色按钮悬停保持本色，只做提亮（不被上面的白玻璃悬停盖掉）
      '.dshrice-menu button.dshrice-on:hover,' +
        '.dshrice-menu button.dshrice-save:hover,.dshrice-menu button.dshrice-try:hover{' +
        'filter:brightness(1.12) !important;}',
      '.dshrice-menu button:active{transform:translateY(1px) !important;}',
      '.dshrice-menu button.dshrice-on{' +
        'background:linear-gradient(180deg,rgba(52,74,148,.94),rgba(32,49,112,.94)) !important;' +
        'border-color:rgba(255,255,255,.3) !important;color:#fff !important;' +
        'box-shadow:0 2px 8px rgba(21,36,84,.3),inset 0 1px 0 rgba(255,255,255,.28) !important;}',
      '.dshrice-menu button.dshrice-save{' +
        'background:linear-gradient(180deg,rgba(63,138,92,.94),rgba(47,107,70,.94)) !important;' +
        'border-color:rgba(255,255,255,.3) !important;' +
        'box-shadow:0 2px 8px rgba(24,58,40,.28),inset 0 1px 0 rgba(255,255,255,.28) !important;}',
      '.dshrice-menu button.dshrice-try{' +
        'background:linear-gradient(180deg,rgba(169,112,42,.94),rgba(138,90,31,.94)) !important;' +
        'border-color:rgba(255,255,255,.3) !important;' +
        'box-shadow:0 2px 8px rgba(80,52,14,.28),inset 0 1px 0 rgba(255,255,255,.28) !important;}',
      // 「唱歌按住」的按下态要赢过 button:hover 的上浮
      '.dshrice-menu button.dshrice-sing.dshrice-on{transform:translateY(1px) !important;' +
        'box-shadow:inset 0 2px 4px rgba(0,0,0,.4) !important;}',
      // 输入控件：统一主题色 + 玻璃底（形象与互动的数字框也走这条）
      '.dshrice-menu input[type=checkbox],.dshrice-menu input[type=range]{accent-color:#2f4488 !important;}',
      '.dshrice-menu input[type=number]{background:rgba(255,255,255,.62) !important;' +
        'border:1px solid rgba(32,49,112,.2) !important;border-radius:8px !important;}',
      // —— 小鲸鱼记账：菜单内子界面的设置区与输入控件 ——
      '.dshwv-usageset{border:1px dashed rgba(32,49,112,.24) !important;' +
        'border-radius:10px !important;background:rgba(255,255,255,.4) !important;}',
      '.dshwv-usagemsg,.dshwv-msgtext{background:rgba(255,255,255,.66) !important;' +
        'border:1px solid rgba(32,49,112,.2) !important;border-radius:8px !important;}',
      '.dshwv-usage-scroll{background:rgba(255,255,255,.45) !important;' +
        'border:1px solid rgba(32,49,112,.12) !important;border-radius:10px !important;}',
      '.dshwv-usage-more{background:rgba(255,255,255,.5) !important;' +
        'border:1px solid rgba(32,49,112,.22) !important;border-radius:9px !important;' +
        'transition:background .16s ease !important;}',
      '.dshwv-usage-more:hover{background:rgba(255,255,255,.85) !important;}',
      '.dshwv-usageset input[type=checkbox],.dshwv-usagebody input[type=checkbox]{accent-color:#2f4488 !important;}',
      // —— 记账浮层：用量记录弹窗卡片 + 浮动用量面板 ——
      '.dshwv-usage-card,.dshwv-usagepanel{' +
        'background:linear-gradient(152deg,rgba(255,255,255,.88),rgba(240,245,255,.78)) !important;' +
        'backdrop-filter:blur(16px) saturate(1.4) !important;' +
        '-webkit-backdrop-filter:blur(16px) saturate(1.4) !important;' +
        'border:1px solid rgba(255,255,255,.66) !important;' +
        'box-shadow:0 18px 48px rgba(21,36,84,.24),inset 0 1px 0 rgba(255,255,255,.9) !important;}',
      '.dshwv-usage-card{border-radius:16px !important;}',
      '.dshwv-usagepanel{border-radius:16px !important;}',
      // —— 其余三级浮层：音效编辑/确认/GIF/截图/重置卡片，同款玻璃 ——
      '.dshwv-audiowin,.dshwv-confirmwin,.dshwv-gifwin,.dshwv-cropwin,.dshwv-rescard{' +
        'background:linear-gradient(152deg,rgba(255,255,255,.88),rgba(240,245,255,.78)) !important;' +
        'backdrop-filter:blur(16px) saturate(1.4) !important;' +
        '-webkit-backdrop-filter:blur(16px) saturate(1.4) !important;' +
        'border:1px solid rgba(255,255,255,.66) !important;border-radius:16px !important;' +
        'box-shadow:0 18px 48px rgba(21,36,84,.24),inset 0 1px 0 rgba(255,255,255,.9) !important;}',
      // —— 自绘下拉（跑马灯方案等）：与三级列表同款玻璃 ——
      '.dshwv-rgbmenu{background:linear-gradient(150deg,rgba(255,255,255,.8),rgba(238,244,255,.66)) !important;' +
        'backdrop-filter:blur(12px) saturate(1.5) !important;' +
        '-webkit-backdrop-filter:blur(12px) saturate(1.5) !important;' +
        'border:1px solid rgba(255,255,255,.62) !important;border-radius:12px !important;' +
        'box-shadow:0 14px 38px rgba(21,36,84,.24),inset 0 1px 0 rgba(255,255,255,.85) !important;}',
      '.dshwv-rgbhead{background:rgba(255,255,255,.62) !important;' +
        'border:1px solid rgba(32,49,112,.2) !important;border-radius:8px !important;}',
      // 音效编辑窗里的行内输入框统一玻璃底
      '.dshwv-audiorow input{background:rgba(255,255,255,.62) !important;' +
        'border:1px solid rgba(32,49,112,.2) !important;border-radius:8px !important;}',
      // —— 六个后加入口按键：统一液态玻璃按键 ——
      // 偷吃白饭/形象与互动/打开桌宠/打开 dsh 网页端/黄金回旋/吃掉统计。
      // 有意与挂件自带的深蓝 pill（.dshwv-roleimport）区分：自带的是深蓝
      // 实底，这六个是磨砂白玻璃块。黄金回旋/吃掉统计两个按钮是行内样式
      // 创建的（golden-spin.js/file-eater.js），这里用 !important 统一接管。
      '.dshpet-rice-row,.dshpet-exp-btn,.dshpet-spawn-btn,.dshpet-openweb-btn,' +
        '.dshpet-spin-row>button,.dshpet-eat-row>button{' +
        'display:inline-flex !important;align-items:center !important;gap:4px !important;' +
        'padding:3px 11px !important;' +
        'background:linear-gradient(180deg,rgba(255,255,255,.72),rgba(240,245,255,.5)) !important;' +
        'backdrop-filter:blur(10px) saturate(1.5) !important;' +
        '-webkit-backdrop-filter:blur(10px) saturate(1.5) !important;' +
        'border:1px solid rgba(255,255,255,.75) !important;border-radius:10px !important;' +
        'box-shadow:0 3px 10px rgba(21,36,84,.16),inset 0 1px 0 rgba(255,255,255,.9),' +
          'inset 0 -1px 0 rgba(255,255,255,.35) !important;' +
        'transition:background .16s ease,transform .16s ease,box-shadow .16s ease !important;}',
      '.dshpet-rice-row:hover,.dshpet-exp-btn:hover,.dshpet-spawn-btn:hover,' +
        '.dshpet-openweb-btn:hover,.dshpet-spin-row>button:hover,.dshpet-eat-row>button:hover{' +
        'background:linear-gradient(180deg,rgba(255,255,255,.92),rgba(240,245,255,.75)) !important;' +
        'transform:translateY(-1px) !important;' +
        'box-shadow:0 6px 16px rgba(21,36,84,.22),inset 0 1px 0 rgba(255,255,255,.95) !important;}',
      '.dshpet-rice-row:active,.dshpet-exp-btn:active,.dshpet-spawn-btn:active,' +
        '.dshpet-openweb-btn:active,.dshpet-spin-row>button:active,.dshpet-eat-row>button:active{' +
        'transform:translateY(0) !important;filter:brightness(.96) !important;}',
      // —— 「甩出力度」右侧选项栏：圆角玻璃下拉 ——
      // 原生 <select>：去掉系统默认外观，自绘箭头，配色跟随菜单主题。
      '.dshpet-strength-row{display:flex !important;align-items:center !important;gap:6px !important;' +
        'margin:4px -6px !important;padding:3px 6px !important;border-radius:10px !important;' +
        'transition:background .16s ease !important;}',
      '.dshpet-strength-row:hover{background:rgba(32,49,112,.08) !important;}',
      '.dshpet-strength-row select{' +
        'appearance:none !important;-webkit-appearance:none !important;' +
        'background-color:rgba(255,255,255,.62) !important;' +
        'background-image:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'6\'%3E%3Cpath d=\'M1 1l4 4 4-4\' stroke=\'%23536ba9\' stroke-width=\'1.5\' fill=\'none\' stroke-linecap=\'round\' stroke-linejoin=\'round\'/%3E%3C/svg%3E") !important;' +
        'background-repeat:no-repeat !important;background-position:right 7px center !important;' +
        'background-size:10px 6px !important;' +
        'border:1px solid rgba(32,49,112,.2) !important;border-radius:9px !important;' +
        'padding:2px 24px 2px 9px !important;color:#203170 !important;' +
        'font:12px/1.4 inherit !important;cursor:pointer !important;color-scheme:light !important;' +
        'box-shadow:0 1px 4px rgba(21,36,84,.12),inset 0 1px 0 rgba(255,255,255,.85) !important;' +
        'transition:background-color .16s ease !important;}',
      '.dshpet-strength-row select:hover{background-color:rgba(255,255,255,.88) !important;}',
      // —— 全屏遮罩改为点击穿透：面板现在贴着 ☰ 菜单打开，遮罩若还整窗
      //      拦点击，菜单行/她/空白关闭就全被一层**透明图层**挡死（实测踩坑）。
      //      遮罩只负责承载卡片，点击全部放行；卡片自己照常可点。
      '.dshwv-bubmask,.dshwv-usage-mask,.dshwv-resmask,.dshwv-confirmmask,' +
        '.dshwv-audiomask,.dshwv-gifmask,.dshwv-cropmask,.dshwv-snapmask{' +
        'pointer-events:none !important;}',
      '.dshwv-bubmask .dshwv-bubcard,.dshwv-bubcard,.dshwv-snapwin,.dshwv-usage-card,' +
        '.dshwv-rescard,.dshwv-audiowin,.dshwv-confirmwin,.dshwv-gifwin,.dshwv-cropwin,' +
        '.dshwv-bubmask .dshwv-bubclose{' +
        'pointer-events:auto !important;}',
      // —— 拖动手柄：融进玻璃语言 ——
      '.dshpet-draggrip{background:rgba(32,49,112,.06) !important;' +
        'border:1px solid rgba(32,49,112,.16) !important;border-radius:8px !important;}',
      '.dshpet-draggrip:hover{background:rgba(32,49,112,.14) !important;}',
    ].join('')
    document.head.appendChild(st)
  }

  function bindGrip(g, getPos, setPos, onDragStart) {
    g.addEventListener('pointerdown', function (e) {
      e.stopPropagation()
      if (onDragStart) onDragStart()
      var p = getPos()
      if (!p) return
      var sx = e.clientX, sy = e.clientY, ox = p[0], oy = p[1]
      try { g.setPointerCapture(e.pointerId) } catch (err) {}
      var move = function (ev) { setPos(ox + ev.clientX - sx, oy + ev.clientY - sy) }
      var up = function () {
        g.removeEventListener('pointermove', move)
        g.removeEventListener('pointerup', up)
        g.removeEventListener('pointercancel', up)
      }
      g.addEventListener('pointermove', move)
      g.addEventListener('pointerup', up)
      g.addEventListener('pointercancel', up)
    })
  }
  function makeGrip(label) {
    var g = document.createElement('div')
    g.className = 'dshpet-draggrip'
    g.textContent = label || '⠿ 按住拖动'
    return g
  }

  // —— ① 三级浮层列表（角色 / 音效组 / 卡槽）：「⠿」手柄拖动 ——
  // 挂件每次打开都会重写它们的位置（普通行内值）；用户拖过一次后用
  // !important 接管（el.__dshpetDragged），本次打开内保持拖到的位置；
  // 关掉再开回到挂件的默认位置（每次打开都从原位开始，符合直觉）。
  // ⚠️ 每个元素走独立函数，别在 for 循环里给回调绑 var 变量（var 是函数
  //    作用域，多元素时回调会全部指向最后一个元素）。
  function handleList(el) {
    var vis = !!(el.offsetWidth || el.offsetHeight) && getComputedStyle(el).display !== 'none'
    if (!vis) { el.__dshpetDragged = false; el.__dshpetPos = null; return }
    if (!el.__dshpetGrip) {
      el.__dshpetGrip = true
      var g = makeGrip('⠿')
      el.insertBefore(g, el.firstChild)
      bindGrip(g,
        function () { return el.__dshpetPos ? [el.__dshpetPos.x, el.__dshpetPos.y] : null },
        function (x, y) {
          el.__dshpetDragged = true
          var c = clampPos(x, y, el.offsetWidth, el.offsetHeight)
          el.__dshpetPos = { x: c[0], y: c[1] }
          putImportant(el, c[0], c[1])
        },
        function () { el.__dshpetDragged = true })
    }
    // 只有用户拖过的才持续接管位置（拖动过程中每轮重写同一份值，
    // 视觉无变化，但能压住挂件在打开瞬间写入的普通行内值）
    if (el.__dshpetDragged && el.__dshpetPos) {
      var w = el.offsetWidth, h = el.offsetHeight
      if (!w || !h) return
      var c = clampPos(el.__dshpetPos.x, el.__dshpetPos.y, w, h)
      el.__dshpetPos = { x: c[0], y: c[1] }
      putImportant(el, c[0], c[1])
    }
  }

  // —— ② 弹窗面板（.dshwv-bubmask 系遮罩 + 弹性居中卡片）：按住标题栏拖动 ——
  // 卡片在分区定位下会被写成 position:absolute + left/top（视口坐标，
  // 遮罩是 fixed inset:0，两者重合）；拖动以**按下瞬间的实测矩形**为基准
  // 继续写绝对坐标，与定位模块同一套坐标系。按下一律打 __dshpetUserDragged
  // 标记 —— 分区定位模块看到它就不再接管这块卡片。
  function bindCardDrag(card, title) {
    card.__dshpetTitleDrag = true
    title.classList.add('dshpet-draggable-title')
    title.addEventListener('pointerdown', function (e) {
      e.stopPropagation()
      card.__dshpetUserDragged = true
      var r = card.getBoundingClientRect()
      var bl = r.left, bt = r.top
      var sx = e.clientX, sy = e.clientY
      // 还没被分区定位接管过（static、靠遮罩 flex 居中）→ 先转 absolute，
      // 否则 left/top 对静态元素不生效，拖了没反应
      setImp(card, 'position', 'absolute')
      try { title.setPointerCapture(e.pointerId) } catch (err) {}
      var move = function (ev) {
        putImportant(card, bl + ev.clientX - sx, bt + ev.clientY - sy)
      }
      var up = function () {
        title.removeEventListener('pointermove', move)
        title.removeEventListener('pointerup', up)
        title.removeEventListener('pointercancel', up)
      }
      title.addEventListener('pointermove', move)
      title.addEventListener('pointerup', up)
      title.addEventListener('pointercancel', up)
    })
  }
  function handleMasks() {
    var cards = document.querySelectorAll('.dshwv-bubmask .dshwv-bubcard')
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i]
      if (card.__dshpetTitleDrag) continue
      var title = card.querySelector('.dshwv-bubtitle')
      if (!title) continue
      bindCardDrag(card, title)
    }
  }

  // ========================================================================
  // ③ 分区菜单定位
  // ========================================================================
  // 定位写入用「实测矩形 + 位移量」：先量元素当前视口矩形，算出与目标点
  // 的差值，再把这个差值加到它现有的 left/top 使用值上。这样无论元素的
  // containing block 是视口还是别的定位祖先（三级列表是 .dshwv-menu 的
  // DOM 子节点，玻璃的 backdrop-filter 会让它成为 fixed 后代的包含块），
  // 落点都是对的 —— 不用关心各自的坐标系。
  function setImp(el, prop, val) {
    // ⚠️ 对照**真实内联值**判断要不要写，不能只看自己的记忆 —— vendor 开菜单
    //    时会用普通优先级重写 bottom/left/right（positionMenu），把我们上一轮
    //    的 important 值覆盖掉；若只看记忆就会漏写，top+bottom 过约束会把
    //    菜单盒压塌（实测 26px）。值相同但优先级丢了也要重写。
    var cur = null, prio = ''
    try { cur = el.style.getPropertyValue(prop); prio = el.style.getPropertyPriority(prop) } catch (e) {}
    if (cur === val && prio === 'important') return
    try { el.style.setProperty(prop, val, 'important') } catch (e) {}
    var m = el.__dshpetZoneStyles || (el.__dshpetZoneStyles = {})
    m[prop] = val
  }
  function unsetImp(el, prop) {
    var m = el.__dshpetZoneStyles
    if (!(m && m[prop])) return
    delete m[prop]
    try { el.style.removeProperty(prop) } catch (e) {}
  }

  // 屏幕工作区在**视口坐标**里的可视范围（窗口可能半截在屏幕外，
  // 能画出来的区域 = 视口 ∩ 屏幕工作区 —— 钳制只认这个交集）
  function visibleRect(ox0, oy0) {
    var oX = ox0 !== undefined ? ox0 : (window.screenX || 0)
    var oY = oy0 !== undefined ? oy0 : (window.screenY || 0)
    var avL = 0, avT = 0, avW = window.innerWidth, avH = window.innerHeight
    try {
      if (window.screen) {
        avL = window.screen.availLeft || 0
        avT = window.screen.availTop || 0
        if (window.screen.availWidth) avW = window.screen.availWidth
        if (window.screen.availHeight) avH = window.screen.availHeight
      }
    } catch (e) {}
    var l = Math.max(0, avL - oX), t = Math.max(0, avT - oY)
    var r = Math.min(window.innerWidth, avL + avW - oX)
    var b = Math.min(window.innerHeight, avT + avH - oY)
    if (r - l < 50 || b - t < 50) return { l: 0, t: 0, r: window.innerWidth, b: window.innerHeight }
    return { l: l, t: t, r: r, b: b }
  }

  // 她脚底的屏幕纵坐标落在工作区哪个三分之一 → 上/中/下分区
  function pickZone(art) {
    var oY = window.screenY || 0
    var avT = 0, avH = window.innerHeight
    try {
      if (window.screen) {
        avT = window.screen.availTop || 0
        if (window.screen.availHeight) avH = window.screen.availHeight
      }
    } catch (e) {}
    var rel = avH > 0 ? (art.bottom + oY - avT) / avH : 1
    if (rel >= 2 / 3) return 'bottom'
    if (rel <= 1 / 3) return 'top'
    return 'mid'
  }

  // ========================================================================
  // ④ 菜单窗口平移（上方区"正下方" / 中间区偏左侧的"右侧"）
  // ========================================================================
  // 她脚底以下、她右缘以右都在窗口外——那里要摆菜单就只能把窗口临时挪过去。
  // 做法：菜单打开期间把窗口平移 Δ（**尺寸不变**，视频不受影响），同时把
  // 立绘的「钉住位」从 right:0/bottom:0 改成 right:Δx/bottom:Δy ——
  // ⚠️ 钉住位是 drag-physics 的 restorePinnedRoot 用 !important 每 100ms 写死
  //    的（"根必须一直钉在窗口右下"是它的核心不变量），**不能自己去写
  //    left/top 跟它抢**（实测会被碾掉）——正确做法就是旧"窗口生长"的结论：
  //    让 restorePinnedRoot 感知 __dshpetMenuShiftDelta，钉住位=Δ。这边只负责
  //    设偏移量、挪窗口、复位。
  // ⚠️ 分区（openZone）**每次打开只判一次并冻结**：平移落定前的过渡帧里
  //    "窗口已动、补偿未生效"，实时重算会把 top 误判成 bottom → 释放平移 →
  //    下一轮又判成 top → 再平移……无限乒乓（实测窗口来回弹）。
  var shift = null   // { dx, dy, ox, oy, dir: 'below'|'right', landed, failed }
  function shiftActive() { return !!(shift && !shift.failed) }

  function writePin(dx, dy) {
    var root = document.querySelector('.dshwv-root')
    if (!root) return
    try {
      root.style.setProperty('left', 'auto', 'important')
      root.style.setProperty('top', 'auto', 'important')
      root.style.setProperty('right', Math.round(dx) + 'px', 'important')
      root.style.setProperty('bottom', Math.round(dy) + 'px', 'important')
    } catch (e) {}
  }

  function ensureShift(zone, art, menu) {
    var menuW = Math.max(menu.offsetWidth, menu.scrollWidth)
    var menuH = Math.max(menu.offsetHeight, menu.scrollHeight)
    var wantDx = 0, wantDy = 0, dir = null
    if (zone === 'top') {
      // 菜单要完整落到她脚底下方：窗口向下挪 menuH + 间隙
      wantDy = menuH + 12
      dir = 'below'
    } else if (zone === 'mid') {
      // 她在屏幕左半 → 菜单开她右侧：窗口右缘要伸到她右缘 + 菜单宽 + 间隙
      // ⚠️ 用**平移前**的立绘右缘算需求：补偿生效后 art.right 已含 -Δ，
      //    直接拿它算会得出"Δ 越大需求越小"的自引用 → Δ 在 131↔0 间振荡
      //    （窗口来回弹，实测踩坑）。
      var oX = window.screenX || 0
      var avL = 0, avW = window.innerWidth
      try { if (window.screen) { avL = window.screen.availLeft || 0; if (window.screen.availWidth) avW = window.screen.availWidth } } catch (e) {}
      var centerX = art.left + (window.screenX || 0) + art.width / 2
      if (centerX < avL + avW / 2) {
        var artRight0 = art.right + (shift ? shift.dx : 0)
        wantDx = Math.max(0, menuW + 16 - (window.innerWidth - artRight0))
        dir = 'right'
        // 她偏高时窗口可视高度可能装不下菜单 → 组合向下平移。
        // ⚠️ 按**平移前**的原点算可视高度（和 artRight0 同一个道理，
        //    否则 Δ 自己影响需求 → 振荡）
        var bx = shift ? shift.ox : (window.screenX || 0)
        var by = shift ? shift.oy : (window.screenY || 0)
        var vis0 = visibleRect(bx, by)
        wantDy = Math.max(0, menuH + 16 - (vis0.b - vis0.t))
      }
    }
    if (!dir) { if (shift) releaseShift(); return }
    if (shift && shift.failed) return   // 本次打开已失败 → 兜底方案，不再重试
    if (shift && shift.dir === dir) {
      // 已在平移：菜单尺寸变了就微调 Δ
      if (Math.abs(wantDx - shift.dx) > 8 || Math.abs(wantDy - shift.dy) > 8) {
        shift.dx = wantDx; shift.dy = wantDy
        window.__dshpetMenuShiftDelta = { dx: shift.dx, dy: shift.dy }
        writePin(shift.dx, shift.dy)
        try { window.petApi.moveWindow({ x: shift.ox + shift.dx, y: shift.oy + shift.dy }) } catch (e) {}
      }
      return
    }
    if (shift) releaseShift()
    var ox = window.screenX || 0, oy = window.screenY || 0
    shift = { dx: wantDx, dy: wantDy, ox: ox, oy: oy, dir: dir, landed: false, failed: false }
    window.__dshpetMenuShift = true
    window.__dshpetMenuShiftDelta = { dx: wantDx, dy: wantDy }
    writePin(wantDx, wantDy)   // 立刻换钉住位（物理层的周期重钉会写同样的值）
    try { window.petApi.moveWindow({ x: ox + wantDx, y: oy + wantDy }) } catch (e) { shift.failed = true }
    // 等窗口真的挪过去（rAF 轮询 screenX/Y），落定后重摆一次；600ms 兜底放弃
    var t0 = Date.now()
    ;(function poll() {
      if (!shift || shift.landed) return
      var gx = Math.abs((window.screenX || 0) - (shift.ox + shift.dx))
      var gy = Math.abs((window.screenY || 0) - (shift.oy + shift.dy))
      if (gx < 2 && gy < 2) {
        shift.landed = true
        schedulePlace()
        return
      }
      if (Date.now() - t0 > 600) { shift.failed = true; return }
      requestAnimationFrame(poll)
    })()
  }

  function releaseShift() {
    if (!shift) return
    var s = shift
    shift = null
    openZone = null
    window.__dshpetMenuShift = false
    // ⚠️ 实际动作放进 rAF（与打开路径同款时序）：同一次 rAF 里先撤钉住位、
    //    再挪窗，两个变化落在同一次绘制里。600ms 兜底强制撤。
    requestAnimationFrame(function () {
      window.__dshpetMenuShiftDelta = { dx: 0, dy: 0 }
      writePin(0, 0)
      try { window.petApi.moveWindow({ x: s.ox, y: s.oy }) } catch (e) {}
    })
  }

  function placeMenuBox(zone, art) {
    var menu = document.querySelector('.dshwv-menu')
    if (!menu) return null
    var vis = visibleRect()
    var mw = menu.offsetWidth, mh = menu.offsetHeight
    var left, top
    if (zone === 'top' && shiftActive() && shift.dir === 'below') {
      // 窗口已下移：菜单完整落在她脚底正下方，**正常大小不裁剪**
      top = art.bottom + 8
      left = (art.left + art.right) / 2 - mw / 2
      unsetImp(menu, 'max-height')
      unsetImp(menu, 'overflow-y')
    } else if (zone === 'top') {
      // 平移不可用（IPC 失败/超时）的兜底：贴身向上 + 裁高内滚
      var capH = art.bottom - vis.t - 4
      var naturalH = Math.max(mh, menu.scrollHeight)
      if (capH > 100 && naturalH > capH) {
        setImp(menu, 'max-height', Math.round(capH) + 'px')
        setImp(menu, 'overflow-y', 'auto')
        mh = Math.min(mh, Math.round(capH))
      }
      top = art.bottom - mh
      left = (art.left + art.right) / 2 - mw / 2
    } else if (zone === 'mid') {
      if (shiftActive() && shift.dir === 'right') {
        left = art.right + 8            // 窗口已右移：菜单开在她右侧
        setImp(menu, 'transform-origin', 'left center')
      } else {
        left = art.left - 8 - mw        // 有空间的一侧（她的左侧）
        setImp(menu, 'transform-origin', 'right center')
      }
      top = (art.top + art.bottom) / 2 - mh / 2
    } else {
      top = art.top - 6 - mh
      left = (art.left + art.right) / 2 - mw / 2
      setImp(menu, 'transform-origin', 'center bottom')
    }
    // 越出屏幕就收进来（收不干净时允许压住她，绝不跑出桌面）
    left = Math.max(vis.l + 4, Math.min(left, vis.r - mw - 4))
    top = Math.max(vis.t + 4, Math.min(top, vis.b - mh - 4))
    if (zone !== 'mid') setImp(menu, 'transform-origin', zone === 'top' && shiftActive() ? 'center top' : 'center bottom')
    moveTo(menu, left, top, false)
    return { l: left, t: top, r: left + mw, b: top + mh, w: mw, h: mh }
  }

  // 把元素挪到视口目标点：位移量加到它现有 left/top 的**使用值**上
  //（getComputedStyle().left 返回的是已解析的使用值，与 containing block 无关）
  function moveTo(el, vx, vy, asAbsolute) {
    var r = el.getBoundingClientRect()
    var dx = vx - r.left, dy = vy - r.top
    if (asAbsolute) setImp(el, 'position', 'absolute')
    if (el.__dshpetZoneOwned && Math.abs(dx) < 1 && Math.abs(dy) < 1) return
    var cs = getComputedStyle(el)
    var bl = parseFloat(cs.left), bt = parseFloat(cs.top)
    if (!isFinite(bl)) bl = r.left
    if (!isFinite(bt)) bt = r.top
    setImp(el, 'left', Math.round(bl + dx) + 'px')
    setImp(el, 'top', Math.round(bt + dy) + 'px')
    setImp(el, 'right', 'auto')
    setImp(el, 'bottom', 'auto')
    el.__dshpetZoneOwned = true
  }

  // 菜单开着时要摆到菜单边上的二级/三级面板。
  // ⚠️ **偷吃白饭 / 形象与互动不接管**（实测教训）：rice 的 placeMenu 每 700ms
  //    重写 left/top、rice-entry 另有 transform 避让、形象与互动每 400ms 自己
  //    贴住菜单 —— 我们再用 important 写 left/top 就成了三个写者打架，面板每
  //    秒在两个位置间乒乓（"一闪一闪"、按钮在指针底下跳、点了没反应）。
  //    它们各自的避让逻辑本来就是为"避开 ☰ 菜单"设计的，交还给它们。
  // .dshwv-menu 内部的子界面（记账 .dshwv-usage-sub / 菜单视图）跟着菜单盒
  // 走，不用管；自绘下拉（.dshwv-rgbmenu 系）锚在自己的行上，也不挪。
  var FLOAT_SEL = [
    '.dshwv-rolelist', '.dshwv-audiolist', '.dshwv-slotlist',
    '.dshwv-linepanel', '.dshwv-custmenu', '.dshwv-fontmenu',
    '.dshwv-qcolmenu', '.dshwv-usagepanel',
  ].join(',')
  var CARD_SEL = [
    '.dshwv-bubcard', '.dshwv-snapwin', '.dshwv-usage-card',
    '.dshwv-rescard', '.dshwv-audiowin', '.dshwv-confirmwin',
    '.dshwv-gifwin', '.dshwv-cropwin',
  ].join(',')

  function nestedPanel(el) {
    var p = el.parentElement
    var sel = FLOAT_SEL + ',' + CARD_SEL
    while (p) {
      try { if (p.matches && p.matches(sel)) return true } catch (e) {}
      p = p.parentElement
    }
    return false
  }
  function rectsIntersect(a, b) {
    return a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t
  }

  function placePanels(mr) {
    var vis = visibleRect()
    var els
    try { els = document.querySelectorAll(FLOAT_SEL + ',' + CARD_SEL) } catch (e) { return }
    var placed = []
    var ztr = window.__dshpetZoneTrace   // 调试：外部预先设为数组才记录
    for (var i = 0; i < els.length; i++) {
      var el = els[i]
      if (!el.offsetWidth || !el.offsetHeight) continue            // 不可见
      if (el.__dshpetDragged || el.__dshpetUserDragged) continue   // 用户拖过的
      if (el.classList.contains('dshpet-presspin')) { clearOwned(el); continue }
      if (nestedPanel(el)) continue                                // 跟着父面板走
      var pw = el.offsetWidth, ph = el.offsetHeight
      // 依次试：菜单左侧 → 菜单上方 → 菜单下方；都放不下才允许压住菜单
      var cands = [
        { x: mr.l - 8 - pw, y: mr.t },
        { x: mr.r + 8, y: mr.t },
        { x: mr.l, y: mr.t - 8 - ph },
        { x: mr.l, y: mr.t + mr.h + 8 },
      ]
      var pick = null
      var pickWhy = ''
      for (var c = 0; c < cands.length; c++) {
        var x = Math.max(vis.l + 4, Math.min(cands[c].x, vis.r - pw - 4))
        var y = Math.max(vis.t + 4, Math.min(cands[c].y, vis.b - ph - 4))
        var rr = { l: x, t: y, r: x + pw, b: y + ph }
        var blocked = rectsIntersect(rr, mr)
        for (var q = 0; q < placed.length; q++) if (rectsIntersect(rr, placed[q])) blocked = true
        if (ztr) ztr.push(
          'cand' + c + ' raw=(' + Math.round(cands[c].x) + ',' + Math.round(cands[c].y) +
          ') clamped=(' + Math.round(x) + ',' + Math.round(y) + ') blocked=' + blocked)
        if (!blocked) { pick = { x: x, y: y }; pickWhy = 'cand' + c; break }
      }
      if (!pick) {
        pick = {
          x: Math.max(vis.l + 4, Math.min(cands[0].x, vis.r - pw - 4)),
          y: Math.max(vis.t + 4, Math.min(cands[0].y, vis.b - ph - 4)),
        }
        pickWhy = 'fallback'
      }
      if (ztr) ztr.push(
        'PICK ' + pickWhy + ' mr=' + [mr.l, mr.t, mr.r, mr.b].map(Math.round).join(',') +
        ' wh=' + pw + 'x' + ph + ' vis=[' + [vis.l, vis.t, vis.r, vis.b].join(',') + ']')
      moveTo(el, pick.x, pick.y, el.matches(CARD_SEL))
      placed.push({ l: pick.x, t: pick.y, r: pick.x + pw, b: pick.y + ph })
    }
  }

  // 菜单一关就交还：清掉我们写过的行内定位（菜单盒自己的不清 —— 关闭
  // 动画还用它，下次打开我们会重写）。偷吃白饭/形象与互动交还后，它们
  // 自己每 400~700ms 的跟随逻辑立刻恢复；卡片/列表下次打开由 vendor 重
  // 新定位、我们在同一帧内接管，不会闪旧位置。
  function clearOwned(el) {
    if (!el.__dshpetZoneOwned) return
    el.__dshpetZoneOwned = false
    el.__dshpetZoneStyles = null
    var props = ['left', 'top', 'right', 'bottom', 'position', 'max-height', 'overflow-y']
    for (var i = 0; i < props.length; i++) {
      try { el.style.removeProperty(props[i]) } catch (e) {}
    }
  }
  function zoneCleanup() {
    var els
    try { els = document.querySelectorAll(FLOAT_SEL + ',' + CARD_SEL) } catch (e) { return }
    for (var i = 0; i < els.length; i++) clearOwned(els[i])
  }

  var openZone = null   // 本次菜单打开判定的分区（冻结，防过渡帧误判）

  function placeAll() {
    var menu = document.querySelector('.dshwv-menu')
    var img = document.querySelector('img.dshwv-img')
    if (!menu || !img) return null
    var art = img.getBoundingClientRect()
    if (!art || art.width < 2) return null
    if (!openZone) openZone = pickZone(art)
    var zone = openZone
    ensureShift(zone, art, menu)
    // 平移未落定时用「预期立绘矩形」（补偿后的视口位置）摆菜单——
    // 视口坐标与窗口位置无关，先写终值，窗口挪过去的同一瞬间就是对的
    var artP = art
    if (shiftActive() && !shift.landed) {
      artP = {
        left: art.left - shift.dx, top: art.top - shift.dy,
        right: art.right - shift.dx, bottom: art.bottom - shift.dy,
        width: art.width, height: art.height,
      }
    }
    var mr = placeMenuBox(zone, artP)
    if (mr) placePanels(mr)
  }

  // ☰ 菜单开/关 + 菜单子树里 vendor 写样式（打开三级列表等）→ 同帧内接管，
  // 不给"先闪一下原位"的机会。rAF 合帧：一帧最多摆一次。
  var placePending = false
  var menuObs = null
  function schedulePlace() {
    var menu = document.querySelector('.dshwv-menu')
    if (!menu || !menu.classList.contains('dshwv-menu-open')) return
    if (placePending) return
    placePending = true
    requestAnimationFrame(function () {
      placePending = false
      var m = document.querySelector('.dshwv-menu')
      if (m && m.classList.contains('dshwv-menu-open')) placeAll()
    })
  }
  function watchMenu() {
    if (menuObs) return true
    var menu = document.querySelector('.dshwv-menu')
    if (!menu) return false
    menuObs = new MutationObserver(function () {
      var m = document.querySelector('.dshwv-menu')
      if (m && m.classList.contains('dshwv-menu-open')) schedulePlace()
      else { openZone = null; releaseShift(); zoneCleanup() }
    })
    menuObs.observe(menu, { attributes: true, attributeFilter: ['class', 'style'], subtree: true })
    return true
  }

  // —— 轮询：面板出现即绑定拖动。150ms 一轮、每轮几个 querySelector，代价可忽略。
  //    不用 MutationObserver 的原因：面板的创建路径太多（挂件各处都在写），
  //    轮询是唯一"不管谁开的面板都认"的口径。
  function tick() {
    var lists = document.querySelectorAll('.dshwv-rolelist,.dshwv-audiolist,.dshwv-slotlist')
    for (var i = 0; i < lists.length; i++) handleList(lists[i])
    handleMasks()
    // 分区定位：观察器负责开/关瞬间与 vendor 写样式的同帧响应，
    // 这里 150ms 一轮兜底（新面板、她被挪动后的重钳制）。
    if (watchMenu()) {
      var menu = document.querySelector('.dshwv-menu')
      if (menu && menu.classList.contains('dshwv-menu-open')) placeAll()
    }
  }

  function start() {
    ensureCss()
    setInterval(tick, 150)
    log('面板拖动 + 分区菜单定位已就绪（上/中/下分区摆菜单，二级/三级贴菜单左侧；' +
      '弹窗按标题栏、列表按 ⠿ 手柄拖动；不扩窗、不影响视频）')
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
})()
