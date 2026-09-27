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
      $pos = -1.0; $dur = -1.0
      try {
        $tl = $s.GetTimelineProperties()
        if ($tl) {
          $pos = [double]$tl.Position.TotalSeconds
          $dur = [double]$tl.EndTime.TotalSeconds
        }
      } catch {}
      [void]$list.Add([pscustomobject]@{
        app    = [string]$s.SourceAppUserModelId
        title  = $title
        artist = $artist
        album  = $album
        status = $status
        pos    = $pos
        dur    = $dur
      })
    }
    # Wrap in @() so an empty list serialises as [] rather than null.
    Emit @{ ok = $true; sessions = @($list) }
  } catch {
    Emit @{ ok = $false; reason = [string]$_.Exception.Message }
  }
  Start-Sleep -Milliseconds 1500
}
