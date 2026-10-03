# hook-guard.ps1 — PreToolUse 守卫示例（JSON 决策协议版）
# 配合 @deepseek-ai/dsh-hooks-claude-code 桥使用（hooks.json 的 PreToolUse 指向本脚本）。
# 决策协议：exit 2 + stderr 在部分桥实现里不被当作阻塞（记录为 hook 失败）；
# 改用 stdout JSON 决策：blocked 时 stdout 输出 {"decision":"block","reason":"..."}，
# 桥解析后真正阻塞工具调用，reason 模型可见。
# 输入：stdin JSON { tool_name, tool_input }；无命中 exit 0 无输出。
$ErrorActionPreference = 'Stop'
try { $raw = [Console]::In.ReadToEnd() } catch { exit 0 }
if (-not $raw) { exit 0 }
try { $j = $raw | ConvertFrom-Json } catch { exit 0 }

$tool = $j.tool_name
if (-not $tool) { exit 0 }

$cmd = ''
if ($tool -eq 'pwsh' -or $tool -eq 'Bash') { $cmd = [string]$j.tool_input.command }
elseif ($tool -eq 'write' -or $tool -eq 'edit') { $cmd = [string]$j.tool_input.file_path }
if (-not $cmd) { exit 0 }

$block = $null
$hitsTemp = $cmd -match '\$env:TEMP|%TEMP%|AppData\\Local\\Temp'

# 1. 递归删除触及受保护目录（junction 穿透）
if (-not $hitsTemp -and $cmd -match 'Remove-Item.*-Recurse' -and $cmd -match '(node_modules|\.bsk|profiles|skills)') {
  $block = 'hook-guard: 递归删除触及受保护目录。若是 junction，Remove-Item -Recurse 会穿透删掉目标本体——用 [System.IO.Directory]::Delete(path) 只删链接。'
}
# 2. 写 C 盘非白名单路径（write/edit）
if (-not $block -and ($tool -eq 'write' -or $tool -eq 'edit') -and $cmd -match '(?i)[A-Za-z]:\\(?!(deepseek harness|DSH备份|_学业|_下载|_项目|_工具|tools|npm-global|Users\\[^\\]+\\AppData\\Local\\Temp))') {
  $block = 'hook-guard: 磁盘纪律——新文件默认放 D 盘工作区，不写 C 盘。'
}
# 3. 环境变量枚举（DSH 剥疑似密钥变量，结论不可信）
if (-not $block -and $cmd -match 'Get-ChildItem\s+Env:|Get-Item\s+Env:|\[Environment\]::GetEnvironmentVariable') {
  $block = 'hook-guard: 工具子进程的环境变量枚举结果不可信（疑似密钥变量被剥掉）。'
}
# 4. .bsk junction 上的 -Recurse
if (-not $block -and -not $hitsTemp -and $cmd -match 'Remove-Item.*-Recurse' -and $cmd -match '\.bsk') {
  $block = 'hook-guard: .bsk 是 Junction。Remove-Item -Recurse 会穿透删掉目标本体，用 cmd /c rmdir 只删链接。'
}

if ($block) {
  # JSON 决策协议（stdout）：桥解析 decision:"block" 后真正阻塞，reason 模型可见
  @{ decision = 'block'; reason = $block } | ConvertTo-Json -Compress
  exit 0
}
exit 0
