# ============================================================================
#  mailbox.psm1 — 通用跨会话文件信箱 v1 (泛化自 mcp/RP 联调工具)
#
#  模型: N 个对等参与者, 每人一个信箱目录, 各写各的, 互读对方的。
#    - layout=root (标准): 共享根目录 <root>/<id>/ 每人一个子目录
#    - layout=dirs (兼容旧双目录): 显式 dirs 映射 { id -> 目录 }
#    - 消息格式: { id, from, to, type, topic, payload, ts, reply_to }
#    - 路由: to=<id> 定向 / to=all 广播 (写一份, 各人自取)
#    - seen 去重: 每参与者独立 seen 目录 (默认 <outDir>/.seen/, 每消息一个 .seen 标记, 原子写)
#
#  用法:
#    Import-Module <dir>/mailbox.psm1
#    $cfg = Get-MailboxConfig                       # 配置解析 (env > 文件 > 默认)
#    Send-Mailbox -Cfg $cfg -To "agent-b" -Topic "hello" -Payload @{x=1}
#    $msgs = Recv-Mailbox -Cfg $cfg                 # 读取新消息 (自动更新 seen)
#    Remove-MailboxMsg -Cfg $cfg -Id $msg.id -InInbox
# ============================================================================

Set-StrictMode -Version Latest

# ---------------------------------------------------------------------------
# 配置解析: 默认值 < 环境变量 < 配置文件 (CLI 参数由调用方覆盖)
# ---------------------------------------------------------------------------
function Get-MailboxConfig {
    param([string]$ConfigPath = "")

    $cfg = @{
        identity     = ""
        layout       = "root"        # root | dirs
        root         = ""
        dirs         = @{}           # layout=dirs: { id -> 目录 }
        participants = @()           # layout=root 可选的显式参与者列表 (默认自动扫描)
        intervalSec  = 2
        timeoutSec   = 0
        seenFile     = ""            # 显式时用单文件兼容; 默认目录化 <outDir>/.seen/
        patchRoot    = ""            # 供示例补丁 handler 使用
    }

    if ($ConfigPath -eq "") { $ConfigPath = $env:MAILBOX_CONFIG }
    if ($ConfigPath -eq "") { $ConfigPath = Join-Path $PSScriptRoot "mailbox.config.json" }
    if (Test-Path -LiteralPath $ConfigPath) {
        try {
            $file = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
            foreach ($k in @($cfg.Keys)) {
                if ($null -ne $file.$k) { $cfg[$k] = $file.$k }
            }
        } catch {
            Write-Warning "读取配置失败: $ConfigPath ($($_.Exception.Message))"
        }
    }

    if ($env:MAILBOX_ID)       { $cfg.identity = $env:MAILBOX_ID }
    if ($env:MAILBOX_ROOT)     { $cfg.root = $env:MAILBOX_ROOT; $cfg.layout = "root" }
    if ($env:MAILBOX_INTERVAL) { $cfg.intervalSec = [int]$env:MAILBOX_INTERVAL }
    if ($env:MAILBOX_TIMEOUT)  { $cfg.timeoutSec = [int]$env:MAILBOX_TIMEOUT }

    # 默认 root: DSH_HOME 已含 .dsh → 接 mailbox; 否则 ~/.dsh/mailbox (可移植, 不写死路径)
    if ($cfg.layout -eq "root" -and $cfg.root -eq "") {
        $home = $env:DSH_HOME
        if (-not $home) { $home = Join-Path $env:USERPROFILE ".dsh" }
        $cfg.root = Join-Path $home "mailbox"
    }

    # 规范化: JSON 解析出的 dirs 是 PSCustomObject, participants 可能是 $null/空数组
    if ($cfg.dirs -and $cfg.dirs -isnot [System.Collections.IDictionary]) {
        $h = @{}
        foreach ($p in $cfg.dirs.PSObject.Properties) { $h[$p.Name] = [string]$p.Value }
        $cfg.dirs = $h
    }
    if ($null -eq $cfg.dirs) { $cfg.dirs = @{} }
    $cfg.participants = @(@($cfg.participants) | Where-Object { $_ })

    return $cfg
}

