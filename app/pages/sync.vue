<script setup lang="ts">
import type {
  Connection,
  OperationRun,
  SyncLoadMode,
  SyncPipeline,
  SyncRunError,
  SyncState,
} from '~/types'

const api = useApi()
const toast = useToast()
const reportError = useApiToast()
const { t } = useI18n()

const pipelines = ref<SyncPipeline[]>([])
const connections = ref<Connection[]>([])
const states = ref<Record<string, SyncState | null>>({})
const loading = ref(true)
const saving = ref(false)
const runningId = ref<string | null>(null)
const validatingId = ref<string | null>(null)

const showForm = ref(false)
const editing = ref<SyncPipeline | null>(null)
const name = ref('')
const sourceConnectionId = ref('')
const targetConnectionId = ref('')
const sourceResource = ref('')
const targetResource = ref('')
const loadMode = ref<SyncLoadMode>('append')
const keyColumns = ref('')
const mappingText = ref('')
const optionsText = ref('')
const enabled = ref(true)
const formError = ref('')

const deleteTarget = ref<SyncPipeline | null>(null)
const confirmTarget = ref<SyncPipeline | null>(null)
const confirmName = ref('')
const detail = ref<SyncPipeline | null>(null)
const detailState = ref<SyncState | null>(null)
const detailErrors = ref<SyncRunError[]>([])
const detailRun = ref<OperationRun | null>(null)

let pollTimer: ReturnType<typeof setInterval> | undefined

async function load() {
  try {
    const [pipelineRows, connectionRows] = await Promise.all([
      api.get<SyncPipeline[]>('/sync/pipelines'),
      api.get<Connection[]>('/connections'),
    ])
    pipelines.value = pipelineRows
    connections.value = connectionRows
    await Promise.all(
      pipelineRows.map(async (pipeline) => {
        try {
          states.value[pipeline.id] = await api.get<SyncState | null>(`/sync/pipelines/${encodeURIComponent(pipeline.id)}/state`)
        } catch {
          states.value[pipeline.id] = null
        }
      }),
    )
  } catch (error) {
    reportError(error, t('syncPage.loadFailed'))
  } finally {
    loading.value = false
  }
}

onMounted(load)
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
})

function connectionName(id: string): string {
  return connections.value.find((connection) => connection.id === id)?.name ?? id.slice(0, 8)
}

function connectionById(id: string): Connection | undefined {
  return connections.value.find((connection) => connection.id === id)
}

function targetNeedsConfirmation(pipeline: SyncPipeline): boolean {
  if (pipeline.load_mode === 'truncate_and_load' || pipeline.load_mode === 'replace_resource') return true
  return connectionById(pipeline.target_connection_id)?.environment === 'production'
}

const availableConnections = computed(() =>
  connections.value.map((connection) => ({
    label: `${connection.name} (${connection.provider_id})`,
    value: connection.id,
  })),
)

const loadModes = computed(() => [
  { label: t('syncPage.modeAppend'), value: 'append' },
  { label: t('syncPage.modeUpsert'), value: 'upsert' },
  { label: t('syncPage.modeTruncate'), value: 'truncate_and_load' },
])

function openCreate() {
  editing.value = null
  name.value = ''
  sourceConnectionId.value = connections.value[0]?.id ?? ''
  targetConnectionId.value = connections.value[1]?.id ?? connections.value[0]?.id ?? ''
  sourceResource.value = ''
  targetResource.value = ''
  loadMode.value = 'append'
  keyColumns.value = ''
  mappingText.value = ''
  optionsText.value = ''
  enabled.value = true
  formError.value = ''
  showForm.value = true
}

function openEdit(pipeline: SyncPipeline) {
  editing.value = pipeline
  name.value = pipeline.name
  sourceConnectionId.value = pipeline.source_connection_id
  targetConnectionId.value = pipeline.target_connection_id
  sourceResource.value = pipeline.source_resource
  targetResource.value = pipeline.target_resource
  loadMode.value = pipeline.load_mode
  keyColumns.value = pipeline.key_columns.join(', ')
  mappingText.value = pipeline.mapping.length ? JSON.stringify(pipeline.mapping, null, 2) : ''
  optionsText.value = Object.keys(pipeline.options).length ? JSON.stringify(pipeline.options, null, 2) : ''
  enabled.value = pipeline.enabled
  formError.value = ''
  showForm.value = true
}

