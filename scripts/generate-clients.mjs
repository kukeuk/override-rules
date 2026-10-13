#!/usr/bin/env node
/**
 * 为 Loon / Quantumult X 生成分流配置。
 *
 * 单一数据源：ruleset/*.list（mihomo 文本格式）+ 本文件内的映射表。
 * 以后加域名/调策略：改 ruleset/*.list 或映射表，然后跑
 *   node scripts/generate-clients.mjs
 * 即可重新产出全部产物。产物全部提交到仓库，走 jsDelivr 分发。
 *
 * 产物：
 *   ruleset/*.loon.list / *.qx.list   各自定义规则集的 Loon / QX 版
 *   ruleset/{SogouInput,StaticResources,CDNResources,GFWList}.{loon,qx}.list
 *   clients/loon.conf / clients/qx.conf  完整可导入配置（含策略组+规则）
 *
 * 注意：Loon / QX 不支持 GEOSITE，映射表中用 blackmatrix7 的同名规则集代替；
 * Loon / QX 的 [Remote Rule]/[filter_remote] 先于 [Rule]/[filter_local] 求值，
 * 映射表已按 mihomo 规则顺序排列，语义一致。
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RULESET_DIR = join(ROOT, "ruleset");
const CLIENTS_DIR = join(ROOT, "clients");
const CDN = "https://cdn.jsdelivr.net/gh/kukeuk/override-rules@master";
const RAW = "https://raw.githubusercontent.com/kukeuk/override-rules/master";
const BM = "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule";
const ICON_CDN = "https://cdn.jsdelivr.net";

// ---- 从 src/constants.ts 解析国家/地区元数据（名称、正则、图标、权重） ----
function parseCountries() {
    const src = readFileSync(join(ROOT, "src/constants.ts"), "utf8");
    const start = src.indexOf("export const countriesMeta");
    const end = src.indexOf("\n};", start);
    const block = src.slice(start, end);
    const parts = block.split(/^ {4}(\S+): \{$/m);
    const list = [];
    for (let i = 1; i + 1 < parts.length; i += 2) {
        const name = parts[i];
        const body = parts[i + 1];
        const patM = body.match(/pattern:\s*\n?\s*"((?:[^"\\]|\\.)*)"/);
        if (!patM) continue;
        const iconM = body.match(/icon:\s*`([^`]+)`/);
        const weightM = body.match(/weight:\s*(\d+)/);
        list.push({
            name,
            group: `${name}节点`,
            filter: `Sub-${name}`,
            pattern: patM[1].replace(/\\\\/g, "\\"),
            icon: iconM ? iconM[1].replace("${CDN_URL}", ICON_CDN) : "",
            weight: weightM ? parseInt(weightM[1], 10) : 999,
        });
    }
    list.sort((a, b) => a.weight - b.weight);
    return list;
}
const COUNTRIES = parseCountries();
const OFFLINE = process.argv.includes("--offline");
const SPEEDTEST_URL = "http://www.gstatic.com/generate_204";

const GEN_HEADER = `# 由 scripts/generate-clients.mjs 生成，请勿手改；改上游后重新跑脚本`;

// ---------------------------------------------------------------- 列表转换

/** 规范化：裸域名（无类型前缀）视为 DOMAIN-SUFFIX */
function normalize(lines) {
    return lines.map((line) => {
        const t = line.trim();
        if (!t || t.startsWith("#") || t.includes(",")) return line;
        // 纯 IP / CIDR
        if (/^[\d.:a-fA-F]+\/\d+$/.test(t)) return `IP-CIDR,${t}`;
        if (/^[\d.]+$/.test(t)) return `IP-CIDR,${t}/32`;
        return `DOMAIN-SUFFIX,${t}`;
    });
}

/** mihomo 文本规则 -> Loon(Surge) 格式：基本原样透传 */
function toLoon(lines) {
    return normalize(lines);
}

