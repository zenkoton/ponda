/** `ponda wiki`：wiki 知识库操作（design: 08-wiki.md；M9 余项 CLI） */
import { buildIndex, buildWiki, listPages, readPage, refreshWiki, searchWiki } from "../../../core/src/wiki.ts";
import { c } from "../ui.ts";

export async function runWiki(
	workspace: string,
	action: string,
	args: string[],
	flags: Map<string, string | boolean>,
	json: boolean,
): Promise<number> {
	switch (action) {
		case "build": {
			const r = buildWiki(workspace);
			if (json) {
				console.log(JSON.stringify(r));
				return 0;
			}
			console.log(c.green("✓"), `wiki 骨架已创建：${r.created.join(", ") || "(已存在)"}`);
			console.log(c.dim(`  目录：${workspace}/.wiki/`));
			return 0;
		}

		case "search": {
			const query = args.join(" ");
			if (query.length === 0) {
				console.error("用法：ponda wiki search <关键词>");
				return 1;
			}
			const pages = listPages(workspace);
			if (pages.length === 0) {
				console.log(c.dim("无 wiki 页面（ponda wiki build 初始化）"));
				return 0;
			}
			const hits = searchWiki(buildIndex(pages), query);
			if (json) {
				console.log(JSON.stringify(hits));
				return 0;
			}
			if (hits.length === 0) {
				console.log(c.dim(`无命中："${query}"`));
				return 0;
			}
			for (const h of hits) {
				console.log(`  ${c.bold(h.rel)}  ${h.title} ${c.dim(`(score ${h.score})`)}`);
			}
			return 0;
		}

		case "read": {
			const page = args[0];
			if (page === undefined) {
				const pages = listPages(workspace);
				if (json) {
					console.log(JSON.stringify(pages.map((p) => p.rel)));
				} else {
					for (const p of pages) console.log(`  ${p.rel}  ${p.frontmatter.title}`);
				}
				return 0;
			}
			const content = readPage(workspace, page);
			if (content === null) {
				console.error(`页面不存在：${page}`);
				return 2;
			}
			console.log(content.body);
			return 0;
		}

		case "refresh": {
			const r = refreshWiki(workspace, { supplier: () => null });
			if (json) {
				console.log(JSON.stringify(r));
				return 0;
			}
			console.log(
				c.green("✓"),
				`复验 ${r.reviewed.length} 页${r.refreshed.length > 0 ? `，刷新 ${r.refreshed.length} 页` : ""}`,
			);
			return 0;
		}

		default:
			console.error("可用动作：build | search <关键词> | read [page] | refresh [--workspace <dir>]");
			return 1;
	}
}
