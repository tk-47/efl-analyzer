import { spawnSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { chromium } from "playwright-core";

const PORT = 3456;

// ── Rate extraction from text ──────────────────────────────────────────────
// Texas PUC mandates every EFL show average prices at exactly 500, 1000, 2000 kWh.
function extractRates(text: string): { r500: number; r1000: number; r2000: number } | null {
  const clean = text.replace(/\r/g, "\n").replace(/[ \t]+/g, " ");
  const pricePattern = /(\d+\.?\d*)\s*[¢c]/i;

  function findRateNear(label: RegExp): number | null {
    const m = clean.match(label);
    if (!m) return null;
    const window = clean.slice(m.index!, m.index! + 300);
    const p = window.match(pricePattern);
    return p ? parseFloat(p[1]) : null;
  }

  // ── Strategy 1: "Average Price per kWh" row followed by 3 prices (column layout) ──
  // Standard EFL table: headers (500/1000/2000 kWh) in one row, prices in next row.
  const avgPriceIdx = clean.search(/average\s*price\s*per\s*kwh/i);
  if (avgPriceIdx !== -1) {
    const after = clean.slice(avgPriceIdx, avgPriceIdx + 300);
    const prices = [...after.matchAll(/(\d+\.?\d*)\s*[¢c]/gi)]
      .map(m => parseFloat(m[1]))
      .filter(v => v >= 1 && v <= 50);
    if (prices.length >= 3) return { r500: prices[0], r1000: prices[1], r2000: prices[2] };
  }

  // ── Strategy 2: Each price appears near its kWh label (inline layout) ──
  const r500  = findRateNear(/500\s*kWh/i);
  const r1000 = findRateNear(/1[,.]?000\s*kWh/i);
  const r2000 = findRateNear(/2[,.]?000\s*kWh/i);

  if (r500 && r1000 && r2000) return { r500, r1000, r2000 };

  // ── Strategy 3: grab first 3 plausible ¢ values in order ──
  const all = [...clean.matchAll(/(\d+\.?\d*)\s*[¢c]/gi)]
    .map(m => parseFloat(m[1]))
    .filter(v => v >= 1 && v <= 50);
  if (all.length >= 3) return { r500: all[0], r1000: all[1], r2000: all[2] };

  return null;
}

function extractMeta(text: string) {
  const meta: Record<string, string> = {};

  // Provider — labeled or EFL header pattern "Name • PUCT Cert. #NNNNN"
  const repLabeled = text.match(/(?:retail electric provider|provider|company)[:\s]+([^\n]{3,60})/i);
  const repPuct    = text.match(/^([^\n•]{3,60})\s*•\s*PUCT\s*Cert/im);
  if (repLabeled) meta.provider = repLabeled[1].trim().replace(/\s+/g, " ");
  else if (repPuct) meta.provider = repPuct[1].trim();

  // Plan name — labeled or second line of EFL header
  const planLabeled = text.match(/(?:plan name|product name)[:\s]+([^\n]{3,80})/i);
  if (planLabeled) meta.planName = planLabeled[1].trim();
  else {
    // EFL header: "Provider Name\nPlan Name\nTDU Name"
    const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
    const puct = lines.findIndex(l => /PUCT\s*Cert/i.test(l));
    if (puct !== -1 && lines[puct + 1]) meta.planName = lines[puct + 1];
    else if (lines[1] && lines[1].length > 4) meta.planName = lines[1];
  }

  // ETF — "$NNN early termination fee" or "assess a $NNN early termination"
  const flat = text.replace(/\n/g, " ");
  const etf = flat.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(?:early\s*termination|cancellation)\s*fee/i)
           || flat.match(/(?:early\s*termination|cancellation)\s*fee[^$]*?\$\s*([\d,]+(?:\.\d+)?)/i);
  if (etf) meta.etf = etf[1].replace(/,/g, "");

  const term = text.match(/(\d+)[- ]?month/i);
  if (term) meta.term = term[1];

  // Credit — "Usage Credit of $125.00" or "$125.00 credit"
  const creditOf = text.match(/(?:usage\s*)?credit\s+of\s+\$\s*([\d,]+(?:\.\d+)?)/i);
  const creditAmt = text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(?:usage\s*)?credit/i);
  if (creditOf) meta.credit = creditOf[1].replace(/,/g, "");
  else if (creditAmt) meta.credit = creditAmt[1].replace(/,/g, "");

  // Credit threshold — "above or equal to 1000 kWh" / ">= 1000 kWh" / "exceeds 1000 kWh"
  const thresh = flat.match(
    /credit.{0,300}?(?:above\s*or\s*equal\s*to?|equals?\s*or\s*exceeds?|>=|≥)\s*([\d,]+)\s*kWh/i
  );
  if (thresh) meta.creditThreshold = thresh[1].replace(/,/g, "");

  if (/variable\s*rate/i.test(text))    meta.planType = "variable";
  else if (/fixed\s*rate/i.test(text))  meta.planType = "fixed";
  else if (/indexed/i.test(text))        meta.planType = "indexed";
  return meta;
}

