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

		/** Anchor icon (the hook glyph, inline SVG) — sized via CSS width/height. */
		const ANCHOR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="3"/><line x1="12" y1="22" x2="12" y2="8"/><path d="M5 12H2a10 10 0 0 0 20 0h-3"/></svg>';

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

		function renderRows(container, doc) {
			container.innerHTML = '';
			if (doc.loadError) {
				container.innerHTML = '<div class="hooks-panel-error">无法加载钩子: ' + esc(doc.loadError) + '</div>';
				return;
			}
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
			node.innerHTML = '<div class="hooks-panel-head">' + ANCHOR_SVG + '<div class="hooks-panel-headtext"><span class="hooks-panel-title">钩子</span><span class="hooks-panel-sub">通过配置和已启用的插件管理生命周期钩子</span></div></div><div class="hooks-panel-list">正在加载钩子…</div>';
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
			style.textContent = '.hooks-panel-root{display:flex;flex-direction:column;gap:14px;width:100%}.hooks-panel-head{display:flex;align-items:center;gap:10px;color:var(--dsw-alias-fg,inherit)}.hooks-panel-head>svg{width:22px;height:22px;flex-shrink:0}.hooks-panel-headtext{display:flex;flex-direction:column;gap:2px}.hooks-panel-title{font-size:1.9em;font-weight:700;line-height:1.2}.hooks-panel-sub{font-size:.85em;opacity:.65}.hooks-panel-list{display:flex;flex-direction:column;gap:12px}.hooks-panel-card{border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:12px;overflow:hidden}.hooks-panel-card-head{display:flex;align-items:center;gap:8px;padding:11px 16px;background:color-mix(in srgb,currentColor 5%,transparent)}.hooks-panel-card-head>svg{width:16px;height:16px;flex-shrink:0}.hooks-panel-event{font-weight:600}.hooks-panel-count{margin-left:auto;opacity:.6;font-size:.85em}.hooks-panel-body{display:flex;flex-direction:column}.hooks-panel-row{display:flex;gap:10px;padding:11px 16px;border-top:1px solid color-mix(in srgb,currentColor 8%,transparent);align-items:center}.hooks-panel-idx{opacity:.5;min-width:14px}.hooks-panel-main{flex:1;display:flex;flex-direction:column;gap:4px}.hooks-panel-msg{font-weight:500}.hooks-panel-cmd code{font-size:.8em;word-break:break-all;opacity:.8}.hooks-panel-meta{font-size:.8em;opacity:.6}.hooks-panel-empty,.hooks-panel-error{padding:28px;text-align:center;opacity:.7;border:1px dashed color-mix(in srgb,currentColor 20%,transparent);border-radius:12px;line-height:1.6}.hooks-panel-error{color:#d97706}';
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
						label: () => '钩子',
					}, HooksSection);
					return () => { try { unregister() } catch {} };
				} catch {
					return () => {};
				}
			});
		};
		module.exports.inject = ['slots'];
		//#endregion
		// 🔴 必须返回 exports：ModuleLoader 用 factory 的返回值作为插件模块，
		// 不返回 → 渲染进程收到 undefined → "expect ... apply method, received undefined" 启动失败
		return module.exports;
	},
});
