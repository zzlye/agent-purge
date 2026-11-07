// 证据链：跑真二进制 → 本机假 provider → 看它到底把什么发给了模型。
// 这里不信任 harness 的自述、也不信 matrix.json 的常量表，只认抓到的请求体。
import { spawnSync } from "node:child_process";
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnBin, resolveBin } from "./spawn.mjs";
import { isolatedEnv } from "./environment.mjs";
import { isCompiled } from "./root.mjs";
export { isolatedEnv } from "./environment.mjs";
import { inspectRequest, requestKind, startCaptureProvider } from "../bench/capture-provider.mjs";
import { writeVerification } from "../bench/capture-report.mjs";
import { desktopCaptureBinary, installDesktop, uninstallDesktop } from "./claude-desktop.mjs";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "agent-purge.mjs");

// 隔离 HOME 是临时脚手架：证据落在 out/，临时树不能越攒越多。
const ISOLATED_ROOTS = [];
export function trackRoot(root) {
	ISOLATED_ROOTS.push(root);
	return root;
}

export function cleanupRoots() {
	if (process.env.AP_KEEP_ROOTS || process.argv.includes("--keep-roots")) return;
	for (const root of ISOLATED_ROOTS.splice(0)) {
		// 不用 rm -rf：Windows 没有；node 自己的重试删除两边都可靠
		try {
			rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		} catch {
			/* 临时目录删不掉不影响证据 */
		}
	}
}

export function agentCommand(args) { return { cmd: process.execPath, args: isCompiled() ? args : [CLI, ...args] }; }

export function captureOutcome(result, requests, mode) {
	const detail = String(result.error || result.stderr || result.stdout || '').trim().slice(-1800);
	if (result.timedOut) return { status: "error", reason: `执行器超时${detail ? `：${detail}` : ""}` };
	if (result.error || result.code !== 0) return { status: "error", reason: `执行器未正常结束（退出码 ${result.code ?? "未知"}）${detail ? `：${detail}` : ""}` };
	if (!requests.length) return { status: "no-request", reason: "执行器已退出，但没有捕获到主请求；不能据此判断人设是否生效。" };
	const passed = requests.every(request => mode === "off" ? request.markerCount === 0 : request.markerCount === 1);
	return { status: passed ? "captured" : "mismatch", reason: passed ? null : "已捕获主请求，但人设次数与测试模式不符。" };
}

async function prepareCapture(harness, bin, env, cwd, out, timeout) {
	if (harness !== "dsh") return;
	// Single-mode verification used to fail in a fresh HOME: only the first
	// `off` run in the four-mode benchmark happened to initialize this profile.
	const result = await runProcess(bin, ["--profile", "headless", "--dump-config"], { env, cwd, timeout });
	if (out) put(join(out, harness, "prepare.process.json"), result);
	if (result.error || result.timedOut || result.code !== 0)
		throw new Error("无法初始化隔离 DSH headless profile：" + (result.error || result.stderr || `exit ${result.code}`));
}

export function runProcess(cmd, args, { env, cwd, timeout = 35000, input } = {}) {
	return new Promise((done) => {
		let child;
		try {
			child = spawnBin(cmd, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
		} catch (e) {
			done({ code: null, error: e.message, stdout: "", stderr: "" });
			return;
		}
		let stdout = "",
			stderr = "",
			timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
			else child.kill("SIGKILL");
		}, timeout);
		child.stdout.on("data", (b) => (stdout = (stdout + b).slice(-100000)));
		child.stderr.on("data", (b) => (stderr = (stderr + b).slice(-100000)));
		child.on("error", (e) => {
			clearTimeout(timer);
			done({ code: null, error: e.message, stdout, stderr });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			done({ code, timedOut, stdout, stderr });
		});
		child.stdin.end(input);
	});
}

export function put(file, content) {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
}

export function seed(env, harness, mode, body) {
	const root = env.AGENT_PURGE_HOME;
	put(join(root, "personas", "capture-a.md"), body);
	put(join(root, "personas", "active.md"), body);
	put(join(root, "state.json"), { v: 1, persona: "capture-a", default: { harness, mode }, armed: {}, piAuto: false, ompAuto: false });
}

