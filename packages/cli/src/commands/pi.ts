/**
 * `ponda pi`：透传上游 pi 入口（PATCHES.md P1 落地前的过渡形态）。
 * 按当前环境设置 PI_CODING_AGENT_DIR / PI_CODING_AGENT_SESSION_DIR 后 spawn 真正的 pi。
 */
import { type StdioOptions, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "../../../core/src/paths.ts";
import type { EnvStore } from "../../../core/src/store.ts";
import { resolveEnvForWorkspace } from "../../../core/src/workspace.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 定位本 monorepo 内 coding-agent 的可执行入口（构建产物 dist/bundle/cli.js） */
export function locatePiBin(): string | null {
	const pkgRoot = join(__dirname, "..", "..", "..", "coding-agent");
	for (const c of [
		join(pkgRoot, "dist", "bundle", "cli.js"),
		join(pkgRoot, "bin", "pi.ts"),
		join(pkgRoot, "bin", "pi.js"),
	]) {
		if (existsSync(c)) return c;
	}
	return null;
}

export async function runPi(
	store: EnvStore,
	passthrough: string[],
	io: StdioOptions = "inherit",
	envOverride?: string,
): Promise<number> {
	const r =
		envOverride !== undefined
			? { env: envOverride, source: "history-attach" }
			: resolveEnvForWorkspace(process.cwd(), store.readState());
	if (!store.exists(r.env)) {
		console.error(`当前环境 "${r.env}"（来源：${r.source}）不存在；先运行 ponda init`);
		return 2;
	}
	const bin = locatePiBin();
	if (bin === null) {
		console.error(
			"未找到 pi 入口（packages/coding-agent/bin）。\n" +
				"fork 基线下的使用方式：在 monorepo 根目录执行 npm install && npm run build 后重试。",
		);
		return 1;
	}

	const envDir = paths.env(store.home, r.env);
	const env = {
		...process.env,
		PONDA_ACTIVE_ENV: r.env,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR || envDir, // 显式设置优先（design: 01 §5）
		PI_CODING_AGENT_SESSION_DIR: join(envDir, "sessions"),
	};

	const child = spawn(process.execPath, [bin, ...passthrough], { stdio: io, env });
	return await new Promise((resolve) => {
		child.on("exit", (code) => resolve(code ?? 0));
		child.on("error", (e) => {
			console.error(`启动 pi 失败：${e.message}`);
			resolve(1);
		});
	});
}
