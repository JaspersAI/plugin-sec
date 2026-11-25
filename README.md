# SEC EDGAR for Jaspers Terminal

Primary-source SEC EDGAR filings, full-text search, XBRL company facts, parsed Form 4 insider buys/sells, electronic Form 144 sell notices, Schedule 13D/13G beneficial ownership stakes, and Form 10-K Exhibit 21 subsidiary lists—straight from `sec.gov` with no API key required.

- **Sources:**
  - `sec/filings` — Company filings list, newest first, optionally filtered by form (`10-K`, `10-Q`, `8-K`, `4`)
  - `sec/search` — Full-text boolean search across EDGAR (`efts.sec.gov/LATEST/search-index`) since 2001
  - `sec/facts` — Single-tag US GAAP XBRL history across periods, deduplicated to latest restatement
  - `sec/insider-trades` — Parsed Form 4 XML insider transactions (shares, price, value, `P`/`S` code, post-holdings, Rule 10b5-1 flag)
  - `sec/form-144` — Parsed Form 144 executive restricted-stock proposed sale notices
  - `sec/activist-filings` — Schedule 13D / 13D/A / 13G / 13G/A >5% beneficial ownership filings
  - `sec/subsidiaries` — Significant subsidiaries & jurisdictions extracted from latest 10-K Exhibit 21 (`EX-21`)
  - `sec/insiders` — Raw Form 3/4/5 filing links
  - `sec/company` — Filer profile (CIK, tickers, exchanges, SIC, incorporation, fiscal year end)
- **Views:** `sec/filings` (`Filings`, `Form 4 Trades`, `Form 144 Sales`, `13D / 13G`, and `Full-Text Search` tabs)

## Working on it

```sh
npm ci
npm run typecheck
npm test
npm run package
```

MIT.
