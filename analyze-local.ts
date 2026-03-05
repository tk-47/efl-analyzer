#!/usr/bin/env bun
/**
 * EFL Analyzer — Local Agentic Electricity Cost Analyzer
 * Usage: bun run analyze-local.ts [smt-file] [efl-pdf]
 *
 * Ingests Smart Meter Texas usage data, pulls all plans from Power to Choose,
 * simulates actual monthly costs, and produces a ranked Excel report + Claude narrative.
 */

import * as fs from "fs";
import * as path from "path";
import { XMLParser } from "fast-xml-parser";
import * as XLSX from "xlsx";
import Anthropic from "@anthropic-ai/sdk";
import { $ } from "bun";

// ── Config ───────────────────────────────────────────────────────────────────
const CONFIG = {
  zip: "77479",
  tduMonthly: 4.90,
  tduPerKwh: 0.049993,
  minTerm: 6,
  nightWindow1: { start: 23, end: 6 },  // 11pm-6am (Chariot-style)
  nightWindow2: { start: 21, end: 6 },  // 9pm-6am (others)
};

// ── Types ────────────────────────────────────────────────────────────────────
interface Interval {
  startUtc: number;   // epoch ms
  endUtc: number;
  kwh: number;
}

interface MonthProfile {
  year: number;
  month: number;       // 1-12
  totalKwh: number;
  weekdayKwh: number;
  weekendKwh: number;
  nightKwh1: number;   // 11pm-6am
  nightKwh2: number;   // 9pm-6am
  dayKwh: number;      // non-night1 (for TOU billing)
}

type PlanType = "simple" | "bill_credit" | "free_nights" | "free_weekends";

interface RawPlan {
  idKey: string;
  provider: string;
  planName: string;
  termMonths: number;
  tou: boolean;
  prepaid: boolean;
  renewable: number;
  etfText: string;
  p500: number;   // ¢/kWh at 500 kWh
  p1000: number;
  p2000: number;
}

interface ClassifiedPlan extends RawPlan {
  planType: PlanType;
  energyRate: number;   // ¢/kWh  (base or day rate)
  baseCharge: number;   // $/month
  creditAmt: number;    // $ credit (bill_credit plans)
  nightRate: number;    // ¢/kWh for free_nights (0 = free)
}

interface MonthlyCost {
  year: number;
  month: number;
  kwh: number;
  cost: number;
  effectiveRate: number; // ¢/kWh
}

interface PlanResult {
  plan: ClassifiedPlan;
  annualCost: number;
  effectiveRate: number;
  monthlyCosts: MonthlyCost[];
  annualSavings: number; // vs current plan (0 if no current)
}

// ── Step 1: Parse SMT data ───────────────────────────────────────────────────
function parseSmtData(filePath: string): Interval[] {
  const content = fs.readFileSync(filePath, "utf8");

  // Detect format: Green Button XML or CSV
  if (content.trimStart().startsWith("<") || content.trimStart().startsWith("<?")) {
    return parseGreenButtonXml(content);
  } else {
    return parseSmtCsv(content);
  }
}

function parseGreenButtonXml(xml: string): Interval[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseNodeValue: true,
    parseAttributeValue: true,
  });
  const doc = parser.parse(xml);

  const intervals: Interval[] = [];

  // Walk the ESPI structure to find IntervalBlock > IntervalReading
  function walk(node: any) {
    if (!node || typeof node !== "object") return;
    if (node.IntervalReading) {
      const readings = Array.isArray(node.IntervalReading)
        ? node.IntervalReading
        : [node.IntervalReading];
      for (const r of readings) {
        const start = parseInt(r.timePeriod?.start ?? r["espi:timePeriod"]?.["espi:start"] ?? "0");
        const duration = parseInt(r.timePeriod?.duration ?? r["espi:timePeriod"]?.["espi:duration"] ?? "900");
        const value = parseInt(r.value ?? "0");
        if (start && value !== undefined) {
          intervals.push({
            startUtc: start * 1000,
            endUtc: (start + duration) * 1000,
            kwh: value / 1000, // Wh → kWh
          });
        }
      }
    }
    for (const key of Object.keys(node)) {
      if (typeof node[key] === "object") walk(node[key]);
    }
  }

  walk(doc);
  return intervals.sort((a, b) => a.startUtc - b.startUtc);
}