function parseJson<T>(value: string, label: string, fallback: T): T {
  if (!value.trim()) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    throw new Error(t('syncPage.invalidJson', { field: label }))
  }
}

async function save() {
  formError.value = ''
  if (!name.value.trim() || !sourceConnectionId.value || !targetConnectionId.value) {
    formError.value = t('syncPage.requiredFields')
    return
  }
  if (!sourceResource.value.trim() || !targetResource.value.trim()) {
    formError.value = t('syncPage.requiredFields')
    return
  }
  if (loadMode.value === 'upsert' && !keyColumns.value.trim()) {
    formError.value = t('syncPage.keysRequired')
    return
  }
  saving.value = true
  try {
    const mapping = parseJson<unknown[]>(mappingText.value, 'mapping', [])
    const options = parseJson<Record<string, unknown>>(optionsText.value, 'options', {})
    const body = {
      name: name.value.trim(),
      source_connection_id: sourceConnectionId.value,
      target_connection_id: targetConnectionId.value,
      source_resource: sourceResource.value.trim(),
      target_resource: targetResource.value.trim(),
      load_mode: loadMode.value,
      key_columns: keyColumns.value
        .split(',')
        .map((column) => column.trim())
        .filter(Boolean),
      mapping,
      options,
      enabled: enabled.value,
    }
    if (editing.value) {
      await api.patch(`/sync/pipelines/${encodeURIComponent(editing.value.id)}`, body)
      toast.add({ title: t('syncPage.updated'), color: 'success', icon: 'i-lucide-arrow-right-left' })
    } else {
      await api.post('/sync/pipelines', body)
      toast.add({ title: t('syncPage.created'), color: 'success', icon: 'i-lucide-arrow-right-left' })
    }
    showForm.value = false
    await load()
  } catch (error) {
    if (error instanceof Error && !('code' in error)) {
      formError.value = error.message
    } else {
      reportError(error, editing.value ? t('syncPage.updateFailed') : t('syncPage.createFailed'))
    }
  } finally {
    saving.value = false
  }
}

async function remove() {
  if (!deleteTarget.value) return
  try {
    await api.del(`/sync/pipelines/${encodeURIComponent(deleteTarget.value.id)}`)
    toast.add({ title: t('syncPage.deleted'), color: 'success', icon: 'i-lucide-trash-2' })
    deleteTarget.value = null
    await load()
  } catch (error) {
    reportError(error, t('syncPage.deleteFailed'))
  }
}

function askRun(pipeline: SyncPipeline) {
  confirmName.value = ''
  if (targetNeedsConfirmation(pipeline)) {
    confirmTarget.value = pipeline
    return
  }
  void runPipeline(pipeline, {})
}

async function confirmRun() {
  if (!confirmTarget.value) return
  const pipeline = confirmTarget.value
  if (confirmName.value !== connectionName(pipeline.target_connection_id)) {
    toast.add({ title: t('syncPage.confirmMismatch'), color: 'warning', icon: 'i-lucide-triangle-alert' })
    return
  }
  confirmTarget.value = null
  await runPipeline(pipeline, { confirm: confirmName.value })
}

async function runPipeline(pipeline: SyncPipeline, options: { confirm?: string }) {
  runningId.value = pipeline.id
  try {
    const run = await api.post<OperationRun>(`/sync/pipelines/${encodeURIComponent(pipeline.id)}/run`, options)
    toast.add({ title: t('syncPage.runStarted'), description: run.id.slice(0, 8), color: 'info', icon: 'i-lucide-play' })
    await pollRun(pipeline, run.id)
  } catch (error) {
    reportError(error, t('syncPage.runFailed'))
    runningId.value = null
  }
}

