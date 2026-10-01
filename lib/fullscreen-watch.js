// ============================================================================
// 全屏检测 —— 前台窗口铺满主屏（视频全屏 / 无边框播放器 / F11 等）时通知宿主，
// 让桌宠"让路"（隐藏，别挡视频），全屏结束再回来。
// ============================================================================
// 检测手段：常驻一个 PowerShell 子进程（与 lib/now-playing.js 的 gsmtc.ps1 同路数），
// 每 ~1 秒 P/Invoke 一次：
//     GetForegroundWindow() → 前台窗口
//     GetWindowRect()       → 它的矩形
//     GetSystemMetrics(0/1) → 主屏宽高
//     GetWindowThreadProcessId() / GetClassName()
// 判定"全屏"：矩形与主屏完全重合（容差 4px，防边缘差 1px 的播放器），
// 且**不是我们自己进程**的窗口（桌宠/设置窗本身就是铺满主屏的！）、
// 不是桌面（Progman / WorkerW）和任务栏（Shell_TrayWnd）。
//
// ⚠️ DPI：PowerShell（Windows PowerShell 5.1）默认 DPI-unaware，所有窗口矩形
//    和 GetSystemMetrics 都按同一套虚拟化坐标返回 —— 互相比较是自洽的，
//    不需要换算（换算反而会错）。
//
// 输出协议：状态**变化**时向 stdout 打一行 `FS 1` / `FS 0`（不全量刷，防IPC 噪声）。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const SCRIPT = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class FSWatch {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a, bool b, uint pid);
  [DllImport("kernel32.dll")] public static extern bool QueryFullProcessImageName(IntPtr h, uint f, System.Text.StringBuilder sb, ref uint size);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@
