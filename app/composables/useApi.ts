export class ApiError extends Error {
  code: string
  details?: Record<string, unknown>

  constructor(message: string, code = 'INTERNAL_ERROR', details?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.details = details
  }
}

async function request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api${path}`, {
      method: options.method ?? 'GET',
      headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
  } catch (error) {
    throw new ApiError(
      `Cannot reach the local udmt API. Start it with \`udmt serve\` (${(error as Error).message}).`,
      'NETWORK_ERROR',
    )
  }

  const text = await response.text()
  let payload: unknown = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = text
  }

  if (!response.ok) {
    const envelope = payload as { error?: { code?: string; message?: string; details?: Record<string, unknown> } }
    throw new ApiError(
      envelope?.error?.message ?? `Request failed (${response.status})`,
      envelope?.error?.code ?? 'INTERNAL_ERROR',
      envelope?.error?.details,
    )
  }
  return payload as T
}

export function useApi() {
  return {
    get: <T>(path: string) => request<T>(path),
    post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
    patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
    del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  }
}

/** Reports API failures through the shared toast channel without swallowing them. */
export function useApiToast() {
  const toast = useToast()
  return (error: unknown, title = 'Request failed') => {
    const apiError = error instanceof ApiError ? error : new ApiError((error as Error).message ?? String(error))
    toast.add({
      title,
      description: apiError.message,
      color: 'error',
      icon: 'i-lucide-circle-alert',
    })
    return apiError
  }
}