async function pollRun(pipeline: SyncPipeline, runId: string) {
  if (pollTimer) clearInterval(pollTimer)
  const terminal = new Set(['completed', 'completed_with_warnings', 'failed', 'cancelled', 'interrupted'])
  const check = async () => {
    try {
      const run = await api.get<OperationRun>(`/runs/${encodeURIComponent(runId)}`)
      if (!terminal.has(run.status)) return
      if (pollTimer) clearInterval(pollTimer)
      pollTimer = undefined
      runningId.value = null
      await load()
      if (detail.value?.id === pipeline.id) await openDetail(pipeline)
      const success = run.status === 'completed' || run.status === 'completed_with_warnings'
      toast.add({
        title: success ? t('syncPage.runFinished') : t('syncPage.runFailed'),
        description: run.error_message_safe ?? undefined,
        color: success ? (run.status === 'completed_with_warnings' ? 'warning' : 'success') : 'error',
        icon: success ? 'i-lucide-circle-check' : 'i-lucide-circle-x',
      })
    } catch (error) {
      if (pollTimer) clearInterval(pollTimer)
      pollTimer = undefined
      runningId.value = null
      reportError(error, t('syncPage.runFailed'))
    }
  }
  await check()
  if (runningId.value === pipeline.id) {
    pollTimer = setInterval(() => {
      void check()
    }, 1500)
  }
}

async function validate(pipeline: SyncPipeline) {
  validatingId.value = pipeline.id
  try {
    const run = await api.post<OperationRun>(`/sync/pipelines/${encodeURIComponent(pipeline.id)}/validate`, { limit: 100 })
    const success = run.status === 'completed' || run.status === 'completed_with_warnings'
    toast.add({
      title: success ? t('syncPage.validatePassed') : t('syncPage.validateFailed'),
      description: t('syncPage.validateSummary', {
        sampled: Number(run.result?.rows_sampled ?? 0),
        matched: Number(run.result?.rows_matched ?? 0),
        errors: Number(run.result?.errors ?? 0),
      }),
      color: success ? 'success' : 'error',
      icon: success ? 'i-lucide-flask-conical' : 'i-lucide-circle-x',
    })
  } catch (error) {
    reportError(error, t('syncPage.validateFailed'))
  } finally {
    validatingId.value = null
  }
}

async function openDetail(pipeline: SyncPipeline) {
  detail.value = pipeline
  detailRun.value = null
  detailErrors.value = []
  detailState.value = states.value[pipeline.id] ?? null
  try {
    detailState.value = await api.get<SyncState | null>(`/sync/pipelines/${encodeURIComponent(pipeline.id)}/state`)
    const runId = detailState.value?.last_run_id
    if (runId) {
      detailRun.value = await api.get<OperationRun>(`/runs/${encodeURIComponent(runId)}`)
      detailErrors.value = await api.get<SyncRunError[]>(`/runs/${encodeURIComponent(runId)}/errors?limit=100`)
    }
  } catch (error) {
    reportError(error, t('syncPage.detailFailed'))
  }
}

async function resetCheckpoint(pipeline: SyncPipeline) {
  try {
    await api.post(`/sync/pipelines/${encodeURIComponent(pipeline.id)}/reset`, {})
    detailState.value = null
    states.value[pipeline.id] = null
    toast.add({ title: t('syncPage.checkpointReset'), description: pipeline.name, color: 'success', icon: 'i-lucide-rotate-ccw' })
  } catch (error) {
    reportError(error, t('syncPage.detailFailed'))
  }
}
</script>

