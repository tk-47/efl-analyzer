// Cloudflare Pages Function — /api/extract
// Fetches an EFL URL (HTML or PDF) and extracts the three average rates.
// No pdftotext or Playwright available in Workers — uses pure-JS PDF text extraction.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
};

// ── PDF text extraction ─────────────────────────────────────────────────────
// Reads raw PDF bytes and extracts visible text from content streams.
// Works for standard text-based PDFs (the vast majority of EFL documents).
function extractTextFromPdfBytes(buffer) {
  // Decode as latin-1 to preserve all bytes
  const raw = new TextDecoder("latin-1").decode(buffer);
  const parts = [];

  // Strategy 1: extract strings from BT...ET blocks (text blocks)
  const btEt = /BT\s([\s\S]*?)ET/g;
  let btMatch;
  while ((btMatch = btEt.exec(raw)) !== null) {
    const block = btMatch[1];
    // Parenthesized strings: (text)Tj or [(text)]TJ
    const strRe = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g;
    let m;
    while ((m = strRe.exec(block)) !== null) {
      const s = m[1]
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\n")
        .replace(/\\t/g, " ")
        .replace(/\\\(/g, "(")
        .replace(/\\\)/g, ")")
        .replace(/\\\\/g, "\\")
        .replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
      if (s.trim()) parts.push(s);
    }
  }

  // Strategy 2: if BT/ET extraction is empty, grab all parenthesized strings
  // (some PDFs use different stream structures)
  if (parts.length < 5) {
    const allStrings = /\(([^)\\]{2,}(?:\\.[^)\\]*)*)\)\s*(?:Tj|'|")/g;
    let m2;
    while ((m2 = allStrings.exec(raw)) !== null) {
      const s = m2[1].replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\\\/g, "\\");
      if (s.trim()) parts.push(s);
    }
  }

  return parts.join(" ");
}

// ── Rate extraction ─────────────────────────────────────────────────────────
function extractRates(text) {
  const clean = text.replace(/\r/g, "\n").replace(/[ \t]+/g, " ");
  const priceRe = /(\d+\.?\d*)\s*[¢c]/i;

  function findRateNear(label) {
    const m = clean.match(label);
    if (!m) return null;
    const window = clean.slice(m.index, m.index + 300);
    const p = window.match(priceRe);
    return p ? parseFloat(p[1]) : null;
  }

  // Strategy 1: "Average Price per kWh" row then 3 prices
  const idx = clean.search(/average\s*price\s*per\s*kwh/i);
  if (idx !== -1) {
    const after = clean.slice(idx, idx + 300);
    const prices = [...after.matchAll(/(\d+\.?\d*)\s*[¢c]/gi)]
      .map(m => parseFloat(m[1]))
      .filter(v => v >= 1 && v <= 50);
    if (prices.length >= 3) return { r500: prices[0], r1000: prices[1], r2000: prices[2] };
  }

  // Strategy 2: each price near its kWh label
  const r500  = findRateNear(/500\s*kWh/i);
  const r1000 = findRateNear(/1[,.]?000\s*kWh/i);
  const r2000 = findRateNear(/2[,.]?000\s*kWh/i);
  if (r500 && r1000 && r2000) return { r500, r1000, r2000 };

  // Strategy 3: first 3 plausible ¢ values
  const all = [...clean.matchAll(/(\d+\.?\d*)\s*[¢c]/gi)]
    .map(m => parseFloat(m[1]))
    .filter(v => v >= 1 && v <= 50);
  if (all.length >= 3) return { r500: all[0], r1000: all[1], r2000: all[2] };

  return null;
}

// ── Meta extraction ─────────────────────────────────────────────────────────
function extractMeta(text) {
  const meta = {};
  const flat = text.replace(/\n/g, " ");

  const repLabeled = text.match(/(?:retail electric provider|provider|company)[:\s]+([^\n]{3,60})/i);
  const repPuct    = text.match(/^([^\n•]{3,60})\s*•\s*PUCT\s*Cert/im);
  if (repLabeled)  meta.provider = repLabeled[1].trim().replace(/\s+/g, " ");
  else if (repPuct) meta.provider = repPuct[1].trim();

  const planLabeled = text.match(/(?:plan name|product name)[:\s]+([^\n]{3,80})/i);
  if (planLabeled) {
    meta.planName = planLabeled[1].trim();
  } else {
    const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
    const puct = lines.findIndex(l => /PUCT\s*Cert/i.test(l));
    if (puct !== -1 && lines[puct + 1]) meta.planName = lines[puct + 1];
    else if (lines[1] && lines[1].length > 4) meta.planName = lines[1];
  }

  const etf = flat.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(?:early\s*termination|cancellation)\s*fee/i)
           || flat.match(/(?:early\s*termination|cancellation)\s*fee[^$]*?\$\s*([\d,]+(?:\.\d+)?)/i);
  if (etf) meta.etf = etf[1].replace(/,/g, "");

  const term = text.match(/(\d+)[- ]?month/i);
  if (term) meta.term = term[1];

  const creditOf  = text.match(/(?:usage\s*)?credit\s+of\s+\$\s*([\d,]+(?:\.\d+)?)/i);
  const creditAmt = text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(?:usage\s*)?credit/i);
  if (creditOf) meta.credit = creditOf[1].replace(/,/g, "");
  else if (creditAmt) meta.credit = creditAmt[1].replace(/,/g, "");

  const thresh = flat.match(
    /credit.{0,300}?(?:above\s*or\s*equal\s*to?|equals?\s*or\s*exceeds?|>=|≥)\s*([\d,]+)\s*kWh/i
  );
  if (thresh) meta.creditThreshold = thresh[1].replace(/,/g, "");

  if (/variable\s*rate/i.test(text))   meta.planType = "variable";
  else if (/fixed\s*rate/i.test(text)) meta.planType = "fixed";
  else if (/indexed/i.test(text))      meta.planType = "indexed";

  return meta;
}

