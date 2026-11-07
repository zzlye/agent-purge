// Claude 桌面端（Windows）本机 Code 接入：替换桌面端缓存目录里的 Code 运行时入口。
//
// 桌面端把 Code 运行时下载到 <数据目录>/claude-code/<版本>/<哈希>/claude.exe，启动时只认
// 同目录的 .verified 标记，不校验 exe 本身的哈希/签名。安装时：
//   1. 原 claude.exe 改名为 claude.exe.agent-purge-original.exe（完整保留，可按字节还原）；
//   2. 原位置放入入口转发器（C# 编译，见 templates/claude-desktop-launcher.cs）；
//   3. 同目录写 claude.exe.agent-purge.json 清单，指向 Node 与数据目录里的自包含转发脚本。
// 每一步都记入数据目录的 claude-desktop/install.json，卸载按记录还原，遇到外部修改就保留现场报告冲突。
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { dataHome } from "./home.mjs";
import { claudeDesktopHomes } from "./paths.mjs";
import { atomicControlJSON } from "./control.mjs";
import { isCompiled, readResource } from "./root.mjs";
import { RELAY_KIND, relaySource } from "./claude-desktop-relay.mjs";

const KIND = RELAY_KIND;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const digest = file => hash(readFileSync(file));
const manifestFor = file => file + ".agent-purge.json";
const originalFor = file => file + ".agent-purge-original.exe";
const bridgeDir = root => join(root, "claude-desktop");
const journalFor = root => join(bridgeDir(root), "install.json");

const IN_USE = new Set(["EPERM", "EBUSY", "EACCES"]);
const ASIDE = /^claude\.exe(?:\.agent-purge-original\.exe)?\.agent-purge-old-\d+\.exe$/;

/**
 * 把文件挪到一边：Windows 不允许覆盖/删除正在运行的 exe，但允许改名。
 * 挪开的文件能删就删，删不掉（仍有会话在跑）就留给下次 sweepAside 清理。
 */
function moveAside(file) {
	const aside = `${file}.agent-purge-old-${Date.now()}${Math.floor(Math.random() * 1000)}.exe`;
	renameSync(file, aside);
	try { rmSync(aside, { force: true }); } catch { /* 仍在运行 */ }
}

/** 清理运行时目录里挪开后没删掉的旧入口文件（会话结束后就能删了） */
function sweepAside(files) {
	for (const dir of new Set(files.map(file => join(file, "..")))) {
		let names = [];
		try { names = readdirSync(dir); } catch { continue; }
		for (const name of names) if (ASIDE.test(name)) try { rmSync(join(dir, name), { force: true }); } catch { /* 仍在运行 */ }
	}
}

/** 先写临时文件再改名：替换过程中桌面端不会读到半个文件；目标正在运行时先挪开再放入 */
function replaceWithCopy(source, file) {
	const temp = file + ".agent-purge-tmp";
	try {
		copyFileSync(source, temp);
		try { renameSync(temp, file); }
		catch (error) {
			if (!IN_USE.has(error.code) || !existsSync(file)) throw error;
			moveAside(file); renameSync(temp, file);
		}
	} finally { rmSync(temp, { force: true }); }
}

/** 用备份原件还原入口：改名而不是复制（原件可能正被会话运行，复制后也删不掉；改名还省掉 300MB 拷贝） */
function restoreOriginal(entry) {
	if (existsSync(entry.file)) moveAside(entry.file);
	renameSync(entry.original, entry.file);
}

/** 只比较小文件的哈希：入口转发器只有几 KB，几百 MB 的原件不必每次探测都算一遍 */
function isBridge(file, bridgeHash) {
	try { return statSync(file).size < 1024 * 1024 && digest(file) === bridgeHash; } catch { return false; }
}
export const desktopInstallFile = (root = dataHome()) => journalFor(root);
function json(file, fallback) {
	try { return JSON.parse(readFileSync(file, "utf8")); }
	catch (error) { if (error.code === "ENOENT") return fallback; throw new Error(`桌面端接入记录无法读取：${file}`, { cause: error }); }
}