/** mihomo 文本规则 -> Quantumult X filter 格式 */
function toQx(lines) {
    const out = [];
    for (const line of normalize(lines)) {
        const t = line.trim();
        if (!t || t.startsWith("#")) {
            out.push(line);
            continue;
        }
        const [type, ...rest] = t.split(",");
        const v = rest.join(",").trim();
        const value = v.split(",")[0].trim(); // 去掉 no-resolve 等后缀
        switch (type.trim().toUpperCase()) {
            case "DOMAIN":
                out.push(`host, ${value}`);
                break;
            case "DOMAIN-SUFFIX":
                out.push(`host-suffix, ${value}`);
                break;
            case "DOMAIN-KEYWORD":
                out.push(`host-keyword, ${value}`);
                break;
            case "DOMAIN-REGEX":
                console.warn(`  [跳过] QX 不支持: ${t}`);
                break;
            case "IP-CIDR":
                out.push(`ip-cidr, ${value}`);
                break;
            case "IP-CIDR6":
                out.push(`ip6-cidr, ${value}`);
                break;
            case "USER-AGENT":
                out.push(`user-agent, ${value}`);
                break;
            default:
                console.warn(`  [跳过] 未知类型: ${t}`);
        }
    }
    return out;
}

function convertLocalLists() {
    console.log("== 转换本地 ruleset/*.list ==");
    const files = readdirSync(RULESET_DIR).filter(
        (f) => f.endsWith(".list") && !f.endsWith(".loon.list") && !f.endsWith(".qx.list")
    );
    for (const f of files) {
        const name = basename(f, ".list");
        const lines = readFileSync(join(RULESET_DIR, f), "utf8").split("\n");
        writeFileSync(
            join(RULESET_DIR, `${name}.loon.list`),
            [GEN_HEADER, `# 上游：ruleset/${f}`, ...toLoon(lines)].join("\n")
        );
        writeFileSync(
            join(RULESET_DIR, `${name}.qx.list`),
            [GEN_HEADER, `# 上游：ruleset/${f}`, ...toQx(lines)].join("\n")
        );
        console.log(`  ${f} -> ${name}.loon.list / ${name}.qx.list`);
    }
}

// ------------------------------------------------------------ 外部源抓取转换

const EXTERNAL = [
    {
        name: "SogouInput",
        url: "https://ruleset.skk.moe/Clash/non_ip/sogouinput.txt",
        kind: "text",
    },
    {
        name: "StaticResources",
        url: "https://ruleset.skk.moe/Clash/domainset/cdn.txt",
        kind: "text",
    },
    {
        name: "CDNResources",
        url: "https://ruleset.skk.moe/Clash/non_ip/cdn.txt",
        kind: "text",
    },
    {
        name: "GFWList",
        url: "https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/gfw.txt",
        kind: "yaml-payload",
    },
];

/** 从 yaml payload 提取规则行；顺手把 Loyalsoldier 的 '+.域名' 记法转成 DOMAIN-SUFFIX */
function fromYamlPayload(text) {
    const lines = [];
    let inPayload = false;
    for (const raw of text.split("\n")) {
        const t = raw.trim();
        if (t === "payload:") {
            inPayload = true;
            continue;
        }
        if (inPayload && t.startsWith("- ")) {
            let item = t.slice(2).trim();
            // 去掉单引号
            if (item.startsWith("'") && item.endsWith("'")) item = item.slice(1, -1);
            // '+.example.com' 是 DOMAIN-SUFFIX 的缩写记法
            if (item.startsWith("+.")) {
                lines.push(`DOMAIN-SUFFIX,${item.slice(2)}`);
            } else {
                lines.push(item);
            }
        } else if (inPayload && t && !t.startsWith("#") && !t.startsWith("-")) {
            break;
        }
    }
    return lines;
}

