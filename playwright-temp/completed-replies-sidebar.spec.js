const { test, expect } = require('@playwright/test')

const AUTH_TOKEN = 'playwright-sidebar-token'
const BASE_URL = 'http://localhost:5174'
const API_URL = 'http://localhost:3002'

function buildMessagePayload(message) {
  return [
    {
      id: `msg-user-${Date.now()}`,
      role: 'user',
      content: message,
    },
    {
      id: `msg-assistant-${Date.now()}`,
      role: 'assistant',
      content: '',
    },
  ]
}

async function startExplainRun(message, threadKey) {
  const response = await fetch(`${API_URL}/api/chat/runs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      projectId: 'intentlane-codex',
      threadKey,
      scopeLabel: threadKey,
      message,
      messages: buildMessagePayload(message),
      drafts: [],
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to start explain run: ${response.status} ${await response.text()}`)
  }

  return response.json()
}

async function waitForCompletedRun(runId, timeoutMs = 60000) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetch(`${API_URL}/api/background-runs/${runId}`, {
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
    })

    if (!response.ok) {
      throw new Error(`Failed to load background run ${runId}: ${response.status}`)
    }

    const run = await response.json()
    if (run.status === 'completed') {
      return run
    }

    if (run.status === 'failed' || run.status === 'stopped') {
      throw new Error(`Background run ${runId} ended as ${run.status}`)
    }

    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  throw new Error(`Timed out waiting for background run ${runId}`)
}

test('completed replies sidebar stays available, marks unread runs, and remains after all items are dismissed', async ({ page }) => {
  await page.addInitScript((token) => {
    window.sessionStorage.setItem('intentlane-codex.auth-token', token)
  }, AUTH_TOKEN)

  await page.goto(BASE_URL)

  const completedSidebar = page.locator('aside').nth(1)
  await expect(completedSidebar.getByText('Completed Replies')).toBeVisible({ timeout: 15000 })
  await expect(completedSidebar.getByLabel('완료된 답변 정렬')).toBeVisible()

  const threadKey = `pw-sidebar-${Date.now()}`
  const message = `${threadKey} README.md와 flows.config.json 기준으로 이 앱 목적을 두 문장으로 요약해줘.`
  const started = await startExplainRun(message, threadKey)
  await waitForCompletedRun(started.run.id)

  const unreadCard = completedSidebar.locator('div.rounded-2xl').filter({
    has: completedSidebar.getByText(threadKey, { exact: false }),
  }).first()

  await expect(unreadCard).toBeVisible({ timeout: 30000 })
  await expect(unreadCard.getByText('읽지 않음')).toBeVisible()

  await completedSidebar.getByLabel('완료된 답변 정렬').selectOption('unread')
  await expect(completedSidebar.getByLabel('완료된 답변 정렬')).toHaveValue('unread')

  await unreadCard.getByRole('button', { name: '열기' }).click()
  await expect(page.getByText('Explain Mode').first()).toBeVisible()
  await expect(page.getByText(threadKey, { exact: false }).first()).toBeVisible()
  await expect(unreadCard.getByText('읽지 않음')).toHaveCount(0)

  while (await completedSidebar.getByRole('button', { name: '닫기' }).count()) {
    await completedSidebar.getByRole('button', { name: '닫기' }).first().click()
  }

  await expect(completedSidebar.getByText('아직 완료된 응답이 없습니다.')).toBeVisible()

  await completedSidebar.getByLabel('완료된 답변 사이드바 접기').click()
  await expect(completedSidebar.getByLabel('완료된 답변 사이드바 펼치기')).toBeVisible()
  await completedSidebar.getByLabel('완료된 답변 사이드바 펼치기').click()
  await expect(completedSidebar.getByText('아직 완료된 응답이 없습니다.')).toBeVisible()
})