// ── Handler ─────────────────────────────────────────────────────────────────
export async function onRequest({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  const url = new URL(request.url);
  const eflUrl = url.searchParams.get("url");

  if (!eflUrl) {
    return new Response(JSON.stringify({ error: "Missing url parameter" }), { headers: CORS, status: 400 });
  }

  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36";

  try {
    const isPdf = /\.pdf(\?|$)/i.test(eflUrl);

    // ── Direct PDF ──────────────────────────────────────────────────────────
    if (isPdf) {
      const res = await fetch(eflUrl, { headers: { "User-Agent": ua } });
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching PDF`);
      const buffer = await res.arrayBuffer();
      const text = extractTextFromPdfBytes(buffer);
      const rates = extractRates(text);
      const meta  = extractMeta(text);
      if (!rates) {
        return new Response(JSON.stringify({
          success: false,
          error: "Found the PDF but could not locate the rate table. It may be image-based (scanned). Try entering the three rates manually.",
        }), { headers: CORS });
      }
      return new Response(JSON.stringify({ success: true, source: "pdf", rates, meta }), { headers: CORS });
    }

    // ── HTML page ───────────────────────────────────────────────────────────
    const res = await fetch(eflUrl, {
      headers: { "User-Agent": ua, Accept: "text/html,*/*" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const contentType = res.headers.get("content-type") ?? "";

    // Sometimes a URL looks like HTML but server returns a PDF
    if (contentType.includes("application/pdf")) {
      const buffer = await res.arrayBuffer();
      const text = extractTextFromPdfBytes(buffer);
      const rates = extractRates(text);
      const meta  = extractMeta(text);
      if (rates) return new Response(JSON.stringify({ success: true, source: "pdf", rates, meta }), { headers: CORS });
      return new Response(JSON.stringify({
        success: false,
        error: "PDF is image-based and cannot be read automatically. Enter the three rates manually.",
      }), { headers: CORS });
    }

    const html = await res.text();

    // Strip tags and extract from HTML text
    const stripped = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&cent;/g, "¢")
      .replace(/\s{2,}/g, " ");

    const htmlRates = extractRates(stripped);
    if (htmlRates) {
      const meta = extractMeta(stripped);
      return new Response(JSON.stringify({ success: true, source: "html", rates: htmlRates, meta }), { headers: CORS });
    }

    // Look for an embedded PDF link and try to fetch it
    const pdfMatch = html.match(/["'](https?:\/\/[^"']+\.pdf[^"']*)/i)
                  || html.match(/href=["']([^"']+\.pdf[^"']*)/i);
    if (pdfMatch) {
      const pdfUrl = pdfMatch[1].startsWith("http")
        ? pdfMatch[1]
        : new URL(pdfMatch[1], eflUrl).href;
      const pr = await fetch(pdfUrl, { headers: { "User-Agent": ua } });
      if (pr.ok) {
        const buffer = await pr.arrayBuffer();
        const text = extractTextFromPdfBytes(buffer);
        const rates = extractRates(text);
        const meta  = extractMeta(text);
        if (rates) {
          return new Response(JSON.stringify({ success: true, source: "embedded-pdf", rates, meta }), { headers: CORS });
        }
      }
    }

    return new Response(JSON.stringify({
      success: false,
      error: "Could not find the rate table in this page. If you have the direct PDF link, paste that instead. Or use the zip code search to find the plan's published rates.",
      hint: "Some providers use JavaScript to render their EFL pages — try finding the direct .pdf link from the EFL page.",
    }), { headers: CORS });

  } catch (err) {
    return new Response(JSON.stringify({
      success: false,
      error: err.message,
    }), { headers: CORS, status: 500 });
  }
}
