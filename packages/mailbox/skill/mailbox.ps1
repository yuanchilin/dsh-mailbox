# ============================================================================
#  mailbox.ps1 — 通用跨会话文件信箱 CLI v1
#
#  用法示例:
#    .\mailbox.ps1 init -Id agent-a -Root D:/Downloads/Agent/.mailbox
#    .\mailbox.ps1 send -To agent-b -Topic hello -Payload '{"x":1}'
#    .\mailbox.ps1 recv -Format table
#    .\mailbox.ps1 wait -Timeout 60                  # 新消息即退出 (exit 0, 唤醒 agent)
#    .\mailbox.ps1 poll -Interval 2 -Handlers .\examples\handlers.patch.ps1
#    .\mailbox.ps1 clean -TtlHours 24
#    .\mailbox.ps1 status
#    .\mailbox.ps1 sessions                     # 会话目录 (注册表: 身份/别名/在线)
#
#  配置优先级: 参数 > 环境变量 (MAILBOX_CONFIG/ID/ROOT/INTERVAL/TIMEOUT) > 配置文件 > 默认
# ============================================================================
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet("init","send","recv","wait","poll","clean","status","sessions")]
    [string]$Command = "status",

    [string]$Config = "",
    [string]$Identity = "",
    [string]$Root = "",

    # send
    [string]$To = "",
    [ValidateSet("request","response","notify","reply")]
    [string]$Type = "notify",
    [string]$Topic = "",
    [string]$Payload = "",
    [string]$ReplyTo = "",

    # recv
    [ValidateSet("table","json")]
    [string]$Format = "table",

    # wait / poll
    [int]$Timeout = -1,
    [int]$Interval = -1,
    [string]$Handlers = "",

    # clean
    [int]$TtlHours = 24,
    [switch]$DryRun,

    # sessions
    [int]$PresenceWindow = 300
)

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "mailbox.psm1") -Force

$cfg = Get-MailboxConfig -ConfigPath $Config
if ($Identity) { $cfg.identity = $Identity }
if ($Root)     { $cfg.root = $Root; $cfg.layout = "root" }
if (-not $cfg.identity) { throw "未指定身份: 请用 -Identity / MAILBOX_ID / 配置文件 identity" }
if ($Interval -ge 0)    { $cfg.intervalSec = $Interval }
if ($Timeout -ge 0)     { $cfg.timeoutSec = $Timeout }