# ---------------------------------------------------------------------------
# 目录解析: 返回 @{ Out = <自己的目录>; In = @(<对方目录...>) }
# ---------------------------------------------------------------------------
function Resolve-MailboxDirs {
    param($Cfg)

    if ($Cfg.layout -eq "dirs") {
        # dirs 可能是程序构造的 hashtable 或配置文件解析出的 PSCustomObject, 统一为 hashtable
        $dirMap = @{}
        if ($Cfg.dirs -is [System.Collections.IDictionary]) {
            $dirMap = $Cfg.dirs
        } elseif ($Cfg.dirs) {
            foreach ($p in $Cfg.dirs.PSObject.Properties) { $dirMap[$p.Name] = [string]$p.Value }
        }
        if (-not $dirMap.ContainsKey($Cfg.identity)) {
            throw "layout=dirs 但配置缺少 identity '$($Cfg.identity)' 的目录映射"
        }
        $out = $dirMap[$Cfg.identity]
        $in = @()
        foreach ($k in @($dirMap.Keys)) {
            if ($k -ne $Cfg.identity) { $in += $dirMap[$k] }
        }
        return @{ Out = $out; In = @($in | Select-Object -Unique) }
    }

    # layout=root
    if (-not $Cfg.root) { throw "layout=root 需要配置 root" }
    if (-not $Cfg.identity) { throw "layout=root 需要 identity (显式配置或按会话自动派生)" }
    $out = Join-Path $Cfg.root $Cfg.identity
    $in = @()
    $participants = @(@($Cfg.participants) | Where-Object { $_ })
    if ($participants.Count -eq 0) {
        $participants = @(Get-ChildItem -LiteralPath $Cfg.root -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -notlike "_*" -and $_.Name -notlike ".*" } |
            Select-Object -ExpandProperty Name)
    }
    foreach ($p in $participants) {
        if ($p -ne $Cfg.identity -and $p -ne "") { $in += (Join-Path $Cfg.root $p) }
    }
    return @{ Out = $out; In = @($in | Select-Object -Unique) }
}

# ---------------------------------------------------------------------------
# seen 读写
# ---------------------------------------------------------------------------
function Get-MailboxSeenFile {
    param($Cfg)
    if ($Cfg.seenFile -ne "") { return $Cfg.seenFile }
    return Join-Path (Resolve-MailboxDirs $Cfg).Out ".seen.json"
}

# 目录化 seen 的存储目录; 显式 seenFile 时返回 "" (走单文件兼容)
function Get-MailboxSeenDir {
    param($Cfg)
    if ($Cfg.seenFile -ne "") { return "" }
    return Join-Path (Resolve-MailboxDirs $Cfg).Out ".seen"
}

function Get-MailboxSeen {
    param($Cfg)
    $dir = Get-MailboxSeenDir $Cfg
    if ($dir -eq "") {
        $f = Get-MailboxSeenFile $Cfg
        $seen = @()
        if (Test-Path -LiteralPath $f) {
            try { $seen = @((Get-Content -LiteralPath $f -Raw | ConvertFrom-Json)) } catch { $seen = @() }
        }
        return ,$seen
    }
    # 目录模式: 先迁移旧单文件 .seen.json (幂等)
    $legacy = Get-MailboxSeenFile $Cfg
    if ((Test-Path -LiteralPath $legacy) -and -not (Test-Path -LiteralPath $dir)) {
        try {
            $old = @((Get-Content -LiteralPath $legacy -Raw | ConvertFrom-Json))
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
            foreach ($id in $old) { if ($id) { Set-Content -LiteralPath (Join-Path $dir "$id.seen") -Value "" -Encoding UTF8 } }
            Remove-Item -LiteralPath $legacy -Force -ErrorAction SilentlyContinue
        } catch { }
    }
    $seen = @()
    if (Test-Path -LiteralPath $dir) {
        $seen = @(Get-ChildItem -LiteralPath $dir -Filter "*.seen" -ErrorAction SilentlyContinue |
            ForEach-Object { $_.BaseName })
    }
    # 逗号运算符: 防止单元素数组在函数输出边界被解包成裸字符串 (PowerShell 经典坑)
    return ,$seen
}

