# hook-guard.ps1 — PreToolUse 守卫示例：把铁律从"祈祷模型遵守"变成"系统挡住"
# 配合 @deepseek-ai/dsh-hooks-claude-code 桥使用（hooks.json 的 PreToolUse 指向本脚本）。
# 输入：stdin 的 JSON：{ tool_name, tool_input }
# 输出：exit 0 = 放行；exit 2 = 阻止（stderr 信息模型可见）
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
  $block = "hook-guard: 递归删除触及受保护目录。若是 junction，Remove-Item -Recurse 会穿透删掉目标本体——用 [System.IO.Directory]::Delete(path) 只删链接。"
}

# 2. 写 C 盘非白名单路径（write/edit）
if ($cmd -match '(?i)[A-Za-z]\:\\(?!deepseek harness|_学业|_下载|_项目|_工具|tools|npm-global|Users\\ASUS\\AppData\\Local\\Temp)') {
  if ($tool -eq 'write' -or $tool -eq 'edit') {
    $block = "hook-guard: 磁盘纪律——新文件默认放 D 盘工作区，不写 C 盘。"
  }
}

# 3. 环境变量枚举（DSH 会剥疑似密钥变量，结论不可信）
if ($cmd -match 'Get-ChildItem\s+Env:|Get-Item\s+Env:|\[Environment\]::GetEnvironmentVariable') {
  $block = "hook-guard: 工具子进程的环境变量枚举结果不可信（疑似密钥变量被剥掉）。"
}

# 4. junction 上的 -Recurse
if (-not $hitsTemp -and $cmd -match 'Remove-Item.*-Recurse' -and $cmd -match '\.bsk|C:\\Users\\[^\\]+\\\.bsk') {
  $block = "hook-guard: .bsk 是 Junction。Remove-Item -Recurse 会穿透删掉目标本体，用 cmd /c rmdir 只删链接。"
}

if ($block) {
  [Console]::Error.WriteLine($block)
  exit 2
}
exit 0