/** 只处理桌面端托管的运行时缓存；绝不碰 ~/.local/bin/claude（CLI）或虚拟机里的运行时。 */
export function desktopBinaries(home) {
	if (home === undefined) return [...new Set(claudeDesktopHomes().flatMap(dir => desktopBinaries(dir)))];
	const cache = join(home, "claude-code"), result = [];
	if (!existsSync(cache)) return result;
	for (const version of readdirSync(cache, { withFileTypes: true })) {
		if (!version.isDirectory() || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version.name)) continue;
		const base = join(cache, version.name);
		// 新布局是 <版本>/<哈希>/claude.exe，旧布局直接放在 <版本>/ 下，两种都认
		const dirs = [base, ...readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory() && /^[a-f0-9]{8,64}$/i.test(d.name)).map(d => join(base, d.name))];
		for (const dir of dirs) if (existsSync(join(dir, "claude.exe"))) result.push(join(dir, "claude.exe"));
	}
	return result.sort();
}

/** 隔离验证用的“原始”运行时：已接入的取备份原件，未接入的取本体；按版本号从新到旧挑。 */
export function desktopCaptureBinary(homes = claudeDesktopHomes()) {
	for (const home of homes) {
		const files = desktopBinaries(home).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
		for (const file of files) {
			const manifest = json(manifestFor(file), null);
			if (!manifest) return file;
			if (manifest.kind === KIND && existsSync(originalFor(file))) return originalFor(file);
		}
	}
	return null;
}

