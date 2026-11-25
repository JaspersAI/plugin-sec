// Pure XML/HTML/JSON parsers and view state/output helpers for SEC EDGAR filings, EFTS search,
// Form 4 insider transactions, Form 144 sell notices, Schedule 13D/13G, and Exhibit 21 subsidiaries.

export const OUTPUT_MAX = 4096
export const SEC_TABS = ['filings', 'insider-trades', 'form-144', 'activists', 'search'] as const
export type SecTab = (typeof SEC_TABS)[number]

export type SecState = {
  ticker: string
  tab: SecTab
  form: string
  query: string
  limit: number
}

export type SecOutput = {
  ticker: string
  tab: SecTab
  query: string
  count: number
  items: { date: string; label: string; detail: string; url: string }[]
}

export interface ParsedForm4Trade {
  ticker: string
  filed: string
  transactionDate: string
  insiderName: string
  insiderTitle: string
  relationship: string
  securityTitle: string
  code: string
  acquiredDisposed: string
  shares: number | null
  pricePerShare: number | null
  totalValue: number | null
  sharesOwnedAfter: number | null
  rule10b51: boolean
  url: string
  [key: string]: unknown
}

export interface ParsedForm144Notice {
  ticker: string
  filed: string
  approxSaleDate: string
  sellerName: string
  relationship: string
  broker: string
  sharesToSell: number | null
  aggregateMarketValue: number | null
  exchange: string
  url: string
  [key: string]: unknown
}

export interface SubsidiaryRow {
  parentTicker: string
  parentCik: string
  filingDate: string
  subsidiary: string
  jurisdiction: string
  url: string
  [key: string]: unknown
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#160;|&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim()
}

function xmlTag(block: string, tag: string): string {
  const re = new RegExp(`<(?:[a-z0-9_]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[a-z0-9_]+:)?${tag}>`, 'i')
  const match = re.exec(block)
  if (!match) return ''
  const inner = match[1] ?? ''
  const valMatch = /<(?:[a-z0-9_]+:)?value(?:\s[^>]*)?>([\s\S]*?)<\/(?:[a-z0-9_]+:)?value>/i.exec(inner)
  const raw = valMatch ? (valMatch[1] ?? '') : inner
  return decodeEntities(raw.replace(/<[^>]+>/g, ' '))
}

function xmlAllBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:[a-z0-9_]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[a-z0-9_]+:)?${tag}>`, 'gi')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) out.push(m[1] ?? '')
  return out
}

function parseXmlNum(text: string): number | null {
  const cleaned = text.replace(/[,$\s]/g, '')
  if (!cleaned) return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

export function stripXslPrefix(docPath: string): string {
  return docPath.replace(/^xsl[^/]+\//i, '')
}

export function edgarDocUrl(cik: string | number, accessionNumber: string, docName: string): string {
  const numericCik = Number(String(cik).replace(/\D/g, ''))
  const cleanAcc = accessionNumber.replace(/-/g, '')
  return `https://www.sec.gov/Archives/edgar/data/${numericCik}/${cleanAcc}/${docName}`
}

/**
 * Parses an SEC Form 4 `<ownershipDocument>` XML string into one row per non-derivative or derivative transaction.
 */
export function parseForm4Xml(
  xml: string,
  meta: { ticker: string; filed: string; url: string },
): ParsedForm4Trade[] {
  const symbol = (xmlTag(xml, 'issuerTradingSymbol') || meta.ticker).toUpperCase()
  const owners = xmlAllBlocks(xml, 'reportingOwner')
  const ownerNames = owners.map((o) => xmlTag(o, 'rptOwnerName')).filter(Boolean)
  const insiderName = ownerNames.join('; ') || 'Reporting Owner'
  const firstOwner = owners[0] ?? ''
  const isDirector = /^(1|true)$/i.test(xmlTag(firstOwner, 'isDirector'))
  const isOfficer = /^(1|true)$/i.test(xmlTag(firstOwner, 'isOfficer'))
  const isTenPct = /^(1|true)$/i.test(xmlTag(firstOwner, 'isTenPercentOwner'))
  const insiderTitle = xmlTag(firstOwner, 'officerTitle')
  const relParts: string[] = []
  if (isOfficer) relParts.push(insiderTitle || 'Officer')
  if (isDirector) relParts.push('Director')
  if (isTenPct) relParts.push('10% Owner')
  const relationship = relParts.join(', ') || 'Insider'

  const aff10b5 = /^(1|true)$/i.test(xmlTag(xml, 'aff10b5One'))
  const footnoteText = xmlAllBlocks(xml, 'footnote').join(' ')
  const rule10b51 = aff10b5 || /10b5-1/i.test(footnoteText)

  const txBlocks = [
    ...xmlAllBlocks(xml, 'nonDerivativeTransaction'),
    ...xmlAllBlocks(xml, 'derivativeTransaction'),
  ]

  const rows: ParsedForm4Trade[] = []
  for (const tx of txBlocks) {
    const securityTitle = xmlTag(tx, 'securityTitle') || 'Common Stock'
    const transactionDate = xmlTag(tx, 'transactionDate') || xmlTag(xml, 'periodOfReport') || meta.filed
    const code = xmlTag(tx, 'transactionCode').toUpperCase()
    const acquiredDisposed = xmlTag(tx, 'transactionAcquiredDisposedCode').toUpperCase()
    const shares = parseXmlNum(xmlTag(tx, 'transactionShares'))
    const pricePerShare =
      parseXmlNum(xmlTag(tx, 'transactionPricePerShare')) ??
      parseXmlNum(xmlTag(tx, 'conversionOrExercisePrice'))
    const sharesOwnedAfter = parseXmlNum(xmlTag(tx, 'sharesOwnedFollowingTransaction'))
    const totalValue =
      shares !== null && pricePerShare !== null ? Math.round(shares * pricePerShare * 100) / 100 : null

    rows.push({
      ticker: symbol,
      filed: meta.filed,
      transactionDate,
      insiderName,
      insiderTitle: insiderTitle || relationship,
      relationship,
      securityTitle,
      code,
      acquiredDisposed,
      shares,
      pricePerShare,
      totalValue,
      sharesOwnedAfter,
      rule10b51,
      url: meta.url,
    })
  }
  return rows
}

