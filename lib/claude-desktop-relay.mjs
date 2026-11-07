// Claude 桌面端 Code 走 SDK 的 JSONL 协议，不经过用户的 PATH / CLI 启动器。
// 这里是转发脚本的“源”：测试直接导入这些函数；安装时用 relaySource() 把它们连同
// 激活判定、提示词改写一起序列化成一个自包含 .mjs，落到 agent-purge 数据目录。
// 这样转发脚本不依赖 agent-purge 的安装位置（升级/移动/卸载程序都不会让它缺依赖）。
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { resolveActivation } from "./activation.mjs";
import { resolveRuntime, rewriteTexts, stripIdentity } from "./rewrite.mjs";

export const RELAY_KIND = "agent-purge-claude-desktop-v1";

/** 读取当前对 claude-desktop 生效的人设；暂停/未启用/人设缺失/状态损坏一律返回 null（原样转发）。 */
export function desktopPersona(root) {
	try {
		const state = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
		const active = resolveActivation(state, "claude-desktop", { channel: "install" });
		if (!active.on || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(active.persona ?? "")) return null;
		const text = readFileSync(join(root, "personas", active.persona + ".md"), "utf8")
			.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
		return text ? { text, mode: active.mode } : null;
	} catch { return null; }
}

/** 只改写 control_request / initialize 这一帧的提示词字段，其它任何行原样返回。 */
export function rewriteInitialize(line, persona) {
	if (!persona || persona.mode === "off") return line;
	// 先做廉价的子串判断：用户消息可能带几 MB 的图片 base64，不值得逐行 JSON.parse
	if (!line.includes("initialize")) return line;
	try {
		const message = JSON.parse(line);
		const request = message?.request;
		if (message.type !== "control_request" || request?.subtype !== "initialize") return line;
		const host = request.systemPrompt;
		// 未来协议若换成对象等未知形态，宁可不注入也不破坏宿主
		if (host !== undefined && typeof host !== "string" && !(Array.isArray(host) && host.every(s => typeof s === "string"))) return line;
		if (request.appendSystemPrompt !== undefined && typeof request.appendSystemPrompt !== "string") return line;
		if (persona.mode === "append") {
			request.appendSystemPrompt = [request.appendSystemPrompt, persona.text].filter(Boolean).join("\n\n");
		} else {
			// 桌面端用 preset：不带 systemPrompt，运行时自己拼内置默认提示词——转发层看不到默认正文，
			// 所以 replace 与 CLI 的 --system-prompt-file 一样整段换成人设（保留桌面端追加段）；strict 额外去掉追加段
			request.systemPrompt = rewriteTexts(Array.isArray(host) ? host : host ? [host] : [], persona.text, persona.mode);
			if (persona.mode === "strict") delete request.appendSystemPrompt;
		}
		return JSON.stringify(message) + (line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "");
	} catch { return line; }
}

/** 按行切分 stdin 并改写 initialize；处理 UTF-8 分片、最后一行没有换行等情况。 */
export class InitializeTransform extends Transform {
	constructor(getPersona) {
		super(); this.getPersona = getPersona; this.decoder = new StringDecoder("utf8"); this.pending = ""; this.passthrough = false;
	}
	consume(text) {
		this.pending += text;
		let end;
		while ((end = this.pending.indexOf("\n")) >= 0) {
			const line = this.pending.slice(0, end + 1); this.pending = this.pending.slice(end + 1);
			this.push(this.passthrough ? line : rewriteInitialize(line, this.getPersona()));
			this.passthrough = false;
		}
		// 超大的非协议输入直接透传，避免无限缓冲
		if (this.pending.length > 16 * 1024 * 1024) { this.push(this.pending); this.pending = ""; this.passthrough = true; }
	}
	_transform(chunk, _encoding, done) { try { this.consume(this.decoder.write(chunk)); done(); } catch (error) { done(error); } }
	_flush(done) { this.consume(this.decoder.end()); if (this.pending) this.push(this.passthrough ? this.pending : rewriteInitialize(this.pending, this.getPersona())); done(); }
}

/** 转发主流程：拉起原始运行时，stdin 经改写后送入，stdout/stderr 直接继承，退出码原样返回。 */
export function runRelay(manifestFile, parentPid, args) {
	const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
	if (manifest.kind !== "agent-purge-claude-desktop-v1") throw new Error("Invalid desktop bridge manifest");
	const child = spawn(manifest.original, args, { stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
	const streaming = args.some((arg, i) => arg === "--input-format=stream-json" || (arg === "--input-format" && args[i + 1] === "stream-json"));
	// 人设只在 initialize 那一刻读取一次：新会话读新配置，已有会话不受影响
	const input = streaming ? process.stdin.pipe(new InitializeTransform(() => desktopPersona(manifest.root))) : process.stdin;
	input.pipe(child.stdin);
	child.stdin.on("error", error => { if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") console.error(error.message); });
	// 桌面端只会结束入口进程：父进程消失时连带结束原始运行时，避免残留
	const timer = setInterval(() => {
		try { process.kill(parentPid, 0); } catch { child.kill(); }
	}, 1000);
	const stop = () => child.kill();
	process.on("SIGTERM", stop); process.on("SIGINT", stop);
	child.on("error", error => { clearInterval(timer); console.error(`[agent-purge desktop] ${error.message}`); process.exit(1); });
	child.on("exit", (code, signal) => { clearInterval(timer); process.exit(code ?? (signal ? 1 : 0)); });
}

/** 生成自包含的转发脚本源码（只依赖 Node 内置模块）。 */
export function relaySource() {
	return `// agent-purge 托管：Claude 桌面端 Code 转发脚本（自动生成，请勿手改；重新应用会覆盖）
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
${resolveRuntime}
${[stripIdentity, rewriteTexts, desktopPersona, rewriteInitialize, runRelay].map(fn => fn.toString()).join("\n")}
${InitializeTransform.toString()}
try { runRelay(process.argv[2], Number(process.argv[3]), process.argv.slice(4)); }
catch (error) { console.error("[agent-purge desktop] " + error.message); process.exitCode = 1; }
`;
}

// 源码直跑（测试/调试用）：node lib/claude-desktop-relay.mjs <manifest> <parentPid> ...args
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try { runRelay(process.argv[2], Number(process.argv[3]), process.argv.slice(4)); }
	catch (error) { console.error(`[agent-purge desktop] ${error.message}`); process.exitCode = 1; }
}