function Save-MailboxSeen {
    param($Cfg, [string[]]$Seen)
    $dir = Get-MailboxSeenDir $Cfg
    if ($dir -eq "") {
        $f = Get-MailboxSeenFile $Cfg
        $d = Split-Path $f -Parent
        if ($d -and -not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
        # 参数形式 (-InputObject) 保证单元素也输出数组 JSON ["a"], 避免管道解包成 "a"
        $unique = @($Seen | Select-Object -Unique)
        ConvertTo-Json -InputObject $unique | Set-Content -LiteralPath $f -Encoding UTF8
        return
    }
    # 目录模式: 逐条原子标记 (并发安全, 不互不覆盖)
    foreach ($id in ($Seen | Select-Object -Unique)) { if ($id) { Add-MailboxSeenMark $Cfg $id } }
}

# 目录化 seen: 每条已读消息一个 `.seen` 标记文件, 临时文件 + Move 原子提交
function Add-MailboxSeenMark {
    param($Cfg, [string]$Id)
    if (-not $Id) { return }
    $dir = Get-MailboxSeenDir $Cfg
    if ($dir -eq "") {
        # 单文件兼容: 读改写
        $seen = Get-MailboxSeen $Cfg
        if ($seen -notcontains $Id) { Save-MailboxSeen $Cfg @($seen + $Id) }
        return
    }
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $mark = Join-Path $dir ("$Id.seen")
    if (Test-Path -LiteralPath $mark) { return }
    $tmp = Join-Path $dir (".tmp-$Id")
    Set-Content -LiteralPath $tmp -Value "" -Encoding UTF8
    Move-Item -LiteralPath $tmp -Destination $mark -Force
}

# ---------------------------------------------------------------------------
# 发送: 写到自己的目录 (对方读你的目录)
# ---------------------------------------------------------------------------
function Send-Mailbox {
    param(
        [Parameter(Mandatory)][string]$To,                     # 参与者 id 或 "all"
        [ValidateSet("request","response","notify","reply")][string]$Type = "notify",
        [string]$Topic = "",
        $Payload = @{},
        [string]$ReplyTo = "",
        $Cfg
    )

    $dirs = Resolve-MailboxDirs $Cfg
    if (-not (Test-Path -LiteralPath $dirs.Out)) { New-Item -ItemType Directory -Force -Path $dirs.Out | Out-Null }

    $id = "$(Get-Date -Format 'yyyyMMddHHmmss')-$(Get-Random -Minimum 1000 -Maximum 9999)-$([guid]::NewGuid().ToString('N').Substring(0,4))"
    $msg = [ordered]@{
        id = $id
        from = $Cfg.identity
        to = $To
        type = $Type
        topic = $Topic
        payload = $Payload
        ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        reply_to = $ReplyTo
    }
    $file = Join-Path $dirs.Out "msg_$id.json"
    $msg | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $file -Encoding UTF8
    return $id
}

# ---------------------------------------------------------------------------
# 接收: 扫描所有对方目录, 取 to=自己 或 to=all 且未 seen 的消息
# ---------------------------------------------------------------------------
function Recv-Mailbox {
    param(
        $Cfg,
        [switch]$KeepSeen   # 置位时只读不更新 seen (wait 场景由调用方决定)
    )

    # Get-MailboxSeen 已用逗号保证返回扁平数组, 这里不要再 @() 包装 (会变成嵌套数组)
    $seen = Get-MailboxSeen $Cfg
    $new = @()
    foreach ($dir in (Resolve-MailboxDirs $Cfg).In) {
        if (-not (Test-Path -LiteralPath $dir)) { continue }
        Get-ChildItem -LiteralPath $dir -Filter "msg_*.json" -ErrorAction SilentlyContinue |
            Sort-Object Name |
            ForEach-Object {
                try {
                    $m = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json
                    if (($m.to -eq $Cfg.identity -or $m.to -eq "all") -and ($seen -notcontains $m.id)) {
                        $new += $m
                        if (-not $KeepSeen) { Add-MailboxSeenMark $Cfg $m.id }
                    }
                } catch { }
            }
    }
    return $new
}

# ---------------------------------------------------------------------------
# 删除消息: -InInbox 删对方目录(已处理), 默认删自己的目录(已发送)
# ---------------------------------------------------------------------------
function Remove-MailboxMsg {
    param(
        [Parameter(Mandatory)][string]$Id,
        $Cfg,
        [switch]$InInbox
    )

    $dirs = Resolve-MailboxDirs $Cfg
    $dirsToScan = if ($InInbox) { $dirs.In } else { @($dirs.Out) }
    foreach ($dir in $dirsToScan) {
        if (-not (Test-Path -LiteralPath $dir)) { continue }
        Get-ChildItem -LiteralPath $dir -Filter "msg_*.json" -ErrorAction SilentlyContinue |
            ForEach-Object {
                try {
                    $m = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json
                    if ($m.id -eq $Id) { Remove-Item -LiteralPath $_.FullName -Force; return }
                } catch { }
            }
    }
}

# ---------------------------------------------------------------------------
# TTL 清理: 删除自己 OutDir 中超过 TtlHours 的已发送消息 (收方应已读过)
# ---------------------------------------------------------------------------
function Clear-MailboxTTL {
    param($Cfg, [int]$TtlHours = 24, [switch]$DryRun)

    $dirs = Resolve-MailboxDirs $Cfg
    if (-not (Test-Path -LiteralPath $dirs.Out)) { return 0 }
    $cutoff = (Get-Date).AddHours(-$TtlHours)
    $removed = 0
    Get-ChildItem -LiteralPath $dirs.Out -Filter "msg_*.json" -ErrorAction SilentlyContinue |
        ForEach-Object {
            if ($_.LastWriteTime -lt $cutoff) {
                if (-not $DryRun) { Remove-Item -LiteralPath $_.FullName -Force }
                $removed++
            }
        }
    return $removed
}

# ---------------------------------------------------------------------------
# 状态: 身份/目录/各参与者消息数/未读数
# ---------------------------------------------------------------------------
function Get-MailboxStatus {
    param($Cfg)

    $dirs = Resolve-MailboxDirs $Cfg
    $seen = Get-MailboxSeen $Cfg
    $inInfo = @()
    foreach ($dir in $dirs.In) {
        $count = if (Test-Path -LiteralPath $dir) {
            @(Get-ChildItem -LiteralPath $dir -Filter "msg_*.json" -ErrorAction SilentlyContinue).Count
        } else { 0 }
        $inInfo += [pscustomobject]@{ Dir = $dir; MsgCount = $count }
    }
    return [pscustomobject]@{
        identity = $Cfg.identity
        layout   = $Cfg.layout
        outDir   = $dirs.Out
        outCount = @(Get-ChildItem -LiteralPath $dirs.Out -Filter "msg_*.json" -ErrorAction SilentlyContinue).Count
        seen     = @($seen).Count
        inboxes  = $inInfo
    }
}

Export-ModuleMember -Function Get-MailboxConfig, Resolve-MailboxDirs, Send-Mailbox, Recv-Mailbox, Remove-MailboxMsg, Clear-MailboxTTL, Get-MailboxStatus