async function fetchExternal() {
    console.log("== 抓取外部源 ==");
    for (const { name, url, kind } of EXTERNAL) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`抓取失败 ${url}: ${res.status}`);
        const text = await res.text();
        const lines = kind === "yaml-payload" ? fromYamlPayload(text) : text.split("\n");
        writeFileSync(
            join(RULESET_DIR, `${name}.loon.list`),
            [GEN_HEADER, `# 上游：${url}`, ...toLoon(lines)].join("\n")
        );
        writeFileSync(
            join(RULESET_DIR, `${name}.qx.list`),
            [GEN_HEADER, `# 上游：${url}`, ...toQx(lines)].join("\n")
        );
        console.log(`  ${name}: ${lines.length} 行`);
    }
}

// ---------------------------------------------------------------- 映射表
// 策略组名与 mihomo 版保持一致，方便对照。

const G = {
    SELECT: "选择代理",
    MANUAL: "手动选择",
    AUTO: "自动选择",
    FALLBACK: "故障转移",
    STATIC: "静态资源",
    AI: "AI服务",
    CRYPTO: "加密货币",
    FINANCE: "金融服务",
    APPLE: "苹果服务",
    GOOGLE: "谷歌服务",
    MS: "微软服务",
    BILIBILI: "哔哩哔哩",
    BAHAMUT: "巴哈姆特",
    XBOX: "Xbox",
    GITHUB: "Github",
    YOUTUBE: "Youtube",
    NETFLIX: "Netflix",
    TIKTOK: "TikTok",
    SPOTIFY: "Spotify",
    EHENTAI: "E-Hentai",
    TG: "Telegram",
    TRUTH: "Truth Social",
    TWITTER: "Twitter",
    TWITCH: "Twitch",
    WEIBO: "新浪微博",
    PIKPAK: "PikPak网盘",
    SOGOU: "搜狗输入法",
    AD: "广告拦截",
    FINAL: "Final",
    DIRECT: "DIRECT",
};

const ICON = (p) => `https://cdn.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/${p}`;
const ICONS = {
    [G.SELECT]: ICON("Proxy.png"),
    [G.MANUAL]: "https://cdn.jsdelivr.net/gh/shindgewongxj/WHATSINStash@master/icon/select.png",
    [G.AUTO]: ICON("Auto.png"),
    [G.FALLBACK]: ICON("Available_1.png"),
    [G.STATIC]: ICON("Cloudflare.png"),
    [G.AI]: ICON("ChatGPT.png"),
    [G.CRYPTO]: ICON("Cryptocurrency_1.png"),
    [G.FINANCE]: `${CDN}/icons/Nasdaq.png`,
    [G.APPLE]: ICON("Apple_2.png"),
    [G.GOOGLE]: "https://cdn.jsdelivr.net/gh/Orz-3/mini@master/Color/Google.png",
    [G.MS]: `${CDN}/icons/Microsoft_Copilot.png`,
    [G.BILIBILI]: ICON("bilibili.png"),
    [G.BAHAMUT]: ICON("Bahamut.png"),
    [G.XBOX]: ICON("Xbox.png"),
    [G.GITHUB]: ICON("GitHub.png"),
    [G.YOUTUBE]: ICON("YouTube.png"),
    [G.TWITCH]: ICON("Twitch.png"),
    [G.NETFLIX]: ICON("Netflix.png"),
    [G.TIKTOK]: ICON("TikTok.png"),
    [G.SPOTIFY]: ICON("Spotify.png"),
    [G.EHENTAI]: `${CDN}/icons/Ehentai.png`,
    [G.TG]: `${CDN}/icons/Telegram.png`,
    [G.TRUTH]: `${CDN}/icons/Truth_Social.png`,
    [G.TWITTER]: ICON("Twitter.png"),
    [G.WEIBO]: ICON("Weibo.png"),
    [G.PIKPAK]: `${CDN}/icons/PikPak.png`,
    [G.SOGOU]: `${CDN}/icons/Sougou.png`,
    [G.AD]: ICON("AdBlack.png"),
    [G.FINAL]: ICON("Final.png"),
};

