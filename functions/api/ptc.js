// Cloudflare Pages Function — /api/ptc
// Proxies Power to Choose API to avoid browser CORS restrictions.
// Fetches both plan_type=0 (variable) and plan_type=1 (fixed) in parallel,
// merges, and deduplicates by plan_id.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
};

export async function onRequest({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  const url = new URL(request.url);
  const zip = url.searchParams.get("zip") ?? "";
  const eflUrl = url.searchParams.get("url") ?? "";

  // Health-check ping
  if (zip === "00000") {
    return new Response(JSON.stringify({ ok: true }), { headers: CORS });
  }

  if (!zip) {
    return new Response(JSON.stringify({ error: "Missing zip" }), { headers: CORS, status: 400 });
  }

  try {
    const base = `http://api.powertochoose.org/api/PowerToChoose/plans?zip_code=${zip}&key=&language=en&renewable=0&term_month=0&page_size=200`;
    const headers = { Accept: "application/json" };

    const [r0, r1] = await Promise.all([
      fetch(`${base}&plan_type=0&page_number=1`, { headers }),
      fetch(`${base}&plan_type=1&page_number=1`, { headers }),
    ]);

    if (!r0.ok) throw new Error(`PTC API returned ${r0.status}`);
    if (!r1.ok) throw new Error(`PTC API returned ${r1.status}`);

    const [j0, j1] = await Promise.all([r0.json(), r1.json()]);
    const raw = [...(j0?.data ?? []), ...(j1?.data ?? [])];

    // Deduplicate by plan_id
    const seen = new Set();
    const plans = raw.filter(p => {
      if (seen.has(p.plan_id)) return false;
      seen.add(p.plan_id);
      return true;
    });

    const parseEtf = (details) => {
      const m = (details ?? "").match(/Cancellation Fee:\s*\$\s*([\d,]+(?:\.\d+)?)/i);
      return m ? parseFloat(m[1].replace(/,/g, "")) : 0;
    };

    const mapPlan = (p) => ({
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

    // Try to match a specific plan by EFL URL if provided
    let matched = null;
    if (eflUrl) {
      matched = plans.find(p => p.fact_sheet && p.fact_sheet === eflUrl) ?? null;
      if (!matched) {
        const prod = eflUrl.match(/prodcode=([^&]+)/i);
        if (prod) {
          const code = prod[1].toLowerCase();
          matched = plans.find(p => (p.fact_sheet ?? "").toLowerCase().includes(code)) ?? null;
        }
      }
    }

    return new Response(JSON.stringify({
      success:    true,
      matched:    matched ? mapPlan(matched) : null,
      totalPlans: plans.length,
      all:        plans.map(mapPlan),
    }), { headers: CORS });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      headers: CORS,
      status: 500,
    });
  }
}
