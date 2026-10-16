# Renders the installer artwork (apps/desktop/src-tauri/windows/art/art.html)
# with headless Edge at four times the size and scales it down into the BMP
# files NSIS needs: sidebar.bmp (164 x 314) and header.bmp (150 x 57).
#
#   powershell -ExecutionPolicy Bypass -File scripts/installer-art.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$windows = Join-Path $root 'apps\desktop\src-tauri\windows'
$html = Join-Path $windows 'art\art.html'
$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge was not found' }
$tmp = Join-Path ([IO.Path]::GetTempPath()) "ylide-art-$PID"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

function Render($name, $w, $h) {
  $png = Join-Path $tmp "$name.png"
  $url = ([Uri]$html).AbsoluteUri + "?$name"
  # Edge reports the written file on stderr; that is not an error.
  $ErrorActionPreference = 'Continue'
  & $edge --headless=new --disable-gpu --hide-scrollbars --no-first-run --force-device-scale-factor=1 "--user-data-dir=$tmp\profile" "--window-size=$($w * 4),$($h * 4)" --virtual-time-budget=3000 "--screenshot=$png" $url 2>&1 | Out-Null
  $ErrorActionPreference = 'Stop'
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Path $png) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
  $big = [System.Drawing.Image]::FromFile($png)
  $small = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($small)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.DrawImage($big, [System.Drawing.Rectangle]::new(0, 0, $w, $h), [System.Drawing.Rectangle]::new(0, 0, $w * 4, $h * 4), [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose(); $big.Dispose()
  $out = Join-Path $windows "$name.bmp"
  $small.Save($out, [System.Drawing.Imaging.ImageFormat]::Bmp)
  # A PNG copy to look at (BMPs do not preview everywhere).
  $small.Save((Join-Path $windows "art\$name-preview.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $small.Dispose()
  "wrote $out ($w x $h)"
}

Render 'sidebar' 164 314
Render 'header' 150 57
Remove-Item -Recurse -Force $tmp
