import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCodexToolEventData } from '../services/codex-sdk.js'
import {
  buildConversationRequestDraftPrompt,
  buildExplainRequestDraftPrompt,
  buildManualRequestDraftPrompt,
  normalizeRequestDraftPayload,
  parseRequestDraftToolResult,
} from '../services/request-draft-tool.js'

test('normalizeRequestDraftPayload trims and normalizes draft fields', () => {
  const normalized = normalizeRequestDraftPayload({
    title: '  Add request intake tool  ',
    categoryId: '  Change ',
    template: {
      problem: 'First line.   \n\n\nSecond line.   ',
      desiredOutcome: '  User can save richer requests. ',
      userScenarios: '  User clicks Request + and reviews the draft. ',
      constraints: '  Keep Explain read-only. ',
      nonGoals: '  No implementation plan here. ',
      openQuestions: '  Should categories vary by project? ',
    },
    rationale: '  Pulled from chat context.  ',
  })

  assert.deepEqual(normalized, {
    title: 'Add request intake tool',
    categoryId: 'change',
    template: {
      problem: 'First line.\n\nSecond line.',
      desiredOutcome: 'User can save richer requests.',
      userScenarios: 'User clicks Request + and reviews the draft.',
      constraints: 'Keep Explain read-only.',
      nonGoals: 'No implementation plan here.',
      openQuestions: 'Should categories vary by project?',
    },
    rationale: 'Pulled from chat context.',
  })
})

test('buildExplainRequestDraftPrompt embeds project and category guidance', () => {
  const prompt = buildExplainRequestDraftPrompt('이 대화를 request로 정리해줘', 'intentlane-codex', [
    {
      id: 'feature',
      label: 'Feature Add',
      description: '새 기능 추가',
      steps: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
    },
    {
      id: 'bugfix',
      label: 'Bug Fix',
      description: '버그 수정',
      steps: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
    },
  ])

  assert.match(prompt, /Current project id: intentlane-codex/)
  assert.match(prompt, /- feature: Feature Add/)
  assert.match(prompt, /create_client_request_draft/)
  assert.match(prompt, /search_repository/)
  assert.match(prompt, /read_repository_file/)
  assert.match(prompt, /list_repository_files/)
})

test('buildConversationRequestDraftPrompt embeds transcript and implementation guidance', () => {
  const prompt = buildConversationRequestDraftPrompt(
    [
      {
        role: 'user',
        content: 'Explain 창 말고 이 버튼 구현해줘',
      },
      {
        role: 'assistant',
        content: '현재 Explain 모드는 읽기 전용입니다.',
      },
    ],
    'intentlane-codex',
    [
      {
        id: 'feature',
        label: 'Feature Add',
        description: '새 기능 추가',
        steps: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
      },
    ],
    'implementation_request'
  )

  assert.match(prompt, /Explain mode is read-only/)
  assert.match(prompt, /Call create_client_request_draft exactly once/)
  assert.match(prompt, /\[1\] 사용자/)
  assert.match(prompt, /Explain 창 말고 이 버튼 구현해줘/)
  assert.match(prompt, /\[2\] Codex/)
})

test('buildConversationRequestDraftPrompt can refine an existing request draft with follow-up chat context', () => {
  const prompt = buildConversationRequestDraftPrompt(
    [
      {
        role: 'user',
        content: '채팅에서 request 초안을 만들었는데 제약 조건도 추가해줘',
      },
      {
        role: 'assistant',
        content: '좋아요. 최신 대화를 반영해서 다시 정리하겠습니다.',
      },
    ],
    'intentlane-codex',
    [
      {
        id: 'feature',
        label: 'Feature Add',
        description: '새 기능 추가',
        steps: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
      },
    ],
    'manual',
    {
      title: 'Refine request draft',
      categoryId: 'feature',
      template: {
        problem: '초안은 만들어졌지만 제약 조건이 비어 있다.',
        desiredOutcome: '채팅으로 보완한 제약 조건이 request에 반영된다.',
        userScenarios: '사용자가 Explain에서 초안을 다시 정리한다.',
        constraints: '읽기 전용 Explain 흐름 유지',
      },
      rationale: '이전 draft를 기반으로 refinement',
    }
  )

  assert.match(prompt, /Refine the current request draft/)
  assert.match(prompt, /Current request draft to refine:/)
  assert.match(prompt, /Title: Refine request draft/)
  assert.match(prompt, /Constraints:\n읽기 전용 Explain 흐름 유지/)
  assert.match(prompt, /Current rationale:\n이전 draft를 기반으로 refinement/)
  assert.match(prompt, /채팅에서 request 초안을 만들었는데 제약 조건도 추가해줘/)
})

