<script setup lang="ts">
import type { Artifact, Health, OperationRun, WorkerStatus } from '~/types'

const api = useApi()
const reportError = useApiToast()
const { t } = useI18n()

const health = ref<Health | null>(null)
const worker = ref<WorkerStatus | null>(null)
const runs = ref<OperationRun[]>([])
const artifacts = ref<Artifact[]>([])
const loading = ref(true)

let timer: ReturnType<typeof setInterval> | undefined

async function load() {
  try {
    const [healthInfo, workerInfo, runList, artifactList] = await Promise.all([
      api.get<Health>('/health'),
      api.get<WorkerStatus>('/worker'),
      api.get<OperationRun[]>('/runs?limit=8'),
      api.get<Artifact[]>('/artifacts?limit=5'),
    ])
    health.value = healthInfo
    worker.value = workerInfo
    runs.value = runList
    artifacts.value = artifactList
  } catch (error) {
    reportError(error, t('overview.couldNotReach'))
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await load()
  timer = setInterval(load, 4000)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})

const activeRuns = computed(
  () => runs.value.filter((run) => ['queued', 'preparing', 'preflight', 'running', 'finalizing', 'verifying', 'cancel_requested'].includes(run.status)).length,
)

const quickActions = computed(() => [
  { to: '/connections', icon: 'i-lucide-cable', title: t('overview.quickTitle'), description: t('overview.quickConnections') },
  { to: '/export', icon: 'i-lucide-arrow-up-from-line', title: t('overview.quickTitleExport'), description: t('overview.quickExport') },
  { to: '/import', icon: 'i-lucide-arrow-down-to-line', title: t('overview.quickTitleImport'), description: t('overview.quickImport') },
  { to: '/schedules', icon: 'i-lucide-calendar-clock', title: t('overview.quickTitleSchedule'), description: t('overview.quickSchedule') },
])
</script>

<template>
  <PageShell id="overview" :title="$t('overview.title')" :description="$t('overview.description')">
    <template #right>
      <UButton to="/export" icon="i-lucide-arrow-up-from-line" color="primary" variant="soft">{{ $t('nav.export') }}</UButton>
      <UButton to="/import" icon="i-lucide-arrow-down-to-line" color="neutral" variant="soft">{{ $t('nav.import') }}</UButton>
    </template>

    <div class="flex-1 overflow-auto scroll-thin p-4 sm:p-6">
      <div v-if="loading" class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" /> {{ $t('overview.loading') }}
      </div>

      <div v-else class="grid gap-6">
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            :label="$t('overview.statConnections')"
            :value="health?.counts.connections ?? 0"
            icon="i-lucide-cable"
            :hint="health ? `API ${health.version}` : $t('overview.offline')"
            to="/connections"
          />
          <StatCard
            :label="$t('overview.statActiveRuns')"
            :value="activeRuns"
            icon="i-lucide-activity"
            :hint="$t('common.runsInHistory', { count: health?.counts.runs ?? 0 })"
            to="/operations"
          />
          <StatCard
            :label="$t('overview.statArtifacts')"
            :value="health?.counts.artifacts ?? 0"
            icon="i-lucide-package"
            :hint="$t('overview.checksummedExports')"
            to="/artifacts"
          />
          <StatCard
            :label="$t('overview.statWorker')"
            :value="worker?.running ? $t('overview.workerRunning') : health ? $t('overview.workerStopped') : $t('overview.offline')"
            icon="i-lucide-cpu"
            :hint="worker?.heartbeat_age_seconds != null
              ? $t('common.heartbeat', { seconds: worker.heartbeat_age_seconds })
              : $t('overview.startWorkerHint')"
            to="/schedules"
          />
        </div>

        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <NuxtLink
            v-for="action in quickActions"
            :key="action.to"
            :to="action.to"
            class="panel group flex flex-col gap-2 p-4 transition hover:-translate-y-0.5 hover:border-primary/40"
          >
            <span class="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <UIcon :name="action.icon" class="size-5" />
            </span>
            <p class="font-medium text-highlighted">{{ action.title }}</p>
            <p class="text-xs text-muted">{{ action.description }}</p>
          </NuxtLink>
        </div>

        <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div class="panel overflow-hidden">
            <div class="flex items-center justify-between border-b border-default px-4 py-3">
              <p class="text-sm font-medium">{{ $t('overview.recentOperations') }}</p>
              <UButton to="/operations" size="xs" variant="ghost" color="neutral" trailing-icon="i-lucide-arrow-right">{{ $t('overview.allRuns') }}</UButton>
            </div>
            <table class="w-full text-sm">
              <tbody>
                <tr v-for="run in runs" :key="run.id" class="border-t border-default/60 hover:bg-elevated/40">
                  <td class="px-4 py-3">
                    <p class="mono text-xs text-muted">{{ shortId(run.id) }}</p>
                    <p class="font-medium">{{ run.operation_type }} · {{ run.resource ?? '—' }}</p>
                  </td>
                  <td class="px-4 py-3"><StatusBadge :status="run.status" /></td>
                  <td class="hidden px-4 py-3 text-right text-xs text-muted sm:table-cell">{{ formatRelative(run.created_at) }}</td>
                </tr>
                <tr v-if="runs.length === 0">
                  <td class="px-4 py-10 text-center text-sm text-muted" colspan="3">
                    {{ $t('overview.noRuns') }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="grid content-start gap-4">
            <div class="panel p-4">
              <p class="mb-2 flex items-center gap-2 text-sm font-medium">
                <UIcon name="i-lucide-history" class="size-4 text-dimmed" /> {{ $t('overview.latestArtifacts') }}
              </p>
              <div v-if="artifacts.length === 0" class="text-xs text-muted">{{ $t('overview.noArtifacts') }}</div>
              <div v-else class="grid gap-2">
                <NuxtLink
                  v-for="artifact in artifacts"
                  :key="artifact.id"
                  to="/artifacts"
                  class="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-xs transition hover:bg-elevated/60"
                >
                  <span class="min-w-0">
                    <span class="block truncate font-medium">{{ artifact.manifest.resource ?? '—' }}</span>
                    <span class="block text-muted">{{ formatRelative(artifact.created_at) }} · {{ formatBytes(artifact.size_bytes) }}</span>
                  </span>
                  <StatusBadge :status="artifact.verification_status" />
                </NuxtLink>
              </div>
            </div>

            <div class="panel p-4 text-xs text-muted">
              <p class="mb-2 flex items-center gap-2 text-sm font-medium text-highlighted">
                <UIcon name="i-lucide-shield-check" class="size-4 text-dimmed" /> {{ $t('overview.howItWorks') }}
              </p>
              <ul class="grid list-disc gap-1 ps-4">
                <li>{{ $t('overview.how1') }}</li>
                <li>{{ $t('overview.how2') }}</li>
                <li>{{ $t('overview.how3') }}</li>
                <li>{{ $t('overview.how4') }}</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  </PageShell>
</template>
