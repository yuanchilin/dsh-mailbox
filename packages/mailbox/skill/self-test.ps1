# ============================================================================
#  self-test.ps1 — mailbox 泛化工具自测
#  覆盖: 往返 / 广播 / wait 唤醒 / TTL 清理 / pwsh↔node 互通 / 旧 dirs 布局 / seen 去重
#  用法: .\self-test.ps1   (全部通过 exit 0)
# ============================================================================
$ErrorActionPreference = "Stop"

$toolDir = $PSScriptRoot
$testRoot = Join-Path $toolDir ".selftest"
if (Test-Path -LiteralPath $testRoot) { Remove-Item -Recurse -Force -LiteralPath $testRoot }
New-Item -ItemType Directory -Force -Path $testRoot | Out-Null

$pass = 0; $fail = 0
function Check($name, $cond) {
    if ($cond) { Write-Host "PASS  $name"; $script:pass++ }
    else       { Write-Host "FAIL  $name"; $script:fail++ }
}

Import-Module (Join-Path $toolDir "mailbox.psm1") -Force

# ---- 配置: root 布局, 三参与者 agent-a / agent-b / rp ----
$cfgA = Get-MailboxConfig; $cfgA.identity = "agent-a"; $cfgA.root = $testRoot; $cfgA.layout = "root"
$cfgB = Get-MailboxConfig; $cfgB.identity = "agent-b"; $cfgB.root = $testRoot; $cfgB.layout = "root"
$cfgR = Get-MailboxConfig; $cfgR.identity = "rp";     $cfgR.root = $testRoot; $cfgR.layout = "root"
New-Item -ItemType Directory -Force -Path (Join-Path $testRoot "rp") | Out-Null   # 让自动扫描包含 rp

# 供 CLI 使用的配置文件
$cfgAFile = Join-Path $testRoot "agent-a.config.json"
$cfgBFile = Join-Path $testRoot "agent-b.config.json"
@{ identity="agent-a"; layout="root"; root=$testRoot; dirs=@{}; participants=@(); intervalSec=1; timeoutSec=0; seenFile=""; patchRoot="" } | ConvertTo-Json | Set-Content $cfgAFile -Encoding UTF8
@{ identity="agent-b"; layout="root"; root=$testRoot; dirs=@{}; participants=@(); intervalSec=1; timeoutSec=0; seenFile=""; patchRoot="" } | ConvertTo-Json | Set-Content $cfgBFile -Encoding UTF8

$ps1 = Join-Path $toolDir "mailbox.ps1"
$mjs = Join-Path $toolDir "mailbox.mjs"

# ================= 1. 模块级: 往返 + seen 去重 =================
$id1 = Send-Mailbox -Cfg $cfgA -To "agent-b" -Topic "hello" -Payload @{ x = 1 }
$msgs = @(Recv-Mailbox -Cfg $cfgB)
Check "往返: B 收到 A 的消息" ($msgs.Count -eq 1 -and $msgs[0].from -eq "agent-a" -and $msgs[0].topic -eq "hello")
Check "往返: payload 正确" ($msgs[0].payload.x -eq 1)
$msgs2 = @(Recv-Mailbox -Cfg $cfgB)
Check "seen 去重: 第二次 recv 无新消息" ($msgs2.Count -eq 0)

# ================= 2. 广播 to=all =================
Send-Mailbox -Cfg $cfgR -To "all" -Topic "broadcast" -Payload @{ n = 42 } | Out-Null
$b1 = @(Recv-Mailbox -Cfg $cfgA)
$b2 = @(Recv-Mailbox -Cfg $cfgB)
Check "广播: A 和 B 都收到 to=all" ($b1.Count -eq 1 -and $b2.Count -eq 1 -and $b1[0].topic -eq "broadcast")

# ================= 3. wait 唤醒 (pwsh CLI) =================
Send-Mailbox -Cfg $cfgA -To "agent-b" -Topic "wake" | Out-Null
$waitOut = & $ps1 wait -Config $cfgBFile -Timeout 5 6>&1 2>&1 | Out-String
Check "wait: 有新消息时输出唤醒标记" ($waitOut -match "WAKE-UP")