test('buildManualRequestDraftPrompt embeds partial intake form guidance', () => {
  const prompt = buildManualRequestDraftPrompt(
    {
      requester: '  Product Manager  ',
      title: '  Draft assist for requests  ',
      categoryId: 'feature',
      template: {
        problem: '사용자가 request form을 끝까지 작성하기 어렵다.  ',
        nonGoals: '구현 계획을 쓰는 화면으로 바꾸지 않는다.  ',
      },
    },
    'intentlane-codex',
    [
      {
        id: 'feature',
        label: 'Feature Add',
        description: '새 기능 추가',
        steps: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
      },
    ]
  )

  assert.match(prompt, /Call create_client_request_draft exactly once/)
  assert.match(prompt, /Current intake form:/)
  assert.match(prompt, /Requester:\nProduct Manager/)
  assert.match(prompt, /Title:\nDraft assist for requests/)
  assert.match(prompt, /Selected category:\nfeature: Feature Add/)
  assert.match(prompt, /Problem:\n사용자가 request form을 끝까지 작성하기 어렵다\./)
  assert.match(prompt, /Desired outcome:\n\(empty\)/)
  assert.match(prompt, /Non-goals:\n구현 계획을 쓰는 화면으로 바꾸지 않는다\./)
})

test('parseRequestDraftToolResult normalizes title, template, and category', () => {
  const parsed = parseRequestDraftToolResult(
    {
      title: '  Add Request Button  ',
      categoryId: '  CHANGE ',
      template: {
        problem: '첫 줄.  \n\n\n둘째 줄.  ',
        desiredOutcome: '  버튼으로 request를 저장한다. ',
        userScenarios: '  사용자가 대화 내용을 request로 남긴다. ',
        constraints: '  Explain 모드는 읽기 전용이다. ',
      },
      rationale: '  explain 구현 요청을 request로 전환  ',
    },
    [
      {
        id: 'feature',
        label: 'Feature Add',
        description: '새 기능 추가',
        steps: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
      },
      {
        id: 'change',
        label: 'Feature Change',
        description: '기능 변경',
        steps: ['analyze', 'plan', 'implement', 'verify', 'review', 'ready'],
      },
    ]
  )

  assert.deepEqual(parsed, {
    title: 'Add Request Button',
    categoryId: 'change',
    template: {
      problem: '첫 줄.\n\n둘째 줄.',
      desiredOutcome: '버튼으로 request를 저장한다.',
      userScenarios: '사용자가 대화 내용을 request로 남긴다.',
      constraints: 'Explain 모드는 읽기 전용이다.',
      nonGoals: undefined,
      openQuestions: undefined,
    },
    rationale: 'explain 구현 요청을 request로 전환',
  })
})

test('buildCodexToolEventData prefers structured MCP content', () => {
  const data = buildCodexToolEventData({
    id: 'tool-1',
    type: 'mcp_tool_call',
    server: 'request_intake',
    tool: 'create_client_request_draft',
    arguments: { title: 'Draft' },
    result: {
      content: [{ type: 'text', text: 'fallback' }],
      structured_content: { title: 'Draft', categoryId: 'feature' },
    },
    status: 'completed',
  })

  assert.deepEqual(data, {
    id: 'tool-1',
    server: 'request_intake',
    tool: 'create_client_request_draft',
    input: { title: 'Draft' },
    result: { title: 'Draft', categoryId: 'feature' },
    error: undefined,
  })
})
