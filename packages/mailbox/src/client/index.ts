/**
 * Browser client plugin for the mailbox: decorates the HOST `/mailbox`
 * command with a popupSelect — typing `/mailbox` pops the session directory
 * as selectable options, picking one fills the composer with
 * `/mailbox <identity> ` so the user types the message and Enter executes
 * the host command.
 *
 * 低风险设计 (教训沉淀):
 *   - 不用自定义 Remote 命名空间 (无挂载/注入死锁)。选项数据走成熟的
 *     `remote.commands` 通道: 执行 `/mailbox` 拿目录文本, 解析成选项。
 *   - 根级只注入 ui-commands 自己也在用的成熟服务
 *     (commandUi / remote / remote.commands / sessions)。
 *   - `conversation.input` 不是服务键, 在 onSelect 里经 ctx.conversation
 *     懒取, 取不到静默跳过。
 *
 * @module @yuanchilin/dsh-mailbox/client
 */

import { parseDirectory } from '../../lib/directory-parse.js'

// ---- local structural types (no cross-package value imports) ----

interface SelectOption {
  readonly id: string
  readonly label: string
  readonly detail?: string
  readonly active?: boolean
  /** true 表示这是命令动作 (recv/list)，选中时回填 `/mailbox <cmd>` 而非 `/mailbox <身份> ` */
  readonly isCommand?: boolean
}

interface ClientSessionContext {
  readonly sessionId: string
}

interface RemoteResult<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { readonly code?: string; readonly message?: string }
}

interface SessionInputLike {
  setDraft(text: string): void
}

interface Scope {
  get(key: string): unknown
  effect(fn: () => unknown, label?: string): unknown
}

interface MailboxClientContext {
  inject(deps: readonly string[], fn: (scope: Scope) => void): unknown
}

const name = 'mailbox-client'
const inject = ['commandUi', 'remote', 'remote.commands', 'sessions']

function apply(ctx: MailboxClientContext): void {
  ctx.inject(['commandUi', 'remote', 'remote.commands', 'sessions'], (scope: Scope) => {
    const command = scope.get('commandUi') as {
      decorate(decoration: unknown): () => void
    }
    const sessions = scope.get('sessions') as { scope(sessionId: string): unknown | undefined }
    const remote = scope.get('remote') as {
      commands?: {
        // DSH client runtime 的 commands.execute 真实业务签名 (3 个参数):
        //   execute(sessionId, line, images)
        // - images 是附件图片数组 (EncodedImageAttachment[]):
        //   { mediaType: 'image/png'|'image/jpeg'|'image/webp'|'image/gif'; data: string; name?: string }[]
        // - 无图时必须传空数组 []。早期误把第 3 参当 options 对象传 {}，
        //   触发 strict codec 报错 `client api: commands/execute rejected "images"`。
        execute(sessionId: string, line: string, images: readonly unknown[]): Promise<
          RemoteResult<{ result?: { kind: string; text?: string } } | undefined>
        >
      }
    }
    scope.effect(() => command.decorate({
      name: 'mailbox',
      available: () => true,
      ui: {
        kind: 'popupSelect',
        options: async (session: ClientSessionContext): Promise<SelectOption[]> => {
          // 命令动作置顶：recv/list 也能从补全里选；随后拉取会话目录供点选。
          // 注意：取目录需执行裸 /mailbox，该执行会被宿主记录并渲染一次目录（DSH 设计，execute 无静默模式）；
          // 为保留"点选会话"的便利，这里接受这次渲染。
          const commandActions: SelectOption[] = [
            { id: 'recv', label: '📥 recv — 收取发给我的新消息', detail: '读取当前会话收件箱（自动去重）', isCommand: true },
            { id: 'list', label: '📇 list — 列出会话目录', detail: '查看所有会话身份/别名/在线状态', isCommand: true },
          ]
          if (remote.commands === undefined) return commandActions
          // 执行裸 /mailbox → 拿会话目录文本 → 解析成选项 (复用宿主逻辑, 零自定义 Remote)
          const result = await remote.commands.execute(session.sessionId, '/mailbox', [])
          if (!result.ok || result.value === undefined) {
            throw new Error(`mailbox 目录获取失败: ${result.error?.message ?? result.error?.code ?? 'unknown'}`)
          }
          const text = result.value.result?.text ?? ''
          const rows = parseDirectory(text)
          // 命令动作在前，会话身份在后
          return [...commandActions, ...rows]
        },
        onSelect: async (option: SelectOption, session: ClientSessionContext): Promise<void> => {
          const actx = sessions.scope(session.sessionId)
          if (actx === undefined) return
          // conversation.input = ctx.conversation 服务的属性 (非服务键), 用户正在输入时存在
          const conversation = scope.get('conversation') as
            | { input?: { for(actx: unknown): SessionInputLike } }
            | undefined
          const input = conversation?.input?.for(actx)
          if (input === undefined) return
          // 命令动作无需后续消息参数：回填 `/mailbox recv`；会话身份则留尾随空格便于续写消息
          const draft = option.isCommand ? `/mailbox ${option.id}` : `/mailbox ${option.id} `
          input.setDraft(draft)
          // 焦点兜底: 框架的 popup 焦点回挂是死代码 (bindComposerFocus 无生产调用方),
          // 键盘选中后 composer 不会自动聚焦。等弹窗卸载后直接聚焦输入框并置光标于末尾。
          setTimeout(() => {
            const list = document.querySelectorAll<HTMLTextAreaElement>('textarea[data-phase]')
            let target: HTMLTextAreaElement | null = null
            for (const el of list) {
              if (el.offsetParent !== null) { target = el; break }
            }
            target ??= list[0] ?? null
            if (target === null) return
            target.focus()
            target.setSelectionRange(target.value.length, target.value.length)
          }, 0)
        },
      },
    }), 'mailbox: /mailbox popup decoration')
  })
}

export { apply, inject, name }
