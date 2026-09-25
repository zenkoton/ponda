/**
 * `ponda _hook`：shell 集成后端（design: 01-environment.md §6.2/§6.3）。
 * 职责：提示符片段、兼容环境变量导出、目录切换自动激活（chpwd）、
 * Ctrl-P 快捷键命名空间（真实 bind，§6.3：e 列表激活 / c 创建 / i 信息 / d 删除预填）。
 */

import { paths } from "../../../core/src/paths.ts";
import type { EnvStore } from "../../../core/src/store.ts";
import { resolveEnvForWorkspace } from "../../../core/src/workspace.ts";

export function shellIntegration(shell: "bash" | "zsh" | "fish"): string {
	const header = "# ponda shell integration（由 ponda init 生成；逻辑全部在 ponda _hook 内，此文件保持轻量）";
	if (shell === "fish") {
		return [
			header,
			"function __ponda_precmd --on-event fish_prompt",
			"  ponda _hook env 2>/dev/null | source",
			"end",
			"function __ponda_chpwd --on-variable PWD",
			"  ponda _hook chpwd >/dev/null 2>&1",
			"end",
			"# 提示符：把 (pi:<env>) 加入 fish_prompt，例如：",
			"#   function fish_prompt; echo (ponda _hook prompt)(fish_default_prompt); end",
			"# 快捷键（Ctrl-P 前缀命名空间，01 §6.3）：Ctrl-P 后按 e/c/i/d",
			"function __ponda_env_list; ponda env list; commandline --current-token 'ponda env activate '; end",
			"function __ponda_env_create; commandline --current-token 'ponda env create '; end",
			"function __ponda_env_info; ponda env list; commandline --current-token 'ponda env info '; end",
			"function __ponda_env_rm; ponda env list; commandline --current-token 'ponda env rm '; end",
			"bind \\cpe __ponda_env_list",
			"bind \\cpc __ponda_env_create",
			"bind \\cpi __ponda_env_info",
			"bind \\cpd __ponda_env_rm",
			"",
		].join("\n");
	}
	const lines = [
		header,
		"__ponda_precmd() {",
		"  local out",
		'  out="$(ponda _hook env 2>/dev/null)"',
		'  [[ -n "$out" ]] && eval "$out"',
		"}",
		"__ponda_chpwd() { ponda _hook chpwd >/dev/null 2>&1; }",
	];
	if (shell === "zsh") {
		lines.push("precmd_functions+=(__ponda_precmd)", "chpwd_functions+=(__ponda_chpwd)");
	} else {
		lines.push(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell 参数展开语法，非 JS 模板
			'PROMPT_COMMAND="__ponda_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"',
			'cd() { builtin cd "$@" && __ponda_chpwd; }',
		);
	}
	lines.push(
		"# 提示符嵌入：在 PS1/PROMPT 中加入 $(ponda _hook prompt)，例如：",
		'#   PS1="$(ponda _hook prompt) \\$ "          # bash',
		"#   PROMPT='$(ponda _hook prompt) %#'       # zsh",
		"# 快捷键（Ctrl-P 前缀命名空间，01 §6.3）：Ctrl-P 后按 e/c/i/d",
	);
	if (shell === "zsh") {
		lines.push(
			"ponda-env-list() { ponda env list; print -z 'ponda env activate '; zle reset-prompt; }",
			"ponda-env-create() { print -z 'ponda env create '; zle reset-prompt; }",
			"ponda-env-info() { ponda env list; print -z 'ponda env info '; zle reset-prompt; }",
			"ponda-env-rm() { ponda env list; print -z 'ponda env rm '; zle reset-prompt; }",
			"zle -N ponda-env-list",
			"zle -N ponda-env-create",
			"zle -N ponda-env-info",
			"zle -N ponda-env-rm",
			"bindkey '^Pe' ponda-env-list",
			"bindkey '^Pc' ponda-env-create",
			"bindkey '^Pi' ponda-env-info",
			"bindkey '^Pd' ponda-env-rm",
		);
	} else {
		lines.push(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell 展开语法，非 JS 模板
			"__ponda_env_list() { ponda env list; READLINE_LINE='ponda env activate '; READLINE_POINT=${#READLINE_LINE}; }",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell 展开语法，非 JS 模板
			"__ponda_env_create() { READLINE_LINE='ponda env create '; READLINE_POINT=${#READLINE_LINE}; }",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell 展开语法，非 JS 模板
			"__ponda_env_info() { ponda env list; READLINE_LINE='ponda env info '; READLINE_POINT=${#READLINE_LINE}; }",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell 展开语法，非 JS 模板
			"__ponda_env_rm() { ponda env list; READLINE_LINE='ponda env rm '; READLINE_POINT=${#READLINE_LINE}; }",
			"bind -x '\"\\C-pe\":__ponda_env_list'",
			"bind -x '\"\\C-pc\":__ponda_env_create'",
			"bind -x '\"\\C-pi\":__ponda_env_info'",
			"bind -x '\"\\C-pd\":__ponda_env_rm'",
		);
	}
	lines.push("");
	return lines.join("\n");
}

export async function runHook(store: EnvStore, sub: string): Promise<number> {
	switch (sub) {
		case "prompt": {
			const r = resolveEnvForWorkspace(process.cwd(), store.readState());
			const exists = store.exists(r.env);
			console.log(`(pi:${exists ? r.env : `${r.env}?`})`);
			return 0;
		}
		case "env": {
			// 兼容导出：ponda 入口不依赖它；state 变化时由 precmd eval
			const state = store.readState();
			if (state.activeEnv && store.exists(state.activeEnv)) {
				const envDir = paths.env(store.home, state.activeEnv);
				console.log(`export PONDA_ACTIVE_ENV=${state.activeEnv}`);
				console.log(`export PI_CODING_AGENT_DIR=${envDir}`);
			} else {
				console.log("unset PONDA_ACTIVE_ENV PI_CODING_AGENT_DIR");
			}
			return 0;
		}
		case "chpwd": {
			// 工作区绑定自动激活（design: 01 §7）：bind 与全局激活不同才动作
			const r = resolveEnvForWorkspace(process.cwd(), store.readState());
			if (r.source !== "bind") return 0;
			if (!store.exists(r.env)) return 0; // 绑定环境不存在：留给 ponda env create / autoCreate（M2）
			if (store.readState().activeEnv === r.env) return 0;
			store.activate(r.env);
			store.bindWorkspace(r.workspaceRoot ?? process.cwd(), r.env);
			return 0;
		}
		default:
			console.error("用法：ponda _hook prompt|env|chpwd");
			return 1;
	}
}
