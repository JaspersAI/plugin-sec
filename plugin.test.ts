import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildSecOutput,
  normalizeEftsHits,
  OUTPUT_MAX,
  parseExhibit21Html,
  parseForm4Xml,
  parseForm144Xml,
  readSecState,
  secSummary,
  stripXslPrefix,
} from './sec.ts'
import * as sources from './sources.ts'

const all = Object.entries(sources).filter(([, one]) => (one as { kind?: string }).kind === 'source')

test('it declares all nine SEC EDGAR sources', () => {
  assert.deepEqual(
    all.map(([name]) => name).sort(),
    [
      'activistFilings',
      'company',
      'facts',
      'filings',
      'form144',
      'insiderTrades',
      'insiders',
      'search',
      'subsidiaries',
    ],
  )
})

test('every source says what it is for, and which hosts it reaches', () => {
  for (const [name, source] of all) {
    const one = source as { description?: string; hosts?: string[] }
    assert.ok((one.description ?? '').length > 30, `${name} has no description worth reading`)
    assert.ok((one.hosts ?? []).length > 0, `${name} declares no hosts`)
    for (const host of one.hosts ?? []) assert.match(host, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, host)
  }
})

test('stripXslPrefix removes EDGAR stylesheet folders to expose raw XML', () => {
  assert.equal(stripXslPrefix('xslF345X06/form4.xml'), 'form4.xml')
  assert.equal(stripXslPrefix('xsl144X01/primary_doc.xml'), 'primary_doc.xml')
  assert.equal(stripXslPrefix('primary_doc.xml'), 'primary_doc.xml')
})

