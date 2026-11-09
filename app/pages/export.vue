<script setup lang="ts">
import type { Artifact, Connection, OperationRun, ResourceDescriptor, ResourceSchema } from '~/types'

const api = useApi()
const toast = useToast()
const reportError = useApiToast()
const { t } = useI18n()

const connections = ref<Connection[]>([])
const resources = ref<ResourceDescriptor[]>([])
const schema = ref<ResourceSchema | null>(null)
const loadingResources = ref(false)
const loadingSchema = ref(false)

const connectionId = ref('')
const resource = ref('')
const format = ref<'jsonl' | 'csv' | 'json' | 'xml' | 'xlsx'>('jsonl')
const compression = ref<'none' | 'gzip'>('gzip')

watch(format, (next) => {
  // XLSX is already a zip container; wrapping it in gzip is rejected by the core.
  if (next === 'xlsx') compression.value = 'none'
})
const limit = ref<number | undefined>(undefined)
const batchSize = ref<number>(1000)
const outputDir = ref('')

const run = ref<OperationRun | null>(null)
const artifact = ref<Artifact | null>(null)
const starting = ref(false)
let pollTimer: ReturnType<typeof setInterval> | undefined

const connection = computed(() => connections.value.find((item) => item.id === connectionId.value) ?? null)
const selectableResources = computed(() =>
  resources.value
    .filter((item) => ['table', 'view', 'collection'].includes(item.type))
    .map((item) => ({ value: item.id, label: `${item.id} · ${item.type}` })),
)
const terminal = computed(() =>
  run.value ? ['completed', 'completed_with_warnings', 'failed', 'cancelled', 'interrupted'].includes(run.value.status) : false,
)
const percent = computed(() => Math.round(run.value?.progress?.percent ?? 0))

onMounted(async () => {
  try {
    connections.value = await api.get<Connection[]>('/connections')
    connectionId.value = connections.value[0]?.id ?? ''
    if (connectionId.value) await loadResources()
  } catch (error) {
    reportError(error, t('exportPage.loadConnectionsFailed'))
  }
})

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
})

async function loadResources() {
  resources.value = []
  resource.value = ''
  schema.value = null
  if (!connection.value) return
  loadingResources.value = true
  try {
    resources.value = await api.get<ResourceDescriptor[]>(`/connections/${encodeURIComponent(connection.value.name)}/resources`)
  } catch (error) {
    reportError(error, t('exportPage.listResourcesFailed'))
  } finally {
    loadingResources.value = false
  }
}

async function loadSchema() {
  schema.value = null
  if (!connection.value || !resource.value) return
  loadingSchema.value = true
  try {
    schema.value = await api.get<ResourceSchema>(
      `/connections/${encodeURIComponent(connection.value.name)}/schema?resource=${encodeURIComponent(resource.value)}`,
    )
  } catch (error) {
    reportError(error, t('exportPage.schemaFailed'))
  } finally {
    loadingSchema.value = false
  }
}

watch(connectionId, async () => {
  await loadResources()
})

watch(resource, () => {
  void loadSchema()
})

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = undefined
}

async function start() {
  if (!connection.value || !resource.value) {
    toast.add({ title: t('exportPage.pickRequired'), color: 'warning', icon: 'i-lucide-triangle-alert' })
    return
  }
  starting.value = true
  artifact.value = null
  run.value = null
  try {
    const created = await api.post<OperationRun>('/export', {
      connection_id: connection.value.id,
      resource: resource.value,
      format: format.value,
      compression: compression.value,
      ...(limit.value ? { limit: Number(limit.value) } : {}),
      batch_size: Number(batchSize.value) || 1000,
      ...(outputDir.value ? { output_dir: outputDir.value } : {}),
    })
    run.value = created
    stopPolling()
    pollTimer = setInterval(async () => {
      if (!run.value) return
      try {
        const fresh = await api.get<OperationRun>(`/runs/${run.value.id}`)
        run.value = fresh
        if (['completed', 'completed_with_warnings'].includes(fresh.status) && fresh.result?.artifact_id) {
          stopPolling()
          artifact.value = await api.get<Artifact>(`/artifacts/${String(fresh.result.artifact_id)}`)
          toast.add({
            title: t('exportPage.completed'),
            description: t('exportPage.completedDescription', { count: formatNumber(Number(fresh.result.rows ?? 0)) }),
            color: 'success',
            icon: 'i-lucide-circle-check',
          })
        } else if (['failed', 'cancelled', 'interrupted'].includes(fresh.status)) {
          stopPolling()
          toast.add({
            title: t('exportPage.failed'),
            description: fresh.error_message_safe ?? fresh.status,
            color: 'error',
            icon: 'i-lucide-circle-x',
          })
        }
      } catch (error) {
        stopPolling()
        reportError(error, t('exportPage.lostTrack'))
      }
    }, 700)
  } catch (error) {
    reportError(error, t('exportPage.startFailed'))
  } finally {
    starting.value = false
  }
}

