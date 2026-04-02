interface AttemptLike {
  attempt: number
}

export function normalizeAttemptNumbers(attempts: number[]) {
  return Array.from(new Set(attempts)).sort((left, right) => left - right)
}

export function resolveAttemptNumber(availableAttempts: number[], selectedAttempt?: number | null) {
  const normalizedAttempts = normalizeAttemptNumbers(availableAttempts)

  if (normalizedAttempts.length === 0) {
    return null
  }

  if (selectedAttempt != null && normalizedAttempts.includes(selectedAttempt)) {
    return selectedAttempt
  }

  return normalizedAttempts.at(-1) ?? null
}

export function resolveAttemptItem<T extends AttemptLike>(items: T[], selectedAttempt?: number | null) {
  const resolvedAttempt = resolveAttemptNumber(
    items.map((item) => item.attempt),
    selectedAttempt
  )

  if (resolvedAttempt == null) {
    return null
  }

  return items.find((item) => item.attempt === resolvedAttempt) ?? items.at(-1) ?? null
}

export function extractAttemptSection(content: string, sectionHeading: string, attempt?: number | null) {
  const normalized = content.trim()
  if (!normalized || attempt == null) {
    return normalized
  }

  const heading = `## ${sectionHeading} ${attempt}`
  const startIndex = normalized.indexOf(heading)
  if (startIndex === -1) {
    return normalized
  }

  const nextSectionIndex = normalized.indexOf('\n## ', startIndex + heading.length)
  return normalized.slice(startIndex, nextSectionIndex === -1 ? undefined : nextSectionIndex).trim()
}