export function configure(h, env, url, cwd) {
	// 常规代理变量也被同一个 loopback 服务器接住，避免子进程偷偷走真网络。
	Object.assign(env, {
		HTTP_PROXY: url,
		HTTPS_PROXY: url,
		ALL_PROXY: url,
		NO_PROXY: "127.0.0.1,localhost",
		ANTHROPIC_BASE_URL: url,
		ANTHROPIC_API_KEY: "capture-fixture-key",
		OPENAI_BASE_URL: url + "/v1",
		OPENAI_API_KEY: "capture-fixture-key",
	});
	const model = {
		id: "capture",
		name: "Capture fixture",
		reasoning: false,
		input: ["text"],
		contextWindow: 128000,
		maxTokens: 2048,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const providers = { capture: { baseUrl: url + "/v1", api: "openai-completions", apiKey: "capture-fixture-key", models: [model] } };
	if (h === "pi") {
		put(join(env.PI_CODING_AGENT_DIR, "models.json"), { providers });
		put(join(env.PI_CODING_AGENT_DIR, "settings.json"), { packages: [], mcp: { servers: {} } });
		return ["--provider", "capture", "--model", "capture", "--no-mcp", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-session"];
	}
	if (h === "omp") {
		env.PI_CODING_AGENT_DIR = join(env.OMP_HOME, "agent");
		put(join(env.PI_CODING_AGENT_DIR, "models.yml"), JSON.stringify({ providers }));
		return ["--provider", "capture", "--model", "capture", "--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-title", "--no-session"];
	}
	if (h === "claude") return ["--model", "claude-sonnet-4-5", "--max-turns", "1", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence", "--setting-sources", ""];
	if (h === "codex") {
		put(
			join(env.CODEX_HOME, "config.toml"),
			`model = "gpt-5.4"\nmodel_provider = "capture"\n[model_providers.capture]\nname = "Capture"\nbase_url = "${url}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`,
		);
		return ["--skip-git-repo-check", "--ephemeral"];
	}
	if (h === "opencode") {
		put(join(cwd, "opencode.json"), {
			model: "capture/capture",
			small_model: "capture/capture",
			provider: { capture: { npm: "@ai-sdk/openai-compatible", options: { baseURL: url + "/v1", apiKey: "capture-fixture-key" }, models: { capture: { name: "Capture", limit: { context: 128000, output: 2048 } } } } },
		});
		return ["--model", "capture/capture"];
	}
	if (h === "kilo") {
		put(join(cwd, "kilo.json"), {
			model: "capture/capture",
			provider: { capture: { npm: "@ai-sdk/openai-compatible", options: { baseURL: url + "/v1", apiKey: "capture-fixture-key" }, models: { capture: { name: "Capture" } } } },
		});
		return ["--model", "capture/capture", "--format", "json"];
	}
	if (h === "dsh") {
		Object.assign(env, { DEEPSEEK_BASE_URL: url, DEEPSEEK_API_KEY: "capture-fixture-key", DSH_TELEMETRY_MODE: "DISABLED", DSH_TELEMETRY_OTLP_URL: url + "/telemetry" });
		return [];
	}
	if (h === "codebuddy") {
		Object.assign(env, {
			CODEBUDDY_BASE_URL: url,
			CODEBUDDY_API_KEY: "capture-fixture-key",
			CODEBUDDY_MODEL: "capture",
			CODEBUDDY_SMALL_FAST_MODEL: "capture",
			CODEBUDDY_BIG_SLOW_MODEL: "capture",
		});
		return ["--model", "capture", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence", "--setting-sources", ""];
	}
	if (h === "grok") {
		Object.assign(env, { XAI_API_KEY: "capture-fixture-key", GROK_XAI_API_BASE_URL: url + "/v1", GROK_MODELS_BASE_URL: url + "/v1", GROK_DISABLE_AUTOUPDATER: "1" });
		put(
			join(env.GROK_HOME, "config.toml"),
			`[model.capture]\nmodel = "capture"\nbase_url = "${url}/v1"\nenv_key = "XAI_API_KEY"\napi_backend = "chat_completions"\n[models]\ndefault = "capture"\n`,
		);
		return ["--model", "capture", "--max-turns", "1", "--disable-web-search", "--no-subagents"];
	}
	if (h === "opencode2") {
		put(join(cwd, "opencode.json"), {
			model: "capture/capture",
			providers: { capture: { package: "aisdk:@ai-sdk/openai-compatible", settings: { baseURL: url + "/v1", apiKey: "capture-fixture-key" }, models: { capture: { name: "Capture" } } } },
		});
		return ["--standalone", "--model", "capture/capture"];
	}
	return null;
}



// ---- Claude 桌面端：没有命令行入口，按桌面端自己的 SDK 协议抓包 ----
const DESKTOP = "claude-desktop";
const DESKTOP_QUERY = "Reply CAPTURE_OK.";
// 与桌面端一致的 SDK 启动参数（流式 JSONL 输入输出），外加隔离用的开关
const DESKTOP_ARGS = ["--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--await-initialize",
	"--model", "claude-sonnet-4-5", "--max-turns", "1", "--no-session-persistence", "--setting-sources", "",
	"--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--tools", ""];
// 桌面端 Code 会话的 initialize 形态（preset）：不带 systemPrompt（运行时用内置默认提示词）+ 桌面端自己的追加段。
// 注意不能发 systemPrompt: [""]——运行时会把它当成“空的自定义提示词”，默认提示词就没了，与真实桌面端不符。
const DESKTOP_HOST_APPEND = "Desktop host append (capture fixture).";
export function desktopInput(query = DESKTOP_QUERY) {
	return JSON.stringify({ type: "control_request", request_id: "ap-capture-init", request: { subtype: "initialize", appendSystemPrompt: DESKTOP_HOST_APPEND, systemPromptSnapshot: false } }) + "\n"
		+ JSON.stringify({ type: "user", message: { role: "user", content: query }, session_id: "", parent_tool_use_id: null }) + "\n";
}

/**
 * 把真实运行时放进临时“桌面数据目录”：同盘优先硬链接（瞬间完成、不占空间），跨盘再复制。
 * 安装只会改名临时目录里的链接，不会动到桌面端正在用的原文件。
 */
function stageDesktopRuntime(source, home) {
	// 运行时路径是 <版本>/<哈希>/claude.exe(.agent-purge-original.exe) 或旧布局 <版本>/claude.exe
	const semver = /^\d+\.\d+\.\d+/;
	const version = [basename(dirname(dirname(source))), basename(dirname(source))].find(name => semver.test(name)) ?? "0.0.0";
	const file = join(home, "claude-code", version, "0000ca7e", "claude.exe");
	mkdirSync(dirname(file), { recursive: true });
	try { linkSync(source, file); } catch { copyFileSync(source, file); }
	return file;
}

/** 桌面端隔离抓包：临时 HOME + 临时桌面目录 + 测试人设 + 本地假 provider；不碰当前桌面会话与真实运行时。 */
async function captureDesktop({ out, modes, timeout = 60000 }) {
	const source = desktopCaptureBinary();
	if (!source) return { harness: DESKTOP, status: "missing", reason: "Executable not found", modes: [] };
	const root = trackRoot(mkdtempSync(join(tmpdir(), "ap-capture-claude-desktop-")));
	const env = isolatedEnv(root);
	const cwd = join(root, "work");
	mkdirSync(cwd);
	const data = env.AGENT_PURGE_HOME;
	const scope = { kind: "isolated-desktop-runtime", profile: null, syntheticPersona: true, currentSession: false };
	let bin;
	try {
		bin = stageDesktopRuntime(source, join(root, "desktop"));
		installDesktop({ root: data, homes: [join(root, "desktop")] });
	} catch (e) {
		return { harness: DESKTOP, executable: source, version: "", scope, status: "error", reason: `无法准备隔离的桌面端运行时：${e.message}`, modes: [] };
	}
	const provider = await startCaptureProvider(join(out ?? root, DESKTOP, "requests"));
	try {
		configure("claude", env, provider.url, cwd);
		Object.assign(env, { CLAUDE_CODE_ENTRYPOINT: "claude-desktop", CLAUDE_CODE_ENABLE_TELEMETRY: "0" });
		const version = await runProcess(bin, ["--version"], { env, cwd, timeout: 15000 });
		const report = { harness: DESKTOP, executable: source, version: version.stdout.trim(), scope, modes: [] };
		for (const mode of modes) {
			const marker = `AP_CAPTURE_${DESKTOP}_${mode}_${randomUUID()}`;
			put(join(data, "personas", "capture-a.md"), `Capture-only neutral persona. Marker: ${marker}. Reply briefly.`);
			// 桌面端只认“常驻配置”通道：state 里要把 claude-desktop 的 install 标为已启用
			put(join(data, "state.json"), { v: 1, persona: "capture-a", default: { harness: DESKTOP, mode }, armed: { [DESKTOP]: ["install"] } });
			const start = provider.captures.length;
			const result = await runProcess(bin, DESKTOP_ARGS, { env, cwd, timeout, input: desktopInput() });
			const processFile = join(out ?? root, DESKTOP, mode + ".process.json");
			put(processFile, result);
			const analyses = provider.captures.slice(start).map((r) => ({ id: r.id, protocol: r.protocol, kind: requestKind(r.body, DESKTOP_QUERY), ...inspectRequest(r.body, marker) }));
			const checks = analyses.filter((a) => a.kind === "main");
			const hit = checks.find((a) => a.markerCount > 0);
			report.modes.push({
				mode, ...captureOutcome(result, checks, mode), processFile, exitCode: result.code, timedOut: result.timedOut, marker,
				injected: { sys: Boolean(hit), user: checks.some(request => request.userMarkerCount > 0) },
				chars: hit?.chars ?? 0, head: (hit?.text ?? "").slice(0, 200),
				requests: analyses.map(({ text: _text, ...a }) => a),
			});
		}
		report.status = report.modes.every((r) => r.status === "captured") ? "captured" : modes.length === 1 ? report.modes[0].status : "partial";
		report.reason = modes.length === 1 ? report.modes[0].reason ?? null : null;
		return report;
	} finally {
		await provider.close();
		try { uninstallDesktop({ root: data }); } catch { /* 临时目录随后整体删除 */ }
	}
}

/** 一次抓包：装好种子人设 → 跑一条真请求 → 分析请求体里的 marker 落在哪一层。 */
export async function captureMode(h, { out, mode = "replace", timeout = 45000 } = {}) {
	if (h === DESKTOP) {
		// 桌面端没有命令行入口：按桌面端的 SDK 协议在临时目录里跑真实运行时
		const report = await captureDesktop({ out, modes: [mode], timeout });
		const one = report.modes[0] ?? {};
		return { ...report, ...one, mode, status: report.status, reason: report.reason ?? one.reason ?? null };
	}
	const bin = resolveBin(h);
	if (!bin) return { harness: h, mode, status: "missing", reason: "Executable not found" };
	const root = trackRoot(mkdtempSync(join(tmpdir(), `ap-capture-${h}-`)));
	const env = isolatedEnv(root);
	const cwd = join(root, "work");
	mkdirSync(cwd);
	env.AGENT_PURGE_REAL_BIN = bin;
	const version = await runProcess(bin, ["--version"], { env, cwd, timeout: 12000 });
	const base = { harness: h, mode, executable: bin, version: version.stdout.trim(),
		scope: { kind: "isolated-cli", profile: h === "dsh" ? "headless" : null, syntheticPersona: true, currentSession: false } };
	if (h === "hermes") return { ...base, status: "blocked", reason: (version.stderr || version.stdout).trim() || "No isolated provider adapter" };

	const provider = await startCaptureProvider(join(out ?? root, h, "requests"));
	let flags;
	try {
		flags = configure(h, env, provider.url, cwd);
		if (flags) await prepareCapture(h, bin, env, cwd, out, timeout);
	} catch (e) {
		await provider.close();
		return { ...base, status: "error", reason: e.message };
	}
	if (!flags) {
		await provider.close();
		return { ...base, status: "blocked", reason: "Provider/isolation adapter not yet verified for this executable" };
	}
	try {
		const marker = `AP_CAPTURE_${h}_${mode}_${randomUUID()}`;
		const body = `Capture-only neutral persona. Marker: ${marker}. Reply briefly.`;
		seed(env, h, mode, body);
		const start = provider.captures.length;
		const command = agentCommand([h, "--ask", "Reply CAPTURE_OK.", "--", ...flags]);
		const result = await runProcess(command.cmd, command.args, { env, cwd, timeout });
		const processFile = join(out ?? root, h, mode + ".process.json");
		put(processFile, result);
		const analyses = provider.captures.slice(start).map((r) => ({ id: r.id, protocol: r.protocol, kind: requestKind(r.body), ...inspectRequest(r.body, marker) }));
		// 未知/辅助请求仍是证据，但不能替代主回合。
		const checks = analyses.filter((a) => a.kind === "main");
		const hit = checks.find((a) => a.markerCount > 0);
		return {
			...base,
			...captureOutcome(result, checks, mode),
			processFile,
			exitCode: result.code,
			timedOut: result.timedOut,
			marker,
			// 注入层：inspectRequest 的 text/markerCount 只算特权角色（system/developer），
			// 用户消息里的命中由 userMarkerCount 单独给，两个合起来才是「注到哪层」。
			injected: { sys: Boolean(hit), user: checks.some(request => request.userMarkerCount > 0) },
			chars: hit?.chars ?? 0,
			head: (hit?.text ?? "").slice(0, 200),
			requests: analyses.map(({ text: _text, ...a }) => a),
		};
	} finally {
		await provider.close();
	}
}

/** verify：只抓「当前模式」一次，写 web 读的那份 verification/latest.json。
 * 不写原始提示词文本（那是本地抓包目录的事）：摘要只有角色、字数、marker 命中数。 */
export async function verifyHarnesses(harnesses, { root, timeout, mode = "replace" } = {}) {
	const at = new Date().toISOString();
	const out = join(root, "verification", at.replace(/[:.]/g, "-"));
	const report = {
		schema: 1,
		at,
		kind: "loopback-real-binary",
		out,
		limitations: ["只证明请求体里有人设：不代表模型行为质量", "loopback 假 provider 不是 OS 级网络沙箱"],
		harnesses: [],
	};
	for (const h of harnesses) {
		let r;
		try {
			r = await captureMode(h, { out, mode, timeout });
		} catch (e) {
			r = { harness: h, status: "error", reason: e.message };
		}
		report.harnesses.push({
			harness: h,
			executable: r.executable ?? null,
			version: r.version ?? "",
			scope: r.scope ?? null,
			processFile: r.processFile ?? null,
			status: r.status,
			reason: r.reason ?? null,
			modes: r.requests
				? [{ mode: r.mode, status: r.status, exitCode: r.exitCode, timedOut: r.timedOut, marker: r.marker, injected: r.injected, chars: r.chars, requests: r.requests }]
				: [],
			hotSwitch: { status: "not-tested" },
		});
	}
	writeVerification(join(root, "verification", "latest.json"), report);
	return report;
}

export async function captureHarness(h, out) {
	if (h === DESKTOP) {
		// 四模式基准：同样走桌面端 SDK 协议
		const report = await captureDesktop({ out, modes: ["off", "strict", "replace", "append"], timeout: 60000 });
		report.hotSwitch = { status: "not-tested", reason: "Startup capture does not prove same-session switching" };
		for (const m of report.modes) console.log(`${h} ${m.mode}: ${m.status} (exit ${m.exitCode})`);
		return report;
	}
	const bin = resolveBin(h);
	if (!bin) return { harness: h, status: "unavailable", reason: "Executable not found" };
	const root = trackRoot(mkdtempSync(join(tmpdir(), `ap-capture-${h}-`)));
	const env = isolatedEnv(root);
	const cwd = join(root, "work");
	mkdirSync(cwd);
	env.AGENT_PURGE_REAL_BIN = bin;
	const version = await runProcess(bin, ["--version"], { env, cwd, timeout: 12000 });
	put(join(out, h, "version.json"), version);
	const report = { harness: h, executable: bin, version: version.stdout.trim(), isolation: root,
		scope: { kind: "isolated-cli", profile: h === "dsh" ? "headless" : null, syntheticPersona: true, currentSession: false },
		modes: [], hotSwitch: { status: "not-tested", reason: "Startup capture does not prove same-session switching" } };
	if (h === "hermes") {
		report.status = "blocked";
		report.reason = (version.stderr || version.stdout).trim() || "No isolated provider adapter";
		return report;
	}
	const provider = await startCaptureProvider(join(out, h, "requests"));
	const flags = configure(h, env, provider.url, cwd);
	if (!flags) {
		await provider.close();
		return { ...report, status: "blocked", reason: "Provider/isolation adapter not yet verified for this executable" };
	}
	try {
		await prepareCapture(h, bin, env, cwd, out, 35000);
		for (const mode of ["off", "strict", "replace", "append"]) {
			const marker = `AP_CAPTURE_${h}_${mode}_${randomUUID()}`;
			const body = `Capture-only neutral persona. Marker: ${marker}. Reply briefly.`;
			seed(env, h, mode, body);
			const start = provider.captures.length;
			const command = agentCommand([h, "--ask", "Reply CAPTURE_OK.", "--", ...flags]);
			const result = await runProcess(command.cmd, command.args, { env, cwd });
			put(join(out, h, mode + ".process.json"), result);
			const requests = provider.captures.slice(start);
			const analyses = requests.map((r) => ({ id: r.id, protocol: r.protocol, kind: requestKind(r.body), ...inspectRequest(r.body, marker) }));
			const checks = analyses.filter((a) => a.kind === "main");
			report.modes.push({ mode, ...captureOutcome(result, checks, mode), exitCode: result.code, timedOut: result.timedOut, marker, requests: analyses.map(({ text: _text, ...a }) => a) });
			console.log(`${h} ${mode}: ${report.modes.at(-1).status} (${checks.length} request, exit ${result.code})`);
		}
		report.status = report.modes.every((r) => r.status === "captured") ? "captured" : "partial";
		return report;
	} finally {
		await provider.close();
	}
}