<template>
  <PageShell
    id="sync"
    :title="$t('syncPage.title')"
    :description="$t('syncPage.description', { count: pipelines.length })"
  >
    <template #right>
      <UButton icon="i-lucide-plus" :disabled="connections.length < 2" @click="openCreate">{{ $t('syncPage.newPipeline') }}</UButton>
      <UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" square :aria-label="$t('common.refresh')" @click="load" />
    </template>

    <div class="flex-1 overflow-auto scroll-thin p-4 sm:p-6">
      <div v-if="loading" class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" /> {{ $t('syncPage.loading') }}
      </div>

      <EmptyState
        v-else-if="pipelines.length === 0"
        icon="i-lucide-arrow-right-left"
        :title="$t('syncPage.emptyTitle')"
        :description="$t('syncPage.emptyDescription')"
      >
        <UButton icon="i-lucide-plus" :disabled="connections.length < 2" @click="openCreate">{{ $t('syncPage.newPipeline') }}</UButton>
      </EmptyState>

      <div v-else class="panel overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-elevated/60 text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th class="px-4 py-3 font-medium">{{ $t('syncPage.colPipeline') }}</th>
              <th class="hidden px-4 py-3 font-medium sm:table-cell">{{ $t('syncPage.colMode') }}</th>
              <th class="hidden px-4 py-3 font-medium md:table-cell">{{ $t('syncPage.colRoute') }}</th>
              <th class="hidden px-4 py-3 font-medium lg:table-cell">{{ $t('syncPage.colLastRun') }}</th>
              <th class="px-4 py-3 text-right font-medium">{{ $t('common.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="pipeline in pipelines" :key="pipeline.id" class="border-t border-default/60 hover:bg-elevated/40">
              <td class="px-4 py-3">
                <div class="flex items-center gap-2">
                  <UIcon name="i-lucide-arrow-right-left" class="size-4 shrink-0 text-dimmed" />
                  <span class="min-w-0">
                    <span class="block truncate font-medium">{{ pipeline.name }}</span>
                    <span class="mono block truncate text-xs text-muted">{{ pipeline.id }}</span>
                  </span>
                  <UBadge v-if="!pipeline.enabled" color="warning" variant="subtle" size="sm">{{ $t('syncPage.disabled') }}</UBadge>
                </div>
              </td>
              <td class="hidden px-4 py-3 sm:table-cell">
                <UBadge color="neutral" variant="subtle" size="sm">{{ pipeline.load_mode }}</UBadge>
              </td>
              <td class="hidden max-w-72 px-4 py-3 md:table-cell">
                <span class="mono block truncate text-xs">{{ connectionName(pipeline.source_connection_id) }}.{{ pipeline.source_resource }}</span>
                <span class="mono block truncate text-xs text-muted">→ {{ connectionName(pipeline.target_connection_id) }}.{{ pipeline.target_resource }}</span>
              </td>
              <td class="hidden px-4 py-3 lg:table-cell">
                <div v-if="states[pipeline.id]" class="flex items-center gap-2">
                  <StatusBadge :status="states[pipeline.id]?.last_status ?? 'unknown'" />
                  <span class="text-xs text-muted">{{ formatRelative(states[pipeline.id]?.last_run_at ?? '') }}</span>
                </div>
                <span v-else class="text-xs text-muted">{{ $t('common.never') }}</span>
              </td>
              <td class="px-4 py-3">
                <div class="flex justify-end gap-1">
                  <UTooltip :text="$t('syncPage.validate')">
                    <UButton
                      icon="i-lucide-flask-conical"
                      color="neutral"
                      variant="ghost"
                      size="sm"
                      square
                      :loading="validatingId === pipeline.id"
                      :aria-label="$t('syncPage.validate')"
                      @click="validate(pipeline)"
                    />
                  </UTooltip>
                  <UTooltip :text="$t('syncPage.run')">
                    <UButton
                      icon="i-lucide-play"
                      color="neutral"
                      variant="ghost"
                      size="sm"
                      square
                      :loading="runningId === pipeline.id"
                      :disabled="!pipeline.enabled"
                      :aria-label="$t('syncPage.run')"
                      @click="askRun(pipeline)"
                    />
                  </UTooltip>
                  <UTooltip :text="$t('syncPage.inspect')">
                    <UButton icon="i-lucide-eye" color="neutral" variant="ghost" size="sm" square :aria-label="$t('syncPage.inspect')" @click="openDetail(pipeline)" />
                  </UTooltip>
                  <UTooltip :text="$t('common.edit')">
                    <UButton icon="i-lucide-pencil" color="neutral" variant="ghost" size="sm" square :aria-label="$t('common.edit')" @click="openEdit(pipeline)" />
                  </UTooltip>
                  <UTooltip :text="$t('common.delete')">
                    <UButton icon="i-lucide-trash-2" color="error" variant="ghost" size="sm" square :aria-label="$t('common.delete')" @click="deleteTarget = pipeline" />
                  </UTooltip>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <UModal
      v-model:open="showForm"
      :title="editing ? $t('syncPage.editTitle') : $t('syncPage.createTitle')"
      :description="$t('syncPage.formDescription')"
    >
      <template #body>
        <div class="grid gap-4">
          <p v-if="formError" class="rounded-lg bg-error/10 px-3 py-2 text-sm text-error">{{ formError }}</p>
          <UFormField :label="$t('common.name')" required>
            <UInput v-model="name" class="w-full" :placeholder="$t('syncPage.namePlaceholder')" />
          </UFormField>
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField :label="$t('syncPage.sourceConnection')" required>
              <USelect v-model="sourceConnectionId" :items="availableConnections" class="w-full" />
            </UFormField>
            <UFormField :label="$t('syncPage.sourceResource')" required>
              <UInput v-model="sourceResource" class="w-full" :placeholder="$t('syncPage.resourcePlaceholder')" />
            </UFormField>
          </div>
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField :label="$t('syncPage.targetConnection')" required>
              <USelect v-model="targetConnectionId" :items="availableConnections" class="w-full" />
            </UFormField>
            <UFormField :label="$t('syncPage.targetResource')" required>
              <UInput v-model="targetResource" class="w-full" :placeholder="$t('syncPage.resourcePlaceholder')" />
            </UFormField>
          </div>
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField :label="$t('syncPage.loadMode')" :help="$t('syncPage.loadModeHelp')">
              <USelect v-model="loadMode" :items="loadModes" class="w-full" />
            </UFormField>
            <UFormField :label="$t('syncPage.keyColumns')" :help="$t('syncPage.keyColumnsHelp')">
              <UInput v-model="keyColumns" class="w-full" placeholder="id, tenant_id" />
            </UFormField>
          </div>
          <UFormField :label="$t('syncPage.mapping')" :help="$t('syncPage.mappingHelp')">
            <UTextarea v-model="mappingText" :rows="5" class="w-full mono" placeholder='[{"source":"id","target":"id"}]' />
          </UFormField>
          <UFormField :label="$t('syncPage.options')" :help="$t('syncPage.optionsHelp')">
            <UTextarea v-model="optionsText" :rows="5" class="w-full mono" placeholder='{"filter":{"column":"updated_at","operator":"gte","value":"2024-01-01"}}' />
          </UFormField>
          <div class="flex items-center gap-3">
            <USwitch v-model="enabled" />
            <span class="text-sm">{{ $t('syncPage.enabled') }}</span>
          </div>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="showForm = false">{{ $t('common.cancel') }}</UButton>
          <UButton :loading="saving" icon="i-lucide-save" @click="save">{{ editing ? $t('common.save') : $t('common.create') }}</UButton>
        </div>
      </template>
    </UModal>

    <UModal :open="Boolean(confirmTarget)" :title="$t('syncPage.confirmTitle')" @update:open="(value) => { if (!value) confirmTarget = null }">
      <template #body>
        <div v-if="confirmTarget" class="grid gap-4 text-sm">
          <p>{{ $t('syncPage.confirmBody', { target: connectionName(confirmTarget.target_connection_id) }) }}</p>
          <p class="text-xs text-muted">{{ $t('syncPage.confirmHint', { target: connectionName(confirmTarget.target_connection_id) }) }}</p>
          <UInput v-model="confirmName" class="w-full" :placeholder="connectionName(confirmTarget.target_connection_id)" />
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="confirmTarget = null">{{ $t('common.cancel') }}</UButton>
          <UButton color="error" icon="i-lucide-play" :disabled="!confirmName" @click="confirmRun">{{ $t('syncPage.confirmRun') }}</UButton>
        </div>
      </template>
    </UModal>

    <UModal :open="Boolean(deleteTarget)" :title="$t('syncPage.deleteTitle')" @update:open="(value) => { if (!value) deleteTarget = null }">
      <template #body>
        <p v-if="deleteTarget" class="text-sm">{{ $t('syncPage.deleteBody', { name: deleteTarget.name }) }}</p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="deleteTarget = null">{{ $t('common.cancel') }}</UButton>
          <UButton color="error" icon="i-lucide-trash-2" @click="remove">{{ $t('common.delete') }}</UButton>
        </div>
      </template>
    </UModal>

    <USlideover
      :open="Boolean(detail)"
      :title="detail ? $t('syncPage.detailTitle', { name: detail.name }) : $t('syncPage.inspect')"
      @update:open="(value) => { if (!value) detail = null }"
    >
      <template #body>
        <div v-if="detail" class="grid gap-5 text-sm">
          <div class="flex flex-wrap items-center gap-2">
            <UBadge color="neutral" variant="subtle" size="sm">{{ detail.load_mode }}</UBadge>
            <UBadge :color="detail.enabled ? 'success' : 'warning'" variant="subtle" size="sm">
              {{ detail.enabled ? $t('syncPage.enabled') : $t('syncPage.disabled') }}
            </UBadge>
            <StatusBadge v-if="detailState" :status="detailState.last_status ?? 'unknown'" />
          </div>

          <div class="grid gap-2">
            <p class="text-xs uppercase tracking-wide text-muted">{{ $t('syncPage.route') }}</p>
            <p class="mono break-all rounded-lg bg-elevated/60 p-2 text-[11px]">
              {{ connectionName(detail.source_connection_id) }}.{{ detail.source_resource }}
              → {{ connectionName(detail.target_connection_id) }}.{{ detail.target_resource }}
            </p>
            <p class="text-xs text-muted">{{ $t('syncPage.keys') }}: <span class="mono">{{ detail.key_columns.join(', ') || '—' }}</span></p>
          </div>

          <div>
            <p class="mb-1 text-xs uppercase tracking-wide text-muted">{{ $t('syncPage.mapping') }}</p>
            <pre class="max-h-48 overflow-auto rounded-lg bg-elevated/60 p-2 text-[11px]">{{ JSON.stringify(detail.mapping, null, 2) }}</pre>
          </div>
          <div>
            <p class="mb-1 text-xs uppercase tracking-wide text-muted">{{ $t('syncPage.options') }}</p>
            <pre class="max-h-40 overflow-auto rounded-lg bg-elevated/60 p-2 text-[11px]">{{ JSON.stringify(detail.options, null, 2) }}</pre>
          </div>

          <div v-if="detailState" class="grid gap-2">
            <div class="flex items-center justify-between">
              <p class="text-xs uppercase tracking-wide text-muted">{{ $t('syncPage.checkpoint') }}</p>
              <UButton icon="i-lucide-rotate-ccw" size="xs" color="neutral" variant="ghost" @click="resetCheckpoint(detail)">
                {{ $t('syncPage.resetCheckpoint') }}
              </UButton>
            </div>
            <p class="text-xs">{{ $t('syncPage.lastRunAt', { at: detailState.last_run_at ?? '—' }) }} · {{ $t('syncPage.totalRows', { count: detailState.rows_synced }) }}</p>
            <pre class="max-h-40 overflow-auto rounded-lg bg-elevated/60 p-2 text-[11px]">{{ JSON.stringify(detailState.checkpoint, null, 2) }}</pre>
          </div>

          <div v-if="detailRun" class="grid gap-2">
            <p class="text-xs uppercase tracking-wide text-muted">{{ $t('syncPage.lastRunResult') }}</p>
            <pre class="max-h-56 overflow-auto rounded-lg bg-elevated/60 p-2 text-[11px]">{{ JSON.stringify(detailRun.result, null, 2) }}</pre>
          </div>

          <div>
            <p class="mb-1 text-xs uppercase tracking-wide text-muted">{{ $t('syncPage.rowErrors', { count: detailErrors.length }) }}</p>
            <p v-if="detailErrors.length === 0" class="text-xs text-muted">{{ $t('syncPage.noErrors') }}</p>
            <div v-else class="max-h-64 overflow-auto rounded-lg border border-default/60">
              <table class="w-full text-xs">
                <thead class="bg-elevated/60 text-left text-muted">
                  <tr>
                    <th class="px-2 py-1.5">{{ $t('syncPage.colRow') }}</th>
                    <th class="px-2 py-1.5">{{ $t('syncPage.colCode') }}</th>
                    <th class="px-2 py-1.5">{{ $t('syncPage.colMessage') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in detailErrors" :key="row.id" class="border-t border-default/40">
                    <td class="px-2 py-1.5 mono">{{ row.row_index ?? '—' }}</td>
                    <td class="px-2 py-1.5 mono">{{ row.code }}</td>
                    <td class="px-2 py-1.5">{{ row.message }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </template>
    </USlideover>
  </PageShell>
</template>