/** 找一个可用的 Node（20+）：源码/瘦包直接用当前进程；独立 EXE 去 PATH 上找。 */
export function desktopNode(env = process.env) {
	if (!isCompiled() && /node(?:\.exe)?$/i.test(process.execPath)) return process.execPath;
	const dirs = String(env.PATH || env.Path || "").split(delimiter).filter(Boolean);
	for (const dir of dirs) {
		const file = join(dir, process.platform === "win32" ? "node.exe" : "node");
		if (!existsSync(file)) continue;
		const probe = spawnSync(file, ["-p", "process.versions.node"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
		if (probe.status === 0 && Number(String(probe.stdout).trim().split(".")[0]) >= 20) return file;
	}
	return null;
}

export function desktopBlocked() {
	if (process.platform !== "win32") return "Claude 桌面端 Code 接入目前只支持 Windows；macOS 尚待验证";
	if (!desktopNode()) return "桌面 Code 接入需要 Node.js 20+（装好后重新应用）";
	if (!desktopBinaries().length) return "先在 Claude 桌面端打开一次本机 Code 会话，等待 Code 运行时下载完成";
	return null;
}

export function probeDesktop(root = dataHome()) {
	try {
		const journal = json(journalFor(root), null), binaries = desktopBinaries();
		return Boolean(journal?.kind === KIND && binaries.length && binaries.every(file => {
			const entry = journal.entries.find(e => e.file === file);
			const manifest = entry && json(manifestFor(file), null);
			// 转发脚本或 Node 不见了，入口会自动直通原程序（不注入）：如实报告“未接入”，提示重新应用
			return manifest && existsSync(entry.original) && manifest.root === resolve(root)
				&& existsSync(manifest.relay ?? "") && existsSync(manifest.node ?? "") && isBridge(file, entry.bridgeHash);
		}));
	} catch { return false; }
}

/** 编译入口转发器（按源码哈希缓存，源码不变就复用） */
export function buildDesktopLauncher(root) {
	const source = readResource("lib/templates/claude-desktop-launcher.cs");
	const dir = bridgeDir(root); mkdirSync(dir, { recursive: true });
	const file = join(dir, `launcher-${hash(source).slice(0, 16)}.exe`);
	if (existsSync(file)) return file;
	const compiler = ["Framework64", "Framework"].map(name => join(process.env.SystemRoot || "C:\\Windows", "Microsoft.NET", name, "v4.0.30319", "csc.exe")).find(existsSync);
	if (!compiler) throw new Error("需要 Windows 自带的 .NET Framework 4 C# 编译器（csc.exe）");
	const sourceFile = file + ".cs"; writeFileSync(sourceFile, source);
	const result = spawnSync(compiler, ["/nologo", "/target:exe", "/optimize+", "/reference:System.Web.Extensions.dll", `/out:${file}`, sourceFile], { encoding: "utf8", windowsHide: true });
	rmSync(sourceFile, { force: true });
	if (result.status !== 0) { rmSync(file, { force: true }); throw new Error(`桌面端入口转发器编译失败：${result.error?.message ?? result.stdout + result.stderr}`); }
	return file;
}

/** 把自包含转发脚本写进数据目录（按内容哈希命名，内容不变就复用） */
export function writeDesktopRelay(root) {
	const source = relaySource();
	const dir = bridgeDir(root); mkdirSync(dir, { recursive: true });
	const file = join(dir, `relay-${hash(source).slice(0, 16)}.mjs`);
	if (!existsSync(file) || digest(file) !== hash(source)) writeFileSync(file, source);
	return file;
}

/** 清掉不再被任何清单引用的旧转发脚本/转发器 */
function pruneArtifacts(root, keep) {
	const dir = bridgeDir(root);
	if (!existsSync(dir)) return;
	for (const name of readdirSync(dir)) {
		if (!/^(?:relay-[a-f0-9]{16}\.mjs|launcher-[a-f0-9]{16}\.exe(?:\.cs)?)$/.test(name)) continue;
		const file = join(dir, name);
		if (!keep.has(resolve(file))) rmSync(file, { force: true });
	}
}

/**
 * 安装/重新应用。homes 只给隔离验证用（指定临时桌面数据目录），正常调用扫描本机全部桌面数据目录：
 * 同一台机器可能同时有官方模式（%APPDATA%\Claude）与第三方模式（%LOCALAPPDATA%\Claude-3p）。
 */
export function installDesktop({ root = dataHome(), homes } = {}) {
	if (process.platform !== "win32") throw new Error(desktopBlocked());
	root = resolve(root);
	const node = desktopNode();
	if (!node) throw new Error("桌面 Code 接入需要 Node.js 20+（装好后重新应用）");
	const binaries = homes ? [...new Set(homes.flatMap(home => desktopBinaries(home)))] : desktopBinaries();
	if (!binaries.length) throw new Error("先在 Claude 桌面端打开一次本机 Code 会话，等待 Code 运行时下载完成");
	const launcher = buildDesktopLauncher(root), bridgeHash = digest(launcher);
	const relay = writeDesktopRelay(root);
	const journalFile = journalFor(root), journal = json(journalFile, { kind: KIND, entries: [] });
	if (journal.kind !== KIND || !Array.isArray(journal.entries)) throw new Error("桌面端接入记录格式不对，已停止以免误改运行时");
	sweepAside([...binaries, ...journal.entries.map(e => e.file)]);
	// 先全部预检，再动任何一个可执行文件
	for (const file of binaries) {
		const entry = journal.entries.find(e => e.file === file);
		if (entry) {
			// 允许当前是任一历史版本的转发器（升级转发器时哈希会变），但原件必须完好
			const current = digest(file);
			const known = new Set([entry.bridgeHash, entry.originalHash, ...(entry.previousBridges ?? [])]);
			if (!existsSync(entry.original) || digest(entry.original) !== entry.originalHash || !known.has(current)) throw new Error(`桌面端运行时被外部改动过，已保留备份，请先处理冲突：${file}`);
		} else {
			if (existsSync(manifestFor(file)) || existsSync(originalFor(file))) throw new Error(`发现没有对应记录的旧接入文件，已停止：${file}`);
			if (readFileSync(file).subarray(0, 2).toString() !== "MZ") throw new Error(`不是 Windows 可执行文件：${file}`);
		}
	}
	const installed = [];
	try {
		for (const file of binaries) {
			let entry = journal.entries.find(e => e.file === file);
			if (!entry) {
				// 先记账再改名：中途断电也能从记录里找回原件
				entry = { file, original: originalFor(file), originalHash: digest(file), bridgeHash };
				journal.entries.push(entry);
				atomicControlJSON(journalFile, journal);
				renameSync(file, entry.original);
				installed.push(entry);
			}
			atomicControlJSON(manifestFor(file), { kind: KIND, root, original: entry.original, node, relay });
			if (!existsSync(file) || !isBridge(file, bridgeHash)) replaceWithCopy(launcher, file);
			if (entry.bridgeHash !== bridgeHash) entry.previousBridges = [...new Set([...(entry.previousBridges ?? []), entry.bridgeHash])].slice(-8);
			entry.bridgeHash = bridgeHash; atomicControlJSON(journalFile, journal);
		}
	} catch (error) {
		// 本次新接入的逐个回滚；回滚失败的保留记录和原件，留给下次卸载重试
		for (const entry of installed.reverse()) {
			try {
				if (existsSync(entry.file) && !isBridge(entry.file, entry.bridgeHash)) continue;
				restoreOriginal(entry); rmSync(manifestFor(entry.file), { force: true });
				journal.entries = journal.entries.filter(e => e !== entry);
			} catch { /* 保留记录与原件 */ }
		}
		atomicControlJSON(journalFile, journal); throw error;
	}
	// 桌面端更新后旧版本目录可能已被删掉：记录里清理掉文件已不存在的条目
	journal.entries = journal.entries.filter(e => existsSync(e.file) || existsSync(e.original));
	atomicControlJSON(journalFile, journal);
	pruneArtifacts(root, new Set([resolve(launcher), resolve(relay)]));
	return { file: journalFile, binaries, note: "Claude 桌面端本机 Code 已接入；新建会话读取人设。桌面端更新 Code 运行时后需重新应用；Chat/Cowork/SSH/WSL 不在此通道。" };
}

export function uninstallDesktop({ root = dataHome() } = {}) {
	const file = journalFor(root), journal = json(file, null);
	if (!journal) return { file, restored: [] };
	if (journal.kind !== KIND || !Array.isArray(journal.entries)) throw new Error("桌面端接入记录格式不对，已停止以免误改运行时");
	const restored = [], conflicts = [];
	for (const entry of [...journal.entries]) {
		try {
			const current = existsSync(entry.file) ? digest(entry.file) : null;
			const bridges = new Set([entry.bridgeHash, ...(entry.previousBridges ?? [])]);
			if (!existsSync(entry.original)) {
				if (current && current !== entry.originalHash) throw new Error("原件备份不见了");
			} else {
				if (digest(entry.original) !== entry.originalHash || (current && !bridges.has(current) && current !== entry.originalHash)) throw new Error("文件被 agent-purge 以外的程序改过");
				if (current !== entry.originalHash) restoreOriginal(entry);
				else moveAside(entry.original); // 入口已经是原件：多出来的备份挪开删除（在运行就留给下次清理）
			}
			rmSync(manifestFor(entry.file), { force: true }); restored.push(entry.file);
			journal.entries = journal.entries.filter(e => e !== entry); atomicControlJSON(file, journal);
		} catch (error) { conflicts.push(`${entry.file}: ${error.message}`); }
	}
	sweepAside(restored);
	if (conflicts.length) throw new Error(`桌面端还原有冲突（备份已保留）：${conflicts.join("; ")}`);
	rmSync(file, { force: true });
	pruneArtifacts(root, new Set());
	return { file, restored };
}