/**
 * Parses an electronic SEC Form 144 (`<edgarSubmission>`) XML notice of proposed sale of securities.
 */
export function parseForm144Xml(
  xml: string,
  meta: { ticker: string; filed: string; url: string },
): ParsedForm144Notice {
  const sellerName = xmlTag(xml, 'nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold') || 'Insider'
  const relationship = xmlTag(xml, 'relationshipToIssuer') || 'Affiliate'
  const secInfo = xmlAllBlocks(xml, 'securitiesInformation')[0] ?? xml
  const brokerBlock = xmlAllBlocks(secInfo, 'brokerOrMarketmakerDetails')[0] ?? ''
  const broker = xmlTag(brokerBlock, 'name')
  const sharesToSell = parseXmlNum(xmlTag(secInfo, 'noOfUnitsSold'))
  const aggregateMarketValue = parseXmlNum(xmlTag(secInfo, 'aggregateMarketValue'))
  const approxSaleDate = xmlTag(secInfo, 'approxSaleDate')
  const exchange = xmlTag(secInfo, 'securitiesExchangeName')
  return {
    ticker: meta.ticker.toUpperCase(),
    filed: meta.filed,
    approxSaleDate,
    sellerName,
    relationship,
    broker,
    sharesToSell,
    aggregateMarketValue,
    exchange,
    url: meta.url,
  }
}

export function normalizeEftsHits(hits: readonly Record<string, unknown>[]) {
  return hits.map((hit) => {
    const id = String(hit['_id'] ?? '')
    const [adshRaw, filename = ''] = id.split(':')
    const src = (hit['_source'] ?? {}) as Record<string, unknown>
    const adsh = String(src['adsh'] ?? adshRaw ?? '')
    const ciks = Array.isArray(src['ciks']) ? (src['ciks'] as string[]) : []
    const primaryCik = String(ciks[0] ?? '')
    const names = Array.isArray(src['display_names']) ? (src['display_names'] as string[]) : []
    const items = Array.isArray(src['items']) ? (src['items'] as string[]) : []
    const url =
      primaryCik && adsh && filename
        ? edgarDocUrl(primaryCik, adsh, filename)
        : primaryCik && adsh
          ? `https://www.sec.gov/Archives/edgar/data/${Number(primaryCik)}/${adsh.replace(/-/g, '')}/${adsh}-index.htm`
          : 'https://www.sec.gov/edgar/searchedgar/companysearch'
    return {
      filed: String(src['file_date'] ?? ''),
      form: String(src['form'] ?? src['file_type'] ?? ''),
      fileType: String(src['file_type'] ?? ''),
      company: names.join(' | ') || primaryCik,
      cik: primaryCik,
      periodEnding: String(src['period_ending'] ?? ''),
      items: items.join(', '),
      accessionNumber: adsh,
      url,
    }
  })
}

/**
 * Extracts `(subsidiary, jurisdiction)` pairs from a Form 10-K Exhibit 21 HTML table.
 */