switch ($Command) {
    "init" {
        $out = [ordered]@{
            identity = $cfg.identity
            layout   = "root"
            root     = $cfg.root
            dirs     = $cfg.dirs
            participants = @()
            intervalSec  = $cfg.intervalSec
            timeoutSec   = $cfg.timeoutSec
            seenFile     = $cfg.seenFile
            patchRoot    = $cfg.patchRoot
        }
        $cfgPath = if ($Config) { $Config } else { Join-Path $PSScriptRoot "mailbox.config.json" }
        $out | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $cfgPath -Encoding UTF8
        Write-Host "已生成配置: $cfgPath"
        Write-Host ($out | ConvertTo-Json -Depth 6)
    }

    "send" {
        if (-not $To) { throw "send 需要 -To <id|alias|all>" }
        $payloadObj = @{}
        if ($Payload) {
            try { $payloadObj = $Payload | ConvertFrom-Json } catch { throw "payload 不是合法 JSON: $Payload" }
        }
        # 别名解析: to 命中注册表 alias / 完整 sessionId → 换成对应 identity
        if ($To -ne "all" -and $cfg.root) {
            $regDir = Join-Path $cfg.root "_sessions"
            if (Test-Path -LiteralPath $regDir) {
                foreach ($f in Get-ChildItem -LiteralPath $regDir -Filter "*.json" -ErrorAction SilentlyContinue) {
                    try {
                        $r = $f | Get-Content -Raw | ConvertFrom-Json
                        if (($r.alias -and $r.alias -eq $To) -or ($r.sessionId -and $r.sessionId -eq $To)) {
                            if ($r.identity) { $To = $r.identity }
                            break
                        }
                    } catch { }
                }
            }
        }
        $id = Send-Mailbox -Cfg $cfg -To $To -Type $Type -Topic $Topic -Payload $payloadObj -ReplyTo $ReplyTo
        Write-Output "sent $id  ($(Get-Date -Format 'HH:mm:ss'))"
    }

    "recv" {
        $msgs = @(Recv-Mailbox -Cfg $cfg)
        if ($msgs.Count -eq 0) { Write-Output "(无新消息)"; break }
        if ($Format -eq "json") {
            $msgs | ForEach-Object { Write-Output ($_ | ConvertTo-Json -Depth 8 -Compress) }
        } else {
            $msgs | ForEach-Object {
                $p = if ($_.payload) { ($_ | ConvertTo-Json -Depth 3 -Compress) } else { "" }
                Write-Host "[$($_.from) -> $($_.to)] $($_.type) topic=$($_.topic) id=$($_.id)"
                Write-Host "   reply_to=$($_.reply_to) ts=$($_.ts)"
                if ($p) { Write-Host "   payload: $p" }
            }
        }
    }

    "wait" {
        # 事件唤醒: 检测到新消息 → 打印 → exit 0 (DSH 后台 job 完成即通知 agent)
        $started = Get-Date
        while ($true) {
            $msgs = @(Recv-Mailbox -Cfg $cfg)
            if ($msgs.Count -gt 0) {
                Write-Host "=== NEW MESSAGES: $($msgs.Count) ==="
                $msgs | ForEach-Object { Write-Host ($_ | ConvertTo-Json -Depth 8 -Compress) }
                Write-Host "=== WAKE-UP (exit 0) ==="
                exit 0
            }
            if ($cfg.timeoutSec -gt 0 -and ((Get-Date) - $started).TotalSeconds -ge $cfg.timeoutSec) {
                Write-Host "TIMEOUT after $($cfg.timeoutSec)s, no new messages"
                exit 0
            }
            Start-Sleep -Seconds $cfg.intervalSec
        }
    }

    "poll" {
        # 常驻轮询: 默认 request→echo response, notify/reply→打印
        # -Handlers <ps1>: dot-source 后若定义 Handle-Message($Msg, $Ctx) 则调用
        if ($Handlers) {
            $handlersPath = if (Test-Path -LiteralPath $Handlers) { (Resolve-Path $Handlers).Path } else { $Handlers }
            . $handlersPath
            Write-Host "已加载 handlers: $handlersPath"
        }
        Write-Host "poll 启动 (identity=$($cfg.identity) 每 $($cfg.intervalSec)s). Ctrl+C 退出"
        while ($true) {
            try {
                $msgs = @(Recv-Mailbox -Cfg $cfg)
                foreach ($m in $msgs) {
                    Write-Host "[收到] from=$($m.from) type=$($m.type) topic=$($m.topic) id=$($m.id)"
                    $handled = $false
                    if ($Handlers -and (Get-Command Handle-Message -ErrorAction SilentlyContinue)) {
                        $handled = Handle-Message -Msg $m -Ctx @{ Cfg = $cfg }
                    }
                    if (-not $handled) {
                        if ($m.type -eq "request") {
                            # 默认: 自动回 response (echo)
                            Send-Mailbox -Cfg $cfg -To $m.from -Type "response" -Topic $m.topic -ReplyTo $m.id `
                                -Payload @{ echo = $m.payload; from = $cfg.identity }
                            Write-Host "  → 已回 response (reply_to=$($m.id))"
                        } else {
                            Write-Host ($m | ConvertTo-Json -Depth 6 -Compress)
                        }
                    }
                    try { Remove-MailboxMsg -Cfg $cfg -Id $m.id -InInbox } catch { }
                }
            } catch {
                Write-Host "轮询异常: $($_.Exception.Message)" -ForegroundColor Yellow
            }
            Start-Sleep -Seconds $cfg.intervalSec
        }
    }

    "clean" {
        $removed = Clear-MailboxTTL -Cfg $cfg -TtlHours $TtlHours -DryRun:$DryRun
        $mode = if ($DryRun) { "dry-run" } else { "已删除" }
        Write-Output "clean: $mode $removed 条过期消息 (TtlHours=$TtlHours, outDir=$((Resolve-MailboxDirs $cfg).Out))"
    }

    "status" {
        $s = Get-MailboxStatus $cfg
        Write-Host "身份: $($s.identity)  layout=$($s.layout)"
        Write-Host "写:   $($s.outDir)  (消息 $($s.outCount))"
        Write-Host "seen: $($s.seen) 条"
        foreach ($i in $s.inboxes) {
            Write-Host "读:   $($i.Dir)  (消息 $($i.MsgCount))"
        }
    }

    "sessions" {
        # 会话目录: 读 <root>/_sessions/*.json (注册表心跳), 按 lastSeen 倒序
        # 注: 只用实例方法与算术, 兼容只读沙箱 (ConstrainedLanguage) 下无 .NET 静态调用
        if (-not $cfg.root) { throw "sessions 需要 -Root (layout=root)" }
        $regDir = Join-Path $cfg.root "_sessions"
        if (-not (Test-Path -LiteralPath $regDir)) {
            Write-Output "(暂无注册会话: 各会话调用一次 mailbox 工具即自动登记)"
            break
        }
        $nowMs = [int64](((Get-Date).ToUniversalTime().Ticks - 621355968000000000) / 10000)
        $list = @()
        foreach ($f in Get-ChildItem -LiteralPath $regDir -Filter "*.json") {
            try { $list += ($f | Get-Content -Raw | ConvertFrom-Json) } catch { }
        }
        if ($list.Count -eq 0) { Write-Output "(暂无注册会话)"; break }
        foreach ($r in ($list | Sort-Object { $_.lastSeen } -Descending)) {
            $deltaMs = [int64]($nowMs - [int64]$r.lastSeen)
            $online = if ($r.lastSeen -and $deltaMs -lt ($PresenceWindow * 1000)) { "●在线" } else { "○离线" }
            $agoSec = [int]($deltaMs / 1000)
            if ($agoSec -lt 0) { $agoSec = 0 }
            $ago = if ($r.lastSeen) { "$($agoSec)s前" } else { "-" }
            $alias = if ($r.alias) { " ($($r.alias))" } else { "" }
            $title = if ($r.title) { "  «$($r.title)»" } else { "" }
            Write-Output "$online $($r.identity)$alias  $($r.workspace)$title  last=$ago"
        }
    }
}
