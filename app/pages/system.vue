<script setup lang="ts">
import type { DoctorReport, ProviderDescriptor, WorkerStatus } from '~/types'

const api = useApi()
const reportError = useApiToast()
const { t } = useI18n()

const doctor = ref<DoctorReport | null>(null)
const worker = ref<WorkerStatus | null>(null)
const storage = ref<{ backends: Array<{ id: string; name: string; backend_type: string; is_default: boolean }>; root: string } | null>(null)
const loading = ref(true)
let timer: ReturnType<typeof setInterval> | undefined

async function load() {
  try {
    const [doctorReport, workerStatus, storageInfo] = await Promise.all([
      api.get<DoctorReport>('/doctor'),
      api.get<WorkerStatus>('/worker'),
      api.get<{ backends: Array<{ id: string; name: string; backend_type: string; is_default: boolean }>; root: string }>('/storage'),
    ])
    doctor.value = doctorReport
    worker.value = workerStatus
    storage.value = storageInfo
  } catch (error) {
    reportError(error, t('systemPage.loadFailed'))
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await load()
  timer = setInterval(load, 10_000)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})

const providers = computed<ProviderDescriptor[]>(() => doctor.value?.providers ?? [])
</script>

<template>
  <PageShell id="system" :title="$t('systemPage.title')" :description="$t('systemPage.description')">
    <template #right>
      <UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" square :aria-label="$t('common.refresh')" @click="load" />
    </template>

    <div class="flex-1 overflow-auto scroll-thin p-4 sm:p-6">
      <div v-if="loading" class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" /> {{ $t('systemPage.loading') }}
      </div>

      <div v-else-if="doctor" class="grid gap-6">
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard :label="$t('systemPage.appVersion')" :value="doctor.app_version" icon="i-lucide-box" :hint="`node ${doctor.node_version} · ${doctor.platform}`" />
          <StatCard
            :label="$t('systemPage.database')"
            :value="doctor.db_integrity === 'ok' ? $t('systemPage.healthy') : $t('systemPage.checkFailed')"
            icon="i-lucide-database"
            :hint="doctor.db_path"
          />
          <StatCard
            :label="$t('systemPage.worker')"
            :value="worker?.running ? $t('systemPage.running') : $t('systemPage.stopped')"
            icon="i-lucide-cpu"
            :hint="worker?.heartbeat_age_seconds != null ? $t('common.heartbeat', { seconds: worker.heartbeat_age_seconds }) : $t('systemPage.neverStarted')"
          />
          <StatCard
            :label="$t('systemPage.artifacts')"
            :value="doctor.counts.artifacts"
            icon="i-lucide-package"
            :hint="$t('systemPage.countsHint', { runs: doctor.counts.runs, connections: doctor.counts.connections })"
          />
        </div>

        <div class="grid gap-4 lg:grid-cols-2">
          <div class="panel p-4">
            <p class="mb-3 flex items-center gap-2 text-sm font-medium">
              <UIcon name="i-lucide-folder-tree" class="size-4 text-dimmed" /> {{ $t('systemPage.localPaths') }}
            </p>
            <dl class="grid gap-2 text-xs">
              <div class="flex flex-col gap-0.5">
                <dt class="text-muted">{{ $t('systemPage.dataDir') }}</dt>
                <dd class="mono break-all">{{ doctor.data_dir }}</dd>
              </div>
              <div class="flex flex-col gap-0.5">
                <dt class="text-muted">{{ $t('systemPage.artifactsRoot') }}</dt>
                <dd class="mono break-all">{{ doctor.artifacts_dir }}</dd>
              </div>
              <div class="flex flex-col gap-0.5">
                <dt class="text-muted">{{ $t('systemPage.metadataDb') }}</dt>
                <dd class="mono break-all">{{ doctor.db_path }}</dd>
              </div>
            </dl>
            <div class="mt-3 flex flex-wrap gap-2">
              <UBadge v-for="backend in storage?.backends ?? []" :key="backend.id" color="neutral" variant="subtle" size="sm">
                {{ backend.name }}{{ backend.is_default ? $t('systemPage.defaultBadge') : '' }}
              </UBadge>
            </div>
          </div>

          <div class="panel p-4">
            <p class="mb-3 flex items-center gap-2 text-sm font-medium">
              <UIcon name="i-lucide-key-round" class="size-4 text-dimmed" /> {{ $t('systemPage.secretStorage') }}
            </p>
            <p class="text-sm">{{ doctor.secret_backend }}</p>
            <UAlert
              v-if="doctor.secret_warning"
              class="mt-3"
              color="warning"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              :title="$t('systemPage.secretWarningTitle')"
              :description="doctor.secret_warning"
            />
            <p v-else class="mt-2 text-xs text-muted">{{ $t('systemPage.encryptedAtRest') }}</p>
          </div>
        </div>

        <div class="panel overflow-hidden">
          <div class="border-b border-default px-4 py-3">
            <p class="text-sm font-medium">{{ $t('systemPage.providerCapabilities') }}</p>
            <p class="text-xs text-muted">{{ $t('systemPage.providerCapabilitiesHint') }}</p>
          </div>
          <div class="overflow-auto scroll-thin">
            <table class="w-full text-sm">
              <thead class="bg-elevated/60 text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th class="px-4 py-3 font-medium">{{ $t('systemPage.colProvider') }}</th>
                  <th class="px-4 py-3 font-medium">{{ $t('systemPage.colVersion') }}</th>
                  <th class="px-4 py-3 font-medium">{{ $t('systemPage.colCapabilities') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="provider in providers" :key="provider.provider_id" class="border-t border-default/60">
                  <td class="px-4 py-3">
                    <p class="font-medium">{{ provider.display_name }}</p>
                    <p class="mono text-xs text-muted">{{ provider.provider_id }}</p>
                  </td>
                  <td class="px-4 py-3 text-xs text-muted">{{ provider.version }}</td>
                  <td class="px-4 py-3">
                    <div class="flex flex-wrap gap-1">
                      <UBadge
                        v-for="capability in provider.capabilities"
                        :key="capability.id"
                        :color="capability.supported ? 'success' : 'neutral'"
                        variant="subtle"
                        size="sm"
                      >
                        {{ capability.id }}
                      </UBadge>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="panel p-4">
          <p class="mb-3 flex items-center gap-2 text-sm font-medium">
            <UIcon name="i-lucide-terminal" class="size-4 text-dimmed" /> {{ $t('systemPage.cliEquivalents') }}
          </p>
          <div class="mono grid gap-1 rounded-lg bg-elevated/60 p-3 text-[11px] text-muted">
            <p>udmt connection list</p>
            <p>udmt export --conn &lt;name&gt; --resource &lt;resource&gt; --format jsonl --compression gzip</p>
            <p>udmt import --conn &lt;name&gt; --resource &lt;resource&gt; --artifact &lt;id&gt; --mode append</p>
            <p>udmt operation list --limit 20</p>
            <p>udmt worker run</p>
            <p>udmt artifact prune --older-than-days 30 --keep-last 5</p>
          </div>
        </div>
      </div>
    </div>
  </PageShell>
</template>
