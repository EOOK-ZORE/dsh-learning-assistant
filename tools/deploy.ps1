# 构建 client 半并把插件同步进 DSH profile。
#
# 为什么需要复制而不是 link：
# Windows 上 pnpm 对 link:/file: 本地目录建的是 junction，Node 解析插件里的
# `import "@deepseek-ai/dsh-tools"` 时会 realpath 到源码目录（例如 F:\projects\...），
# 那里向上找不到宿主提供的 @deepseek-ai/* 包，import 直接失败，插件 fiber 不激活，
# 界面上不会出现「术语 N」按钮，/learning-assistant/* 也全是 404。
# 插件必须是 profile node_modules 里的真实目录才能拿到宿主依赖。
#
# 用法：改完代码后运行
#   pwsh -File tools\deploy.ps1
# 然后重启 DeepSeek Harness。

$ErrorActionPreference = "Stop"

$src = Split-Path -Parent $PSScriptRoot
$dst = Join-Path $env:USERPROFILE ".dsh\profiles\desktop\node_modules\dsh-learning-assistant"

if (-not (Test-Path (Join-Path $env:USERPROFILE ".dsh\profiles\desktop\package.json"))) {
    throw "找不到 DSH desktop profile：$dst"
}

Write-Host "1/3 构建 client 半..." -ForegroundColor Cyan
node (Join-Path $src "tools\build-client.mjs")

Write-Host "2/3 同步到 profile..." -ForegroundColor Cyan
if (Test-Path $dst) {
    $link = (Get-Item $dst -Force).LinkType
    if ($link) {
        Write-Host "    发现 $link，先删除" -ForegroundColor Yellow
        # 删除 junction/符号链接本身，不跟随进去删目标
        (Get-Item $dst -Force).Delete()
    }
}
robocopy $src $dst /E /XD .git node_modules /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy 失败，退出码 $LASTEXITCODE" }

Write-Host "3/3 校验..." -ForegroundColor Cyan
foreach ($f in @("package.json", "cordis.patch.yml", "lib\index.js", "lib\client.js")) {
    if (-not (Test-Path (Join-Path $dst $f))) { throw "同步后缺少 $f" }
}
$type = (Get-Item $dst -Force).LinkType
if ($type) { throw "同步后仍是 $type，插件不会加载" }

Write-Host "完成。重启 DeepSeek Harness 后生效。" -ForegroundColor Green
