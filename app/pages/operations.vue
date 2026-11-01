<script setup lang="ts">
import { nextTick, watch } from 'vue'
import type { LogEntry, OperationRun } from '~/types'

const api = useApi()
const toast = useToast()
const reportError = useApiToast()
const { t } = useI18n()

const statusFilter = ref<string>('all')
const typeFilter = ref<string>('all')
const runs = ref<OperationRun[]>([])
const loading = ref(true)
const selected = ref<OperationRun | null>(null)
const logs = ref<LogEntry[]>([])
const logsLoading = ref(false)
const autoScroll = ref(true)
const logBox = ref<HTMLElement | null>(null)

watch(logs, async () => {
  if (!autoScroll.value) return
  await nextTick()
  if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight
})

let listTimer: ReturnType<typeof setInterval> | undefined
let logTimer: ReturnType<typeof setInterval> | undefined

async function loadRuns() {
  try {
    const query = new URLSearchParams({ limit: '60' })
    if (statusFilter.value !== 'all') query.set('status', statusFilter.value)
    if (typeFilter.value !== 'all') query.set('type', typeFilter.value)
    runs.value = await api.get<OperationRun[]>(`/runs?${query.toString()}`)
    if (selected.value) {
      const fresh = runs.value.find((run) => run.id === selected.value?.id)
      if (fresh) selected.value = fresh
    }
  } catch (error) {
    reportError(error, t('operationsPage.loadFailed'))
  } finally {
    loading.value = false
  }
}

async function loadLogs() {
  if (!selected.value) return
  logsLoading.value = true
  try {
    logs.value = await api.get<LogEntry[]>(`/runs/${selected.value.id}/logs?limit=500`)
  } catch (error) {
    reportError(error, t('operationsPage.logsFailed'))
  } finally {
    logsLoading.value = false
  }
}

onMounted(async () => {
  await loadRuns()
  listTimer = setInterval(loadRuns, 3000)
})

onBeforeUnmount(() => {
  if (listTimer) clearInterval(listTimer)
  if (logTimer) clearInterval(logTimer)
})

function openRun(run: OperationRun) {
  selected.value = run
  logs.value = []
  void loadLogs()
  if (logTimer) clearInterval(logTimer)
  logTimer = setInterval(loadLogs, 2000)
}

function closeRun() {
  selected.value = null
  logs.value = []
  if (logTimer) clearInterval(logTimer)
  logTimer = undefined
}

async function cancelRun(run: OperationRun) {
  try {
    await api.post(`/runs/${run.id}/cancel`)
    toast.add({ title: t('operationsPage.cancelRequested'), description: shortId(run.id), color: 'warning', icon: 'i-lucide-square' })
    await loadRuns()
  } catch (error) {
    reportError(error, t('operationsPage.cancelFailed'))
  }
}

const activeCount = computed(() =>
  runs.value.filter((run) => ['queued', 'preparing', 'preflight', 'running', 'finalizing', 'verifying', 'cancel_requested'].includes(run.status)).length,
)
</script>

