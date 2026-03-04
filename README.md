# EFL Analyzer

A tool for analyzing Texas Electricity Facts Labels (EFLs). Paste an EFL link and instantly get bill projections, a breakdown of hidden charges, and key takeaways — no manual data entry required.

## Features

- **Auto-extraction** — paste any EFL URL and rates are pulled automatically. Handles JS-rendered pages, PDF downloads, and embedded PDF links via a headless browser fallback (Playwright + Chromium).
- **Bill projections** — see your estimated bill at 500, 1000, 1500, 2000, and 2500 kWh, plus a custom usage level.
- **Hidden charge breakdown** — back-calculates the true marginal rate, fixed monthly charges, and bill credit structure from the three standard EFL average prices.
- **Plan comparison** — analyze up to 4 plans side-by-side with a color-coded table and winner summary.
- **Power to Choose lookup** — enter your ZIP code to pull live plan data directly from the Texas PUC API.
- **Key takeaways** — plain-English summary covering plan type (fixed vs. variable), bill credit structure, ETF, marginal rate, and how you compare to the Texas average.

## How It Works

Texas PUC requires every EFL to show average prices at exactly 500, 1000, and 2000 kWh. From those three numbers, all hidden components can be back-calculated:

```
marginal_rate     = 2 × r2000 − r1000          (¢/kWh — what each extra kWh costs you)
fixed_monthly     = (r500 − marginal_rate) × 5  ($ — TDU customer/meter charge)
fixed_with_credit = (r1000 − marginal_rate) × 10
bill_credit       = fixed_monthly − fixed_with_credit
```

## Requirements

- [Bun](https://bun.sh) v1.3+
- `pdftotext` — install via `brew install poppler`
- Chromium — installed automatically by Playwright on first run

## Setup

```bash
bun install
bunx playwright install chromium
bun server.ts
```

Then open **http://localhost:3456** in your browser.

## Usage

1. Find an EFL link from your provider's website or [Power to Choose](https://www.powertochoose.org)
2. Paste the URL into the **EFL URL** field and click **Extract Rates**
3. Enter your monthly kWh usage and click **Analyze**
4. Optionally add more plans to the **Compare Plans** tab

> **Tip:** If auto-extraction fails (some providers block bots), use the **PTC Lookup** — enter your ZIP code to pull rate data directly from the Texas PUC.

## API

The local server exposes two endpoints:

### `GET /api/extract?url=<efl-url>`
Fetches and parses an EFL page or PDF, returning rates and plan metadata.

### `GET /api/ptc?zip=<zip>&url=<efl-url>`
Queries the Power to Choose API for a ZIP code and attempts to match the provided EFL URL to a specific plan.

## Notes

- EFL rates are updated by providers periodically. Always verify against the current EFL before signing up.
- TDU delivery charges (set by the state utility, not your REP) can be adjusted and are passed through to customers — this is the only component that can change on a fixed-rate plan.
- Bill credit plans advertise low rates at the credit threshold (often 1,000 kWh) but the effective rate rises at higher usage levels. This tool makes that visible.