// 远程规则（按 mihomo 规则顺序）。GEOSITE 用 blackmatrix7 同名集代替。
const REMOTES = [
    {
        loon: `${BM}/Loon/AdvertisingLite/AdvertisingLite.list`,
        qx: `${BM}/QuantumultX/AdvertisingLite/AdvertisingLite.list`,
        policy: G.AD,
        tag: "广告拦截",
    },
    {
        loon: `${CDN}/ruleset/AdditionalFilter.loon.list`,
        qx: `${CDN}/ruleset/AdditionalFilter.qx.list`,
        policy: G.AD,
        tag: "追加过滤",
    },
    {
        loon: `${CDN}/ruleset/SogouInput.loon.list`,
        qx: `${CDN}/ruleset/SogouInput.qx.list`,
        policy: G.SOGOU,
        tag: "搜狗输入法",
    },
    {
        loon: `${CDN}/ruleset/StaticResources.loon.list`,
        qx: `${CDN}/ruleset/StaticResources.qx.list`,
        policy: G.STATIC,
        tag: "静态资源",
    },
    {
        loon: `${CDN}/ruleset/CDNResources.loon.list`,
        qx: `${CDN}/ruleset/CDNResources.qx.list`,
        policy: G.STATIC,
        tag: "CDN资源",
    },
    {
        loon: `${CDN}/ruleset/AdditionalCDNResources.loon.list`,
        qx: `${CDN}/ruleset/AdditionalCDNResources.qx.list`,
        policy: G.STATIC,
        tag: "追加CDN",
    },
    {
        loon: `${BM}/Loon/Crypto/Crypto.list`,
        qx: `${BM}/QuantumultX/Crypto/Crypto.list`,
        policy: G.CRYPTO,
        tag: "加密货币",
    },
    // GEOSITE,category-finance：无可靠第三方等价集，暂略（命中时走 Final）
    {
        loon: `${CDN}/ruleset/Muse.loon.list`,
        qx: `${CDN}/ruleset/Muse.qx.list`,
        policy: G.AI,
        tag: "Muse",
    },
    {
        loon: `${BM}/Loon/OpenAI/OpenAI.list`,
        qx: `${BM}/QuantumultX/OpenAI/OpenAI.list`,
        policy: G.AI,
        tag: "OpenAI",
    },
    {
        loon: `${BM}/Loon/Claude/Claude.list`,
        qx: `${BM}/QuantumultX/Claude/Claude.list`,
        policy: G.AI,
        tag: "Claude",
    },
    {
        loon: `${BM}/Loon/Gemini/Gemini.list`,
        qx: `${BM}/QuantumultX/Gemini/Gemini.list`,
        policy: G.AI,
        tag: "Gemini",
    },
    { loon: `${BM}/Loon/Copilot/Copilot.list`, qx: null, policy: G.AI, tag: "Copilot" },
    { loon: `${BM}/Loon/Anthropic/Anthropic.list`, qx: null, policy: G.AI, tag: "Anthropic" },
    {
        loon: `${BM}/Loon/BiliBili/BiliBili.list`,
        qx: `${BM}/QuantumultX/BiliBili/BiliBili.list`,
        policy: G.BILIBILI,
        tag: "哔哩哔哩",
    },
    {
        loon: `${BM}/Loon/YouTube/YouTube.list`,
        qx: `${BM}/QuantumultX/YouTube/YouTube.list`,
        policy: G.YOUTUBE,
        tag: "Youtube",
    },
    {
        loon: `${BM}/Loon/Telegram/Telegram.list`,
        qx: `${BM}/QuantumultX/Telegram/Telegram.list`,
        policy: G.TG,
        tag: "Telegram",
    },
    {
        loon: `${BM}/Loon/Xbox/Xbox.list`,
        qx: `${BM}/QuantumultX/Xbox/Xbox.list`,
        policy: G.XBOX,
        tag: "Xbox",
    },
    {
        loon: `${BM}/Loon/GitHub/GitHub.list`,
        qx: `${BM}/QuantumultX/GitHub/GitHub.list`,
        policy: G.GITHUB,
        tag: "Github",
    },
    {
        loon: `${BM}/Loon/Netflix/Netflix.list`,
        qx: `${BM}/QuantumultX/Netflix/Netflix.list`,
        policy: G.NETFLIX,
        tag: "Netflix",
    },
    {
        loon: `${BM}/Loon/Twitch/Twitch.list`,
        qx: `${BM}/QuantumultX/Twitch/Twitch.list`,
        policy: G.TWITCH,
        tag: "Twitch",
    },
    {
        loon: `${BM}/Loon/Spotify/Spotify.list`,
        qx: `${BM}/QuantumultX/Spotify/Spotify.list`,
        policy: G.SPOTIFY,
        tag: "Spotify",
    },
    {
        loon: `${BM}/Loon/Bahamut/Bahamut.list`,
        qx: `${BM}/QuantumultX/Bahamut/Bahamut.list`,
        policy: G.BAHAMUT,
        tag: "巴哈姆特",
    },
    {
        loon: `${BM}/Loon/PikPak/PikPak.list`,
        qx: `${BM}/QuantumultX/PikPak/PikPak.list`,
        policy: G.PIKPAK,
        tag: "PikPak",
    },
    {
        loon: `${BM}/Loon/Twitter/Twitter.list`,
        qx: `${BM}/QuantumultX/Twitter/Twitter.list`,
        policy: G.TWITTER,
        tag: "Twitter",
    },
    {
        loon: `${CDN}/ruleset/Weibo.loon.list`,
        qx: `${CDN}/ruleset/Weibo.qx.list`,
        policy: G.WEIBO,
        tag: "新浪微博",
    },
    {
        loon: `${CDN}/ruleset/EHentai.loon.list`,
        qx: `${CDN}/ruleset/EHentai.qx.list`,
        policy: G.EHENTAI,
        tag: "E-Hentai",
    },
    {
        loon: `${CDN}/ruleset/TikTok.loon.list`,
        qx: `${CDN}/ruleset/TikTok.qx.list`,
        policy: G.TIKTOK,
        tag: "TikTok",
    },
    {
        loon: `${CDN}/ruleset/SteamFix.loon.list`,
        qx: `${CDN}/ruleset/SteamFix.qx.list`,
        policy: G.DIRECT,
        tag: "Steam修复",
    },
    {
        loon: `${CDN}/ruleset/FirebaseCloudMessaging.loon.list`,
        qx: `${CDN}/ruleset/FirebaseCloudMessaging.qx.list`,
        policy: G.DIRECT,
        tag: "谷歌推送",
    },
    // GEOSITE,google-play@cn / microsoft@cn：iPhone 场景极少用到，暂略
    {
        loon: `${BM}/Loon/Apple/Apple.list`,
        qx: `${BM}/QuantumultX/Apple/Apple.list`,
        policy: G.APPLE,
        tag: "苹果服务",
    },
    {
        loon: `${BM}/Loon/Microsoft/Microsoft.list`,
        qx: `${BM}/QuantumultX/Microsoft/Microsoft.list`,
        policy: G.MS,
        tag: "微软服务",
    },
    {
        loon: `${BM}/Loon/Google/Google.list`,
        qx: `${BM}/QuantumultX/Google/Google.list`,
        policy: G.GOOGLE,
        tag: "谷歌服务",
    },
    {
        loon: `${CDN}/ruleset/GFWList.loon.list`,
        qx: `${CDN}/ruleset/GFWList.qx.list`,
        policy: G.SELECT,
        tag: "GFWList",
    },
];