<template>
  <PageShell
    id="operations"
    :title="$t('operationsPage.title')"
    :description="$t('operationsPage.description', { count: activeCount })"
  >
    <template #right>
      <UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" square :aria-label="$t('common.refresh')" @click="loadRuns" />
    </template>

    <template #toolbar>
      <div class="flex flex-wrap items-center gap-2 border-t border-default/60 px-4 py-2">
        <USelect
          v-model="statusFilter"
          :items="[
            { value: 'all', label: $t('operationsPage.allStatuses') },
            { value: 'running', label: $t('status.running') },
            { value: 'queued', label: $t('status.queued') },
            { value: 'completed', label: $t('status.completed') },
            { value: 'completed_with_warnings', label: $t('operationsPage.withWarnings') },
            { value: 'failed', label: $t('status.failed') },
            { value: 'cancelled', label: $t('status.cancelled') },
            { value: 'interrupted', label: $t('status.interrupted') },
          ]"
          size="sm"
          class="w-44"
          @update:model-value="loadRuns"
        />
        <USelect
          v-model="typeFilter"
          :items="[
            { value: 'all', label: $t('operationsPage.allTypes') },
            { value: 'export', label: $t('nav.export') },
            { value: 'import', label: $t('nav.import') },
            { value: 'verify', label: $t('artifactsPage.verifyShort') },
          ]"
          size="sm"
          class="w-36"
          @update:model-value="loadRuns"
        />
        <span class="ms-auto text-xs text-muted">{{ $t('operationsPage.autoRefresh') }}</span>
      </div>
    </template>

    <div class="flex-1 overflow-auto scroll-thin p-4 sm:p-6">
      <div v-if="loading" class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" /> {{ $t('operationsPage.loading') }}
      </div>

      <EmptyState
        v-else-if="runs.length === 0"
        icon="i-lucide-activity"
        :title="$t('operationsPage.emptyTitle')"
        :description="$t('operationsPage.emptyDescription')"
      />

      <div v-else class="panel overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-elevated/60 text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th class="px-4 py-3 font-medium">{{ $t('operationsPage.colRun') }}</th>
              <th class="px-4 py-3 font-medium">{{ $t('operationsPage.colType') }}</th>
              <th class="px-4 py-3 font-medium">{{ $t('operationsPage.colStatus') }}</th>
              <th class="hidden px-4 py-3 font-medium md:table-cell">{{ $t('operationsPage.colResource') }}</th>
              <th class="hidden px-4 py-3 font-medium lg:table-cell">{{ $t('operationsPage.colRoute') }}</th>
              <th class="px-4 py-3 font-medium">{{ $t('operationsPage.colProgress') }}</th>
              <th class="hidden px-4 py-3 font-medium sm:table-cell">{{ $t('operationsPage.colStarted') }}</th>
              <th class="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="run in runs"
              :key="run.id"
              class="cursor-pointer border-t border-default/60 hover:bg-elevated/40"
              @click="openRun(run)"
            >
              <td class="mono px-4 py-3 text-xs text-muted">{{ shortId(run.id) }}</td>
              <td class="px-4 py-3">
                <UBadge color="neutral" variant="subtle" size="sm">{{ run.operation_type }}</UBadge>
              </td>
              <td class="px-4 py-3"><StatusBadge :status="run.status" /></td>
              <td class="hidden max-w-56 truncate px-4 py-3 md:table-cell">{{ run.resource ?? '—' }}</td>
              <td class="hidden max-w-64 truncate px-4 py-3 text-xs text-muted lg:table-cell">
                {{ run.source_label ?? '—' }} <span class="text-dimmed">→</span> {{ run.target_label ?? '—' }}
              </td>
              <td class="px-4 py-3">
                <div class="flex items-center gap-2">
                  <UProgress :model-value="Math.round(run.progress?.percent ?? 0)" :max="100" size="xs" class="w-20" />
                  <span class="text-xs text-muted">{{ Math.round(run.progress?.percent ?? 0) }}%</span>
                </div>
              </td>
              <td class="hidden whitespace-nowrap px-4 py-3 text-xs text-muted sm:table-cell">
                {{ formatRelative(run.started_at ?? run.created_at) }}
              </td>
              <td class="px-4 py-3 text-right">
                <UButton
                  v-if="!['completed', 'completed_with_warnings', 'failed', 'cancelled', 'interrupted'].includes(run.status)"
                  icon="i-lucide-square"
                  color="warning"
                  variant="ghost"
                  size="xs"
                  square
                  :aria-label="$t('operationsPage.cancelAria')"
                  @click.stop="cancelRun(run)"
                />
                <UIcon v-else name="i-lucide-chevron-right" class="size-4 text-dimmed" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <USlideover
      :open="Boolean(selected)"
      :title="selected ? `${selected.operation_type} · ${shortId(selected.id)}` : $t('operationsPage.log')"
      :description="selected?.resource ?? undefined"
      @update:open="(value) => { if (!value) closeRun() }"
    >
      <template #body>
        <div v-if="selected" class="flex h-full min-h-0 flex-col gap-4">
          <div class="grid gap-2 rounded-lg border border-default p-3 text-xs">
            <div class="flex items-center justify-between">
              <span class="text-muted">{{ $t('operationsPage.colStatus') }}</span>
              <StatusBadge :status="selected.status" />
            </div>
            <div class="flex items-center justify-between">
              <span class="text-muted">{{ $t('operationsPage.stage') }}</span>
              <span>{{ selected.progress?.stage ?? selected.stage ?? '—' }}</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-muted">{{ $t('operationsPage.rows') }}</span>
              <span>{{ formatNumber(selected.progress?.rows_read) }} {{ $t('common.read') }} / {{ formatNumber(selected.progress?.rows_written) }} {{ $t('common.written') }}</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-muted">{{ $t('operationsPage.started') }}</span>
              <span>{{ formatDateTime(selected.started_at) }}</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-muted">{{ $t('operationsPage.finished') }}</span>
              <span>{{ formatDateTime(selected.finished_at) }}</span>
            </div>
          </div>

          <UProgress :model-value="Math.round(selected.progress?.percent ?? 0)" :max="100" size="sm" />

          <div v-if="selected.error_message_safe" class="rounded-lg bg-error/10 p-3 text-xs text-error">
            <p class="font-medium">{{ selected.error_code }}</p>
            <p class="mt-1">{{ selected.error_message_safe }}</p>
          </div>

          <pre v-if="selected.result" class="mono max-h-48 overflow-auto scroll-thin rounded-lg bg-elevated/60 p-3 text-[11px]">{{
            JSON.stringify(selected.result, null, 2)
          }}</pre>

          <div class="flex items-center justify-between">
            <p class="text-xs font-medium uppercase tracking-wide text-muted">{{ $t('operationsPage.log') }}</p>
            <div class="flex items-center gap-2">
              <USwitch v-model="autoScroll" size="sm" />
              <span class="text-xs text-muted">{{ $t('operationsPage.follow') }}</span>
              <UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" size="xs" square :aria-label="$t('operationsPage.reloadLogs')" @click="loadLogs" />
            </div>
          </div>

          <div ref="logBox" class="mono min-h-0 flex-1 overflow-auto scroll-thin rounded-lg border border-default bg-elevated/30 p-3 text-[11px] leading-5">
            <p v-if="logsLoading && logs.length === 0" class="text-muted">{{ $t('operationsPage.loadingLog') }}</p>
            <p v-else-if="logs.length === 0" class="text-muted">{{ $t('operationsPage.noLogs') }}</p>
            <p v-for="entry in logs" :key="entry.id" :class="{
              'text-error': entry.level === 'error',
              'text-warning': entry.level === 'warn',
              'text-muted': entry.level === 'debug',
            }">
              <span class="text-dimmed">{{ entry.created_at.slice(11, 19) }}</span>
              <span class="text-dimmed"> [{{ entry.level }}]</span>
              {{ entry.message }}
            </p>
          </div>

          <div v-if="!['completed', 'completed_with_warnings', 'failed', 'cancelled', 'interrupted'].includes(selected.status)" class="flex justify-end">
            <UButton icon="i-lucide-square" color="warning" variant="soft" size="sm" @click="cancelRun(selected)">{{ $t('operationsPage.cancelRun') }}</UButton>
          </div>
        </div>
      </template>
    </USlideover>
  </PageShell>
</template>