# ================= 4. TTL 清理 =================
$idOld = Send-Mailbox -Cfg $cfgA -To "agent-b" -Topic "old" | Out-Null
$oldFile = Get-ChildItem -LiteralPath (Join-Path $testRoot "agent-a") -Filter "msg_*.json" | Sort-Object LastWriteTime | Select-Object -Last 1
$oldFile.LastWriteTime = (Get-Date).AddDays(-2)
$dry = Clear-MailboxTTL -Cfg $cfgA -TtlHours 24 -DryRun
Check "TTL dry-run: 计数 1" ($dry -eq 1)
$real = Clear-MailboxTTL -Cfg $cfgA -TtlHours 24
Check "TTL: 实际删除 1" ($real -eq 1)
Check "TTL: 文件已消失" (-not (Test-Path -LiteralPath $oldFile.FullName))

# ================= 5. pwsh ↔ node 互通 =================
& node $mjs send --config $cfgBFile --to agent-a --topic from-node --payload '{"n":2}' 2>&1 | Out-Null
$recvA = @(Recv-Mailbox -Cfg $cfgA)
Check "node 发 → pwsh 收" ($recvA.Count -eq 1 -and $recvA[0].from -eq "agent-b" -and $recvA[0].topic -eq "from-node" -and $recvA[0].payload.n -eq 2)

Send-Mailbox -Cfg $cfgA -To "agent-b" -Topic "to-node" -Payload @{ k = "v" } | Out-Null
$nodeRecv = & node $mjs recv --config $cfgBFile --format json 2>&1 | Out-String
Check "pwsh 发 → node 收" ($nodeRecv -match "to-node")

$nodeStatus = & node $mjs status --config $cfgAFile 2>&1 | Out-String
Check "node status 正常" ($nodeStatus -match "agent-a")

# ================= 6. 旧 dirs 布局兼容 (CLI) =================
$legacyRoot = Join-Path $testRoot "legacy"
New-Item -ItemType Directory -Force -Path (Join-Path $legacyRoot "mcp") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $legacyRoot "rp")  | Out-Null
$legacyCfgM = Join-Path $testRoot "legacy-mcp.config.json"
$legacyCfgR = Join-Path $testRoot "legacy-rp.config.json"
@{ identity="mcp"; layout="dirs"; root=""; dirs=@{ mcp=(Join-Path $legacyRoot "mcp"); rp=(Join-Path $legacyRoot "rp") }; participants=@(); intervalSec=1; timeoutSec=0; seenFile=""; patchRoot="" } | ConvertTo-Json | Set-Content $legacyCfgM -Encoding UTF8
@{ identity="rp";  layout="dirs"; root=""; dirs=@{ mcp=(Join-Path $legacyRoot "mcp"); rp=(Join-Path $legacyRoot "rp") }; participants=@(); intervalSec=1; timeoutSec=0; seenFile=""; patchRoot="" } | ConvertTo-Json | Set-Content $legacyCfgR -Encoding UTF8
& $ps1 send -Config $legacyCfgM -To "rp" -Topic "legacy-test" -Payload '{"L":1}' 2>&1 | Out-Null
$legacyRecv = & node $mjs recv --config $legacyCfgR --format json 2>&1 | Out-String
Check "旧 dirs 布局: mcp 发 → rp (node) 收" ($legacyRecv -match "legacy-test")
Check "旧 dirs 布局: 不创建幽灵目录" (-not (Test-Path -LiteralPath (Join-Path $testRoot "legacy\mcp\.seen.json")))

# ================= 7. CLI status / recv 空 =================
$st = & $ps1 status -Config $cfgAFile 6>&1 2>&1 | Out-String
Check "pwsh status 正常" ($st -match "agent-a")
$empty = & $ps1 recv -Config $cfgBFile 6>&1 2>&1 | Out-String
Check "recv 无新消息提示" ($empty -match "无新消息")

# ================= 8. 泛化代码无硬编码路径 =================
$hardcoded = Select-String -Path (Join-Path $toolDir "mailbox.psm1"),(Join-Path $toolDir "mailbox.ps1"),(Join-Path $toolDir "mailbox.mjs") -Pattern 'D:\\Downloads|Agent\\Soc|Agent\\RP' -ErrorAction SilentlyContinue
Check "泛化代码无硬编码路径 (Soc/RP)" ($null -eq $hardcoded)

# ================= 清理 =================
Remove-Item -Recurse -Force -LiteralPath $testRoot
Write-Host ""
Write-Host "结果: PASS=$pass FAIL=$fail"
if ($fail -gt 0) { exit 1 }
exit 0
