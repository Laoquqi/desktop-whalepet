# ============================================================================
# Read the currently-playing track from Windows media sessions (GSMTC / WinRT)
# ============================================================================
# NOTE ON LANGUAGE: this file is deliberately **ASCII-only (English comments)**.
#   Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI (the system code page).
#   This file used to have Chinese comments; without a BOM they got mis-decoded
#   and the mangled bytes produced real *syntax errors* ("Unexpected token '}'").
#   A BOM fixes it, but a BOM is easy to lose (editors, git normalization,
#   copy/paste), and the failure mode is a cryptic parse error. Keeping the
#   source pure ASCII removes that whole class of problem.
#   Chinese *runtime data* (song titles) is unaffected: that is handled by
#   [Console]::OutputEncoding below, not by the source encoding.
#
# WHY GSMTC instead of other approaches:
#   * Window titles (Get-Process MainWindowTitle): empty when the player is
#     minimized to the tray or in mini mode, and the "Song - Artist" format
#     differs per player/version, so it needs fragile string guessing.
#   * Audio fingerprinting (Shazam-style): needs audio capture plus a network
#     service, far heavier, and useless offline.
#   * GSMTC: built into Windows 10+. Kugou / NetEase Cloud Music / QQ Music all
#     register their current track here (it is the card that pops up when you
#     press a volume key), and it exposes **structured fields**
#     (Title / Artist / Album) so there is nothing to parse.
#     The only catch: it is WinRT, which Node cannot call directly - hence
#     PowerShell.
#
# This script is LONG-LIVED: start it once and it writes one JSON line to
# stdout every 1.5s. Spawning a fresh PowerShell per poll would cost 300-600ms
# of cold start each time, wasting CPU and making "now playing" visibly lag.
$ErrorActionPreference = 'Stop'

# Force UTF-8 on stdout. When stdout is redirected, PowerShell 5.1 defaults to
# the console OEM code page, which turns Chinese titles into mojibake.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null

# WinRT IAsyncOperation must be turned into a .NET Task before it can be waited on.
# NOTE: this is deliberately ONE line. PowerShell 5.1 (unlike 7) does NOT continue
# a statement when a line ends with a binary operator, so leaving "-and" at the
# end of a line is a hard syntax error.
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

function Await($op, $type) {
  $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $t.Wait(4000)) { throw 'await timeout' }
  return $t.Result
}

$mgrType   = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]

function Emit($obj) {
  try {
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4))
    [Console]::Out.Flush()
  } catch {}
}

# ---------------------------------------------------------------------------
# MSAA fallback for players that never publish a timeline over SMTC.
#
# Measured on KuGou (dev repo: _smtc-probe.log, 300ms x 25s x 84 samples,
# including a seek and a pause): SMTC reports
#     pos = 0, posAt = unset, dur = 0, rate = 0
# for EVERY sample. Only title / artist / status are usable. So without help
# the lyric clock has to free-run, and any seek desyncs it forever.
#
# The player's own UI does expose the position through MSAA though:
#     role=STATICTEXT name=[00:13/04:37] value=[00:13/04:37]
#     role=SLIDER     name=[Progress]    value=[4%]
# so when the SMTC timeline is empty we read that static text instead.
#
# Cost control: depth cap + node budget + early exit, and the result is cached
# for ~900ms (the text only changes once per second anyway).
# Everything is wrapped in try/catch: if MSAA is unavailable we simply keep the
# old behaviour and the renderer falls back to its local clock.
# ---------------------------------------------------------------------------
$MSAA_CS = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class MsaaPos
{
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);

    [DllImport("oleacc.dll")]
    public static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint dwObjectID, ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out object ppvObject);

    public static IntPtr[] VisibleTopWindows(uint pid)
    {
        List<IntPtr> list = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            uint p; GetWindowThreadProcessId(h, out p);
            if (p == pid && IsWindowVisible(h)) list.Add(h);
            return true;
        }, IntPtr.Zero);
        return list.ToArray();
    }

    public static string ClassOf(IntPtr h)
    {
        StringBuilder c = new StringBuilder(256);
        GetClassNameW(h, c, 256);
        return c.ToString();
    }

    public static string TitleOf(IntPtr h)
    {
        StringBuilder t = new StringBuilder(512);
        GetWindowTextW(h, t, 512);
        return t.ToString();
    }

    public static object Acc(IntPtr h)
    {
        Guid iid = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
        object o = null;
        int hr = AccessibleObjectFromWindow(h, 0xFFFFFFFC, ref iid, out o);
        if (hr != 0) return null;
        return o;
    }
}
'@

