#!/usr/bin/env node
/**
 * ShowTrip · 跟着演出去旅行 —— 全自动演出行程管线
 * 链路：演出发现 → 交通比价 → 住宿筛选 → 周边游玩 → 行程成稿
 * 数据源：飞猪 FlyAI 真实价库（flyai-cli，无需 API Key 即可试用）
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, mkdirSync } from "node:fs";

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function flyai(cmd, args) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { stdout } = await run("flyai", [cmd, ...args], { timeout: 60000 });
      const j = JSON.parse(stdout);
      if (j.status === 0 && j.data) return j;
      if (j.status === 0 && !j.data) return j; // 合法空结果（status=0 + data=null）
    } catch { /* 重试 */ }
    await sleep(2500 * (attempt + 1)); // 限流退避后重试
  }
  return null;
}

const pick = (list, n) => (list || []).slice(0, n).filter(Boolean);

// 模糊价（"6x"/"¥4xx"）→ 保守下估值；精确价（"¥173.50"）原样解析
function priceNum(p) {
  const s = String(p || "").replace(/[¥￥,\s]/g, "");
  const m = s.match(/^(\d+)/);
  if (!m) return null;
  const xs = (s.match(/x/gi) || []).length;
  if (xs) return parseInt(m[1]) * Math.pow(10, xs); // "6x"→60, "4xx"→400
  const f = parseFloat(s);
  return Number.isFinite(f) ? f : null;
}

function fmtPrice(p) {
  if (!p) return "见链接";
  const n = priceNum(p);
  if (n != null && /x/i.test(String(p))) return `¥${n}+`;
  return String(p).startsWith("¥") ? p : `¥${p}`;
}

