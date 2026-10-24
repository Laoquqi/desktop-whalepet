# 小鲸鱼游戏模式 · 光标状态采样（常驻进程，替代上游的 koffi 独立插件）
# 作用：Win32 GetCursorInfo 读「光标是否可见 / 屏幕坐标」，每 500ms 输出一行 JSON 到 stdout。
# 用途：FPS 里游戏隐藏了光标图标但位置仍随视角移动 —— 游戏模式据此暂停「悬停隐藏」，
#       避免视角扫过小鲸鱼就误触发隐藏。
# 说明：不读内存、不注入、不联网，只做一次系统查询；退出即随主进程结束。
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WhaleCursor {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct CURSORINFO { public uint cbSize; public uint flags; public IntPtr hCursor; public POINT ptScreenPos; }
  [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO pci);
}
'@

while ($true) {
  $ci = New-Object WhaleCursor+CURSORINFO
  $ci.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][WhaleCursor+CURSORINFO])
  $ok = [WhaleCursor]::GetCursorInfo([ref]$ci)
  if ($ok) {
    $visible = (($ci.flags -band 1) -ne 0)
    $ts = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
    $x = $ci.ptScreenPos.X
    $y = $ci.ptScreenPos.Y
    $visStr = 'false'
    if ($visible) { $visStr = 'true' }
    ('{"ok":true,"visible":' + $visStr + ',"x":' + $x + ',"y":' + $y + ',"ts":' + $ts + '}')
  } else {
    '{"ok":false}'
  }
  Start-Sleep -Milliseconds 500
}
