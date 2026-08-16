# ============================================================================
#  handlers.patch.ps1 — 示例 handler: 补丁自动应用
#  (泛化自旧 mailbox_poll_mcp.ps1 的 Invoke-MailboxPatch)
#
#  用法:
#    .\mailbox.ps1 poll -Handlers .\examples\handlers.patch.ps1
#  要求:
#    配置文件里 patchRoot 指向补丁目标工作区 (如 D:/work/myproject)
#  协议 (对端发来的消息):
#    { type:"request", topic:"patch_<任意>", payload:{
#        patch_id:"<标识>", note:"<说明>",
#        edits:[
#          { file:"build/x.js", old:"...", new:"..." },              # 片段替换
#          { file:"build/y.js", whole:"完整新内容" },                 # 整文件替换
#          { file:"build/z.js", old:"...", new:"...", replace_all:true } # 全部替换
#        ] } }
#  行为: 备份 → 替换 → node --check 语法检查 → 失败回滚 →
#        写 <patchRoot>/patches/history.jsonl → 回 response (topic: patch_result)
#
#  返回值: $true=已处理; $false=非补丁消息, 交给默认逻辑 (request→echo)
# ============================================================================

function Handle-Message {
    param($Msg, $Ctx)

    if ("$($Msg.topic)" -notlike "patch_*") { return $false }

    $cfg = $Ctx.Cfg
    $workRoot = [string]$cfg.patchRoot
    if (-not $workRoot -or -not (Test-Path -LiteralPath $workRoot)) {
        Write-Host "  [补丁] patchRoot 未配置或不存在, 跳过 (config.patchRoot=$workRoot)"
        return $true
    }

    $payload = $Msg.payload
    $patchId = if ($payload.patch_id) { [string]$payload.patch_id } else { [string]$Msg.id }
    $edits = @($payload.edits)
    $results = @()
    $changed = @{}          # full path -> backup path
    $ok = $true

    New-Item -ItemType Directory -Force -Path (Join-Path $workRoot "patches") | Out-Null
    $bakDir = Join-Path $workRoot "patches\backup"
    New-Item -ItemType Directory -Force -Path $bakDir | Out-Null

    Write-Host "`n[补丁应用] patch_id=$patchId edits=$($edits.Count) note=$($payload.note) root=$workRoot"

    try {
        foreach ($e in $edits) {
            $rel = [string]$e.file
            $full = Join-Path $workRoot $rel

            # 路径安全: 必须落在 patchRoot 内
            if (-not $full.StartsWith($workRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
                $results += "SKIP  $rel  (路径越界, 拒绝)"
                $ok = $false
                continue
            }
            if (-not (Test-Path -LiteralPath $full)) {
                $results += "FAIL  $rel  (文件不存在)"
                $ok = $false
                continue
            }

            # 首次接触该文件时备份
            if (-not $changed.ContainsKey($full)) {
                $bak = Join-Path $bakDir ((Split-Path $rel -Leaf) + ".$patchId.bak")
                Copy-Item -LiteralPath $full -Destination $bak -Force
                $changed[$full] = $bak
            }

            $content = Get-Content -LiteralPath $full -Raw

            if ($null -ne $e.whole -and [string]$e.whole -ne "") {
                Set-Content -LiteralPath $full -Value ([string]$e.whole) -Encoding UTF8 -NoNewline
                $results += "OK    $rel  (整文件替换)"
                continue
            }

            $old = [string]$e.old
            $new = [string]$e.new
            if ($old -eq "") {
                $results += "FAIL  $rel  (old 为空)"
                $ok = $false
                continue
            }

            $count = ([regex]::Matches($content, [regex]::Escape($old))).Count
            if ($count -eq 0) {
                $results += "FAIL  $rel  (old 片段未找到)"
                $ok = $false
                continue
            }
            if ($count -gt 1 -and -not $e.replace_all) {
                $results += "FAIL  $rel  (old 出现 $count 次, 需 replace_all=true)"
                $ok = $false
                continue
            }

            if ($e.replace_all) {
                $newContent = $content.Replace($old, $new)
            } else {
                $idx = $content.IndexOf($old, [System.StringComparison]::Ordinal)
                $newContent = $content.Substring(0, $idx) + $new + $content.Substring($idx + $old.Length)
            }
            Set-Content -LiteralPath $full -Value $newContent -Encoding UTF8 -NoNewline
            $results += "OK    $rel  (替换 x$count)"
        }

        # --- JS 语法检查 (node --check), 失败回滚 ---
        if ($changed.Count -gt 0) {
            $syntaxFail = $false
            foreach ($full in @($changed.Keys)) {
                if ($full -like "*.js") {
                    $out = & node --check $full 2>&1
                    if ($LASTEXITCODE -ne 0) {
                        $syntaxFail = $true
                        $results += "SYNTAX-FAIL $full : $out"
                    }
                }
            }
            if ($syntaxFail) {
                foreach ($full in @($changed.Keys)) {
                    Copy-Item -LiteralPath $changed[$full] -Destination $full -Force
                    $results += "ROLLED-BACK $full"
                }
                $ok = $false
            }
        }
    } catch {
        $ok = $false
        $results += "EXCEPTION: $($_.Exception.Message)"
        foreach ($full in @($changed.Keys)) {
            Copy-Item -LiteralPath $changed[$full] -Destination $full -Force
            $results += "ROLLED-BACK $full"
        }
    }

    # --- 历史记录 ---
    $rec = [ordered]@{
        ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        patch_id = $patchId; from = $Msg.from; ok = $ok
        edits = $edits.Count; results = $results
    }
    ($rec | ConvertTo-Json -Depth 5) | Add-Content (Join-Path $workRoot "patches\history.jsonl") -Encoding UTF8

    # --- 回 response ---
    Send-Mailbox -Cfg $cfg -To $Msg.from -Type "response" -Topic "patch_result" `
        -ReplyTo $Msg.id -Payload @{ patch_id = $patchId; ok = $ok; results = $results }

    $results | ForEach-Object { Write-Host "  $_" }
    Write-Host "  → 补丁结果: $(if ($ok) {'成功'} else {'失败(已回滚)'}) (response 已回 $($Msg.from))"
    return $true
}
