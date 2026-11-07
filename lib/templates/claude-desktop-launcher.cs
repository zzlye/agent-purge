// agent-purge：Claude 桌面端 Code 运行时入口转发器。
// 桌面端直接启动缓存目录里的 claude.exe；安装后那个位置换成本程序，原文件改名为
// claude.exe.agent-purge-original.exe 保留在同目录。
// 正常路径：本程序 → Node 转发脚本（改写 SDK initialize 的系统提示词）→ 原始运行时。
// 失败开放：清单损坏、Node 或转发脚本缺失、启动失败时，直接透传给原始运行时，
// 保证桌面端 Code 不会因为 agent-purge 被卸载/移动而打不开。
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using System.Threading.Tasks;

[assembly: AssemblyDescription("agent-purge Claude Desktop Code bridge v2")]
class DesktopBridge {
    const string Kind = "agent-purge-claude-desktop-v1";

    // 按 CommandLineToArgvW 规则加引号：处理结尾反斜杠与内嵌双引号
    static string Quote(string value) {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            result.Append(c); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    // 启动子进程，三路标准流全部重定向；启动失败直接抛异常给调用方决定是否回退
    static Process Start(string file, string arguments) {
        var info = new ProcessStartInfo(file, arguments);
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardInput = true;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        return Process.Start(info);
    }

    // 按字节转发（不按行）：保留 UTF-8、JSONL 分帧、stderr 与背压；返回子进程退出码
    static int Pump(Process child) {
        using (child) {
            Task.Run(() => {
                try { Console.OpenStandardInput().CopyTo(child.StandardInput.BaseStream); }
                catch (IOException) { }
                catch (ObjectDisposedException) { }
                finally { try { child.StandardInput.Close(); } catch (Exception) { } }
            });
            var stdout = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
            var stderr = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
            child.WaitForExit();
            try { Task.WaitAll(stdout, stderr); } catch (AggregateException) { }
            return child.ExitCode;
        }
    }

    // 清单里的字符串字段；缺失或类型不对返回 null
    static string Field(Dictionary<string, object> config, string key) {
        object value;
        return config != null && config.TryGetValue(key, out value) ? value as string : null;
    }

    static int Main(string[] args) {
        string self = Assembly.GetExecutingAssembly().Location;
        string manifest = self + ".agent-purge.json";
        string original = self + ".agent-purge-original.exe";
        var forwarded = new StringBuilder();
        foreach (string arg in args) forwarded.Append(" ").Append(Quote(arg));

        // 第一步：读取清单，尽量走 Node 转发脚本
        string node = null, relay = null, reason = null;
        try {
            var config = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(manifest));
            if (Field(config, "kind") != Kind) reason = "invalid bridge manifest";
            else {
                node = Field(config, "node"); relay = Field(config, "relay");
                string configured = Field(config, "original");
                if (!string.IsNullOrEmpty(configured)) original = configured;
                if (string.IsNullOrEmpty(node) || !File.Exists(node)) reason = "node not found: " + node;
                else if (string.IsNullOrEmpty(relay) || !File.Exists(relay)) reason = "relay not found: " + relay;
            }
        } catch (Exception error) {
            reason = "manifest unreadable: " + error.Message;
        }

        if (reason == null) {
            Process child = null;
            try {
                var command = new StringBuilder(Quote(relay));
                command.Append(" ").Append(Quote(manifest)).Append(" ").Append(Process.GetCurrentProcess().Id).Append(forwarded);
                child = Start(node, command.ToString());
            } catch (Exception error) {
                reason = "relay start failed: " + error.Message;
            }
            if (child != null) return Pump(child);
        }

        // 第二步：直通原始运行时（不注入人设，但保证桌面端 Code 照常可用）
        Console.Error.WriteLine("[agent-purge desktop] passthrough (" + reason + ")");
        try {
            return Pump(Start(original, forwarded.ToString().TrimStart()));
        } catch (Exception error) {
            Console.Error.WriteLine("[agent-purge desktop] original runtime failed: " + original + ": " + error.Message);
            return 1;
        }
    }
}
