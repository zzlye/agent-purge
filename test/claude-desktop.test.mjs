import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopPersona, InitializeTransform, relaySource, rewriteInitialize } from "../lib/claude-desktop-relay.mjs";
import { desktopBinaries, installDesktop, probeDesktop, uninstallDesktop } from "../lib/claude-desktop.mjs";
import { status, uninstall } from "../lib/persist.mjs";

const initialize = (request = {}) => JSON.stringify({ type: "control_request", request_id: "fixture-init", request: { subtype: "initialize", systemPrompt: ["You are Claude.\nKeep tools working."], appendSystemPrompt: "Desktop instructions", hooks: { keep: true }, ...request } }) + "\n";
const persona = { text: "中文测试 PERSONA", mode: "replace" };
test("desktop initialize modes preserve SDK IDs/hooks and respect the append slot", () => {
	const replace = JSON.parse(rewriteInitialize(initialize(), persona));
	assert.equal(replace.request_id, "fixture-init"); assert.deepEqual(replace.request.hooks, { keep: true });
	assert.deepEqual(replace.request.systemPrompt, [persona.text, "Keep tools working."]);
	assert.equal(replace.request.appendSystemPrompt, "Desktop instructions");
	const strict = JSON.parse(rewriteInitialize(initialize(), { ...persona, mode: "strict" }));
	assert.deepEqual(strict.request.systemPrompt, [persona.text]); assert.equal(strict.request.appendSystemPrompt, undefined);
	const append = JSON.parse(rewriteInitialize(initialize(), { ...persona, mode: "append" }));
	assert.deepEqual(append.request.systemPrompt, ["You are Claude.\nKeep tools working."]);
	assert.equal(append.request.appendSystemPrompt, "Desktop instructions\n\n" + persona.text);
	assert.equal(rewriteInitialize(initialize(), { ...persona, mode: "off" }), initialize());
	assert.deepEqual(JSON.parse(rewriteInitialize(initialize({ systemPrompt: [] }), persona)).request.systemPrompt, [persona.text]);
	for (const line of ["broken json\r\n", '{"type":"user","message":{"content":"hi"}}\n', initialize({ systemPrompt: { future: true } })]) assert.equal(rewriteInitialize(line, persona), line);
});

test("desktop JSONL streaming handles split UTF-8, multiple frames and an unterminated last frame", async () => {
	const transform = new InitializeTransform(() => persona), output = [];
	transform.on("data", chunk => output.push(chunk));
	const input = Buffer.from(initialize({ title: "你好" }) + '{"type":"user","message":{"content":"原样"}}');
	for (const byte of input) transform.write(Buffer.from([byte]));
	transform.end(); await new Promise((resolve, reject) => { transform.on("end", resolve); transform.on("error", reject); });
	const lines = Buffer.concat(output).toString().split("\n");
	assert.equal(JSON.parse(lines[0]).request.title, "你好");
	assert.equal(lines[1], '{"type":"user","message":{"content":"原样"}}');
});

