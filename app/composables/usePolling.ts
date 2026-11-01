import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * Polls the API while the page is mounted. The durable state in SQLite remains
 * the source of truth; polling only refreshes what the server already persisted.
 */
export function usePolling<T>(fetcher: () => Promise<T>, intervalMs = 2000) {
  const data = ref<T | null>(null) as { value: T | null }
  const error = ref<unknown>(null)
  const pending = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  async function refresh(): Promise<T | null> {
    if (disposed) return null
    pending.value = true
    try {
      data.value = await fetcher()
      error.value = null
      return data.value
    } catch (err) {
      error.value = err
      return null
    } finally {
      pending.value = false
    }
  }

  function schedule() {
    if (disposed) return
    timer = setTimeout(async () => {
      await refresh()
      schedule()
    }, intervalMs)
  }

  onMounted(() => {
    void refresh()
    schedule()
  })

  onBeforeUnmount(() => {
    disposed = true
    if (timer) clearTimeout(timer)
  })

  return { data, error, pending, refresh }
}
