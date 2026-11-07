// 配置落点只在这里解释。XDG_CONFIG_HOME 是配置根，PI_CODING_AGENT_DIR 是 agent 目录。
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export function userHome() {
	return process.env.USERPROFILE || process.env.HOME || homedir();
}
export function claudeDesktopHomes(env = process.env, platform = process.platform) {
	const explicit = env.CLAUDE_DESKTOP_DATA_DIR || env.CLAUDE_USER_DATA_DIR;
	if (explicit) return [resolve(explicit)];
	const home = env.USERPROFILE || env.HOME || homedir();
	if (platform === "win32") return [
		join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "Claude-3p"),
		join(env.APPDATA || join(home, "AppData", "Roaming"), "Claude"),
	];
	return [platform === "darwin" ? join(home, "Library", "Application Support", "Claude") : join(env.XDG_CONFIG_HOME || join(home, ".config"), "Claude")];
}
export function configHome(id) {
	const home = userHome();
	const env = process.env;
	const roots = {
		pi: env.PI_CODING_AGENT_DIR || env.PI_HOME || join(home, ".pi", "agent"),
		omp: env.OMP_HOME || join(home, ".omp"),
		codex: env.CODEX_HOME || join(home, ".codex"),
		claude: env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
		"claude-desktop": claudeDesktopHomes().find(existsSync) || claudeDesktopHomes().at(-1),
		codebuddy: env.CODEBUDDY_HOME || join(home, ".codebuddy"),
		grok: env.GROK_HOME || join(home, ".grok"),
		dsh: env.DSH_HOME || join(home, ".dsh"),
		zcode: env.ZCODE_HOME || join(home, ".zcode"),
		hermes: env.HERMES_HOME || (process.platform === "win32" ? join(home, "AppData", "Local", "hermes") : join(home, ".hermes")),
		opencode: join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode"),
		kilo: env.KILO_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "kilo"),
	};
	const root = roots[id === "opencode2" ? "opencode" : id];
	return root ? resolve(root) : null;
}