async function cancel() {
  if (!run.value) return
  try {
    run.value = await api.post<OperationRun>(`/runs/${run.value.id}/cancel`)
  } catch (error) {
    reportError(error, t('exportPage.cancelFailed'))
  }
}
</script>

<template>
  <PageShell id="export" :title="$t('exportPage.title')" :description="$t('exportPage.description')">
    <template #right>
      <UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" square :aria-label="$t('exportPage.reload')" @click="loadResources" />
    </template>

    <div class="flex-1 overflow-auto scroll-thin p-4 sm:p-6">
      <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div class="panel grid gap-4 p-5">
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField :label="$t('exportPage.connection')" required>
              <USelect
                v-model="connectionId"
                :items="connections.map((item) => ({ value: item.id, label: `${item.name} · ${item.provider_id}` }))"
                :placeholder="$t('exportPage.connectionPlaceholder')"
                class="w-full"
              />
            </UFormField>
            <UFormField :label="$t('exportPage.resource')" required :help="loadingResources ? $t('exportPage.discoveringResources') : undefined">
              <USelect
                v-model="resource"
                :items="selectableResources"
                :loading="loadingResources"
                :placeholder="$t('exportPage.resourcePlaceholder')"
                class="w-full"
                :disabled="selectableResources.length === 0"
              />
            </UFormField>
          </div>

          <div class="grid gap-4 sm:grid-cols-3">
            <UFormField :label="$t('exportPage.format')">
              <USelect v-model="format" :items="['jsonl', 'csv', 'json', 'xml', 'xlsx']" class="w-full" />
            </UFormField>
            <UFormField :label="$t('exportPage.compression')">
              <USelect v-model="compression" :items="['gzip', 'none']" class="w-full" />
            </UFormField>
            <UFormField :label="$t('exportPage.rowLimit')" :help="$t('exportPage.rowLimitHelp')">
              <UInput v-model.number="limit" type="number" min="1" :placeholder="$t('exportPage.allRows')" class="w-full" />
            </UFormField>
          </div>

          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField :label="$t('exportPage.batchSize')" :help="$t('exportPage.batchSizeHelp')">
              <UInput v-model.number="batchSize" type="number" min="1" max="5000" class="w-full" />
            </UFormField>
            <UFormField :label="$t('exportPage.outputDir')" :help="$t('exportPage.outputDirHelp')">
              <UInput v-model="outputDir" :placeholder="$t('exportPage.outputDirPlaceholder')" class="w-full" />
            </UFormField>
          </div>

          <div v-if="schema" class="rounded-lg border border-default">
            <div class="flex items-center gap-2 border-b border-default px-3 py-2 text-xs text-muted">
              <UIcon name="i-lucide-columns-3" class="size-4" />
              <span class="mono">{{ schema.resource }}</span>
              <UBadge color="neutral" variant="subtle" size="sm">{{ schema.source }}</UBadge>
              <span v-if="schema.rowCountEstimate != null" class="ms-auto">{{ $t('common.rowEstimate', { count: formatNumber(schema.rowCountEstimate) }) }}</span>
            </div>
            <div class="max-h-52 overflow-auto scroll-thin px-3 py-2">
              <div class="grid gap-1 sm:grid-cols-2">
                <div v-for="column in schema.columns" :key="column.name" class="flex items-center justify-between gap-2 text-xs">
                  <span class="mono truncate">{{ column.name }}</span>
                  <span class="text-muted">{{ column.type }}</span>
                </div>
              </div>
            </div>
          </div>
          <div v-else-if="loadingSchema" class="flex items-center gap-2 text-sm text-muted">
            <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" /> {{ $t('exportPage.readingSchema') }}
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <UButton icon="i-lucide-arrow-up-from-line" :loading="starting" :disabled="!connection || !resource" @click="start">
              {{ $t('exportPage.start') }}
            </UButton>
            <UButton
              v-if="run && !terminal"
              icon="i-lucide-square"
              color="warning"
              variant="soft"
              @click="cancel"
            >
              {{ $t('common.cancel') }}
            </UButton>
            <span v-if="connection" class="text-xs text-muted">
              {{ connection.provider_id }} · {{ connection.environment }}
            </span>
          </div>
        </div>

        <div class="grid content-start gap-4">
          <div class="panel p-4">
            <p class="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{{ $t('common.run') }}</p>
            <template v-if="run">
              <div class="mb-2 flex items-center justify-between gap-2">
                <StatusBadge :status="run.status" />
                <span class="mono text-xs text-muted">{{ shortId(run.id) }}</span>
              </div>
              <UProgress :model-value="percent" :max="100" size="sm" />
              <div class="mt-2 flex justify-between text-xs text-muted">
                <span>{{ run.progress?.stage ?? $t('exportPage.progressStage') }}</span>
                <span>{{ percent }}%</span>
              </div>
              <p v-if="run.progress?.rows_read" class="mt-2 text-xs text-muted">
                {{ $t('common.rowsRead', { count: formatNumber(run.progress.rows_read) }) }}
              </p>
              <p v-if="run.error_message_safe" class="mt-2 rounded-lg bg-error/10 p-2 text-xs text-error">
                {{ run.error_message_safe }}
              </p>
            </template>
            <p v-else class="text-sm text-muted">{{ $t('exportPage.nothingRunning') }}</p>
          </div>

          <div v-if="artifact" class="panel p-4">
            <p class="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted">
              <UIcon name="i-lucide-package-check" class="size-4 text-success" /> {{ $t('exportPage.artifact') }}
            </p>
            <dl class="grid gap-2 text-xs">
              <div class="flex justify-between gap-2">
                <dt class="text-muted">{{ $t('common.rows') }}</dt>
                <dd>{{ formatNumber(artifact.manifest.row_count) }}</dd>
              </div>
              <div class="flex justify-between gap-2">
                <dt class="text-muted">{{ $t('common.size') }}</dt>
                <dd>{{ formatBytes(artifact.size_bytes) }}</dd>
              </div>
              <div class="flex justify-between gap-2">
                <dt class="text-muted">{{ $t('exportPage.format') }}</dt>
                <dd>{{ $t('exportPage.formatValue', { format: artifact.manifest.format, compression: artifact.manifest.compression }) }}</dd>
              </div>
              <div class="flex justify-between gap-2">
                <dt class="text-muted">{{ $t('exportPage.verified') }}</dt>
                <dd><StatusBadge :status="artifact.verification_status" /></dd>
              </div>
            </dl>
            <p class="mono mt-3 break-all rounded-lg bg-elevated/60 p-2 text-[11px] text-muted">
              {{ artifact.absolute_path }}
            </p>
            <div class="mt-3 flex flex-wrap gap-2">
              <UButton
                size="sm"
                icon="i-lucide-arrow-down-to-line"
                color="primary"
                variant="soft"
                @click="navigateTo(`/import?artifact=${artifact.id}`)"
              >
                {{ $t('exportPage.importThis') }}
              </UButton>
              <UButton size="sm" icon="i-lucide-list-checks" color="neutral" variant="ghost" @click="navigateTo('/artifacts')">
                {{ $t('exportPage.artifactsAction') }}
              </UButton>
            </div>
          </div>

          <div class="panel p-4 text-xs text-muted">
            <p class="mb-2 flex items-center gap-2 font-medium text-highlighted">
              <UIcon name="i-lucide-shield-check" class="size-4" /> {{ $t('exportPage.guarantees') }}
            </p>
            <ul class="grid list-disc gap-1 ps-4">
              <li>{{ $t('exportPage.guarantee1') }}</li>
              <li>{{ $t('exportPage.guarantee2') }}</li>
              <li>{{ $t('exportPage.guarantee3') }}</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  </PageShell>
</template>