$script:msaaTried = $false
$script:msaaReady = $false
$script:msaaCache = $null
$script:msaaCacheAt = 0
$script:msaaCacheKey = ''
$script:msaaProcs = $null
$script:msaaProcsAt = 0
$script:msaaFound = $null
$script:msaaVisited = 0
# Node-path cache: after the first full tree walk we remember the child-index
# path from the window root down to the time text. Re-walking it costs a handful
# of accChild calls instead of hundreds -- the difference between ~4s and ~5ms
# per sample (measured: without it the whole poll loop ran at 1 sample / 7s).
$script:msaaHwnd = [IntPtr]::Zero
# Which app the cached hwnd/path belong to. WITHOUT this the cache leaks across
# apps: the first app that resolves a window owns the cache, and every other
# session (Bilibili, QQ Music, ...) then reads THAT window's time text and gets
# a plausible-looking but completely wrong position. Seen in the wild:
# bilibili session reporting KuGou's 142s/277s.
$script:msaaHwndApp = ''
$script:msaaPath = @()
$script:msaaNode = $null
$script:msaaNodeApp = ''
$script:msaaLast = $null
$script:msaaLastApp = ''
# Negative cache: apps whose UI has no time text (browsers, video players, ...)
# would otherwise force a FULL tree walk every poll -- hundreds of cross-process
# COM calls each time, which stalls the whole 500ms loop. Remember the failure
# and skip that app for 30s.
$script:msaaFail = @{}
# Apps that resolved at least once. Used to pick the retry back-off below.
$script:msaaOk = @{}
$script:msaaStack = New-Object System.Collections.ArrayList

function Ensure-Msaa {
  if ($script:msaaTried) { return $script:msaaReady }
  $script:msaaTried = $true
  try {
    Add-Type -TypeDefinition $MSAA_CS -Language CSharp | Out-Null
    $script:msaaReady = $true
  } catch {
    $script:msaaReady = $false
  }
  return $script:msaaReady
}

# Process list is cached for 10s -- Get-Process on every poll is wasteful.
function Get-ProcsFor($key) {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($null -eq $script:msaaProcs -or ($now - $script:msaaProcsAt) -gt 10000) {
    $list = @()
    try {
      foreach ($p in Get-Process) {
        $list += [pscustomobject]@{ id = $p.Id; nm = $p.ProcessName.ToLowerInvariant() }
      }
    } catch {}
    $script:msaaProcs = $list
    $script:msaaProcsAt = $now
  }
  $out = @()
  foreach ($p in $script:msaaProcs) {
    if ($p.nm.Length -lt 3) { continue }
    if ($p.nm.Contains($key) -or $key.Contains($p.nm)) { $out += $p }
  }
  return $out
}

# "00:13/04:37" -> @{ pos = 13; dur = 277 }. Returns $null if it is not that shape.
function Convert-TimeText($t) {
  if ([string]::IsNullOrEmpty($t)) { return $null }
  if ($t -match '^\s*(\d{1,3}):(\d{2})\s*/\s*(\d{1,3}):(\d{2})\s*$') {
    return @{
      pos = ([int]$Matches[1] * 60 + [int]$Matches[2])
      dur = ([int]$Matches[3] * 60 + [int]$Matches[4])
    }
  }
  return $null
}

function Read-AccText($acc) {
  $nm = ''; $vl = ''
  try { $nm = [string]$acc.accName(0) } catch {}
  try { $vl = [string]$acc.accValue(0) } catch {}
  if ($nm.Length -gt 0) { return $nm }
  if ($vl.Length -gt 0) { return $vl }
  return ''
}

# Depth-first, early exit. Sets $script:msaaFound and records the path.
function Find-TimeText($acc, $depth) {
  if ($null -eq $acc) { return }
  if ($null -ne $script:msaaFound) { return }
  if ($depth -gt 7) { return }
  if ($script:msaaVisited -ge 500) { return }
  $script:msaaVisited++

  $hit = Convert-TimeText (Read-AccText $acc)
  if ($null -ne $hit) {
    $script:msaaFound = $hit
    $script:msaaPath = @($script:msaaStack.ToArray())
    return
  }

  $cnt = 0
  try { $cnt = [int]$acc.accChildCount } catch { $cnt = 0 }
  for ($i = 1; $i -le $cnt; $i++) {
    if ($null -ne $script:msaaFound) { return }
    $c = $null
    try { $c = $acc.accChild($i) } catch {}
    if ($null -ne $c) {
      [void]$script:msaaStack.Add($i)
      Find-TimeText $c ($depth + 1)
      if ($null -ne $script:msaaFound) { return }
      [void]$script:msaaStack.RemoveAt($script:msaaStack.Count - 1)
    }
  }
}