function parseSmtCsv(csv: string): Interval[] {
  const lines = csv.split("\n").map(l => l.trim()).filter(Boolean);
  const intervals: Interval[] = [];

  // SMT CSV format: Date,StartTime,EndTime,Usage(kWh)
  // or: "Date","Start Time","End Time","Consumption"
  // Skip header row(s)
  for (const line of lines) {
    if (/date|start|time|usage|consumption/i.test(line)) continue;
    const cols = line.split(",").map(c => c.replace(/"/g, "").trim());
    if (cols.length < 4) continue;

    const dateStr = cols[0];
    const startStr = cols[1];
    const endStr = cols[2];
    const usageStr = cols[3];

    if (!dateStr || !startStr) continue;
    const startMs = new Date(`${dateStr} ${startStr}`).getTime();
    const endMs = new Date(`${dateStr} ${endStr}`).getTime();
    const kwh = parseFloat(usageStr);

    if (isNaN(startMs) || isNaN(kwh)) continue;
    intervals.push({ startUtc: startMs, endUtc: isNaN(endMs) ? startMs + 900000 : endMs, kwh });
  }

  return intervals.sort((a, b) => a.startUtc - b.startUtc);
}

function buildMonthlyProfiles(intervals: Interval[]): MonthProfile[] {
  // Group by month in America/Chicago
  const monthMap = new Map<string, MonthProfile>();

  const toChicago = (ms: number) => {
    // Use Intl to get Chicago local time
    const dt = new Date(ms);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", hour12: false, weekday: "short",
    }).formatToParts(dt);
    const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
    return {
      year: parseInt(get("year")),
      month: parseInt(get("month")),
      day: parseInt(get("day")),
      hour: parseInt(get("hour")) % 24,
      weekday: get("weekday"), // Mon, Tue...Sat, Sun
    };
  };

  for (const iv of intervals) {
    const local = toChicago(iv.startUtc);
    const key = `${local.year}-${local.month}`;

    if (!monthMap.has(key)) {
      monthMap.set(key, {
        year: local.year, month: local.month,
        totalKwh: 0, weekdayKwh: 0, weekendKwh: 0,
        nightKwh1: 0, nightKwh2: 0, dayKwh: 0,
      });
    }

    const mp = monthMap.get(key)!;
    mp.totalKwh += iv.kwh;

    const isWeekend = local.weekday === "Sat" || local.weekday === "Sun";
    if (isWeekend) mp.weekendKwh += iv.kwh; else mp.weekdayKwh += iv.kwh;

    // Night windows (handle wrap-around midnight)
    const h = local.hour;
    const inWindow = (start: number, end: number) =>
      start > end ? (h >= start || h < end) : (h >= start && h < end);

    if (inWindow(CONFIG.nightWindow1.start, CONFIG.nightWindow1.end)) mp.nightKwh1 += iv.kwh;
    if (inWindow(CONFIG.nightWindow2.start, CONFIG.nightWindow2.end)) mp.nightKwh2 += iv.kwh;
  }

  // Day kWh = total minus night1
  for (const mp of monthMap.values()) {
    mp.dayKwh = mp.totalKwh - mp.nightKwh1;
  }

  // Sort and remove partial months at the edges
  const sorted = [...monthMap.values()].sort((a, b) =>
    a.year !== b.year ? a.year - b.year : a.month - b.month
  );

  // Detect partial months: first/last month may be incomplete
  // Simple heuristic: if total kWh < 50% of adjacent month, mark as partial
  const result: MonthProfile[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const mp = sorted[i];
    const neighbors = [sorted[i - 1], sorted[i + 1]].filter(Boolean);
    const avgNeighbor = neighbors.reduce((s, n) => s + n.totalKwh, 0) / (neighbors.length || 1);
    if (avgNeighbor > 0 && mp.totalKwh < avgNeighbor * 0.5 && (i === 0 || i === sorted.length - 1)) {
      continue; // skip partial edge month
    }
    result.push(mp);
  }

  return result;
}

