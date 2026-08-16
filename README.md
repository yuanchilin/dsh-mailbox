# dsh-mailbox

DeepSeek Harness 跨会话文件信箱：让多个 DSH 会话 / agent 通过共享文件系统异步通信。

- **插件**：6 个工具 + `/mailbox` 命令（含补全弹窗）+ 内建唤醒 watcher
- **CLI**：零依赖 node CLI + pwsh 双实现
- **Skill**：随包携带，供会话加载使用手册与脚本

## 仓库结构

```
packages/mailbox/    # @yuanchilin/dsh-mailbox 插件包 (npm workspace)
.github/workflows/   # GitHub Actions CI
```

## 快速开始

见 [`packages/mailbox/README.md`](packages/mailbox/README.md)。

## 开发

```sh
npm install        # 根目录, 安装 workspace
npm test           # 30 个用例 (node:test)
npm run build      # 重建客户端 bundle (lib/client.js, 提交入库)
```

## CI

`.github/workflows/ci.yml`：push/PR 触发，Node 24，`npm ci` → 测试 → 构建 → 校验 bundle 与源码同步。

## 发布 (CD)

`.github/workflows/publish.yml`：推送 `v*` tag 时自动 测试 → 构建 → 校验 → `npm publish`。

```sh
npm version patch --workspace @yuanchilin/dsh-mailbox   # 0.0.2: 自动提交 + 打 tag v0.0.2
git push origin main --tags
```

前提：仓库 Settings → Secrets and variables → Actions 添加 `NPM_TOKEN`（npm granular access token，勾选 bypass 2FA，权限 Publish）。

## License

MIT
