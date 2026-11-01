<script setup lang="ts">
import type { Artifact, Connection, OperationRun, ResourceDescriptor, ResourceSchema } from '~/types'

const api = useApi()
const toast = useToast()
const reportError = useApiToast()
const route = useRoute()
const { t } = useI18n()

const connections = ref<Connection[]>([])
const artifacts = ref<Artifact[]>([])
const resources = ref<ResourceDescriptor[]>([])
const schema = ref<ResourceSchema | null>(null)

const connectionId = ref('')
const resource = ref('')
const sourceMode = ref<'artifact' | 'file'>('artifact')
const artifactId = ref('')
const filePath = ref('')
const format = ref<'' | 'jsonl' | 'csv' | 'json'>('')
const mode = ref<'append' | 'upsert' | 'truncate_and_load'>('append')
const keyColumns = ref('')
const dryRun = ref(false)
const confirmText = ref('')
const batchSize = ref(1000)

const run = ref<OperationRun | null>(null)
const starting = ref(false)
const loadingSchema = ref(false)
let pollTimer: ReturnType<typeof setInterval> | undefined

const connection = computed(() => connections.value.find((item) => item.id === connectionId.value) ?? null)
const terminal = computed(() =>
  run.value ? ['completed', 'completed_with_warnings', 'failed', 'cancelled', 'interrupted'].includes(run.value.status) : false,
)
const needsConfirm = computed(
  () => mode.value === 'truncate_and_load' || (connection.value?.environment === 'production' && mode.value !== 'append'),
)
const resourceOptions = computed(() =>
  resources.value
    .filter((item) => ['table', 'view', 'collection'].includes(item.type))
    .map((item) => ({ value: item.id, label: `${item.id} · ${item.type}` })),
)
const selectedArtifact = computed(() => artifacts.value.find((item) => item.id === artifactId.value) ?? null)

onMounted(async () => {
  try {
    const [connectionList, artifactList] = await Promise.all([
      api.get<Connection[]>('/connections'),
      api.get<Artifact[]>('/artifacts?limit=100'),
    ])
    connections.value = connectionList
    artifacts.value = artifactList
    connectionId.value = connectionList[0]?.id ?? ''
    const preset = typeof route.query.artifact === 'string' ? route.query.artifact : ''
    if (preset) {
      artifactId.value = preset
      sourceMode.value = 'artifact'
    } else {
      artifactId.value = artifactList[0]?.id ?? ''
    }
    if (connectionId.value) await loadResources()
  } catch (error) {
    reportError(error, t('importPage.contextFailed'))
  }
})

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
})

async function loadResources() {
  resources.value = []
  if (!connection.value) return
  try {
    resources.value = await api.get<ResourceDescriptor[]>(`/connections/${encodeURIComponent(connection.value.name)}/resources`)
  } catch (error) {
    reportError(error, t('importPage.targetResourcesFailed'))
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
  } catch {
    schema.value = null
  } finally {
    loadingSchema.value = false
  }
}

watch(connectionId, () => {
  void loadResources()
})
watch(resource, () => {
  void loadSchema()
})
watch(mode, () => {
  if (mode.value === 'append') confirmText.value = ''
})

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = undefined
}

async function start() {
  if (!connection.value || !resource.value) {
    toast.add({ title: t('importPage.pickRequired'), color: 'warning', icon: 'i-lucide-triangle-alert' })
    return
  }
  if (sourceMode.value === 'artifact' && !artifactId.value) {
    toast.add({ title: t('importPage.artifactRequired'), color: 'warning', icon: 'i-lucide-triangle-alert' })
    return
  }
  if (sourceMode.value === 'file' && !filePath.value.trim()) {
    toast.add({ title: t('importPage.fileRequired'), color: 'warning', icon: 'i-lucide-triangle-alert' })
    return
  }
  starting.value = true
  run.value = null
  try {
    const created = await api.post<OperationRun>('/import', {
      connection_id: connection.value.id,
      resource: resource.value,
      source:
        sourceMode.value === 'artifact'
          ? { artifact_id: artifactId.value }
          : { path: filePath.value.trim() },
      mode: mode.value,
      ...(format.value ? { format: format.value } : {}),
      ...(keyColumns.value ? { key_columns: keyColumns.value.split(',').map((item) => item.trim()).filter(Boolean) } : {}),
      batch_size: Number(batchSize.value) || 1000,
      dry_run: dryRun.value,
      ...(confirmText.value ? { confirm: confirmText.value } : {}),
    })
    run.value = created
    stopPolling()
    pollTimer = setInterval(async () => {
      if (!run.value) return
      try {
        const fresh = await api.get<OperationRun>(`/runs/${run.value.id}`)
        run.value = fresh
        if (['completed', 'completed_with_warnings'].includes(fresh.status)) {
          stopPolling()
          toast.add({
            title: fresh.result?.dry_run ? t('importPage.dryRunFinished') : t('importPage.importCompleted'),
            description: fresh.result?.dry_run
              ? t('importPage.dryRunFinishedDescription')
              : t('importPage.importCompletedDescription', { count: formatNumber(Number(fresh.result?.rows_written ?? 0)) }),
            color: 'success',
            icon: 'i-lucide-circle-check',
          })
        } else if (['failed', 'cancelled', 'interrupted'].includes(fresh.status)) {
          stopPolling()
          toast.add({
            title: t('importPage.importFailed'),
            description: fresh.error_message_safe ?? fresh.status,
            color: 'error',
            icon: 'i-lucide-circle-x',
          })
        }
      } catch (error) {
        stopPolling()
        reportError(error, t('importPage.lostTrack'))
      }
    }, 700)
  } catch (error) {
    reportError(error, t('importPage.startFailed'))
  } finally {
    starting.value = false
  }
}