// ── Step 2: Fetch plans ──────────────────────────────────────────────────────
async function fetchPlans(zip: string): Promise<RawPlan[]> {
  console.log(`\nFetching plans for ZIP ${zip} from Power to Choose...`);
  const url = `http://api.powertochoose.org/api/PowerToChoose/plans?zip_code=${zip}&key=&page_size=200&page_number=1`;

  const res = await fetch(url, {
    headers: { "Accept": "application/json", "User-Agent": "EFL-Analyzer/1.0" },
  });
  if (!res.ok) throw new Error(`Power to Choose API error: ${res.status}`);

  const data: any = await res.json();
  const plans: any[] = data.data ?? data.plans ?? data ?? [];

  if (!Array.isArray(plans)) throw new Error("Unexpected API response shape");
  console.log(`  Got ${plans.length} plans`);

  const result: RawPlan[] = [];
  for (const p of plans) {
    const termMonths = parseInt(p.contract_term ?? p.term_value ?? "0") || 0;
    if (termMonths < CONFIG.minTerm) continue;

    const p500 = parseFloat(p.price_kwh500 ?? p.p_kwh500 ?? "0") || 0;
    const p1000 = parseFloat(p.price_kwh1000 ?? p.p_kwh1000 ?? "0") || 0;
    const p2000 = parseFloat(p.price_kwh2000 ?? p.p_kwh2000 ?? "0") || 0;

    if (!p500 || !p1000 || !p2000) continue;
    // Convert: API values may be in ¢ or $ — detect
    const toC = (v: number) => v > 5 ? v : v * 100; // if < 5, assume dollars
    result.push({
      idKey: String(p.id_key ?? p.plan_id ?? Math.random()),
      provider: String(p.company_name ?? p.provider ?? ""),
      planName: String(p.plan_name ?? p.name ?? ""),
      termMonths,
      tou: Boolean(p.time_of_use),
      prepaid: Boolean(p.prepaid),
      renewable: parseFloat(p.renewable_energy_id ?? "0") || 0,
      etfText: String(p.cancel_fee ?? ""),
      p500: toC(p500),
      p1000: toC(p1000),
      p2000: toC(p2000),
    });
  }

  return result;
}

// ── Step 3: TDU charges are in CONFIG ───────────────────────────────────────