// 策略组：[名称, Loon 定义, QX 定义]
const PROXY = [G.SELECT, G.MANUAL, G.DIRECT];
const PROXY_D = [G.DIRECT, G.SELECT, G.MANUAL];
function loonGroup(name, members) {
    return `${name} = select, ${members.join(", ")}, img-url=${ICONS[name]}`;
}
const GROUPS = [
    [G.SELECT, "select", "static"],
    [G.MANUAL, "select", "static"],
    [G.AUTO, "url-test", "available"],
    [G.FALLBACK, "fallback", "available"],
    [G.STATIC, "select", "static"],
    [G.AI, "select", "static"],
    [G.CRYPTO, "select", "static"],
    [G.FINANCE, "select", "static"],
    [G.APPLE, "select", "static"],
    [G.GOOGLE, "select", "static"],
    [G.MS, "select", "static"],
    [G.BILIBILI, "select", "static"],
    [G.BAHAMUT, "select", "static"],
    [G.XBOX, "select", "static"],
    [G.GITHUB, "select", "static"],
    [G.YOUTUBE, "select", "static"],
    [G.NETFLIX, "select", "static"],
    [G.TIKTOK, "select", "static"],
    [G.SPOTIFY, "select", "static"],
    [G.EHENTAI, "select", "static"],
    [G.TG, "select", "static"],
    [G.TRUTH, "select", "static"],
    [G.TWITTER, "select", "static"],
    [G.TWITCH, "select", "static"],
    [G.WEIBO, "select", "static"],
    [G.PIKPAK, "select", "static"],
    [G.SOGOU, "select", "static"],
    [G.AD, "select", "static"],
    [G.FINAL, "select", "static"],
];
const GROUP_MEMBERS = {
    [G.SELECT]: null, // 用户填节点
    [G.MANUAL]: [G.SELECT],
    [G.AUTO]: [G.SELECT],
    [G.FALLBACK]: [G.SELECT],
    [G.STATIC]: PROXY,
    [G.AI]: PROXY,
    [G.CRYPTO]: PROXY,
    [G.FINANCE]: PROXY_D,
    [G.APPLE]: PROXY_D,
    [G.GOOGLE]: PROXY,
    [G.MS]: PROXY,
    [G.BILIBILI]: PROXY_D,
    [G.BAHAMUT]: PROXY,
    [G.XBOX]: PROXY,
    [G.GITHUB]: PROXY,
    [G.YOUTUBE]: PROXY,
    [G.NETFLIX]: PROXY,
    [G.TIKTOK]: PROXY,
    [G.SPOTIFY]: PROXY,
    [G.EHENTAI]: PROXY,
    [G.TG]: PROXY,
    [G.TRUTH]: PROXY,
    [G.TWITTER]: PROXY,
    [G.TWITCH]: PROXY,
    [G.WEIBO]: PROXY_D,
    [G.PIKPAK]: PROXY,
    [G.SOGOU]: [G.DIRECT, "REJECT"],
    [G.AD]: ["REJECT", G.DIRECT],
    [G.FINAL]: [G.SELECT, G.DIRECT],
};