// ── PDF → text via pdftotext ───────────────────────────────────────────────
async function pdfToText(buffer: Buffer): Promise<string> {
  const tmp = join(tmpdir(), `efl-${Date.now()}.pdf`);
  try {
    writeFileSync(tmp, buffer);
    const result = spawnSync("pdftotext", [tmp, "-"], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.stdout && result.stdout.trim().length > 30) return result.stdout;
    throw new Error("pdftotext produced empty output");
  } finally {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
  }
}

// ── Power to Choose API ────────────────────────────────────────────────────
// plan_type=0 returns variable plans; plan_type=1 returns fixed plans.
// Fetch both in parallel and merge, deduplicating by plan_id.
async function fetchPtc(zip: string): Promise<any[]> {
  const base = `http://api.powertochoose.org/api/PowerToChoose/plans?zip_code=${zip}&key=&language=en&renewable=0&term_month=0&page_size=200`;
  const [r0, r1] = await Promise.all([
    fetch(`${base}&plan_type=0&page_number=1`, { headers: { Accept: "application/json" } }),
    fetch(`${base}&plan_type=1&page_number=1`, { headers: { Accept: "application/json" } }),
  ]);
  if (!r0.ok) throw new Error(`PTC API ${r0.status}`);
  if (!r1.ok) throw new Error(`PTC API ${r1.status}`);
  const [j0, j1]: any[] = await Promise.all([r0.json(), r1.json()]);
  const all = [...(j0?.data ?? []), ...(j1?.data ?? [])];
  // Deduplicate by plan_id
  const seen = new Set<number>();
  return all.filter(p => {
    if (seen.has(p.plan_id)) return false;
    seen.add(p.plan_id);
    return true;
  });
}

