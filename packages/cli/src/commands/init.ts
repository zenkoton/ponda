/** `ponda init`：default 环境 + shell 集成（design: 01-environment.md §6） */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../../core/src/paths.ts";
import type { EnvStore } from "../../../core/src/store.ts";
import { c } from "../ui.ts";
import { shellIntegration } from "./hook.ts";

const SHELLS = ["bash", "zsh", "fish"] as const;
type Shell = (typeof SHELLS)[number];

function detectShell(): Shell {
	const sh = process.env.SHELL ?? "";
	if (sh.includes("zsh")) return "zsh";
	if (sh.includes("fish")) return "fish";
	return "bash";
}

const RC_FILES: Record<Shell, string> = {
	bash: "~/.bashrc",
	zsh: "~/.zshrc",
	fish: "~/.config/fish/config.fish",
};

export async function runInit(store: EnvStore, args: string[], flags: Map<string, string | boolean>): Promise<number> {
	const home = store.home;

	const wantPrint = flags.get("print") === true || flags.get("p") === true;
	const wantAppend = flags.get("append") === true;
	const shellArg = args[0] as Shell | undefined;
	const shell: Shell = shellArg && (SHELLS as readonly string[]).includes(shellArg) ? shellArg : detectShell();
	const script = shellIntegration(shell);

	// --print 仅预览：不创建环境、不写集成文件
	if (wantPrint) {
		console.log(script);
		return 0;
	}

	mkdirSync(home, { recursive: true });

	// 1) default 环境
	if (!store.exists("default")) {
		store.create({ name: "default", systemPrompt: "You are a helpful coding agent." });
		if (!store.readState().activeEnv) store.activate("default");
		console.log(c.green("✓"), "已创建 default 环境（readme 默认配置）");
	} else {
		console.log(c.dim("default 环境已存在，跳过创建"));
	}

	// 2) shell 集成
	const integFile = paths.shellInteg(home, shell);
	mkdirSync(join(home, "shell"), { recursive: true });
	writeFileSync(integFile, script);
	console.log(c.green("✓"), `已生成 ${shell} 集成脚本：${integFile}`);

	if (wantAppend) {
		const rc = RC_FILES[shell].replace("~", process.env.HOME ?? "~");
		const line = shell === "fish" ? `source ${integFile}` : `[[ -f "${integFile}" ]] && source "${integFile}"`;
		if (existsSync(rc) && readFileSync(rc, "utf8").includes(integFile)) {
			console.log(c.dim(`集成已存在于 ${rc}，跳过追加`));
		} else {
			appendFileSync(rc, `\n# ponda environment integration\n${line}\n`);
			console.log(c.green("✓"), `已追加到 ${rc}`);
		}
	}

	console.log(`
${c.bold("下一步")}
  1. 重启 shell 或 source rc 文件，提示符将显示 ${c.cyan("(pi:<env>)")}
  2. ponda env create <name> --base default     # 创建新环境
  3. ponda env activate <name>                  # 切换环境
  4. 快捷键（Ctrl-P 前缀见集成脚本注释）可快速切换/创建/删除环境
${c.dim(`  提示符嵌入：zsh/bash 在 PS1/PROMPT 中加入 "$(ponda _hook prompt)"；fish 用 (ponda _hook prompt)`)}`);
	return 0;
}