# Follow the cached child-index path. Returns $null when the tree changed.
# Follow the cached child-index path and return the NODE OBJECT itself.
# Keeping the object around is the whole point: re-acquiring the root and
# walking the path costs ~300ms per poll (measured: the loop went from 520ms to
# 875ms), while reading accName/accValue off a held node costs a few ms.
function Resolve-AccPath($root) {
  if ($script:msaaPath.Count -eq 0) { return $null }
  $acc = $root
  foreach ($idx in $script:msaaPath) {
    if ($null -eq $acc) { return $null }
    $c = $null
    try { $c = $acc.accChild([int]$idx) } catch { return $null }
    if ($null -eq $c) { return $null }
    $acc = $c
  }
  return $acc
}

function Get-MsaaProgress($appId, $status) {
  if (-not $appId) { return $null }
  if (-not (Ensure-Msaa)) { return $null }

  # Paused: the position cannot change, so reuse the last value and skip COM.
  $paused = (([string]$status) -eq 'Paused')
  if ($paused -and $null -ne $script:msaaLast -and $script:msaaLastApp -eq $appId) {
    return $script:msaaLast
  }

  # --- cheapest path: we still hold the node object from last time ---
  if ($null -ne $script:msaaNode -and $script:msaaNodeApp -eq $appId) {
    $r = $null
    try { $r = Convert-TimeText (Read-AccText $script:msaaNode) } catch { $r = $null }
    if ($null -ne $r) {
      $script:msaaLast = $r
      $script:msaaLastApp = $appId
      return $r
    }
    $script:msaaNode = $null
  }

  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $failedAt = 0
  if ($script:msaaFail.ContainsKey($appId)) { $failedAt = [long]$script:msaaFail[$appId] }
  # The very first tree walk after the player starts (or right after Add-Type
  # compiles) sometimes misses the window. With a flat 30s cool-down that leaves
  # pos=0 for half a minute -- long enough that the renderer gives up and falls
  # back to its local clock. So: short back-off until the app has succeeded once,
  # long cool-down afterwards (browsers genuinely have no time text).
  $coolMs = 30000
  if (-not $script:msaaOk.ContainsKey($appId)) { $coolMs = 2500 }
  if ($failedAt -gt 0 -and ($now - $failedAt) -lt $coolMs) { return $null }
  if ($script:msaaCacheKey -eq $appId -and ($now - $script:msaaCacheAt) -lt 900) {
    return $script:msaaCache
  }

  # --- path cache: same window, follow indices, then hold on to the node ---
  if ($script:msaaHwnd -ne [IntPtr]::Zero -and $script:msaaPath.Count -gt 0 -and $script:msaaHwndApp -eq $appId) {
    $acc0 = $null
    try { $acc0 = [MsaaPos]::Acc($script:msaaHwnd) } catch {}
    if ($null -ne $acc0) {
      $node = $null
      try { $node = Resolve-AccPath $acc0 } catch {}
      if ($null -ne $node) {
        $r0 = $null
        try { $r0 = Convert-TimeText (Read-AccText $node) } catch {}
        if ($null -ne $r0) {
          $script:msaaNode = $node
          $script:msaaNodeApp = $appId
          $script:msaaLast = $r0
          $script:msaaLastApp = $appId
          $script:msaaCache = $r0
          $script:msaaCacheAt = $now
          $script:msaaCacheKey = $appId
          return $r0
        }
      }
    }
    $script:msaaPath = @()
    $script:msaaHwnd = [IntPtr]::Zero
    $script:msaaHwndApp = ''
  }

  # --- slow path: full walk (only on first use / after the UI changed) ---
  $key = ([string]$appId).ToLowerInvariant()
  $key = $key -replace '\.exe$', ''
  $segs = @($key -split '[./\\!]' | Where-Object { $_.Length -gt 0 })
  if ($segs.Count -eq 0) { return $null }
  $key = $segs[$segs.Count - 1]

  $res = $null
  $nodeObj = $null
  $winHwnd = [IntPtr]::Zero
  $procs = @(Get-ProcsFor $key)
  foreach ($p in $procs) {
    $hw = @()
    try { $hw = [MsaaPos]::VisibleTopWindows([uint32]$p.id) } catch {}
    foreach ($h in $hw) {
      $acc = $null
      try { $acc = [MsaaPos]::Acc($h) } catch {}
      if ($null -eq $acc) { continue }
      $script:msaaFound = $null
      $script:msaaVisited = 0
      $script:msaaPath = @()
      [void]$script:msaaStack.Clear()
      try { Find-TimeText $acc 0 } catch {}
      if ($null -ne $script:msaaFound) {
        $res = $script:msaaFound
        $winHwnd = $h
        try { $nodeObj = Resolve-AccPath $acc } catch {}
        break
      }
    }
    if ($null -ne $res) { break }
  }

  if ($null -eq $res) {
    $script:msaaFail[$appId] = $now
  } else {
    if ($script:msaaFail.ContainsKey($appId)) { [void]$script:msaaFail.Remove($appId) }
    $script:msaaOk[$appId] = $true
    $script:msaaHwnd = $winHwnd
    $script:msaaHwndApp = $appId
    if ($null -ne $nodeObj) {
      $script:msaaNode = $nodeObj
      $script:msaaNodeApp = $appId
    }
    $script:msaaLast = $res
    $script:msaaLastApp = $appId
  }

  $script:msaaCache = $res
  $script:msaaCacheAt = $now
  $script:msaaCacheKey = $appId
  return $res
}