// ── Step 4: Classify plans ───────────────────────────────────────────────────
function classifyPlan(plan: RawPlan): ClassifiedPlan {
  const { p500: p5, p1000: p10, p2000: p20 } = plan;
  const spread = p5 - p10;
  const nameL = plan.planName.toLowerCase();

  let planType: PlanType;

  // Priority classification
  if (p10 < p5 - 2 && p10 < p20 - 0.5) {
    planType = "bill_credit";
  } else if (p5 - p10 > 5 && Math.abs(p10 - p20) < 2) {
    planType = "bill_credit";
  } else if (/night/.test(nameL)) {
    planType = "free_nights";
  } else if (/weekend/.test(nameL)) {
    planType = "free_weekends";
  } else if (/(credit|perks)/.test(nameL) && spread > 3) {
    planType = "bill_credit";
  } else if (spread > 5 && p10 < p5 - 3) {
    planType = "bill_credit"; // hidden bill credit
  } else {
    planType = "simple";
  }

  // Derive rate components from p5/p10/p20 math
  let energyRate: number;
  let baseCharge: number;
  let creditAmt: number;
  let nightRate: number;

  switch (planType) {
    case "simple": {
      // Linear fit: cost(kWh) = baseCharge + energyRate * kWh
      // Using p10 and p20: p10*1000 = base + energy*1000, p20*2000 = base + energy*2000
      energyRate = (p20 * 2000 - p10 * 1000) / 1000; // ¢/kWh
      baseCharge = (p10 * 1000 - energyRate * 1000) / 100; // $
      creditAmt = 0;
      nightRate = 0;
      break;
    }
    case "bill_credit": {
      // The p10 dip reveals the credit threshold is near 1000 kWh
      // cost = baseCharge + energyRate*kWh - creditAmt (if kWh >= threshold)
      // Use p20 (no credit likely) for base energy rate
      energyRate = (p20 * 2000 - p10 * 1000) / 1000;
      if (energyRate < 3 || energyRate > 30) energyRate = p20; // fallback
      baseCharge = Math.max(0, (p20 * 2000 - energyRate * 2000) / 100);
      // Credit = what would p10 cost without credit minus actual p10 bill
      const expectedAt1000 = (baseCharge * 100 + energyRate * 1000) / 100; // $
      const actualAt1000 = p10 * 10; // $ (p10 is ¢/kWh × 1000 kWh / 100)
      creditAmt = Math.max(0, expectedAt1000 - actualAt1000);
      nightRate = 0;
      break;
    }
    case "free_nights": {
      // Day rate from p2000 (most usage is daytime)
      energyRate = p20;
      baseCharge = 0;
      creditAmt = 0;
      nightRate = 0; // free nights
      break;
    }
    case "free_weekends": {
      energyRate = p10;
      baseCharge = 0;
      creditAmt = 0;
      nightRate = 0;
      break;
    }
  }

  return { ...plan, planType, energyRate, baseCharge, creditAmt, nightRate };
}

// ── Step 5: Simulate monthly costs ──────────────────────────────────────────
function simulateMonthlyCost(plan: ClassifiedPlan, mp: MonthProfile): number {
  const { energyRate, baseCharge, creditAmt, planType } = plan;
  const kwh = mp.totalKwh;

  let energyCost: number; // in dollars

  switch (planType) {
    case "simple": {
      energyCost = baseCharge + (energyRate * kwh) / 100;
      break;
    }
    case "bill_credit": {
      const rawCost = baseCharge + (energyRate * kwh) / 100;
      // Credit applies if usage >= 1000 kWh (common threshold; adjust if known)
      energyCost = kwh >= 900 ? rawCost - creditAmt : rawCost;
      break;
    }
    case "free_nights": {
      // Night kWh is free, day kWh at energyRate
      energyCost = baseCharge + (energyRate * mp.dayKwh) / 100;
      break;
    }
    case "free_weekends": {
      // Weekend kWh free, weekday at energyRate
      energyCost = baseCharge + (energyRate * mp.weekdayKwh) / 100;
      break;
    }
  }

  // Add TDU
  const tduCost = CONFIG.tduMonthly + CONFIG.tduPerKwh * kwh;
  return Math.max(0, energyCost + tduCost);
}

function simulatePlan(plan: ClassifiedPlan, months: MonthProfile[]): PlanResult {
  const classified = plan; // already classified
  const monthlyCosts: MonthlyCost[] = months.map(mp => {
    const cost = simulateMonthlyCost(classified, mp);
    return {
      year: mp.year, month: mp.month,
      kwh: mp.totalKwh, cost,
      effectiveRate: mp.totalKwh > 0 ? (cost / mp.totalKwh) * 100 : 0,
    };
  });

  const totalCost = monthlyCosts.reduce((s, m) => s + m.cost, 0);
  const totalKwh = months.reduce((s, m) => s + m.totalKwh, 0);
  // Annualize
  const factor = 12 / months.length;
  const annualCost = totalCost * factor;
  const effectiveRate = totalKwh > 0 ? (totalCost / totalKwh) * 100 : 0;

  return { plan: classified, annualCost, effectiveRate, monthlyCosts, annualSavings: 0 };
}

