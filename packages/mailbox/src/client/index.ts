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
        execute(sessionId: string, line: string): Promise<
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
          if (remote.commands === undefined) return []
          // 执行裸 /mailbox → 拿会话目录文本 → 解析成选项 (复用宿主逻辑, 零自定义 Remote)
          const result = await remote.commands.execute(session.sessionId, '/mailbox')
          if (!result.ok || result.value === undefined) {
            throw new Error(`mailbox 目录获取失败: ${result.error?.message ?? result.error?.code ?? 'unknown'}`)
          }
          const text = result.value.result?.text ?? ''
          const rows = parseDirectory(text)
          if (rows.length === 0) throw new Error('mailbox 目录为空 (暂无注册会话)')
          return rows
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
          input.setDraft(`/mailbox ${option.id} `)
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