// ---------------------------------------------------------------- 生成配置

function buildLoonConf(raw = false) {
    const L = [];
    L.push(GEN_HEADER);
    L.push(
        `# 对应 mihomo 分流（convert.min.js）的 Loon 版${raw ? "（raw 直链版，实时最新）" : ""}`
    );
    L.push(`# 使用：1) 导入本文件到 Loon；`);
    L.push(`# 2) 到下面的 [Remote Proxy] 把你的节点订阅链接填进去（去掉行首的 #）；`);
    L.push(`# 3) 地区组（美国节点/新加坡节点…）会自动按正则筛选订阅里的节点，无需手动填；`);
    L.push(`# 4) 其它服务组已自动跟随「${G.SELECT}」`);
    L.push(``);
    L.push(`[General]`);
    L.push(`dns-server = system`);
    L.push(`proxy-test-url = ${SPEEDTEST_URL}`);
    L.push(`internet-test-url = ${SPEEDTEST_URL}`);
    L.push(`skip-proxy = 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, localhost, *.local`);
    L.push(``);
    L.push(`[Remote Proxy]`);
    L.push(`# ↓↓↓ ② 把你的节点订阅链接填在这里（去掉行首的 #，只留一行） ↓↓↓`);
    L.push(`# 节点订阅 = https://你的机场订阅链接`);
    L.push(``);
    L.push(`[Remote Filter]`);
    L.push(`# 按地区自动筛选订阅节点（NameRegex 正则匹配节点名，与 mihomo 版同一套正则）`);
    for (const c of COUNTRIES) {
        // Loon 用逗号分隔参数，正则里的 {2,} 改写成无逗号的等价形式
        const loonPattern = c.pattern.replace(/\[A-Za-z\]\{2,\}/g, "[A-Za-z][A-Za-z]+");
        L.push(`${c.filter} = NameRegex, ${loonPattern}`);
    }
    L.push(``);
    L.push(`[Proxy Group]`);
    // 地区组：url-test 自动按正则筛选
    for (const c of COUNTRIES) {
        const img = c.icon ? `, img-url=${c.icon}` : ``;
        L.push(`${c.group} = url-test, ${c.filter}, url=${SPEEDTEST_URL}, interval=300${img}`);
    }
    const countryGroups = COUNTRIES.map((c) => c.group).join(", ");
    for (const [name, type] of GROUPS) {
        if (name === G.SELECT) {
            L.push(`${name} = ${type}, ${G.DIRECT}, ${countryGroups}, img-url=${ICONS[name]}`);
            continue;
        }
        const members = GROUP_MEMBERS[name];
        if (type === "url-test" || type === "fallback") {
            // 注：这里嵌套引用「选择代理」组；若 Loon 报错，把地区组名字直接填进来代替
            L.push(
                `${name} = ${type}, ${members.join(", ")}, url=${SPEEDTEST_URL}, interval=300, img-url=${ICONS[name]}`
            );
        } else {
            L.push(loonGroup(name, members));
        }
    }
    L.push(``);
    L.push(`[Remote Rule]`);
    for (const r of REMOTES) {
        if (!r.loon) continue;
        const url = raw ? r.loon.replace(CDN, RAW) : r.loon;
        L.push(`${url}, policy=${r.policy}, tag=${r.tag}, enabled=true`);
    }
    L.push(``);
    L.push(`[Rule]`);
    L.push(`# 内网直连（对应 GEOIP,private）`);
    L.push(`IP-CIDR,192.168.0.0/16,${G.DIRECT}`);
    L.push(`IP-CIDR,10.0.0.0/8,${G.DIRECT}`);
    L.push(`IP-CIDR,172.16.0.0/12,${G.DIRECT}`);
    L.push(`DOMAIN-SUFFIX,truthsocial.com,${G.TRUTH}`);
    L.push(`# 国内 IP 直连`);
    L.push(`GEOIP,CN,${G.DIRECT}`);
    L.push(`FINAL,${G.FINAL}`);
    L.push(``);
    return L.join("\n");
}