// ── Step 6: Current plan baseline from EFL PDF ───────────────────────────────
async function parseCurrentEfl(pdfPath: string): Promise<{ energyRate: number; baseCharge: number } | null> {
  try {
    // Use pdftotext to extract text
    const proc = await $`pdftotext ${pdfPath} -`.quiet();
    const text = proc.stdout.toString();

    // Extract base charge
    const baseMatch = text.match(/(?:base\s*charge|customer\s*charge|monthly\s*charge)[^\d]*(\d+\.?\d*)/i);
    const baseCharge = baseMatch ? parseFloat(baseMatch[1]) : 0;

    // Extract energy rate (¢/kWh)
    const rateMatch = text.match(/(\d+\.?\d*)\s*[¢c]\/kWh/i)
      || text.match(/energy\s*charge[^\d]*(\d+\.?\d*)/i);
    const energyRate = rateMatch ? parseFloat(rateMatch[1]) : 0;

    if (!energyRate) return null;
    // Detect dollars vs cents
    const rate = energyRate < 5 ? energyRate * 100 : energyRate;
    return { energyRate: rate, baseCharge };
  } catch {
    return null;
  }
}

function simulateCurrentPlan(
  energyRate: number,
  baseCharge: number,
  months: MonthProfile[]
): PlanResult {
  const fakePlan: ClassifiedPlan = {
    idKey: "current", provider: "Current Plan", planName: "Current Plan",
    termMonths: 0, tou: false, prepaid: false, renewable: 0, etfText: "",
    p500: 0, p1000: 0, p2000: 0,
    planType: "simple", energyRate, baseCharge, creditAmt: 0, nightRate: 0,
  };
  return simulatePlan(fakePlan, months);
}

// ── Step 7: Output ───────────────────────────────────────────────────────────
function buildExcel(
  results: PlanResult[],
  currentResult: PlanResult | null,
  months: MonthProfile[],
  outputPath: string
) {
  const wb = XLSX.utils.book_new();

  // Sheet 1: Plan Comparison (ranked)
  const compRows: any[] = [
    ["Rank", "Provider", "Plan Name", "Type", "Term (mo)", "Annual Cost ($)", "Eff. Rate (¢/kWh)", "Annual Savings ($)", "Renewable %", "ETF"],
  ];
  results.forEach((r, i) => {
    compRows.push([
      i + 1,
      r.plan.provider,
      r.plan.planName,
      r.plan.planType,
      r.plan.termMonths,
      r.annualCost.toFixed(2),
      r.effectiveRate.toFixed(2),
      r.annualSavings.toFixed(2),
      r.plan.renewable,
      r.plan.etfText || "None",
    ]);
  });
  if (currentResult) {
    compRows.push([]);
    compRows.push(["—", "CURRENT PLAN", currentResult.plan.planName, "simple",
      "N/A", currentResult.annualCost.toFixed(2), currentResult.effectiveRate.toFixed(2),
      "0.00", "N/A", "N/A"]);
  }
  const ws1 = XLSX.utils.aoa_to_sheet(compRows);
  ws1["!cols"] = [4, 22, 35, 12, 8, 14, 16, 14, 12, 20].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws1, "Plan Comparison");

  // Sheet 2: Current Plan Monthly (if available)
  if (currentResult) {
    const curRows: any[] = [
      ["Year", "Month", "Usage (kWh)", "Cost ($)", "Eff. Rate (¢/kWh)"],
    ];
    currentResult.monthlyCosts.forEach(m => {
      curRows.push([m.year, m.month, m.kwh.toFixed(1), m.cost.toFixed(2), m.effectiveRate.toFixed(2)]);
    });
    const ws2 = XLSX.utils.aoa_to_sheet(curRows);
    XLSX.utils.book_append_sheet(wb, ws2, "Current Plan Analysis");
  }

  // Sheet 3: Usage Profile
  const usageRows: any[] = [
    ["Year", "Month", "Total kWh", "Weekday kWh", "Weekend kWh", "Night kWh (11pm-6am)", "Night kWh (9pm-6am)", "Day kWh"],
  ];
  months.forEach(m => {
    usageRows.push([
      m.year, m.month,
      m.totalKwh.toFixed(1), m.weekdayKwh.toFixed(1), m.weekendKwh.toFixed(1),
      m.nightKwh1.toFixed(1), m.nightKwh2.toFixed(1), m.dayKwh.toFixed(1),
    ]);
  });
  const totalKwh = months.reduce((s, m) => s + m.totalKwh, 0);
  const factor = 12 / months.length;
  usageRows.push([]);
  usageRows.push(["Annual (extrapolated)", "", (totalKwh * factor).toFixed(0), "", "", "", "", ""]);
  const ws3 = XLSX.utils.aoa_to_sheet(usageRows);
  XLSX.utils.book_append_sheet(wb, ws3, "Usage Profile");

  XLSX.writeFile(wb, outputPath);
  console.log(`\nExcel saved: ${outputPath}`);
}