const addDays = (dateStr, n) => {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

const firstSeg = (f) => f?.journeys?.[0]?.segments?.[0] || {};
const lastSeg = (f) => f?.journeys?.[0]?.segments?.at(-1) || {};
const fNo = (f) => firstSeg(f)?.marketingTransportNo || "-";

const crossDay = (dep, arr) => {
  const dd = dep?.slice(0, 10), ad = arr?.slice(0, 10);
  return dd && ad && dd !== ad ? `（${ad.slice(5).replace("-", "/")}）` : "";
};

function fLine(f) {
  const s = firstSeg(f), e = lastSeg(f);
  return `${s.depDateTime?.slice(5, 16)} ${s.depStationName}→${e.arrStationName} ${e.arrDateTime?.slice(11, 16)}${crossDay(s.depDateTime, e.arrDateTime)}到`;
}

function tLine(t) {
  const s = t?.journeys?.[0]?.segments?.[0] || {};
  return `${s.depDateTime?.slice(5, 16)} ${s.depStationName}→${s.arrStationName} ${s.arrDateTime?.slice(11, 16)}${crossDay(s.depDateTime, s.arrDateTime)}到`;
}

async function main() {
  const [event = "李荣浩演唱会", fromCity = "杭州", departDate = addDays(new Date().toISOString().slice(0, 10), 14), wantCity = ""] = process.argv.slice(2);

  console.error(`[ShowTrip] 演出=${event} 出发地=${fromCity} 出发日=${departDate} 偏好城市=${wantCity || "无"}`);

  // ── 1. 演出发现（逐级降级：精确 → +门票 → 同类演出池） ──
  const searchEvents = async (q) => {
    const r = await flyai("keyword-search", ["--query", q]);
    return { events: pick(r?.data?.itemList?.map((i) => i.info), 6), sys: r?.systemMessage || "" };
  };
  let { events, sys } = await searchEvents(event);
  if (!events.length) ({ events, sys } = await searchEvents(`${event}门票`));
  let fallback = false;
  if (!events.length) {
    ({ events, sys } = await searchEvents("演唱会门票"));
    fallback = true;
  }
  if (!events.length) {
    console.error("[ShowTrip] 未找到在售演出，退出");
    process.exit(1);
  }
  if (wantCity) {
    const hit = events.find((e) => e.title.includes(`【${wantCity}】`));
    if (hit) events = [hit, ...events.filter((e) => e !== hit)];
  }
  const mainEvent = events[0];
  const toCity = mainEvent.title.match(/【(.+?)】/)?.[1] || wantCity;
  if (!toCity) {
    console.error("[ShowTrip] 无法从演出标题解析城市，请用第 4 个参数指定城市");
    process.exit(1);
  }
  console.error(`[ShowTrip] 锁定演出：${mainEvent.title}`);

  // fallback 说明：匹配到相关演出 vs 纯推荐
  const coreWord = event.replace(/演唱会|门票|演出|巡演|live/gi, "").trim();
  const related = fallback && coreWord && mainEvent.title.includes(coreWord);
  const fallbackNote = fallback
    ? (related
        ? `> 已为你匹配「${coreWord}」的在售场次（飞猪搜索未直接命中「${event}」，从在售池中锁定最相关场次）。`
        : `> 未检索到「${event}」在售票务，以上为当前热门在售演出，可从中选择或换个关键词再试。`)
    : "";

  const showDate = addDays(departDate, 1);
  const returnDate = addDays(departDate, 2);

  // ── 2. 交通比价：机票+火车，去返都查 ─────────────
  const [fOut, fBack, tOut, tBack] = await Promise.all([
    flyai("search-flight", ["--origin", fromCity, "--destination", toCity, "--dep-date", departDate, "--sort-type", "3"]),
    flyai("search-flight", ["--origin", toCity, "--destination", fromCity, "--dep-date", returnDate, "--sort-type", "3"]),
    flyai("search-train", ["--origin", fromCity, "--destination", toCity, "--dep-date", departDate, "--sort-type", "3"]),
    flyai("search-train", ["--origin", toCity, "--destination", fromCity, "--dep-date", returnDate, "--sort-type", "3"]),
  ]);
  const flightsOut = pick(fOut?.data?.itemList, 3);
  const flightsBack = pick(fBack?.data?.itemList, 2);
  const trainsOut = pick(tOut?.data?.itemList, 3);
  const trainsBack = pick(tBack?.data?.itemList, 2);

  const cheapest = (arr, key) => {
    const withPrice = (arr || []).filter((x) => priceNum(x[key]) != null);
    return withPrice.sort((a, b) => priceNum(a[key]) - priceNum(b[key]))[0] || (arr || [])[0];
  };
  const goFlight = cheapest(flightsOut, "adultPrice");
  const goTrain = cheapest(trainsOut, "price");
  const backFlight = cheapest(flightsBack, "adultPrice");
  const backTrain = cheapest(trainsBack, "price");

  const goIsFlight = goFlight && (!goTrain || (priceNum(goFlight.adultPrice) ?? Infinity) <= (priceNum(goTrain.price) ?? Infinity));
  const go = goIsFlight ? goFlight : goTrain;
  const backIsFlight = backFlight && backTrain
    ? (priceNum(backFlight.adultPrice) <= priceNum(backTrain.price) ? true : false)
    : !!backFlight && !backTrain;
  const back = backIsFlight ? backFlight : backTrain;
  if (!go && !back) console.error("[ShowTrip] ⚠️ 两程交通均无结果（体验模式数据受限）");

  const priceOf = (x, k) => (x ? fmtPrice(x[k]) : "-");
  await sleep(2500); // 批次间退避，避免体验模式限流
  const goDesc = go ? (goIsFlight ? fLine(go) : tLine(go)) : "待查询";
  const goPrice = goIsFlight ? priceOf(goFlight, "adultPrice") : priceOf(goTrain, "price");
  const backDesc = back ? (backIsFlight ? fLine(back) : tLine(back)) : "待查询";
  const backPrice = backIsFlight ? priceOf(backFlight, "adultPrice") : priceOf(backTrain, "price");

  // ── 3. 住宿：优先场馆周边，不足补市区 ─────────────
  const hArgs = ["--dest-name", toCity, "--check-in-date", departDate, "--check-out-date", returnDate];
  const [h1, h2] = await Promise.all([
    flyai("search-hotel", [...hArgs, "--key-words", "体育馆"]),
    flyai("search-hotel", hArgs),
  ]);
  let hotels = pick(h1?.data?.itemList, 3);
  const seen = new Set(hotels.map((h) => h.name));
  for (const h of pick(h2?.data?.itemList, 6)) {
    if (hotels.length >= 3) break;
    if (!seen.has(h.name)) { hotels.push(h); seen.add(h.name); }
  }
  await sleep(2500);

  // ── 4. 周边游玩 ───────────────────────────────────
  const poi = await flyai("search-poi", ["--city-name", toCity]);
  const pois = pick(poi?.data?.itemList, 3);

  // ── 5. 行程成稿 ───────────────────────────────────
  const rows = [
    [`🚩 去程·推荐`, goIsFlight ? "✈️ " + fNo(go) : "🚄 " + fNo(go), goDesc, goPrice],
    ...flightsOut.filter((f) => f !== goFlight).map((f) => ["✈️ 去程备选", fNo(f), fLine(f), fmtPrice(f.adultPrice)]),
    ...trainsOut.filter((t) => t !== goTrain && goIsFlight).map((t) => ["🚄 去程备选", fNo(t), tLine(t), fmtPrice(t.price)]),
    [`↩️ 返程·推荐`, backIsFlight ? "✈️ " + fNo(back) : "🚄 " + fNo(back), backDesc, backPrice],
    ...trainsBack.filter((t) => t !== backTrain && backIsFlight).map((t) => ["🚄 返程备选", fNo(t), tLine(t), fmtPrice(t.price)]),
  ];
  const transportTable = rows.map((r) => `| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} |`).join("\n");

  const arriveVerb = goIsFlight ? "落地后" : "出站后";
  const budget = [
    ["演出门票", mainEvent.price, 1],
    ["去程交通", goIsFlight ? goFlight?.adultPrice : goTrain?.price, 1],
    ["返程交通", backIsFlight ? backFlight?.adultPrice : backTrain?.price, 1],
    ["住宿 2 晚", hotels[0]?.price, 2],
  ];
  const est = (p, m) => {
    const n = priceNum(p);
    return n == null ? "见链接" : `¥${Math.round(n * m)}${/x/i.test(String(p)) ? "+" : ""}`;
  };
  const total = budget.reduce((acc, [_, p, m]) => acc + (priceNum(p) ?? 0) * m, 0);
  const totalAnyFuzzy = budget.some(([_, p]) => /x/i.test(String(p || "")));

  const md = `# 🎤 跟着演出去旅行 · ${mainEvent.title.replace(/【.+?】/, "")}

> 由 **ShowTrip 演出行程管家** 基于飞猪实时数据自动生成 · 出发地 **${fromCity}** · 目的地 **${toCity}**

## 🎫 目标演出

![](${mainEvent.picUrl})

**${mainEvent.title}** — 票价 ${fmtPrice(mainEvent.price)} 起

[点击预订演出票](${mainEvent.jumpUrl})

${events.length > 1 ? `**同档期其他在售演出**：${events.slice(1, 4).map((e) => `[${e.title}](${e.jumpUrl})`).join(" · ")}` : ""}

${fallbackNote}

## 🚄 交通方案（${departDate} 出发 / ${returnDate} 返程）

| 方案 | 航班/车次 | 时间 | 价格 |
|---|---|---|---|
${transportTable}

${go ? `[预订推荐去程](${go.jumpUrl})` : ""}
${back ? `[预订推荐返程](${back.jumpUrl})` : ""}
${!goIsFlight && flightsOut[0] ? `\n> ⏱️ 时间敏感？${fNo(flightsOut[0])} 约 ${flightsOut[0].journeys?.[0]?.totalDuration || firstSeg(flightsOut[0])?.duration || "2"} 分钟直达，体验模式下部分航班价格需点链接查看，赶时间可优先考虑。` : ""}

## 🏨 住宿推荐（${departDate} 入住 ${returnDate} 退房${h1?.data?.itemList?.length ? " · 优先场馆周边" : ""}）

${hotels.length ? hotels.map((h, i) => `### ${i === 0 ? "⭐ 首选" : `备选${i}`}：${h.name}${h.star ? `（${h.star}）` : ""}

${h.mainPic ? `![](${h.mainPic})\n\n` : ""}- 📍 ${h.address || "位置见预订页"}${h.interestsPoi ? ` · ${h.interestsPoi}` : ""}
- 💰 ${fmtPrice(h.price)}/晚

[点击预订](${h.detailUrl})`).join("\n\n") : "⚠️ 住宿数据暂未返回（体验模式限流），稍后重试或配置正式 API Key 后重新生成。"}

## 🗺️ 行程规划

### Day 1（${departDate}）抵达 ${toCity}
- ${goDesc}，${arriveVerb}前往酒店寄存行李
- 傍晚：酒店周边觅食，早睡蓄能，明天嗨一整天

### Day 2（${showDate}）白天游玩 + 晚上 🎤 演出日
- 上午：${pois[0]?.name || `${toCity}经典地标（景点数据暂未返回，可稍后重试）`}${pois[0]?.description ? ` — ${pois[0].description.slice(0, 60)}…` : ""}
${pois[0]?.jumpUrl ? `[点击预订门票](${pois[0].jumpUrl})` : ""}
- 下午：回酒店休整，17:00 前出发前往场馆（散场打车高峰，提前动身）
- 晚上：🎤 **${mainEvent.title}**，散场后建议地铁/提前叫车返酒店

### Day 3（${returnDate}）补漏 + 返程
- 上午：${pois[1]?.name || "周边随逛"}${pois[1]?.jumpUrl ? `（[门票](${pois[1].jumpUrl})）` : ""}，或睡到自然醒
- ${backDesc} 返回 ${fromCity}

## 💰 预算总览（1 人）

| 项目 | 单价 | 数量 | 小计（估） |
|---|---|---|---|
${budget.map(([k, p, m]) => `| ${k} | ${fmtPrice(p)} | ×${m} | ${est(p, m)} |`).join("\n")}
| **合计（约）** | | | **${total ? `¥${Math.round(total)}${totalAnyFuzzy ? "+ 起" : ""}` : "以实际预订为准"}** |

## 🎒 追演锦囊

- **票务**：热门演出尽早下单，优先官方渠道；留意「不退不换」条款
- **场馆动线**：提前查好场馆出入口和最近地铁站；散场 30 分钟是打车地狱，坐地铁或走远一段再叫车
- **应援装备**：望远镜、充电宝必备；大型场馆通常禁自带水，现场买
- **返程缓冲**：演出约 22:30 散场，Day 3 返程不必赶早，睡饱再走
- **备选演出**：目标场次售罄时，可从上方同档期场次中替补

${sys ? `> ${sys}\n` : ""}---
*本行程单由 ShowTrip 管线自动生成，价格来自飞猪实时数据，以下单页为准。*
`;

  mkdirSync("demo", { recursive: true });
  const outFile = `demo/行程单-${toCity}-${departDate}.md`;
  writeFileSync(outFile, md);
  console.error(`[ShowTrip] ✅ 行程单已生成：${outFile}（${md.length} 字）`);
  console.log(outFile);
}

main().catch((e) => {
  console.error("[ShowTrip] 失败：", e.message);
  process.exit(1);
});