function buildQxConf(raw = false) {
    const L = [];
    L.push(GEN_HEADER);
    L.push(
        `# 对应 mihomo 分流（convert.min.js）的 Quantumult X 版${raw ? "（raw 直链版，实时最新）" : ""}`
    );
    L.push(`# 使用：1) 导入本文件到圈X；2) 在下面的 [server_remote] 填你的节点订阅链接；`);
    L.push(`# 3) 地区组（美国节点/新加坡节点…）会自动按正则筛选订阅里的节点，无需手动填；`);
    L.push(`# 4) 其它策略已自动跟随「${G.SELECT}」`);
    L.push(``);
    L.push(`[general]`);
    L.push(`# 节点延迟测试地址（url-latency-benchmark 策略用它测速）`);
    L.push(`server_check_url=${SPEEDTEST_URL}`);
    L.push(``);
    L.push(`[server_remote]`);
    L.push(`# ↓↓↓ 把你的节点订阅链接填在这里（去掉行首的 #） ↓↓↓`);
    L.push(`# https://你的机场订阅链接, tag=节点订阅, enabled=true`);
    L.push(``);
    L.push(`[policy]`);
    // 地区策略：url-latency-benchmark + server-tag-regex 按正则自动筛选订阅节点
    L.push(`# 地区策略：按正则自动筛选订阅节点（与 mihomo 版同一套正则）`);
    for (const c of COUNTRIES) {
        const img = c.icon ? `, img-url=${c.icon}` : ``;
        // QX 用逗号分隔参数，正则里的 {2,} 改写成无逗号的等价形式 [A-Za-z][A-Za-z]+
        const qxPattern = c.pattern.replace(/\[A-Za-z\]\{2,\}/g, "[A-Za-z][A-Za-z]+");
        L.push(
            `url-latency-benchmark=${c.group}, server-tag-regex=${qxPattern}, check-interval=300, tolerance=50${img}`
        );
    }
    const countryGroups = COUNTRIES.map((c) => c.group).join(", ");
    for (const [name, , qxType] of GROUPS) {
        if (name === G.SELECT) {
            L.push(`static=${name}, direct, ${countryGroups}, img-url=${ICONS[name]}`);
            continue;
        }
        const members = GROUP_MEMBERS[name].map((m) =>
            m === G.DIRECT ? "direct" : m === "REJECT" ? "reject" : m
        );
        if (qxType === "available") {
            L.push(
                `available=${name}, ${members.join(", ")}, url=${SPEEDTEST_URL}, interval=600, img-url=${ICONS[name]}`
            );
        } else {
            L.push(`static=${name}, ${members.join(", ")}, img-url=${ICONS[name]}`);
        }
    }
    L.push(``);
    L.push(`[filter_remote]`);
    for (const r of REMOTES) {
        if (!r.qx) continue;
        const url = raw ? r.qx.replace(CDN, RAW) : r.qx;
        L.push(`${url}, tag=${r.tag}, force-policy=${r.policy}, enabled=true`);
    }
    L.push(``);
    L.push(`[filter_local]`);
    L.push(`# 内网直连（对应 GEOIP,private）`);
    L.push(`ip-cidr, 192.168.0.0/16, direct`);
    L.push(`ip-cidr, 10.0.0.0/8, direct`);
    L.push(`ip-cidr, 172.16.0.0/12, direct`);
    L.push(`host-suffix, truthsocial.com, ${G.TRUTH}`);
    L.push(`# 国内 IP 直连`);
    L.push(`geoip, cn, direct`);
    L.push(`final, ${G.FINAL}`);
    L.push(``);
    return L.join("\n");
}

// ---------------------------------------------------------------- 主流程

async function main() {
    if (!existsSync(CLIENTS_DIR)) mkdirSync(CLIENTS_DIR, { recursive: true });
    convertLocalLists();
    if (!OFFLINE) {
        await fetchExternal();
    } else {
        console.log("== 离线模式：跳过外部源抓取 ==");
    }
    console.log("== 生成客户端配置 ==");
    writeFileSync(join(CLIENTS_DIR, "loon.conf"), buildLoonConf(false));
    writeFileSync(join(CLIENTS_DIR, "qx.conf"), buildQxConf(false));
    writeFileSync(join(CLIENTS_DIR, "loon-raw.conf"), buildLoonConf(true));
    writeFileSync(join(CLIENTS_DIR, "qx-raw.conf"), buildQxConf(true));
    console.log("  clients/loon.conf / qx.conf（jsDelivr 版）");
    console.log("  clients/loon-raw.conf / qx-raw.conf（raw.githubusercontent 版）");
    console.log("完成。");
}

main().catch((e) => {
    console.error("失败:", e.message);
    process.exit(1);
});
