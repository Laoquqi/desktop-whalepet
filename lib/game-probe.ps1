$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8

# 前台窗口所属进程（玩全屏游戏时前台窗口必然是游戏本体）
$fgpid = 0
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class Fg{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);public struct RECT{public int Left;public int Top;public int Right;public int Bottom;}}'
$fg = [Fg]::GetForegroundWindow()
[Fg]::GetWindowThreadProcessId($fg, [ref]$fgpid) | Out-Null

# 屏幕分辨率（主屏，用于判断「全屏游戏」）—— 先加载程序集再取
Add-Type -AssemblyName System.Windows.Forms
$sw = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width
$sh = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height

$ps = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CreationDate
$t = @{}
Get-Process | ForEach-Object { $t[$_.Id] = @{ t = $_.MainWindowTitle; h = $_.MainWindowHandle } }

$out = $ps | ForEach-Object {
    # 每个有窗口的进程：取主窗口尺寸
    $w = 0; $h = 0; $wx = 0; $wy = 0
    $hnd = $t[[int]$_.ProcessId].h
    if ($hnd -ne 0) {
        $r = New-Object Fg+RECT
        [Fg]::GetWindowRect($hnd, [ref]$r) | Out-Null
        $w = $r.Right - $r.Left
        $h = $r.Bottom - $r.Top
        $wx = $r.Left
        $wy = $r.Top
    }
    [pscustomobject]@{
        ProcessId     = $_.ProcessId
        ParentProcessId = $_.ParentProcessId
        Name          = $_.Name
        CreationDate  = $_.CreationDate
        Title         = $t[[int]$_.ProcessId].t
        Handle        = $t[[int]$_.ProcessId].h
        IsFg          = ([int]$_.ProcessId -eq [int]$fgpid)
        WinW          = $w
        WinH          = $h
        WinX          = $wx
        WinY          = $wy
        ScrW          = $sw
        ScrH          = $sh
    }
}
$out | ConvertTo-Json -Compress