// ── Server ─────────────────────────────────────────────────────────────────
const srv = Bun.serve({
  port: PORT,
  async fetch(req) {
    const u = new URL(req.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    // ── /api/extract?url=... ──────────────────────────────────────────────
    if (u.pathname === "/api/extract") {
      const eflUrl = u.searchParams.get("url");
      if (!eflUrl) return new Response(JSON.stringify({ error: "Missing url" }), { headers: cors, status: 400 });

      try {
        const isPdf = /\.pdf(\?|$)/i.test(eflUrl);

        // ── Direct PDF ──
        if (isPdf) {
          console.log("📄 Fetching PDF:", eflUrl);
          const res = await fetch(eflUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
          if (!res.ok) throw new Error(`HTTP ${res.status} from PDF URL`);
          const buf  = Buffer.from(await res.arrayBuffer());
          const text = await pdfToText(buf);
          const rates = extractRates(text);
          const meta  = extractMeta(text);
          if (!rates) throw new Error("Found the PDF but couldn't locate the rate table. It may be image-based (scanned).");
          return new Response(JSON.stringify({ success: true, source: "pdf", rates, meta }), { headers: cors });
        }

        // ── HTML page — fetch and look for embedded PDF link ──
        console.log("🌐 Fetching page:", eflUrl);
        const res = await fetch(eflUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            "Accept": "text/html,*/*",
          }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();

        // Try to extract rates directly from the HTML text
        const stripped = html
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
          .replace(/\s{2,}/g, " ");

        const htmlRates = extractRates(stripped);
        if (htmlRates) {
          const meta = extractMeta(stripped);
          return new Response(JSON.stringify({ success: true, source: "html", rates: htmlRates, meta }), { headers: cors });
        }

        // Look for a PDF link embedded in the page
        const pdfMatch = html.match(/["'](https?:\/\/[^"']+\.pdf[^"']*)/i)
          || html.match(/href=["']([^"']+\.pdf[^"']*)/i);
        if (pdfMatch) {
          const pdfUrl = pdfMatch[1].startsWith("http") ? pdfMatch[1] : new URL(pdfMatch[1], eflUrl).href;
          console.log("📎 Found embedded PDF:", pdfUrl);
          const pr = await fetch(pdfUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
          if (pr.ok) {
            const buf  = Buffer.from(await pr.arrayBuffer());
            const text = await pdfToText(buf);
            const rates = extractRates(text);
            const meta  = extractMeta(text);
            if (rates) return new Response(JSON.stringify({ success: true, source: "embedded-pdf", pdfUrl, rates, meta }), { headers: cors });
          }
        }

        // ── Playwright fallback for JS-rendered pages ──
        console.log("🎭 Trying headless browser:", eflUrl);
        try {
          const browser = await chromium.launch({ headless: true });
          const context = await browser.newContext({ acceptDownloads: true });
          const page = await context.newPage();

          // Race: either the page loads normally, or a download starts
          let downloadBuf: Buffer | null = null;
          const [response] = await Promise.all([
            page.goto(eflUrl, { waitUntil: "domcontentloaded", timeout: 30000 })
              .catch(() => null),
            page.waitForEvent("download", { timeout: 30000 })
              .then(async (dl) => {
                const stream = await dl.createReadStream();
                const chunks: Buffer[] = [];
                for await (const chunk of stream) chunks.push(Buffer.from(chunk));
                downloadBuf = Buffer.concat(chunks);
              })
              .catch(() => {}),
          ]);

          // If a PDF was downloaded directly, parse it
          if (downloadBuf) {
            await browser.close();
            console.log("📥 Playwright captured PDF download");
            const text = await pdfToText(downloadBuf);
            const rates = extractRates(text);
            const meta  = extractMeta(text);
            if (rates) return new Response(JSON.stringify({ success: true, source: "playwright-download", rates, meta }), { headers: cors });
            throw new Error("Downloaded the PDF but couldn't locate the rate table (may be image-based).");
          }

          // Check for a PDF link rendered by JS
          const pdfHref = await page.evaluate(() => {
            const a = Array.from(document.querySelectorAll("a[href]"))
              .find(el => /\.pdf/i.test((el as HTMLAnchorElement).href));
            return a ? (a as HTMLAnchorElement).href : null;
          }).catch(() => null);

          if (pdfHref) {
            await browser.close();
            console.log("📎 Playwright found PDF link:", pdfHref);
            const pr = await fetch(pdfHref, { headers: { "User-Agent": "Mozilla/5.0" } });
            if (pr.ok) {
              const buf  = Buffer.from(await pr.arrayBuffer());
              const text = await pdfToText(buf);
              const rates = extractRates(text);
              const meta  = extractMeta(text);
              if (rates) return new Response(JSON.stringify({ success: true, source: "playwright-pdf", pdfUrl: pdfHref, rates, meta }), { headers: cors });
            }
          }

          // Extract visible text from the rendered page
          const pageText = await page.evaluate(() => document.body.innerText).catch(() => "");
          await browser.close();

          const pwRates = extractRates(pageText);
          if (pwRates) {
            const meta = extractMeta(pageText);
            return new Response(JSON.stringify({ success: true, source: "playwright-html", rates: pwRates, meta }), { headers: cors });
          }

          return new Response(JSON.stringify({
            success: false,
            source: "playwright-html",
            error: "Loaded the page with a headless browser but couldn't find the rate table. The EFL may be image-based or behind a login.",
            hint: "Try pasting the direct PDF link, or use the Power to Choose zip lookup.",
          }), { headers: cors });

        } catch (pwErr: any) {
          console.error("Playwright error:", pwErr.message);
          return new Response(JSON.stringify({
            success: false,
            source: "js-rendered",
            error: "Headless browser failed: " + pwErr.message,
            hint: "Try the Power to Choose lookup (enter your zip code), or find the direct PDF link from the EFL page and paste that instead.",
          }), { headers: cors });
        }

      } catch (err: any) {
        console.error("Extract error:", err.message);
        return new Response(JSON.stringify({ success: false, error: err.message }), { headers: cors, status: 500 });
      }
    }

    // ── /api/ptc?zip=...&url=... ─────────────────────────────────────────
    if (u.pathname === "/api/ptc") {
      const zip    = u.searchParams.get("zip") ?? "";
      const eflUrl = u.searchParams.get("url") ?? "";
      // Return empty result for dummy health-check zip
      if (zip === "00000") return new Response(JSON.stringify({ ok: true }), { headers: cors });
      if (!zip) return new Response(JSON.stringify({ error: "Missing zip" }), { headers: cors, status: 400 });

      try {
        const plans = await fetchPtc(zip);

        // Match by fact_sheet URL exact match first
        let matched = plans.find((p: any) => p.fact_sheet && eflUrl && p.fact_sheet === eflUrl);

        // Match by plan code in URL (e.g. prodcode=GXAECOSVRPLS12)
        if (!matched && eflUrl) {
          const prod = eflUrl.match(/prodcode=([^&]+)/i);
          if (prod) {
            const code = prod[1].toLowerCase();
            matched = plans.find((p: any) => (p.fact_sheet ?? "").toLowerCase().includes(code));
          }
        }

        const parseEtf = (details: string): number => {
          const m = (details ?? "").match(/Cancellation Fee:\s*\$\s*([\d,]+(?:\.\d+)?)/i);
          return m ? parseFloat(m[1].replace(/,/g, "")) : 0;
        };

        const mapPlan = (p: any) => ({
          provider:    p.company_name,
          planName:    p.plan_name,
          planType:    (p.rate_type ?? "").toLowerCase().includes("variable") ? "variable" : "fixed",
          r500:        p.price_kwh500,
          r1000:       p.price_kwh1000,
          r2000:       p.price_kwh2000,
          etf:         parseEtf(p.pricing_details),
          eflUrl:      p.fact_sheet,
          renewable:   (p.renewable_energy_id ?? 0) > 0,
          newCustomer: p.new_customer === true,
          prepaid:     p.prepaid === true,
          timeOfUse:   p.timeofuse === true,
          minUsage:    p.minimum_usage === true,
        });

        return new Response(JSON.stringify({
          success:    true,
          matched:    matched ? mapPlan(matched) : null,
          totalPlans: plans.length,
          all:        plans.map(mapPlan),
        }), { headers: cors });

      } catch (err: any) {
        return new Response(JSON.stringify({ success: false, error: err.message }), { headers: cors, status: 500 });
      }
    }

    // ── Serve index.html ─────────────────────────────────────────────────
    if (u.pathname === "/" || u.pathname === "/index.html") {
      return new Response(Bun.file("index.html"), { headers: { "Content-Type": "text/html" } });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`\n⚡ EFL Analyzer running at http://localhost:${PORT}\n`);