async function cancel() {
  if (!run.value) return
  try {
    run.value = await api.post<OperationRun>(`/runs/${run.value.id}/cancel`)
  } catch (error) {
    reportError(error, t('importPage.cancelFailed'))
  }
}

const warnings = computed(() => (run.value?.result?.warnings as string[] | undefined) ?? [])
</script>

<template>
  <PageShell id="import" :title="$t('importPage.title')" :description="$t('importPage.description')">
    <template #right>
      <UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" square :aria-label="$t('importPage.reload')" @click="loadResources" />
    </template>

    <div class="flex-1 overflow-auto scroll-thin p-4 sm:p-6">
      <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div class="grid content-start gap-4">
          <div class="panel grid gap-4 p-5">
            <div class="grid gap-4 sm:grid-cols-2">
              <UFormField :label="$t('importPage.targetConnection')" required>
                <USelect
                  v-model="connectionId"
                  :items="connections.map((item) => ({ value: item.id, label: `${item.name} · ${item.provider_id}` }))"
                  :placeholder="$t('importPage.connectionPlaceholder')"
                  class="w-full"
                />
              </UFormField>
              <UFormField :label="$t('importPage.targetResource')" required>
                <USelect
                  v-model="resource"
                  :items="resourceOptions"
                  :placeholder="$t('importPage.resourcePlaceholder')"
                  class="w-full"
                />
              </UFormField>
            </div>

            <UFormField :label="$t('importPage.resourceName')" :help="$t('importPage.resourceNameHelp')">
              <UInput v-model="resource" :placeholder="$t('importPage.resourceNamePlaceholder')" class="w-full" />
            </UFormField>

            <div class="grid gap-4 sm:grid-cols-2">
              <UFormField :label="$t('importPage.loadMode')">
                <USelect
                  v-model="mode"
                  :items="[
                    { value: 'append', label: $t('importPage.modeAppend') },
                    { value: 'upsert', label: $t('importPage.modeUpsert') },
                    { value: 'truncate_and_load', label: $t('importPage.modeReplace') },
                  ]"
                  class="w-full"
                />
              </UFormField>
              <UFormField v-if="mode === 'upsert'" :label="$t('importPage.keyColumns')" :help="$t('importPage.keyColumnsHelp')">
                <UInput v-model="keyColumns" placeholder="id" class="w-full" />
              </UFormField>
              <UFormField v-else :label="$t('importPage.batchSize')">
                <UInput v-model.number="batchSize" type="number" min="1" max="5000" class="w-full" />
              </UFormField>
            </div>

            <UAlert
              v-if="mode === 'truncate_and_load'"
              color="warning"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              :title="$t('importPage.destructiveTitle')"
              :description="t('importPage.destructiveBody', { resource: resource || t('importPage.target') })"
            />

            <UFormField v-if="needsConfirm" :label="t('importPage.confirmLabel', { name: connection?.name ?? '' })" required>
              <UInput v-model="confirmText" :placeholder="connection?.name" class="w-full" />
            </UFormField>

            <div class="flex items-center gap-3">
              <USwitch v-model="dryRun" />
              <div>
                <p class="text-sm">{{ $t('importPage.dryRun') }}</p>
                <p class="text-xs text-muted">{{ $t('importPage.dryRunHint') }}</p>
              </div>
            </div>
          </div>

          <div class="panel grid gap-4 p-5">
            <div class="flex gap-2">
              <UButton
                :variant="sourceMode === 'artifact' ? 'soft' : 'ghost'"
                :color="sourceMode === 'artifact' ? 'primary' : 'neutral'"
                icon="i-lucide-package"
                @click="sourceMode = 'artifact'"
              >
                {{ $t('importPage.sourceArtifact') }}
              </UButton>
              <UButton
                :variant="sourceMode === 'file' ? 'soft' : 'ghost'"
                :color="sourceMode === 'file' ? 'primary' : 'neutral'"
                icon="i-lucide-file-input"
                @click="sourceMode = 'file'"
              >
                {{ $t('importPage.sourceFile') }}
              </UButton>
            </div>

            <template v-if="sourceMode === 'artifact'">
              <UFormField :label="$t('importPage.artifact')" required>
                <USelect
                  v-model="artifactId"
                  :items="artifacts.map((item) => ({
                    value: item.id,
                    label: `${shortId(item.id)} · ${item.manifest.resource ?? '?'} · ${item.manifest.row_count} rows · ${item.manifest.format}`,
                  }))"
                  :placeholder="$t('importPage.artifactPlaceholder')"
                  class="w-full"
                />
              </UFormField>
              <div v-if="selectedArtifact" class="rounded-lg bg-elevated/60 p-3 text-xs text-muted">
                <p class="mono break-all">{{ selectedArtifact.absolute_path }}</p>
                <p class="mt-1">
                  {{ formatBytes(selectedArtifact.size_bytes) }} · {{ selectedArtifact.manifest.compression }} ·
                  verified: {{ selectedArtifact.verification_status }}
                </p>
              </div>
            </template>

            <template v-else>
              <UFormField :label="$t('importPage.filePath')" required :help="$t('importPage.filePathHelp')">
                <UInput v-model="filePath" :placeholder="$t('importPage.filePathPlaceholder')" class="w-full" />
              </UFormField>
              <UFormField :label="$t('importPage.formatOverride')" :help="$t('importPage.formatAutoHelp')">
                <USelect
                  v-model="format"
                  :items="[{ value: '', label: $t('importPage.auto') }, { value: 'jsonl', label: 'JSONL' }, { value: 'csv', label: 'CSV' }, { value: 'json', label: 'JSON' }]"
                  class="w-full"
                />
              </UFormField>
            </template>
          </div>

          <div v-if="schema" class="panel p-4">
            <p class="mb-2 flex items-center gap-2 text-xs text-muted">
              <UIcon name="i-lucide-table-2" class="size-4" />
              {{ $t('importPage.targetColumns') }} <span class="mono">{{ schema.resource }}</span>
            </p>
            <div class="grid gap-1 sm:grid-cols-2">
              <div v-for="column in schema.columns" :key="column.name" class="flex items-center justify-between gap-2 text-xs">
                <span class="mono truncate">{{ column.name }}</span>
                <span class="text-muted">{{ column.type }}</span>
              </div>
            </div>
          </div>
          <div v-else-if="loadingSchema" class="flex items-center gap-2 text-sm text-muted">
            <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" /> {{ $t('importPage.readingTargetSchema') }}
          </div>
        </div>

        <div class="grid content-start gap-4">
          <div class="panel p-4">
            <p class="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Run</p>
            <template v-if="run">
              <div class="mb-2 flex items-center justify-between gap-2">
                <StatusBadge :status="run.status" />
                <span class="mono text-xs text-muted">{{ shortId(run.id) }}</span>
              </div>
              <UProgress :model-value="Math.round(run.progress?.percent ?? 0)" :max="100" size="sm" />
              <div class="mt-2 grid gap-1 text-xs text-muted">
                <div class="flex justify-between">
                  <span>{{ $t('common.read') }}</span>
                  <span>{{ formatNumber(run.result?.rows_read as number ?? run.progress?.rows_read) }}</span>
                </div>
                <div class="flex justify-between">
                  <span>{{ $t('common.written') }}</span>
                  <span>{{ formatNumber(run.result?.rows_written as number ?? run.progress?.rows_written) }}</span>
                </div>
                <div v-if="run.result?.dry_run" class="flex justify-between">
                  <span>{{ $t('importPage.dryRunRow') }}</span>
                  <span>{{ $t('importPage.nothingWritten') }}</span>
                </div>
              </div>
              <p v-if="run.error_message_safe" class="mt-2 rounded-lg bg-error/10 p-2 text-xs text-error">
                {{ run.error_message_safe }}
              </p>
              <div v-if="warnings.length" class="mt-2 rounded-lg bg-warning/10 p-2 text-xs text-warning">
                <p v-for="warning in warnings" :key="warning">• {{ warning }}</p>
              </div>
              <UButton v-if="!terminal" class="mt-3" icon="i-lucide-square" color="warning" variant="soft" size="sm" @click="cancel">
                {{ $t('common.cancel') }}
              </UButton>
            </template>
            <p v-else class="text-sm text-muted">{{ $t('importPage.nothingRunning') }}</p>

            <UButton class="mt-3" block icon="i-lucide-arrow-down-to-line" :loading="starting" :disabled="!connection || !resource" @click="start">
              {{ dryRun ? $t('importPage.validate') : $t('importPage.start') }}
            </UButton>
          </div>

          <div class="panel p-4 text-xs text-muted">
            <p class="mb-2 flex items-center gap-2 font-medium text-highlighted">
              <UIcon name="i-lucide-shield-check" class="size-4" /> {{ $t('importPage.safety') }}
            </p>
            <ul class="grid list-disc gap-1 ps-4">
              <li>{{ $t('importPage.safety1') }}</li>
              <li>{{ $t('importPage.safety2') }}</li>
              <li>{{ $t('importPage.safety3') }}</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  </PageShell>
</template>
