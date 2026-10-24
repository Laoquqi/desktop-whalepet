$ErrorActionPreference = 'SilentlyContinue'

# GC339: read Windows (Xbox Game Bar / Game Mode) recorded game list.
# HKCU\System\GameConfigStore\Children\<GUID>\MatchedExeFullPath
# Use as a high-confidence "this is a game" source (no fullscreen heuristics).
$base = 'HKCU:\System\GameConfigStore\Children'
$out = New-Object System.Collections.ArrayList
if (Test-Path $base) {
  foreach ($k in @(Get-ChildItem $base -ErrorAction SilentlyContinue)) {
    $p = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
    $f = $p.MatchedExeFullPath
    if ($f) { [void]$out.Add((Split-Path $f -Leaf).ToLower()) }
  }
}
$u = @($out | Sort-Object -Unique)
if ($u.Count -eq 0) { '[]' } else { ConvertTo-Json -InputObject $u -Compress }
