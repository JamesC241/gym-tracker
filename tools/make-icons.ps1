# make-icons.ps1 - regenerates the PNG app icons in ../icons (Windows PowerShell).
# Run from the project folder:  powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1
# To change the look, edit the colours or the rectangles below (100x100 design grid).
# Keep icons/icon.svg roughly in sync. Bump VERSION in sw.js after changing icons.

$OutDir = Join-Path $PSScriptRoot '..\icons'
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force $OutDir | Out-Null

function Make-Icon([int]$size, [double]$scale, [string]$file) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.ColorTranslator]::FromHtml('#0e1114'))
  $orange = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#ff7a1a'))
  # Dumbbell drawn in a 100x100 design space, centred, scaled by $scale.
  $u = $size / 100.0 * $scale
  $o = ($size - 100 * $u) / 2
  function Box($x, $y, $w, $h) { $g.FillRectangle($orange, [float]($o + $x * $u), [float]($o + $y * $u), [float]($w * $u), [float]($h * $u)) }
  Box 30 46 40 8      # bar
  Box 18 28 12 44     # inner plates
  Box 70 28 12 44
  Box 8 36 10 28      # outer plates
  Box 82 36 10 28
  $bmp.Save((Join-Path $OutDir $file), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

Make-Icon 192 0.86 'icon-192.png'
Make-Icon 512 0.86 'icon-512.png'
Make-Icon 512 0.62 'icon-maskable-512.png'   # smaller so Android's round mask doesn't crop it
Make-Icon 180 0.80 'apple-touch-icon.png'    # iPhone home screen

