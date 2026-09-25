#!/usr/bin/env node
/**
 * ponda CLI 单文件打包：packages/cli/src/bin.ts（含跨包 TS 源）→ dist/ponda.mjs。
 * ESM bundle + createRequire shim（CJS 依赖如 cross-spawn 的 require 在 ESM 下可用）；
 * 可选原生加速包保持 external（缺失时上游代码自动回退 JS 实现）。
 * 产物免 npm install：Node >= 22 直接执行（`node ponda.mjs` 或 chmod +x 后 `ponda`）。
 */
import { chmodSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const outDir = join(repoRoot, "packages", "cli", "dist");
const outfile = join(outDir, "ponda.mjs");

// 与上游 pi bundle（scripts/build-coding-agent-bundle.mjs）一致的可选依赖策略
const allowedExternalPackages = [
	// 注意：与上游 pi 的 npm 发布形态不同，本 bundle 免 node_modules 单文件运行，
	// 因此 @earendil-works/chord* 与 jiti 必须内联（上游 external 是因为其发布带依赖）。
	"@silvia-odwyer/photon-node", // 可选原生加速，缺失时上游自动回退 JS
	"bufferutil",
	"utf-8-validate",
	"kerberos",
	"supports-color",
];

const banner = {
	js: 'import { createRequire as __pondaCreateRequire } from "node:module"; const require = __pondaCreateRequire(import.meta.url);',
};

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
	entryPoints: [join(repoRoot, "packages", "cli", "src", "bin.ts")],
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	outfile,
	banner,
	external: allowedExternalPackages,
	// 入口 shebang 由 esbuild 自动保留（bin.ts 首行）
	logLevel: "info",
});

chmodSync(outfile, 0o755);
// 免扩展名副本：install.sh 落地为 `ponda`（无 .mjs 后缀，Node 按 CJS？——否：
// shebang 执行交给 node，node 对 .mjs 内容按 ESM 依内容判定不可行，故安装名保留 .mjs 语义：
// install.sh 写 `ponda` 为两行 shell 包装（exec node <dir>/ponda.mjs "$@"），避免后缀歧义。
copyFileSync(outfile, join(outDir, "ponda"));
console.log(`bundle: ${outfile}`);
