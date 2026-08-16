window.__ModuleLoader__.load({
	id: "@yuanchilin/dsh-mailbox",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region lib/directory-parse.js
		const DIRECTORY_LINE = /^\s{2}([●○])(在线|离线)\s+(\S+)(?:\s+\(([^()]*)\))?\s+(.*)$/;
		/**
		* 从 /mailbox 目录输出文本解析会话行。
		* @returns { id, label, detail }[] (popupSelect SelectOption 形状)
		*/
		function parseDirectory(text) {
			const rows = [];
			if (typeof text !== "string") return rows;
			for (const raw of text.split(/\r?\n/)) {
				const m = DIRECTORY_LINE.exec(raw);
				if (!m) continue;
				const identity = m[3];
				const alias = m[4] ?? "";
				const rest = (m[5] ?? "").trim();
				rows.push({
					id: identity,
					label: alias ? `${identity} (${alias})` : identity,
					detail: `${m[1] === "●" ? "●在线" : "○离线"}  ${rest || "?"}`
				});
			}
			return rows;
		}
		//#endregion
		//#region src/client/index.ts
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
		const name = "mailbox-client";
		const inject = [
			"commandUi",
			"remote",
			"remote.commands",
			"sessions"
		];
		function apply(ctx) {
			ctx.inject([
				"commandUi",
				"remote",
				"remote.commands",
				"sessions"
			], (scope) => {
				const command = scope.get("commandUi");
				const sessions = scope.get("sessions");
				const remote = scope.get("remote");
				scope.effect(() => command.decorate({
					name: "mailbox",
					available: () => true,
					ui: {
						kind: "popupSelect",
						options: async (session) => {
							if (remote.commands === void 0) return [];
							const result = await remote.commands.execute(session.sessionId, "/mailbox");
							if (!result.ok || result.value === void 0) throw new Error(`mailbox 目录获取失败: ${result.error?.message ?? result.error?.code ?? "unknown"}`);
							const rows = parseDirectory(result.value.result?.text ?? "");
							if (rows.length === 0) throw new Error("mailbox 目录为空 (暂无注册会话)");
							return rows;
						},
						onSelect: async (option, session) => {
							const actx = sessions.scope(session.sessionId);
							if (actx === void 0) return;
							const input = scope.get("conversation")?.input?.for(actx);
							if (input === void 0) return;
							input.setDraft(`/mailbox ${option.id} `);
							setTimeout(() => {
								const list = document.querySelectorAll("textarea[data-phase]");
								let target = null;
								for (const el of list) if (el.offsetParent !== null) {
									target = el;
									break;
								}
								target ??= list[0] ?? null;
								if (target === null) return;
								target.focus();
								target.setSelectionRange(target.value.length, target.value.length);
							}, 0);
						}
					}
				}), "mailbox: /mailbox popup decoration");
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map