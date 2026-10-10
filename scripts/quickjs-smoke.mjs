/**
 * QuickJS 冒烟测试：在 SubStore 真实使用的 QuickJS 引擎里跑构建产物 convert.js，
 * 确保脚本在真机上不会报语法错误、main() 能正常产出配置。
 * 构建目标是 ES2025，而 QuickJS 仅支持到 ES2023 左右，typecheck/lint 抓不住这类问题。
 *
 * 用法: node scripts/quickjs-smoke.mjs
 * 成功返回 0，失败返回 1 并打印原因。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getQuickJS } from "quickjs-emscripten";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const code = readFileSync(join(root, "convert.js"), "utf-8");

const node = (name, extra = {}) => ({
    name,
    type: "ss",
    server: "192.0.2.1",
    port: 8388,
    cipher: "aes-128-gcm",
    password: "test",
    ...extra,
});

/** 模拟订阅：覆盖多地区、低倍率、Tailscale、落地链式四种路径 */
const mockConfig = {
    proxies: [
        node("香港 01"),
        node("HK-02"),
        node("台湾 01"),
        node("日本 01"),
        node("美国 01"),
        node("新加坡 0.2x"), // 命中低倍率匹配
        node("MyTailscale", { type: "tailscale" }),
        node("中转入口"),
        node("落地节点", { "dialer-proxy": "前置代理" }),
    ],
};

const checks = [
    {
        name: "默认参数",
        args: {},
        verify(out) {
            assert(Array.isArray(out["proxy-groups"]) && out["proxy-groups"].length > 0, "proxy-groups 为空");
            assert(Array.isArray(out.rules) && out.rules.length > 0, "rules 为空");
            assert(out["rule-providers"] && typeof out["rule-providers"] === "object", "缺少 rule-providers");
            assert(out["rule-providers"].Muse, "缺少 Muse provider");
            assert(out.rules.some((r) => r.startsWith("RULE-SET,Muse,")), "rules 缺少 RULE-SET,Muse");
            assert(
                out["proxy-groups"].some((g) => g.name === "AI服务"),
                "缺少 AI服务 策略组"
            );
            assert(out.dns && out.dns.enable, "dns 配置异常");
            assert(out["proxy-groups"].some((g) => g.name === "Tailscale"), "Tailscale 节点未生成对应策略组");
        },
    },
    {
        name: "全开参数(grouptype=1,ipv6,tun,regex)",
        args: { grouptype: "1", ipv6: "true", tun: "true", regex: "true", fakeip: "true" },
        verify(out) {
            assert(Array.isArray(out["proxy-groups"]) && out["proxy-groups"].length > 0, "proxy-groups 为空");
            assert(out.tun && out.tun.enable === true, "tun 未启用");
            assert(out.dns && out.dns["enhanced-mode"] === "fake-ip", "fake-ip 模式未生效");
        },
    },
    {
        name: "无 $arguments(未声明变量路径)",
        args: null, // 不声明 $arguments，走 try/catch 回退分支
        verify(out) {
            assert(Array.isArray(out.rules) && out.rules.length > 0, "rules 为空");
        },
    },
];

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

async function runCase(QuickJS, { name, args, verify }) {
    const vm = QuickJS.newContext();
    try {
        const decl =
            args === null
                ? "" // 故意不声明 $arguments
                : `var $arguments = ${JSON.stringify(args)};\n`;
        const harness = `${decl}var __config = ${JSON.stringify(mockConfig)};\n${code}\nJSON.stringify(main(__config));`;
        const result = vm.evalCode(harness);
        if (result.error) {
            const dumped = vm.dump(result.error);
            const msg =
                dumped && typeof dumped === "object" && "message" in dumped
                    ? String(dumped.message)
                    : String(dumped);
            result.error.dispose();
            throw new Error(`QuickJS 执行报错: ${msg}`);
        }
        const out = JSON.parse(String(vm.dump(result.value)));
        result.value.dispose();
        verify(out);
        console.log(`  PASS  ${name}`);
    } finally {
        vm.dispose();
    }
}

const QuickJS = await getQuickJS();
let failed = 0;
console.log("QuickJS 冒烟测试 (convert.js)");
for (const c of checks) {
    try {
        await runCase(QuickJS, c);
    } catch (e) {
        failed++;
        console.log(`  FAIL  ${c.name}: ${e.message}`);
    }
}
if (failed > 0) {
    console.log(`\n${failed} 项未通过`);
    process.exit(1);
}
console.log("\n全部通过");
