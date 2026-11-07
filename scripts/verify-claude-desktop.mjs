// 可选的真实运行时验证：用本机 Claude 桌面端缓存的 Code 运行时，在临时目录里装好转发器，
// 按桌面端的 SDK 协议跑 off/strict/replace/append 四种模式，请求只发往本机假 provider。
// 不修改桌面端正在用的运行时，也不使用真实凭据。
// 用法：node scripts/verify-claude-desktop.mjs [输出目录]
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureHarness, cleanupRoots } from "../lib/capture.mjs";

if (process.platform !== "win32") throw new Error("只支持 Windows");
const out = process.argv[2] || join(tmpdir(), `ap-desktop-verify-${Date.now()}`);
try {
	const report = await captureHarness("claude-desktop", out);
	console.log(JSON.stringify({ version: report.version, executable: report.executable, status: report.status, reason: report.reason ?? null }));
	assert.equal(report.status, "captured", report.reason ?? JSON.stringify(report.modes.map(m => [m.mode, m.status, m.reason])));
	for (const mode of report.modes) {
		// off 不得出现人设；其余三种模式人设必须恰好出现一次，且在 system 层
		assert.equal(mode.injected.sys, mode.mode !== "off", mode.mode);
		assert.equal(mode.injected.user, false, `${mode.mode}: 人设不应落到用户消息里`);
	}
	console.log(`四种模式全部通过；抓包与进程记录在 ${out}`);
} finally {
	cleanupRoots();
}
