import test from 'node:test'
import assert from 'node:assert/strict'
import { getMermaidRenderCandidates, isMermaidErrorSvg, sanitizeMermaidChart } from '../../web/components/MermaidDiagram.js'

test('sanitizeMermaidChart quotes square-bracket labels and escapes route params in flowcharts', () => {
  const chart = [
    'flowchart TD',
    '    A[TermsController] --> B[목록 조회 GET /terms]',
    '    E[AdminTermsController] --> G[상세 조회 GET /admin/terms/{id}]',
    '    G --> H[TermsService.getTermsForAdmin]',
  ].join('\n')

  const sanitized = sanitizeMermaidChart(chart)

  assert.match(sanitized, /A\["TermsController"\]/)
  assert.match(sanitized, /B\["목록 조회 GET \/terms"\]/)
  assert.match(sanitized, /G\["상세 조회 GET \/admin\/terms\/&#123;id&#125;"\]/)
  assert.match(sanitized, /H\["TermsService\.getTermsForAdmin"\]/)
})

test('sanitizeMermaidChart quotes edge labels, other node shapes, and subgraph titles in flowcharts', () => {
  const chart = [
    'flowchart TD',
    '    Client -->|GET /terms/{id}| Api',
    '    Start(시작 /terms/{id}) --> Decision{승인/거절?}',
    '    subgraph API /terms/{id}',
    '      Api --> Done[완료]',
    '    end',
  ].join('\n')

  const sanitized = sanitizeMermaidChart(chart)

  assert.match(sanitized, /\|\s*"GET \/terms\/&#123;id&#125;"\s*\|/)
  assert.match(sanitized, /Start\("시작 \/terms\/&#123;id&#125;"\)/)
  assert.match(sanitized, /Decision\{"승인\/거절\?"\}/)
  assert.match(sanitized, /^\s*subgraph "API \/terms\/&#123;id&#125;"$/m)
})

test('sanitizeMermaidChart escapes embedded quotes inside flowchart labels', () => {
  const chart = 'flowchart TD\nA[He said "go" /terms/{id}] --> B'

  const sanitized = sanitizeMermaidChart(chart)

  assert.match(sanitized, /A\["He said &quot;go&quot; \/terms\/&#123;id&#125;"\]/)
})

test('sanitizeMermaidChart leaves non-flowchart diagrams unchanged', () => {
  const chart = 'sequenceDiagram\nAlice->>Bob: hello'

  assert.equal(sanitizeMermaidChart(chart), chart)
})

test('getMermaidRenderCandidates retries with a sanitized flowchart only when needed', () => {
  const chart = 'flowchart TD\nA[Test] --> B[GET /terms/{id}]'
  const candidates = getMermaidRenderCandidates(chart)

  assert.equal(candidates.length, 2)
  assert.equal(candidates[0], chart)
  assert.match(candidates[1] ?? '', /B\["GET \/terms\/&#123;id&#125;"\]/)
})

test('getMermaidRenderCandidates retries when edge labels or subgraph titles need sanitizing', () => {
  const chart = 'flowchart TD\nClient -->|GET /terms/{id}| Api\nsubgraph API /terms/{id}\nApi --> Done\nend'
  const candidates = getMermaidRenderCandidates(chart)

  assert.equal(candidates.length, 2)
  assert.equal(candidates[0], chart)
  assert.match(candidates[1] ?? '', /\|"GET \/terms\/&#123;id&#125;"\|/)
  assert.match(candidates[1] ?? '', /^subgraph "API \/terms\/&#123;id&#125;"$/m)
})

test('getMermaidRenderCandidates does not duplicate already safe flowcharts', () => {
  const chart = 'flowchart TD\nA["Safe"] -->|"GET /terms/&#123;id&#125;"| B["Done"]'
  const candidates = getMermaidRenderCandidates(chart)

  assert.deepEqual(candidates, [chart])
})

test('isMermaidErrorSvg detects Mermaid parser error diagrams', () => {
  assert.equal(isMermaidErrorSvg('<svg><text>Syntax error in text</text></svg>'), true)
  assert.equal(isMermaidErrorSvg('<svg><g class="error-text"></g></svg>'), true)
  assert.equal(isMermaidErrorSvg('<svg><g class="error-icon"></g></svg>'), true)
  assert.equal(isMermaidErrorSvg('<svg><style>.error-text{fill:red}.error-icon{fill:red}</style><text>Valid diagram</text></svg>'), false)
  assert.equal(isMermaidErrorSvg('<svg><text>Valid diagram</text></svg>'), false)
})