test('parseForm4Xml extracts insider identity, transaction amounts, and Rule 10b5-1 flag', () => {
  const xml = `<?xml version="1.0"?>
    <ownershipDocument>
      <issuer><issuerTradingSymbol>AAPL</issuerTradingSymbol></issuer>
      <reportingOwner>
        <reportingOwnerId><rptOwnerName>Newstead Jennifer</rptOwnerName></reportingOwnerId>
        <reportingOwnerRelationship>
          <isDirector>false</isDirector>
          <isOfficer>true</isOfficer>
          <isTenPercentOwner>false</isTenPercentOwner>
          <officerTitle>SVP, GC</officerTitle>
        </reportingOwnerRelationship>
      </reportingOwner>
      <aff10b5One>true</aff10b5One>
      <nonDerivativeTable>
        <nonDerivativeTransaction>
          <securityTitle><value>Common Stock</value></securityTitle>
          <transactionDate><value>2026-11-17</value></transactionDate>
          <transactionCoding><transactionCode>S</transactionCode></transactionCoding>
          <transactionAmounts>
            <transactionShares><value>2398</value></transactionShares>
            <transactionPricePerShare><value>352.77</value></transactionPricePerShare>
            <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>
          </transactionAmounts>
          <postTransactionAmounts>
            <sharesOwnedFollowingTransaction><value>25200</value></sharesOwnedFollowingTransaction>
          </postTransactionAmounts>
        </nonDerivativeTransaction>
      </nonDerivativeTable>
    </ownershipDocument>`
  const rows = parseForm4Xml(xml, {
    ticker: 'AAPL',
    filed: '2026-11-18',
    url: 'https://www.sec.gov/Archives/edgar/data/320193/0001/xslF345X06/form4.xml',
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.insiderName, 'Newstead Jennifer')
  assert.equal(rows[0]!.insiderTitle, 'SVP, GC')
  assert.equal(rows[0]!.code, 'S')
  assert.equal(rows[0]!.shares, 2398)
  assert.equal(rows[0]!.pricePerShare, 352.77)
  assert.equal(rows[0]!.totalValue, 845_942.46)
  assert.equal(rows[0]!.sharesOwnedAfter, 25_200)
  assert.equal(rows[0]!.rule10b51, true)
})

test('parseForm144Xml extracts proposed sale units, market value, and broker', () => {
  const xml = `<edgarSubmission>
    <formData>
      <issuerInfo>
        <nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold>Teter Timothy S.</nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold>
        <relationshipsToIssuer><relationshipToIssuer>Officer</relationshipToIssuer></relationshipsToIssuer>
      </issuerInfo>
      <securitiesInformation>
        <brokerOrMarketmakerDetails><name>Charles Schwab &amp; Co., Inc.</name></brokerOrMarketmakerDetails>
        <noOfUnitsSold>30000</noOfUnitsSold>
        <aggregateMarketValue>4542782.00</aggregateMarketValue>
        <approxSaleDate>11/19/2026</approxSaleDate>
        <securitiesExchangeName>NASDAQ</securitiesExchangeName>
      </securitiesInformation>
    </formData>
  </edgarSubmission>`
  const parsed = parseForm144Xml(xml, {
    ticker: 'nvda',
    filed: '2026-11-19',
    url: 'https://www.sec.gov/Archives/edgar/data/1045810/0001/primary_doc.xml',
  })
  assert.equal(parsed.ticker, 'NVDA')
  assert.equal(parsed.sellerName, 'Teter Timothy S.')
  assert.equal(parsed.broker, 'Charles Schwab & Co., Inc.')
  assert.equal(parsed.sharesToSell, 30_000)
  assert.equal(parsed.aggregateMarketValue, 4_542_782)
})

test('normalizeEftsHits builds direct sec.gov document links from _id accession:filename', () => {
  const rows = normalizeEftsHits([
    {
      _id: '0001193125-26-042752:d460978d8k.htm',
      _source: {
        ciks: ['0001099219'],
        display_names: ['METLIFE INC (MET)'],
        file_date: '2026-11-10',
        form: '8-K',
        adsh: '0001193125-26-042752',
        items: ['1.01', '8.01'],
      },
    },
  ])
  assert.equal(rows[0]!.url, 'https://www.sec.gov/Archives/edgar/data/1099219/000119312526042752/d460978d8k.htm')
  assert.equal(rows[0]!.items, '1.01, 8.01')
})

test('parseExhibit21Html extracts subsidiary and jurisdiction pairs while skipping headers', () => {
  const html = `<table>
    <tr><td>Name of Subsidiary</td><td>Jurisdiction of Incorporation</td></tr>
    <tr><td>Apple Asia Limited</td><td>Hong Kong</td></tr>
    <tr><td>Apple Distribution International Limited</td><td>Ireland</td></tr>
  </table>`
  const rows = parseExhibit21Html(html, {
    parentTicker: 'aapl',
    parentCik: '0000320193',
    filingDate: '2026-11-03',
    url: 'https://www.sec.gov/Archives/edgar/data/320193/1/ex21.htm',
  })
  assert.equal(rows.length, 2)
  assert.equal(rows[0]!.subsidiary, 'Apple Asia Limited')
  assert.equal(rows[0]!.jurisdiction, 'Hong Kong')
})

test('view state and 4 KB output ceiling hold on large search results', () => {
  const state = readSecState({ tab: 'search', query: '"Wells notice"', limit: 500 })
  assert.equal(state.limit, 100)
  const bigRows = Array.from({ length: 20 }, (_, i) => ({
    filed: '2026-11-20',
    form: '8-K',
    company: `VERY LONG PUBLIC COMPANY NAME ${i} `.repeat(8),
    items: '1.01, 2.02, 7.01, 8.01, 9.01',
    url: `https://www.sec.gov/Archives/edgar/data/100000/${'9'.repeat(60)}${i}/doc.htm`,
  }))
  const output = buildSecOutput(state, bigRows)
  assert.ok(new TextEncoder().encode(JSON.stringify(output)).length <= OUTPUT_MAX)
  assert.match(secSummary(state, output), /SEC EDGAR search "Wells notice": 20 hits/)
})
