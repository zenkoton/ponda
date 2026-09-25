/** daemon 子进程入口：node main.ts --env <env> [--home <dir>] [--idle-ms <n>] */
import { appendFileSync, openSync } from "node:fs";
import { DaemonCore } from "./core.ts";

function arg(name: string): string | undefined {
	const argv = process.argv.slice(2);
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
}

const env = arg("env") ?? "default";
const home = arg("home") ?? process.env.PONDA_HOME;
const idleMs = arg("idle-ms") !== undefined ? Number.parseInt(arg("idle-ms") as string, 10) : undefined;

if (home === undefined) {
	console.error("需要 --home 或 PONDA_HOME");
	process.exit(1);
}
if (!/^[a-z][a-z0-9-]{0,63}$/.test(env)) {
	console.error(`非法环境名：${env}`);
	process.exit(1);
}

const logFile = arg("log");
if (logFile !== undefined) {
	const fd = openSync(logFile, "a");
	process.stdout.write = ((chunk: string | Uint8Array) => {
		appendFileSync(fd, chunk);
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		appendFileSync(fd, chunk);
		return true;
	}) as typeof process.stderr.write;
}

const core = new DaemonCore({ home, env, idleMs });
core.onExit = (code) => process.exit(code);

process.on("SIGTERM", () => {
	void core.shutdown(0);
});

await core.start();
console.log(`ponda-agent daemon up: env=${env} home=${home} pid=${process.pid}`);
