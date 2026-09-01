<#
.SYNOPSIS
    dsh-remote 的 Windows 启动入口。

.DESCRIPTION
    检查 PowerShell 与 Node.js 版本，然后从本脚本所在目录运行 dist\index.js。
    多余的参数原样转交给 dsh-remote，例如：
        pwsh -File .\start.ps1 --config D:\somewhere\my.config.json

.NOTES
    这个文件必须能被 Windows PowerShell 5.1 解析，否则「版本太低」的提示根本没机会
    打印出来 —— 5.1 会先在语法分析阶段就报错。所以不要在这里使用 PowerShell 7 才有
    的语法（三元运算符 ? :、?? 、ForEach-Object -Parallel 等）。
    同理，本文件以 UTF-8 BOM 保存：没有 BOM 时 5.1 会按系统 ANSI 码页读取，中文提示
    会变成乱码。
#>

[CmdletBinding()]
param(
  # 出错时不要暂停等待回车。给脚本、CI 或服务包装器用。
  [switch]$NoPause,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Arguments
)

$ErrorActionPreference = 'Stop'

# 最低 Node 版本，与 packages/launcher/src/node-version.ts 中的 MINIMUM_NODE_VERSION 一致。
$MinimumNode = [Version]'22.19.0'
$NodeDownloadUrl = 'https://nodejs.org'
$PowerShellDownloadUrl = 'https://aka.ms/powershell'

function Write-Failure {
  param([string[]]$Lines)
  foreach ($line in $Lines) { Write-Host $line -ForegroundColor Red }
}

# 双击运行时窗口会随脚本结束立刻消失，错误信息一闪而过等于没有。
# 只在真的有人盯着屏幕时才暂停：非交互场景（CI、服务包装器）里暂停会变成挂起。
function Stop-Here {
  param([int]$Code)
  if ($Code -ne 0 -and -not $NoPause -and [Environment]::UserInteractive) {
    Write-Host ''
    Read-Host '按 Enter 键关闭窗口' | Out-Null
  }
  exit $Code
}

if ($PSVersionTable.PSVersion.Major -lt 7) {
  Write-Failure @(
    ''
    "[dsh-remote] 这个脚本需要 PowerShell 7 或更高版本，当前是 $($PSVersionTable.PSVersion)。"
    "           请到 $PowerShellDownloadUrl 安装 PowerShell 7，然后用它重新运行："
    '               pwsh -File .\start.ps1'
    ''
  )
  Stop-Here 1
}

$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $node) {
  Write-Failure @(
    ''
    '[dsh-remote] 没有找到 Node.js（命令 node 不存在）。'
    "           dsh-remote 使用你本机的 Node.js 运行，请到 $NodeDownloadUrl 下载安装 LTS 版"
    "           （$MinimumNode 或更高），装完重新打开一个终端窗口再运行本脚本。"
    ''
  )
  Stop-Here 1
}

$rawVersion = [string](& $node.Source -v 2>&1 | Select-Object -First 1)
# node -v 输出形如 v22.19.0，也可能带预发布后缀（v23.0.0-nightly）。只看前三段数字，
# 判断口径与 launcher 里的 releaseNumbers 一致。
$matched = [regex]::Match($rawVersion, '(\d+)\.(\d+)\.(\d+)')
if (-not $matched.Success) {
  Write-Failure @(
    ''
    "[dsh-remote] 认不出 Node.js 的版本号，node -v 输出的是：$rawVersion"
    "           请确认 $($node.Source) 确实是 Node.js，或到 $NodeDownloadUrl 重新安装。"
    ''
  )
  Stop-Here 1
}

$detected = [Version]::new(
  [int]$matched.Groups[1].Value,
  [int]$matched.Groups[2].Value,
  [int]$matched.Groups[3].Value
)
if ($detected -lt $MinimumNode) {
  Write-Failure @(
    ''
    "[dsh-remote] Node.js 版本太低：这台机器上是 v$detected，dsh-remote 需要 $MinimumNode 或更高。"
    "           请到 $NodeDownloadUrl 下载安装新版 Node.js（LTS 即可），"
    '           装完重新打开一个终端窗口再运行本脚本。'
    "           当前用的是： $($node.Source)"
    ''
  )
  Stop-Here 1
}

# 以脚本自身所在目录当工作目录：dsh-remote.config.json 是按当前目录查找的，而用户从哪个
# 盘、哪个目录双击或调用这个脚本是无法预测的。
$packageRoot = $PSScriptRoot
$entry = Join-Path $packageRoot 'dist\index.js'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
  Write-Failure @(
    ''
    "[dsh-remote] 找不到 $entry。"
    '           这个压缩包没有完整解压，请把整个 zip 重新解压一次（不要只解压其中几个文件，'
    '           也不要直接在压缩软件的预览窗口里运行）。'
    ''
  )
  Stop-Here 1
}

Write-Host "[dsh-remote] Node v$detected  ($($node.Source))" -ForegroundColor DarkGray

Push-Location -LiteralPath $packageRoot
try {
  if ($null -eq $Arguments) { $Arguments = @() }
  # 直接前台运行：Ctrl+C 会送到同一个控制台进程组，launcher 自己会按
  # connector -> relay -> dsh 的顺序收尾。
  & $node.Source $entry @Arguments
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}

Stop-Here $code
