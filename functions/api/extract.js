// Cloudflare Pages Function — /api/extract
// Fetches an EFL URL (HTML or PDF) and extracts the three average rates.
// Handles FlateDecode-compressed PDF streams using the built-in DecompressionStream API.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
};

// ── PDF decompression ───────────────────────────────────────────────────────
async function decompressWith(format, bytes) {
  const ds = new DecompressionStream(format);
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(bytes);
  writer.close();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

async function decompress(bytes) {
  // Try zlib first (RFC 1950 — standard PDF FlateDecode)
  try {
    return await decompressWith("deflate", bytes);
  } catch (_) {}
  // Fallback: raw deflate (RFC 1951 — some PDF generators)
  try {
    return await decompressWith("deflate-raw", bytes);
  } catch (_) {}
  throw new Error("decompression failed");
}

// ── Content stream text extraction ─────────────────────────────────────────
// Extracts visible text from a decompressed PDF content stream.
function extractFromContentStream(content) {
  const parts = [];
  // Pull text from BT...ET blocks
  const btEt = /BT\s([\s\S]*?)ET/g;
  let m;
  while ((m = btEt.exec(content)) !== null) {
    const block = m[1];
    // Parenthesized strings: (text)Tj  [(text1)(text2)]TJ  etc.
    const strRe = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g;
    let sm;
    while ((sm = strRe.exec(block)) !== null) {
      const s = sm[1]
        .replace(/\\n/g, "\n").replace(/\\r/g, "\n").replace(/\\t/g, " ")
        .replace(/\\\(/g, "(").replace(/\\\)/g, ")")
        .replace(/\\\\/g, "\\")
        .replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
      if (s.trim().length > 0) parts.push(s);
    }
  }
  return parts.join(" ");
}

// ── Dictionary boundary helpers ─────────────────────────────────────────────
function findStreamDictEnd(raw, streamKw) {
  // Walk backward from "stream" to find the first ">>" (closes the stream dict)
  for (let i = streamKw - 1; i >= 1; i--) {
    if (raw[i] === '>' && raw[i - 1] === '>') return i - 1;
  }
  return -1;
}

function findMatchingDictStart(raw, endPos) {
  if (endPos < 0) return -1;
  let depth = 0;
  for (let i = endPos; i >= 1; i--) {
    if (raw[i] === '>' && raw[i - 1] === '>') { depth++; i--; }
    else if (raw[i] === '<' && raw[i - 1] === '<') {
      depth--;
      if (depth === 0) return i - 1;
      i--;
    }
  }
  return -1;
}

// ── Full PDF text extraction with FlateDecode support ──────────────────────
async function extractPdfText(arrayBuffer) {
  const raw = new TextDecoder("latin-1").decode(new Uint8Array(arrayBuffer));
  const allText = [];
  let pos = 0;

  while (pos < raw.length) {
    // Find next stream keyword
    const streamKw = raw.indexOf("stream", pos);
    if (streamKw === -1) break;

    // Must be followed immediately by \n, \r\n, or bare \r (old Mac PDFs)
    const c1 = raw[streamKw + 6];
    const c2 = raw[streamKw + 7];
    let dataStart;
    if (c1 === "\r" && c2 === "\n") dataStart = streamKw + 8;
    else if (c1 === "\n")           dataStart = streamKw + 7;
    else if (c1 === "\r")           dataStart = streamKw + 7; // bare CR (old Mac PDF)
    else { pos = streamKw + 6; continue; }

    // Find the dictionary that precedes this stream
    // Walk backward to find the ">>" that closes the stream dict (not an inner dict)
    const dictEnd   = findStreamDictEnd(raw, streamKw);
    const dictStart = findMatchingDictStart(raw, dictEnd);
    const dict      = dictStart >= 0 ? raw.slice(dictStart, dictEnd + 2) : "";

    // Get declared stream length
    const lenMatch     = dict.match(/\/Length\s+(\d+)/);
    const declaredLen  = lenMatch ? parseInt(lenMatch[1]) : null;
    const dataEnd      = declaredLen ? dataStart + declaredLen : raw.indexOf("endstream", dataStart);
    if (dataEnd <= dataStart) { pos = dataStart + 1; continue; }

    const isFlate = /\/Filter\s*\[\s*\/FlateDecode|\/(?:Filter\s+)?FlateDecode|\/Fl[\s\/\>\]%]/i.test(dict);

    if (isFlate) {
      try {
        // Convert latin-1 string slice back to raw bytes
        const len   = dataEnd - dataStart;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = raw.charCodeAt(dataStart + i) & 0xFF;
        const decompressed = await decompress(bytes);
        const content      = new TextDecoder("latin-1").decode(decompressed);
        const text         = extractFromContentStream(content);
        if (text.trim()) allText.push(text);
      } catch (_) {
        // Decompression failed — skip this stream
      }
    } else {
      // Uncompressed stream — try direct parsing
      const content = raw.slice(dataStart, dataEnd);
      const text    = extractFromContentStream(content);
      if (text.trim()) allText.push(text);
    }

    pos = dataEnd + 9; // skip past "endstream"
  }

  return allText.join("\n");
}

// ── Text sanity check ───────────────────────────────────────────────────────
// Only ASCII printable + named accented chars; stricter 10% threshold
const CLEAN_RE = /[^\x20-\x7E\n\r\t¢°©®™áéíóúàèìòùäëïöüâêîôûãõñçÁÉÍÓÚÀÈÌÒÙÄËÏÖÜÂÊÎÔÛÃÕÑÇ]/g;
function isCleanText(str) {
  if (!str || str.length < 2) return false;
  const nonPrintable = (str.match(CLEAN_RE) || []).length;
  return nonPrintable / str.length < 0.10;
}

function sanitize(str) {
  return str.replace(CLEAN_RE, " ").replace(/\s{2,}/g, " ").trim();
}

// ── Rate extraction ─────────────────────────────────────────────────────────
function extractRates(text) {
  if (!isCleanText(text)) return null;
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
    const after  = clean.slice(idx, idx + 300);
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

// ── Validate extracted rates make physical sense ────────────────────────────
function ratesAreValid(r) {
  if (!r) return false;
  // All three rates must be in plausible range
  if (r.r500 < 1 || r.r500 > 50) return false;
  if (r.r1000 < 1 || r.r1000 > 50) return false;
  if (r.r2000 < 1 || r.r2000 > 50) return false;
  // 500 kWh rate should almost always be >= 1000 kWh rate (fixed cost dilution)
  // (bill-credit plans may invert this slightly — allow up to 2¢ below)
  if (r.r500 < r.r1000 - 2) return false;
  return true;
}

// ── Meta extraction ─────────────────────────────────────────────────────────
function extractMeta(text) {
  // If the overall text is dirty, don't mine it for metadata
  if (!isCleanText(text)) return {};

  const meta = {};
  const flat = text.replace(/\n/g, " ");

  // Helper: sanitize a match and discard if > 30% chars were garbage
  function cleanMatch(s) {
    const cleaned = sanitize(s);
    if (cleaned.length < s.length * 0.70) return null;
    return cleaned;
  }

  const repLabeled = text.match(/(?:retail electric provider|provider|company)[:\s]+([^\n]{3,60})/i);
  const repPuct    = text.match(/^([^\n•]{3,60})\s*•\s*PUCT\s*Cert/im);
  if (repLabeled && isCleanText(repLabeled[1]))  meta.provider = cleanMatch(repLabeled[1]) ?? undefined;
  else if (repPuct && isCleanText(repPuct[1]))  meta.provider = cleanMatch(repPuct[1]) ?? undefined;
  if (meta.provider === undefined) delete meta.provider;

  const planLabeled = text.match(/(?:plan name|product name)[:\s]+([^\n]{3,80})/i);
  if (planLabeled && isCleanText(planLabeled[1])) {
    meta.planName = cleanMatch(planLabeled[1]) ?? undefined;
    if (meta.planName === undefined) delete meta.planName;
  } else {
    const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
    const puct  = lines.findIndex(l => /PUCT\s*Cert/i.test(l));
    if (puct !== -1 && lines[puct + 1] && isCleanText(lines[puct + 1])) {
      meta.planName = cleanMatch(lines[puct + 1]) ?? undefined;
      if (meta.planName === undefined) delete meta.planName;
    } else if (lines[1] && lines[1].length > 4 && isCleanText(lines[1])) {
      meta.planName = cleanMatch(lines[1]) ?? undefined;
      if (meta.planName === undefined) delete meta.planName;
    }
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

  const url    = new URL(request.url);
  const eflUrl = url.searchParams.get("url");
  if (!eflUrl) {
    return new Response(JSON.stringify({ error: "Missing url parameter" }), { headers: CORS, status: 400 });
  }

  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36";

  async function tryPdf(buffer) {
    const text  = await extractPdfText(buffer);
    const rates = extractRates(text);
    const meta  = extractMeta(text);
    if (!ratesAreValid(rates)) return null;
    return { text, rates, meta };
  }

  try {
    const isPdf = /\.pdf(\?|$)/i.test(eflUrl);

    // ── Direct PDF ──────────────────────────────────────────────────────────
    if (isPdf) {
      const res = await fetch(eflUrl, { headers: { "User-Agent": ua } });
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching PDF`);
      const result = await tryPdf(await res.arrayBuffer());
      if (!result) {
        return new Response(JSON.stringify({
          success: false,
          error: "Could not extract rates from this PDF. It may use image-based text (scanned). Try entering the three rates manually from the EFL document.",
        }), { headers: CORS });
      }
      return new Response(JSON.stringify({ success: true, source: "pdf", rates: result.rates, meta: result.meta }), { headers: CORS });
    }

    // ── HTML page ───────────────────────────────────────────────────────────
    const res = await fetch(eflUrl, { headers: { "User-Agent": ua, Accept: "text/html,*/*" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const contentType = res.headers.get("content-type") ?? "";

    // Server returned a PDF despite HTML-looking URL
    if (contentType.includes("application/pdf")) {
      const result = await tryPdf(await res.arrayBuffer());
      if (result) return new Response(JSON.stringify({ success: true, source: "pdf", rates: result.rates, meta: result.meta }), { headers: CORS });
      return new Response(JSON.stringify({ success: false, error: "PDF is image-based and cannot be read automatically. Enter the three rates manually." }), { headers: CORS });
    }

    const html = await res.text();

    // Strip tags and extract from HTML text
    const stripped = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&cent;/g, "¢")
      .replace(/\s{2,}/g, " ");

    const htmlRates = extractRates(stripped);
    if (ratesAreValid(htmlRates)) {
      return new Response(JSON.stringify({ success: true, source: "html", rates: htmlRates, meta: extractMeta(stripped) }), { headers: CORS });
    }

    // Look for an embedded PDF link and try fetching it
    const pdfMatch = html.match(/["'](https?:\/\/[^"']+\.pdf[^"']*)/i)
                  || html.match(/href=["']([^"']+\.pdf[^"']*)/i);
    if (pdfMatch) {
      const pdfUrl = pdfMatch[1].startsWith("http") ? pdfMatch[1] : new URL(pdfMatch[1], eflUrl).href;
      const pr = await fetch(pdfUrl, { headers: { "User-Agent": ua } });
      if (pr.ok) {
        const result = await tryPdf(await pr.arrayBuffer());
        if (result) return new Response(JSON.stringify({ success: true, source: "embedded-pdf", rates: result.rates, meta: result.meta }), { headers: CORS });
      }
    }

    return new Response(JSON.stringify({
      success: false,
      error: "Could not extract rates from this page. The provider may use a format that cannot be read automatically.",
      hint: "Try finding the direct PDF link from the EFL page and paste that URL instead.",
    }), { headers: CORS });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { headers: CORS, status: 500 });
  }
}