function sandbox(t) {
	const root = mkdtempSync(join(tmpdir(), "ap-desktop-"));
	const home = join(root, "Claude"), data = join(root, "data");
	const saved = process.env.CLAUDE_DESKTOP_DATA_DIR;
	process.env.CLAUDE_DESKTOP_DATA_DIR = home;
	mkdirSync(join(data, "personas"), { recursive: true });
	writeFileSync(join(data, "personas", "test.md"), "---\nid: test\n---\n" + persona.text);
	const state = { persona: "test", default: { mode: "replace" }, armed: { "claude-desktop": ["install"] } };
	const save = () => writeFileSync(join(data, "state.json"), JSON.stringify(state)); save();
	t.after(() => { if (saved === undefined) delete process.env.CLAUDE_DESKTOP_DATA_DIR; else process.env.CLAUDE_DESKTOP_DATA_DIR = saved; rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
	return { root, home, data, state, save };
}

test("desktop activation honors pause, overrides, disabled channels and missing persona", t => {
	const s = sandbox(t); assert.deepEqual(desktopPersona(s.data), persona);
	s.state.default.mode = "off"; s.save(); assert.equal(desktopPersona(s.data), null);
	s.state.default.mode = "replace"; s.state.overrides = { "claude-desktop": { mode: "append" } }; s.save();
	assert.equal(desktopPersona(s.data).mode, "append");
	s.state.armed = {}; s.save(); assert.equal(desktopPersona(s.data), null);
	s.state.armed = { "claude-desktop": ["install"] }; s.state.disabledHarnesses = ["claude-desktop"]; s.save(); assert.equal(desktopPersona(s.data), null);
	s.state.disabledHarnesses = []; s.state.persona = "missing"; s.save(); assert.equal(desktopPersona(s.data), null);
	writeFileSync(join(s.data, "state.json"), "{"); assert.equal(desktopPersona(s.data), null);
});

test("Windows bridge: actual executable transport, arguments, pause, reinstall, conflict and byte-exact restore", { skip: process.platform !== "win32" }, t => {
	const s = sandbox(t), file = join(s.home, "claude-code", "2.1.317", "12345678abcd", "claude.exe");
	mkdirSync(dirname(file), { recursive: true });
	const compiler = join(process.env.SystemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
	const source = fileURLToPath(new URL("./fixtures/desktop-protocol.cs", import.meta.url));
	const compile = spawnSync(compiler, ["/nologo", "/reference:System.Web.Extensions.dll", `/out:${file}`, source], { encoding: "utf8", windowsHide: true });
	assert.equal(compile.status, 0, compile.stdout + compile.stderr);
	const original = readFileSync(file);
	assert.deepEqual(desktopBinaries(), [file]);
	installDesktop({ root: s.data }); assert.equal(probeDesktop(s.data), true);
	assert.equal(status(s.data).find(row => row.name === "claude-desktop").installed, true);
	const run = (args, input = "") => spawnSync(file, args, { input, encoding: "utf8", windowsHide: true, timeout: 15000 });
	const version = run(["--version"]);
	assert.equal(version.status, 0, JSON.stringify(version));
	assert.equal(version.stdout.trim(), "fixture 1.0", JSON.stringify(version));
	const args = ["--echo-args", "", 'a"b', "a b", "C:\\space path\\", "中文", "&x%y!"];
	assert.deepEqual(JSON.parse(run(args).stdout), args);
	const result = run(["--input-format", "stream-json"], initialize());
	assert.equal(result.status, 7, result.stderr); assert.equal(result.stderr, "fixture-stderr");
	assert.deepEqual(JSON.parse(result.stdout).request.systemPrompt, [persona.text, "Keep tools working."]);
	s.state.default.mode = "off"; s.save();
	assert.deepEqual(JSON.parse(run(["--input-format=stream-json"], initialize()).stdout), JSON.parse(initialize()));
	installDesktop({ root: s.data }); assert.deepEqual(readFileSync(file + ".agent-purge-original.exe"), original);
	const bridge = readFileSync(file); writeFileSync(file, "external change");
	assert.throws(() => uninstallDesktop({ root: s.data }), /冲突/);
	assert.ok(existsSync(file + ".agent-purge-original.exe")); assert.equal(readFileSync(file, "utf8"), "external change");
	writeFileSync(file, bridge);
	const restored = uninstall("claude-desktop", { root: s.data }); assert.equal(restored.error, undefined);
	assert.deepEqual(readFileSync(file), original); assert.equal(probeDesktop(s.data), false);
	assert.equal(existsSync(file + ".agent-purge.json"), false);
	assert.equal(existsSync(file + ".agent-purge-original.exe"), false);
});

// 编译协议桩程序到指定位置（模拟桌面端缓存里的 claude.exe）
function compileFixture(file) {
	mkdirSync(dirname(file), { recursive: true });
	const compiler = join(process.env.SystemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
	const source = fileURLToPath(new URL("./fixtures/desktop-protocol.cs", import.meta.url));
	const compile = spawnSync(compiler, ["/nologo", "/reference:System.Web.Extensions.dll", `/out:${file}`, source], { encoding: "utf8", windowsHide: true });
	assert.equal(compile.status, 0, compile.stdout + compile.stderr);
	return readFileSync(file);
}

test("生成的转发脚本自包含：只依赖 Node 内置模块，且能被 Node 直接解析", t => {
	const source = relaySource();
	const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map(m => m[1]);
	assert.ok(imports.length > 0);
	for (const name of imports) assert.match(name, /^node:/, `转发脚本不应依赖包内文件：${name}`);
	const dir = mkdtempSync(join(tmpdir(), "ap-relay-src-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "relay.mjs"); writeFileSync(file, source);
	const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8", windowsHide: true });
	assert.equal(check.status, 0, check.stderr);
});

test("桌面端 preset 形态的 initialize（不带 systemPrompt）：replace 只留人设，append 追加到宿主追加段", () => {
	const desktop = JSON.stringify({ type: "control_request", request_id: "d", request: { subtype: "initialize", appendSystemPrompt: "CCD", systemPromptSnapshot: true } }) + "\n";
	assert.deepEqual(JSON.parse(rewriteInitialize(desktop, persona)).request.systemPrompt, [persona.text]);
	assert.equal(JSON.parse(rewriteInitialize(desktop, persona)).request.appendSystemPrompt, "CCD");
	const append = JSON.parse(rewriteInitialize(desktop, { ...persona, mode: "append" })).request;
	// append 不能凭空加 systemPrompt：运行时会把它当成自定义提示词，内置默认提示词就没了
	assert.equal("systemPrompt" in append, false); assert.equal(append.appendSystemPrompt, "CCD\n\n" + persona.text);
	assert.equal(JSON.parse(rewriteInitialize(desktop, { ...persona, mode: "strict" })).request.appendSystemPrompt, undefined);
});

test("失败开放：转发脚本被删后入口直通原程序，桌面端 Code 照常可用", { skip: process.platform !== "win32" }, t => {
	const s = sandbox(t), file = join(s.home, "claude-code", "2.1.317", "12345678abcd", "claude.exe");
	compileFixture(file);
	installDesktop({ root: s.data });
	const manifest = JSON.parse(readFileSync(file + ".agent-purge.json", "utf8"));
	assert.equal(manifest.relay.startsWith(join(s.data, "claude-desktop")), true, "转发脚本应落在数据目录");
	rmSync(manifest.relay);
	assert.equal(probeDesktop(s.data), false, "转发脚本缺失时不能报告已接入");
	const version = spawnSync(file, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 15000 });
	assert.equal(version.status, 0, JSON.stringify(version));
	assert.equal(version.stdout.trim(), "fixture 1.0");
	assert.match(version.stderr, /passthrough/);
	const passthrough = spawnSync(file, ["--input-format", "stream-json"], { input: initialize(), encoding: "utf8", windowsHide: true, timeout: 15000 });
	assert.deepEqual(JSON.parse(passthrough.stdout.trim()), JSON.parse(initialize()), "直通时 initialize 原样到达");
	// 重新应用会补回转发脚本
	installDesktop({ root: s.data }); assert.equal(probeDesktop(s.data), true);
	uninstallDesktop({ root: s.data });
});

test("会话运行中也能卸载：正在运行的入口被挪开，原件按字节还原", { skip: process.platform !== "win32" }, async t => {
	const s = sandbox(t), file = join(s.home, "claude-code", "2.1.317", "12345678abcd", "claude.exe");
	const original = compileFixture(file);
	installDesktop({ root: s.data });
	// 桩程序在 stdin 关闭前一直运行，模拟一个正在进行的 Code 会话
	const running = spawn(file, ["--input-format", "stream-json"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
	running.stdout.resume(); running.stderr.resume();
	await new Promise(resolve => setTimeout(resolve, 1500));
	try {
		uninstallDesktop({ root: s.data });
		assert.deepEqual(readFileSync(file), original);
		assert.equal(existsSync(file + ".agent-purge-original.exe"), false);
	} finally {
		running.stdin.end();
		await new Promise(resolve => running.once("exit", resolve));
	}
	// 会话结束后再次安装会顺手清掉挪开的旧入口
	installDesktop({ root: s.data }); uninstallDesktop({ root: s.data });
	const leftovers = readdirSync(dirname(file)).filter(name => name.includes("agent-purge"));
	assert.deepEqual(leftovers, []);
});