export function parseExhibit21Html(
  html: string,
  meta: { parentTicker: string; parentCik: string; filingDate: string; url: string },
): SubsidiaryRow[] {
  const rows: SubsidiaryRow[] = []
  const seen = new Set<string>()
  const trRegex = /<tr[\s\S]*?<\/tr>/gi
  let m: RegExpExecArray | null
  while ((m = trRegex.exec(html)) !== null) {
    const tr = m[0]
    const cells = [...tr.matchAll(/<t[dh](?:\s[^>]*)?>([\s\S]*?)<\/t[dh]>/gi)]
      .map((cell) => decodeEntities((cell[1] ?? '').replace(/<[^>]+>/g, ' ')))
      .filter((text) => text.length > 0 && !/^[*†\d()]+$/.test(text))
    if (cells.length < 2) continue
    const sub = cells[0]!
    const jur = cells[1]!
    if (/^(name of subsidiary|subsidiary|subsidiaries|entity name|company name|jurisdiction)$/i.test(sub)) continue
    if (/^(jurisdiction|state or other|country|place of incorporation|ownership)/i.test(sub)) continue
    if (/jurisdiction of incorporation|state of incorporation/i.test(jur) && /name/i.test(sub)) continue
    if (sub.length < 2 || sub.length > 180 || jur.length > 120) continue
    const dedupeKey = `${sub.toLowerCase()}|${jur.toLowerCase()}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    rows.push({
      parentTicker: meta.parentTicker.toUpperCase(),
      parentCik: meta.parentCik,
      filingDate: meta.filingDate,
      subsidiary: sub,
      jurisdiction: jur,
      url: meta.url,
    })
  }
  return rows
}

export function readSecState(raw: unknown): SecState {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const ticker = typeof obj['ticker'] === 'string' ? obj['ticker'].trim().toUpperCase() : ''
  const tabRaw = obj['tab']
  const tab: SecTab = SEC_TABS.includes(tabRaw as SecTab) ? (tabRaw as SecTab) : 'filings'
  const form = typeof obj['form'] === 'string' ? obj['form'].trim().toUpperCase() : ''
  const query = typeof obj['query'] === 'string' ? obj['query'].trim() : ''
  const lim = typeof obj['limit'] === 'number' && Number.isFinite(obj['limit']) ? Math.trunc(obj['limit']) : 25
  const limit = Math.max(1, Math.min(100, lim))
  return { ticker, tab, form, query, limit }
}

export function buildSecOutput(state: SecState, rows: readonly Record<string, unknown>[]): SecOutput {
  const preview: { date: string; label: string; detail: string; url: string }[] = []
  for (const row of rows.slice(0, 8)) {
    const date = String(row['filingDate'] ?? row['filed'] ?? row['transactionDate'] ?? '').slice(0, 10)
    let label = ''
    let detail = ''
    if (state.tab === 'insider-trades') {
      label = `${String(row['insiderName'] ?? '')} (${String(row['code'] ?? '')})`.slice(0, 80)
      detail = `${String(row['shares'] ?? '')} sh @ $${String(row['pricePerShare'] ?? '—')}`.slice(0, 80)
    } else if (state.tab === 'form-144') {
      label = String(row['sellerName'] ?? '').slice(0, 80)
      detail = `${String(row['sharesToSell'] ?? '')} sh ($${String(row['aggregateMarketValue'] ?? '—')})`.slice(0, 80)
    } else if (state.tab === 'search' || state.tab === 'activists') {
      label = `${String(row['form'] ?? '')} · ${String(row['company'] ?? '')}`.slice(0, 90)
      detail = String(row['items'] ?? row['accessionNumber'] ?? '').slice(0, 60)
    } else {
      label = String(row['form'] ?? '').slice(0, 40)
      detail = String(row['primaryDocDescription'] ?? row['accessionNumber'] ?? '').slice(0, 80)
    }
    const url = typeof row['url'] === 'string' ? row['url'].slice(0, 180) : ''
    const candidate = { date, label, detail, url }
    const next = {
      ticker: state.ticker.slice(0, 20),
      tab: state.tab,
      query: state.query.slice(0, 120),
      count: rows.length,
      items: [...preview, candidate],
    }
    if (new TextEncoder().encode(JSON.stringify(next)).length > OUTPUT_MAX) break
    preview.push(candidate)
  }
  return {
    ticker: state.ticker.slice(0, 20),
    tab: state.tab,
    query: state.query.slice(0, 120),
    count: rows.length,
    items: preview,
  }
}

export function secSummary(
  state: { ticker?: string; tab?: SecTab; query?: string },
  output: SecOutput | null | undefined,
): string {
  const tab = state.tab ?? output?.tab ?? 'filings'
  const ticker = (state.ticker ?? output?.ticker ?? '').trim().toUpperCase()
  if (tab === 'search') {
    const q = (state.query ?? output?.query ?? '').trim().replace(/^"+|"+$/g, '')
    return q ? `SEC EDGAR search "${q}": ${output?.count ?? 0} hits` : 'SEC EDGAR Full-Text Search'
  }
  if (!ticker) return 'SEC EDGAR Filings & Insiders'
  return `SEC ${ticker} (${tab}): ${output?.count ?? 0} rows`
}
