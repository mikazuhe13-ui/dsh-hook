window.__ModuleLoader__.load({
	id: "dsh-hook",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region src/client/index.ts
		/**
		 * dsh-hook browser half — seats a first-level 钩子 settings section
		 * (Codex Desktop style): lists configured hooks from the host overview
		 * route with event, matcher, command and status. Pure DOM rendering (no
		 * React), polls only while the section is mounted.
		 * @module dsh-hook/client
		 */
		const SECTION_ID = 'dsh-hook';
		const SECTION_ORDER = 152; // below usage (151)
		const FETCH_TIMEOUT_MS = 20_000;
		const POLL_MS = 15_000;
		const NAV_LABEL = '钩子';

		/** Anchor icon (the hook glyph, inline SVG) — sized via CSS width/height. */
		const ANCHOR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="3"/><line x1="12" y1="22" x2="12" y2="8"/><path d="M5 12H2a10 10 0 0 0 20 0h-3"/></svg>';

		/** Anchor glyph as bare paths, for swapping the settings-nav glyph. */
		const ANCHOR_PATHS = '<circle cx="12" cy="5" r="3"/><line x1="12" y1="22" x2="12" y2="8"/><path d="M5 12H2a10 10 0 0 0 20 0h-3"/>';

		/**
		 * The settings shell maps a fixed set of section ids to nav glyphs
		 * (`navIcon(id)` in dsh-client-ui-settings: account/models/agent-presets/
		 * plugins/archived-sessions) and falls back to the settings gear for every
		 * unknown id — the slot contract exposes no plugin-facing icon field. So we
		 * swap the gear on our own nav cell for the anchor glyph, scoped to the
		 * settings dialog and matched by exact label. Idempotent, and re-applied on
		 * mutation because React re-renders the nav.
		 */
		function patchNavIcon() {
			for (const dialog of document.querySelectorAll('[role="dialog"][aria-modal="true"]')) {
				const nav = dialog.querySelector('nav');
				if (!nav) continue;
				for (const cell of nav.querySelectorAll('button')) {
					if ((cell.textContent ?? '').trim() !== NAV_LABEL) continue;
					const svg = cell.querySelector('svg');
					if (!svg || svg.dataset.dshHookNavIcon === '1') continue;
					svg.dataset.dshHookNavIcon = '1';
					svg.setAttribute('viewBox', '0 0 24 24');
					svg.setAttribute('fill', 'none');
					svg.setAttribute('stroke', 'currentColor');
					svg.setAttribute('stroke-width', '2');
					svg.setAttribute('stroke-linecap', 'round');
					svg.setAttribute('stroke-linejoin', 'round');
					svg.setAttribute('width', '16');
					svg.setAttribute('height', '16');
					svg.innerHTML = ANCHOR_PATHS;
				}
			}
		}

		/** Re-apply the nav glyph when the settings dialog mounts or re-renders (one pass per frame). */
		function watchNavIcon() {
			let scheduled = false;
			const run = () => {
				scheduled = false;
				try { patchNavIcon(); } catch { /* nav detached */ }
			};
			const observer = new MutationObserver(() => {
				if (scheduled) return;
				scheduled = true;
				requestAnimationFrame(run);
			});
			observer.observe(document.body, { childList: true, subtree: true });
			run();
			return () => observer.disconnect();
		}

		function esc(s) {
			return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
		}

		async function fetchOverview() {
			const response = await fetch('api/dsh-hook/overview', { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
			if (!response.ok) throw new Error('hooks-panel overview failed: ' + response.status);
			return await response.json();
		}

		async function fetchRules() {
			const response = await fetch('api/dsh-hook/rules', { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
			if (!response.ok) throw new Error('hooks-panel rules failed: ' + response.status);
			return await response.json();
		}

		async function saveRules(rules) {
			const response = await fetch('api/dsh-hook/rules', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(rules),
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			if (!response.ok) throw new Error('hooks-panel rules save failed: ' + response.status);
			return await response.json();
		}

		/** Render the per-rule switches card (live effect: guard re-reads per call). */
		function renderRulesCard(container, doc) {
			const card = document.createElement('div');
			card.className = 'hooks-panel-card';
			let html = '<div class="hooks-panel-card-head">' + ANCHOR_SVG + '<span class="hooks-panel-event">守卫规则</span><span class="hooks-panel-count">实时生效</span></div><div class="hooks-panel-body">';
			const rules = doc.rules ?? {};
			const keys = doc.ruleKeys ?? [
				{ key: 'recursion', label: '递归删除保护', desc: '拦截 Remove-Item -Recurse 触及受保护目录' },
				{ key: 'cWrite', label: 'C 盘写入保护', desc: '拦截 write/edit 写 C 盘非白名单' },
				{ key: 'envProbe', label: '环境变量枚举拦截', desc: '拦截 Get-ChildItem Env:' },
				{ key: 'bskJunction', label: '.bsk Junction 保护', desc: '拦截 .bsk 上的 -Recurse' },
			];
			for (const k of keys) {
				const on = rules[k.key] !== false;
				html += '<div class="hooks-panel-row"><div class="hooks-panel-main"><div class="hooks-panel-msg">' + esc(k.label)
					+ '</div><div class="hooks-panel-meta">' + esc(k.desc) + '</div></div>'
					+ '<label class="hooks-panel-switch"><input type="checkbox" data-rule="' + esc(k.key) + '"' + (on ? ' checked' : '') + '><span class="hooks-panel-slider"></span></label></div>';
			}
			html += '</div>';
			card.innerHTML = html;
			container.appendChild(card);
			// Wire switches: POST on change, then re-render.
			card.querySelectorAll('input[data-rule]').forEach((input) => {
				input.addEventListener('change', () => {
					const next = { ...rules, [input.dataset.rule]: input.checked };
					saveRules(next).then(() => renderRulesCard(container, doc), () => {});
				});
			});
		}

		/** 运行状态卡片：guard 每次调用的放行/拦截记录（hooks-runs.json，guard 写、宿主读） */
		function renderRunsCard(container, doc) {
			const runs = doc.runs ?? [];
			const card = document.createElement('div');
			card.className = 'hooks-panel-card';
			let html = '<div class="hooks-panel-card-head">' + ANCHOR_SVG + '<span class="hooks-panel-event">运行状态</span><span class="hooks-panel-count">' + runs.length + ' 条记录（最近 20）</span></div>';
			if (runs.length === 0) {
				html += '<div class="hooks-panel-body"><div class="hooks-panel-row"><div class="hooks-panel-main"><div class="hooks-panel-meta">暂无运行记录——钩子在每次工具调用时触发，运行后这里会显示放行/拦截结果。</div></div></div></div>';
			} else {
				html += '<div class="hooks-panel-body">';
				runs.forEach((r) => {
					const isBlock = r.decision === 'block';
					const time = (r.time ?? '').replace('T', ' ').slice(5, 19);
					html += '<div class="hooks-panel-row"><div class="hooks-panel-main">'
						+ '<div class="hooks-panel-msg"><span class="' + (isBlock ? 'hooks-panel-badge-block' : 'hooks-panel-badge-allow') + '">' + (isBlock ? '拦截' : '放行') + '</span> <span>' + esc(r.tool ?? '?') + '</span></div>'
						+ '<div class="hooks-panel-cmd"><code>' + esc(r.cmd ?? '') + '</code></div>'
						+ (r.reason ? '<div class="hooks-panel-meta">' + esc(r.reason) + '</div>' : '')
						+ '<div class="hooks-panel-meta">' + esc(time) + '</div>'
						+ '</div></div>';
				});
				html += '</div>';
			}
			card.innerHTML = html;
			container.appendChild(card);
			// 清空按钮
			const clear = document.createElement('button');
			clear.type = 'button';
			clear.className = 'hooks-panel-clearbtn';
			clear.textContent = '清空运行记录';
			clear.addEventListener('click', () => {
				fetch('api/dsh-hook/runs/clear', { method: 'POST', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
					.then(() => renderRunsCard(container, doc), () => {});
			});
			container.appendChild(clear);
		}

		function renderRows(container, doc) {
			container.innerHTML = '';
			if (doc.loadError) {
				container.innerHTML = '<div class="hooks-panel-error">无法加载钩子: ' + esc(doc.loadError) + '</div>';
				return;
			}
			renderRunsCard(container, doc);
			renderRulesCard(container, doc);
			if (!doc.hooks || doc.hooks.length === 0) {
				const empty = document.createElement('div');
				empty.className = 'hooks-panel-empty';
				empty.innerHTML = '<b>未找到钩子</b><br/>已配置的钩子将显示在此处';
				container.appendChild(empty);
				return;
			}
			const byEvent = {};
			for (const h of doc.hooks) (byEvent[h.event] ??= []).push(h);
			for (const event of Object.keys(byEvent)) {
				const card = document.createElement('div');
				card.className = 'hooks-panel-card';
				let html = '<div class="hooks-panel-card-head">' + ANCHOR_SVG + '<span class="hooks-panel-event">' + esc(event) + '</span><span class="hooks-panel-count">' + byEvent[event].length + ' 个钩子</span></div>';
				html += '<div class="hooks-panel-body">';
				byEvent[event].forEach((h, i) => {
					html += '<div class="hooks-panel-row"><div class="hooks-panel-idx">' + (i + 1) + '</div><div class="hooks-panel-main">';
					if (h.statusMessage) html += '<div class="hooks-panel-msg">' + esc(h.statusMessage) + '</div>';
					html += '<div class="hooks-panel-cmd"><code>' + esc(h.command) + '</code></div>';
					html += '<div class="hooks-panel-meta">' + (h.matcher ? 'matcher: <code>' + esc(h.matcher) + '</code> · ' : '') + (h.timeout ? 'timeout: ' + h.timeout + 's · ' : '') + 'type: ' + esc(h.type) + '</div>';
					html += '</div></div>';
				});
				html += '</div>';
				card.innerHTML = html;
				container.appendChild(card);
			}
		}

		/** Imperative DOM mount: poll + render into a container node. */
		function mountInto(node, ctx) {
			node.innerHTML = '<div class="hooks-panel-head">' + ANCHOR_SVG + '<div class="hooks-panel-headtext"><span class="hooks-panel-title">' + NAV_LABEL + '</span><span class="hooks-panel-sub">通过配置和已启用的插件管理生命周期钩子</span></div></div><div class="hooks-panel-list">正在加载钩子…</div><div class="hooks-panel-hint">面板每 15 秒读取一次 hooks.json：新增/修改的钩子会自动出现在这里；但要真正生效（拦截工具调用）需重启桌面端——钩子桥只在启动时读取一次配置。</div>';
			const list = node.querySelector('.hooks-panel-list');
			let alive = true;
			const poll = () => {
				fetchOverview().then((doc) => { if (alive) renderRows(list, doc); }, () => { if (alive) list.innerHTML = '<div class="hooks-panel-error">钩子面板路由不可用（宿主半未加载或已禁用）</div>'; });
			};
			poll();
			const timer = setInterval(poll, POLL_MS);
			return () => { alive = false; clearInterval(timer); };
		}

		function ensureStyles() {
			if (document.getElementById('dsh-hook-styles')) return;
			const style = document.createElement('style');
			style.id = 'dsh-hook-styles';
			style.textContent = '.hooks-panel-root{display:flex;flex-direction:column;gap:14px;width:100%}.hooks-panel-head{display:flex;align-items:center;gap:10px;color:var(--dsw-alias-fg,inherit)}.hooks-panel-head>svg{width:22px;height:22px;flex-shrink:0}.hooks-panel-headtext{display:flex;flex-direction:column;gap:2px}.hooks-panel-title{font-size:1.9em;font-weight:700;line-height:1.2}.hooks-panel-sub{font-size:.85em;opacity:.65}.hooks-panel-hint{font-size:.8em;opacity:.6;line-height:1.6;padding:10px 12px;border-radius:10px;background:color-mix(in srgb,currentColor 4%,transparent)}.hooks-panel-list{display:flex;flex-direction:column;gap:12px}.hooks-panel-card{border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:12px;overflow:hidden}.hooks-panel-card-head{display:flex;align-items:center;gap:8px;padding:11px 16px;background:color-mix(in srgb,currentColor 5%,transparent)}.hooks-panel-card-head>svg{width:16px;height:16px;flex-shrink:0}.hooks-panel-event{font-weight:600}.hooks-panel-count{margin-left:auto;opacity:.6;font-size:.85em}.hooks-panel-body{display:flex;flex-direction:column}.hooks-panel-row{display:flex;gap:10px;padding:11px 16px;border-top:1px solid color-mix(in srgb,currentColor 8%,transparent);align-items:center}.hooks-panel-idx{opacity:.5;min-width:14px}.hooks-panel-main{flex:1;display:flex;flex-direction:column;gap:4px}.hooks-panel-msg{font-weight:500;display:flex;align-items:center;gap:8px}.hooks-panel-cmd code{font-size:.8em;word-break:break-all;opacity:.8}.hooks-panel-meta{font-size:.8em;opacity:.6}.hooks-panel-empty,.hooks-panel-error{padding:28px;text-align:center;opacity:.7;border:1px dashed color-mix(in srgb,currentColor 20%,transparent);border-radius:12px;line-height:1.6}.hooks-panel-error{color:#d97706}.hooks-panel-switch{position:relative;display:inline-block;width:40px;height:22px;flex-shrink:0}.hooks-panel-switch input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer;z-index:2}.hooks-panel-slider{position:absolute;inset:0;background:color-mix(in srgb,currentColor 25%,transparent);border-radius:22px;transition:background .2s}.hooks-panel-slider:before{content:"";position:absolute;height:16px;width:16px;left:3px;top:3px;background:var(--dsw-alias-bg-base,#fff);border-radius:50%;transition:transform .2s;box-shadow:0 1px 3px rgba(0,0,0,.3)}.hooks-panel-switch input:checked~.hooks-panel-slider{background:#10b981}.hooks-panel-switch input:checked~.hooks-panel-slider:before{transform:translateX(18px)}.hooks-panel-switch input:focus-visible~.hooks-panel-slider{outline:2px solid color-mix(in srgb,currentColor 40%,transparent);outline-offset:2px}.hooks-panel-badge-block{background:#dc2626;color:#fff;border-radius:6px;padding:1px 8px;font-size:.75em;font-weight:600}.hooks-panel-badge-allow{background:color-mix(in srgb,currentColor 15%,transparent);border-radius:6px;padding:1px 8px;font-size:.75em;font-weight:600}.hooks-panel-clearbtn{align-self:flex-start;border:1px solid color-mix(in srgb,currentColor 20%,transparent);background:0 0;color:inherit;border-radius:8px;padding:6px 14px;cursor:pointer;font-size:.85em;font-family:inherit}.hooks-panel-clearbtn:hover{background:color-mix(in srgb,currentColor 8%,transparent)}';
			document.head.appendChild(style);
		}

		let clientCtx = null;

		/** React component wrapper: hosts the imperative DOM via a container ref.
		 * ref(null) on unmount disposes the poll timer (prevents a leaked interval
		 * keeping the page awake after the section unmounts). */
		function HooksSection() {
			const react = require('react');
			return react.createElement('div', {
				style: { width: '100%' },
				ref: (node) => {
					if (node) {
						if (node.dataset.hooksPanelMounted === '1') return;
						node.dataset.hooksPanelMounted = '1';
						node.__hooksPanelDispose = mountInto(node, clientCtx);
					} else {
						// Unmount: the previous node's dispose was captured on the element,
						// which is being detached — stop its timer via the live registry.
						const live = document.querySelector('[data-hooks-panel-mounted="1"]');
						if (live && typeof live.__hooksPanelDispose === 'function') {
							live.__hooksPanelDispose();
							delete live.dataset.hooksPanelMounted;
						}
					}
				},
			});
		}

		/** Client plugin entry: DSH calls apply(ctx) on the client half. */
		module.exports.apply = function apply(ctx) {
			clientCtx = ctx;
			ensureStyles();
			// usage-plugin proven path: slots.inject defers registration until the
			// settings page exists (the renderer owns the slot registry).
			ctx.slots.inject('settings.section', () => {
				try {
					const unregister = ctx.slots.register({
						name: 'settings.section',
						id: SECTION_ID,
						order: SECTION_ORDER,
						label: () => NAV_LABEL,
					}, HooksSection);
					return () => { try { unregister() } catch {} };
				} catch {
					return () => {};
				}
			});

			// Nav glyph: the shell's id→glyph map is closed, so swap our own cell's
			// gear for the anchor (see patchNavIcon). Disposed with the fiber.
			try {
				const stopWatching = watchNavIcon();
				ctx.effect(() => () => { try { stopWatching() } catch {} }, 'dsh-hook: nav icon watcher');
			} catch { /* document unavailable */ }
		};
		module.exports.inject = ['slots'];
		//#endregion
		// 🔴 必须返回 exports：ModuleLoader 用 factory 的返回值作为插件模块，
		// 不返回 → 渲染进程收到 undefined → "expect ... apply method, received undefined" 启动失败
		return module.exports;
	},
});