# Acquire the manager. Right after boot the service may not be up yet, so retry.
$mgr = $null
for ($i = 0; $i -lt 40 -and -not $mgr; $i++) {
  try { $mgr = Await ($mgrType::RequestAsync()) $mgrType } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $mgr) { Emit @{ ok = $false; reason = 'no-manager' }; exit 1 }

Emit @{ ok = $true; ready = $true }

# Main loop.
while ($true) {
  $list = New-Object System.Collections.ArrayList
  try {
    foreach ($s in $mgr.GetSessions()) {
      $title = ''; $artist = ''; $album = ''; $status = ''
      try {
        $p = Await ($s.TryGetMediaPropertiesAsync()) $propsType
        if ($p) {
          if ($p.Title)      { $title  = [string]$p.Title }
          if ($p.Artist)     { $artist = [string]$p.Artist }
          if ($p.AlbumTitle) { $album  = [string]$p.AlbumTitle }
        }
      } catch {}
      try { $status = [string]$s.GetPlaybackInfo().PlaybackStatus } catch {}
      # Timeline: current playback position + duration, in seconds.
      # Needed so the renderer can show the right lyric line ("one line after
      # another" in sync with the music). -1 means "unknown".
      # GetTimelineProperties() is synchronous, so no Await here.
      #
   # pos is a SNAPSHOT taken at LastUpdatedTime, not "now". Polling alone
      #    can never be accurate: whatever we sample is already up to one poll
      #    interval old by the time the renderer sees it, and the lyric clock
      #    then has to guess in between. That is why lyrics kept drifting.
      #    So we ALSO emit `posAt` (epoch ms of LastUpdatedTime) and the
      #    playback rate -- the renderer can then extrapolate the exact live
      #    position:
      #        livePos = pos + (nowMs - posAt) / 1000 * rate
      #    which is accurate to tens of milliseconds instead of hundreds.
      $pos = -1.0; $dur = -1.0; $posAt = -1.0; $rate = 1.0
      try {
        $tl = $s.GetTimelineProperties()
        if ($tl) {
          $pos = [double]$tl.Position.TotalSeconds
          $dur = [double]$tl.EndTime.TotalSeconds
          try { $posAt = [double]$tl.LastUpdatedTime.ToUnixTimeMilliseconds() } catch {}
        }
      } catch {}
      try { $rate = [double]$s.GetPlaybackInfo().PlaybackRate } catch {}
      if (-not ($rate -gt 0)) { $rate = 1.0 }

      # SMTC timeline empty? (KuGou always is.) Try the player's own UI via MSAA.
      # posAt is set to "now" because that text is a snapshot taken right here --
      # the renderer extrapolates from it, so a seek lands within ~1s.
      $posSrc = 'smtc'
      if ($pos -le 0) {
        try {
          $mp = Get-MsaaProgress ([string]$s.SourceAppUserModelId) ([string]$status)
          if ($null -ne $mp) {
            $pos = [double]$mp.pos
            if ($dur -le 0) { $dur = [double]$mp.dur }
            $posAt = [double][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            $rate = 1.0
            $posSrc = 'msaa'
          }
        } catch {}
      }
      [void]$list.Add([pscustomobject]@{
        app    = [string]$s.SourceAppUserModelId
        title  = $title
        artist = $artist
        album  = $album
        status = $status
        pos    = $pos
        posAt  = $posAt
        rate   = $rate
        dur    = $dur
        src    = $posSrc
      })
    }
    # Wrap in @() so an empty list serialises as [] rather than null.
    Emit @{ ok = $true; sessions = @($list) }
  } catch {
    Emit @{ ok = $false; reason = [string]$_.Exception.Message }
  }
  # 500ms (was 1500ms). `pos` is the value AT SAMPLE TIME, so the sparser the
  # sampling, the further the lyrics drift behind the player -- at 1500ms they
  # were consistently about half a beat late. GSMTC queries are cheap, so 3x
  # the frequency has no noticeable cost.
  # ASCII-ONLY on purpose: see the note at the top of this file.
  Start-Sleep -Milliseconds 500
}
