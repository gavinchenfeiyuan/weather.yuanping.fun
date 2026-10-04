# 在项目根目录执行
$pic = ".\Pic"
$std = "$pic\favicon.svg"
$mask = "$pic\maskable.svg"
$simple = "$pic\favicon-simple.svg"

# 标准版
120,152,167,180,192,512 | ForEach-Object {
  Write-Host "→ icon-${_}x${_}.png"
  inkscape $std --export-type=png --export-filename="$pic\icon-${_}x${_}.png" --export-width=$_ --export-height=$_
}

# 32px 简化版
Write-Host "→ favicon-32.png"
inkscape $simple --export-type=png --export-filename="$pic\favicon-32.png" --export-width=32 --export-height=32

# Maskable
Write-Host "→ icon-maskable-512.png"
inkscape $mask --export-type=png --export-filename="$pic\icon-maskable-512.png" --export-width=512 --export-height=512

Write-Host "`n完成，检查："
Get-ChildItem "$pic\*.png" | Select-Object Name, Length