# 截图/IM 的全屏覆盖层不算"全屏视频"：QQ 截屏（Ctrl+Alt+A）、微信截屏、
# Snipaste 等都会短暂铺满主屏 —— 之前被判成全屏让桌宠让路，表现就是
# "一截屏桌宠就消失"，个别机器恢复后还会点不动。
# 两道判据，命中任一就跳过：
#   ① 进程名（qq/wechat/…—— 名单可能跟不上版本，比如 QQ 新架构换子进程）；
#   ② **窗口样式 WS_EX_TOOLWINDOW（0x80）**—— 截图覆盖层/悬浮工具窗几乎都带
#      这个样式，而真正的全屏视频窗口没有。这是进程无关的兜底。
$excl = @('qq.exe','wechat.exe','weixin.exe','tim.exe','snipaste.exe','pixpin.exe','sharex.exe','fscapture.exe','snippingtool.exe','screenclip.exe')
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$last = -1
while ($true) {
  $fs = 0
  try {
    $h = [FSWatch]::GetForegroundWindow()
    if ($h -ne [IntPtr]::Zero) {
      $r = New-Object FSWatch+RECT
      [void][FSWatch]::GetWindowRect($h, [ref]$r)
      $p = 0
      [void][FSWatch]::GetWindowThreadProcessId($h, [ref]$p)
      $sb = New-Object System.Text.StringBuilder 256
      [void][FSWatch]::GetClassName($h, $sb, 256)
      $cls = $sb.ToString()
      $w = [FSWatch]::GetSystemMetrics(0)
      $hh = [FSWatch]::GetSystemMetrics(1)
      $own = ($p -eq __OWNPID__)
      $shell = ($cls -eq 'Progman' -or $cls -eq 'WorkerW' -or $cls -eq 'Shell_TrayWnd')
      $shot = $false
      $leaf = ''
      $ph = [FSWatch]::OpenProcess(0x1000, $false, $p)
      if ($ph -ne [IntPtr]::Zero) {
        $sb2 = New-Object System.Text.StringBuilder 1024
        $sz = [uint32]1024
        if ([FSWatch]::QueryFullProcessImageName($ph, 0, $sb2, [ref]$sz)) {
          $leaf = [IO.Path]::GetFileName($sb2.ToString()).ToLower()
          $shot = $excl.Contains($leaf)
        }
        [void][FSWatch]::CloseHandle($ph)
      }
      if (-not $shot) {
        # GWL_EXSTYLE = -20；WS_EX_TOOLWINDOW = 0x80（截图覆盖层/工具浮窗的标志）
        $exstyle = [FSWatch]::GetWindowLong($h, -20)
        $shot = (($exstyle -band 0x80) -ne 0)
      }
      if (-not $own -and -not $shell -and -not $shot -and
          [Math]::Abs($r.Left) -le 4 -and [Math]::Abs($r.Top) -le 4 -and
          [Math]::Abs(($r.Right - $r.Left) - $w) -le 4 -and
          [Math]::Abs(($r.Bottom - $r.Top) - $hh) -le 4) { $fs = 1 }
    }
  } catch {}
  if ($fs -ne $last) {
    $last = $fs
    # 带上类名/进程名：用户报"桌宠又消失了"时，pet.log 里这行能直接定位是谁触发
    Write-Output ("FS " + $fs + " " + $cls + " " + $leaf)
  }
  Start-Sleep -Milliseconds 1000
}
`

export function createFullscreenWatch({ log = () => {}, onFullscreen, ownPid = process.pid } = {}) {
  let child = null
  let stopping = false
  let restarts = 0
  let buf = ''
  let lastError = ''

  function say(m) { try { log('[全屏检测] ' + m) } catch (e) {} }

  function materialize() {
    const dir = path.join(process.env.TEMP || process.env.TMP || '.', 'dshw-fswatch')
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'fs-watch.ps1')
    fs.writeFileSync(p, SCRIPT.replace('__OWNPID__', String(ownPid)), 'utf8')
    return p
  }

  function handleLine(line) {
    const m = /^\s*FS\s+([01])(?:\s+(\S+)(?:\s+(\S.*))?)?\s*$/.exec(line)
    if (!m) return
    try {
      if (m[1] === '1') say('进入全屏（前台=' + (m[3] || '?') + ' 类=' + (m[2] || '?') + '）→ 让路')
      else say('退出全屏 → 恢复')
      onFullscreen(m[1] === '1')
    } catch (e) { say('回调出错：' + (e && e.message)) }
  }

  function spawnIt() {
    if (stopping || child) return
    let exe = 'powershell.exe'
    try {
      const p = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      if (fs.existsSync(p)) exe = p
    } catch (e) {}
    let scriptPath = ''
    try { scriptPath = materialize() } catch (e) { say('写脚本失败：' + (e && e.message)); return }
    try {
      child = spawn(exe, ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      say('启动 PowerShell 失败：' + (e && e.message))
      child = null
      return
    }
    say('已启动全屏轮询（pid ' + (child.pid || '?') + '）')
    buf = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        handleLine(line)
      }
      if (buf.length > 65536) buf = ''
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d) => {
      const s = String(d || '').trim()
      if (s) { lastError = s; say('stderr：' + s.slice(0, 200)) }
    })
    child.on('error', (e) => { lastError = String(e && e.message); say('进程错误：' + lastError) })
    child.on('exit', (code) => {
      child = null
      if (stopping) return
      say('PowerShell 退出了（code ' + code + '）' + (lastError ? '：' + lastError.slice(0, 120) : ''))
      // 退出就重启 —— 但别无限刷屏；重试太多就放弃（此时全屏让路功能不可用，桌宠照常显示）
      if (restarts < 5) {
        restarts++
        setTimeout(() => { if (!stopping) spawnIt() }, 3000)
      } else {
        say('重启次数过多，全屏让路停用（其余功能不受影响）')
      }
    })
  }

  return {
    start() {
      spawnIt()
    },
    // 托盘开关：关掉时杀掉轮询并回调一次"不在全屏"（把藏起来的桌宠放回来）
    setEnabled(on) {
      if (on) {
        stopping = false
        restarts = 0
        spawnIt()
      } else {
        stopping = true
        try { if (child) child.kill() } catch (e) {}
        child = null
        try { onFullscreen(false) } catch (e) {}
      }
    },
    stop() {
      stopping = true
      try { if (child) child.kill() } catch (e) {}
      child = null
    },
  }
}