async function generateNarrative(
  results: PlanResult[],
  currentResult: PlanResult | null,
  months: MonthProfile[]
): Promise<string> {
  const client = new Anthropic();
  const top5 = results.slice(0, 5);
  const annualKwh = months.reduce((s, m) => s + m.totalKwh, 0) * (12 / months.length);

  const context = `
Annual usage: ${annualKwh.toFixed(0)} kWh
Months of data: ${months.length}
${currentResult ? `Current plan annual cost: $${currentResult.annualCost.toFixed(2)} at ${currentResult.effectiveRate.toFixed(2)}¢/kWh` : "No current plan provided"}

Top 5 plans:
${top5.map((r, i) => `${i + 1}. ${r.plan.provider} — ${r.plan.planName} (${r.plan.planType}, ${r.plan.termMonths}mo): $${r.annualCost.toFixed(2)}/yr @ ${r.effectiveRate.toFixed(2)}¢/kWh${r.annualSavings > 0 ? ` (saves $${r.annualSavings.toFixed(2)})` : ""}${r.plan.renewable > 0 ? ` ${r.plan.renewable}% renewable` : ""}`).join("\n")}
`;

  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [{
      role: "user",
      content: `You are an expert Texas electricity rate advisor. Based on this analysis of a household's actual usage and the top plans available, write a 3-5 paragraph narrative recommendation. Be specific and practical. Mention the top plan by name and explain why it wins for this usage pattern. If a bill-credit or free-nights plan ranks high, explain the mechanism. Comment on whether the current plan is competitive.

${context}`,
    }],
  });

  return msg.content[0].type === "text" ? msg.content[0].text : "";
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const smtFile = args[0];
  const eflPdf = args[1];

  if (!smtFile) {
    console.error("Usage: bun run analyze-local.ts <smt-file> [efl-pdf]");
    console.error("  smt-file: Smart Meter Texas Green Button XML or CSV export");
    console.error("  efl-pdf:  (optional) Current plan EFL PDF for savings comparison");
    process.exit(1);
  }
  if (!fs.existsSync(smtFile)) {
    console.error(`File not found: ${smtFile}`);
    process.exit(1);
  }

  // ── Step 1: Parse usage data ─────────────────────────────────────────────
  console.log(`\nParsing SMT data: ${smtFile}`);
  const intervals = parseSmtData(smtFile);
  console.log(`  ${intervals.length} intervals parsed`);

  const months = buildMonthlyProfiles(intervals);
  console.log(`  ${months.length} complete months`);
  if (months.length === 0) {
    console.error("No complete months of data found. Check your SMT file.");
    process.exit(1);
  }

  const totalKwh = months.reduce((s, m) => s + m.totalKwh, 0);
  const annualKwh = totalKwh * (12 / months.length);
  const avgMonthly = totalKwh / months.length;
  console.log(`  Total: ${totalKwh.toFixed(0)} kWh over ${months.length} months (~${annualKwh.toFixed(0)} kWh/yr, avg ${avgMonthly.toFixed(0)} kWh/mo)`);

  // ── Step 2: Fetch plans ──────────────────────────────────────────────────
  const rawPlans = await fetchPlans(CONFIG.zip);
  console.log(`  ${rawPlans.length} plans after filtering (term >= ${CONFIG.minTerm} months)`);

  // ── Steps 3+4: Classify plans ────────────────────────────────────────────
  const classifiedPlans = rawPlans.map(classifyPlan);
  const typeCounts = classifiedPlans.reduce((acc, p) => {
    acc[p.planType] = (acc[p.planType] || 0) + 1; return acc;
  }, {} as Record<string, number>);
  console.log(`  Plan types: ${Object.entries(typeCounts).map(([k, v]) => `${k}=${v}`).join(", ")}`);

  // ── Step 5: Simulate costs ───────────────────────────────────────────────
  console.log("\nSimulating costs...");
  let results: PlanResult[] = classifiedPlans.map(p => simulatePlan(p, months));

  // ── Step 6: Current plan baseline ───────────────────────────────────────
  let currentResult: PlanResult | null = null;
  if (eflPdf) {
    if (!fs.existsSync(eflPdf)) {
      console.warn(`EFL PDF not found: ${eflPdf} — skipping current plan analysis`);
    } else {
      console.log(`\nParsing current EFL: ${eflPdf}`);
      const current = await parseCurrentEfl(eflPdf);
      if (current) {
        console.log(`  Energy rate: ${current.energyRate.toFixed(4)}¢/kWh, Base: $${current.baseCharge}/mo`);
        currentResult = simulateCurrentPlan(current.energyRate, current.baseCharge, months);
        // Calculate savings for each plan
        results = results.map(r => ({
          ...r,
          annualSavings: currentResult!.annualCost - r.annualCost,
        }));
      } else {
        console.warn("  Could not extract rates from current EFL PDF");
      }
    }
  }

  // Sort by annual cost
  results.sort((a, b) => a.annualCost - b.annualCost);

  // ── Terminal summary ──────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(72));
  console.log("  TOP 5 PLANS");
  console.log("═".repeat(72));
  results.slice(0, 5).forEach((r, i) => {
    const savings = r.annualSavings > 0 ? `  💰 saves $${r.annualSavings.toFixed(0)}/yr` : "";
    console.log(`  ${i + 1}. ${r.plan.provider} — ${r.plan.planName}`);
    console.log(`     ${r.plan.planType} | ${r.plan.termMonths}mo | $${r.annualCost.toFixed(0)}/yr | ${r.effectiveRate.toFixed(2)}¢/kWh${savings}`);
  });

  if (currentResult) {
    console.log("\n  CURRENT PLAN");
    console.log(`  $${currentResult.annualCost.toFixed(0)}/yr | ${currentResult.effectiveRate.toFixed(2)}¢/kWh`);
    const top = results[0];
    if (top.annualSavings > 0) {
      console.log(`  Best alternative saves $${top.annualSavings.toFixed(0)}/yr vs current`);
    } else {
      console.log("  Current plan is competitive with available options");
    }
  }
  console.log("═".repeat(72));

  // ── Step 7: Excel output ──────────────────────────────────────────────────
  const outputPath = path.join(process.cwd(), "plans-analysis.xlsx");
  buildExcel(results, currentResult, months, outputPath);

  // ── Claude narrative ──────────────────────────────────────────────────────
  console.log("\nGenerating Claude narrative...");
  try {
    const narrative = await generateNarrative(results, currentResult, months);
    console.log("\n" + "─".repeat(72));
    console.log(narrative);
    console.log("─".repeat(72));

    // Also save to text file
    const narrativePath = path.join(process.cwd(), "recommendation.txt");
    fs.writeFileSync(narrativePath, narrative);
    console.log(`\nNarrative saved: ${narrativePath}`);
  } catch (err: any) {
    console.warn(`\nClaude narrative skipped: ${err.message}`);
    console.warn("Set ANTHROPIC_API_KEY to enable narrative recommendations.");
  }

  console.log("\nDone.");
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
