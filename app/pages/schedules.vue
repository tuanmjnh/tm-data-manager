<script setup lang="ts">
import type { Connection, ProviderDescriptor, ResourceDescriptor, ScheduleRow } from '~/types'

interface JobRow {
  id: string
  name: string
  operation_type: string
  enabled: boolean
  created_at: string
}

const api = useApi()
const toast = useToast()
const reportError = useApiToast()
const { t } = useI18n()

const schedules = ref<ScheduleRow[]>([])
const jobs = ref<JobRow[]>([])
const connections = ref<Connection[]>([])
const resources = ref<ResourceDescriptor[]>([])
const loading = ref(true)
const showCreate = ref(false)
const saving = ref(false)

const name = ref('')
const connectionId = ref('')
const resource = ref('')
const format = ref<'jsonl' | 'csv' | 'json'>('jsonl')
const compression = ref<'none' | 'gzip'>('gzip')
const scheduleType = ref<'interval' | 'daily' | 'weekly' | 'monthly'>('daily')
const everyMinutes = ref(60)
const hour = ref(2)
const minute = ref(0)
const day = ref(1)
const days = ref('1,2,3,4,5')
const timezone = ref(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')

async function load() {
  try {
    const [scheduleList, jobList, connectionList] = await Promise.all([
      api.get<ScheduleRow[]>('/schedules'),
      api.get<JobRow[]>('/jobs'),
      api.get<Connection[]>('/connections'),
    ])
    schedules.value = scheduleList
    jobs.value = jobList
    connections.value = connectionList
    if (!connectionId.value) connectionId.value = connectionList[0]?.id ?? ''
  } catch (error) {
    reportError(error, t('schedulesPage.loadFailed'))
  } finally {
    loading.value = false
  }
}

onMounted(load)

const connection = computed(() => connections.value.find((item) => item.id === connectionId.value) ?? null)

async function loadResources() {
  resources.value = []
  resource.value = ''
  if (!connection.value) return
  try {
    resources.value = await api.get<ResourceDescriptor[]>(`/connections/${encodeURIComponent(connection.value.name)}/resources`)
  } catch (error) {
    reportError(error, t('schedulesPage.resourcesFailed'))
  }
}

watch(connectionId, loadResources)

function scheduleConfig(): Record<string, unknown> {
  if (scheduleType.value === 'interval') return { every_minutes: Number(everyMinutes.value) }
  const config: Record<string, unknown> = { hour: Number(hour.value), minute: Number(minute.value) }
  if (scheduleType.value === 'weekly') config.days = days.value.split(',').map((value) => Number(value.trim()))
  if (scheduleType.value === 'monthly') config.day = Number(day.value)
  return config
}

async function create() {
  if (!connection.value || !resource.value || !name.value.trim()) {
    toast.add({ title: t('schedulesPage.requiredFields'), color: 'warning', icon: 'i-lucide-triangle-alert' })
    return
  }
  saving.value = true
  try {
    await api.post('/jobs/export', {
      name: name.value.trim(),
      connection_id: connection.value.id,
      resource: resource.value,
      format: format.value,
      compression: compression.value,
      schedule: {
        schedule_type: scheduleType.value,
        schedule_config: scheduleConfig(),
        timezone: timezone.value,
      },
    })
    toast.add({
      title: t('schedulesPage.created'),
      description: t('schedulesPage.createdDescription', { name: name.value, timezone: timezone.value }),
      color: 'success',
      icon: 'i-lucide-calendar-plus',
    })
    showCreate.value = false
    name.value = ''
    await load()
  } catch (error) {
    reportError(error, t('schedulesPage.createFailed'))
  } finally {
    saving.value = false
  }
}

async function toggle(schedule: ScheduleRow) {
  try {
    const updated = await api.post<ScheduleRow>(`/schedules/${schedule.id}/${schedule.enabled ? 'disable' : 'enable'}`)
    toast.add({
      title: updated.enabled ? t('schedulesPage.enabled') : t('schedulesPage.disabled'),
      description: updated.next_run_at
        ? t('schedulesPage.nextRun', { at: formatDateTime(updated.next_run_at) })
        : t('schedulesPage.noNextRun'),
      color: 'success',
      icon: 'i-lucide-calendar-check',
    })
    await load()
  } catch (error) {
    reportError(error, t('schedulesPage.updateFailed'))
  }
}

async function remove(schedule: ScheduleRow) {
  try {
    await api.del(`/schedules/${schedule.id}`)
    toast.add({ title: t('schedulesPage.deleted'), color: 'success', icon: 'i-lucide-trash-2' })
    await load()
  } catch (error) {
    reportError(error, t('schedulesPage.deleteFailed'))
  }
}

async function removeJob(job: JobRow) {
  try {
    await api.del(`/jobs/${job.id}`)
    toast.add({ title: t('schedulesPage.jobDeleted'), color: 'success', icon: 'i-lucide-trash-2' })
    await load()
  } catch (error) {
    reportError(error, t('schedulesPage.jobDeleteFailed'))
  }
}

const enabledCount = computed(() => schedules.value.filter((schedule) => schedule.enabled).length)
</script>

<template>
  <PageShell
    id="schedules"
    :title="$t('schedulesPage.title')"
    :description="$t('schedulesPage.description', { count: enabledCount })"
  >
    <template #right>
      <UButton icon="i-lucide-calendar-plus" color="primary" variant="soft" @click="showCreate = true">{{ $t('schedulesPage.newSchedule') }}</UButton>
      <UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" square :aria-label="$t('common.refresh')" @click="load" />
    </template>

    <div class="flex-1 overflow-auto scroll-thin p-4 sm:p-6">
      <div v-if="loading" class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" /> {{ $t('schedulesPage.loading') }}
      </div>

      <div v-else class="grid gap-6">
        <div class="panel overflow-hidden">
          <table class="w-full text-sm">
            <thead class="bg-elevated/60 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th class="px-4 py-3 font-medium">{{ $t('schedulesPage.colJob') }}</th>
                <th class="px-4 py-3 font-medium">{{ $t('schedulesPage.colSchedule') }}</th>
                <th class="hidden px-4 py-3 font-medium lg:table-cell">{{ $t('schedulesPage.colPolicies') }}</th>
                <th class="px-4 py-3 font-medium">{{ $t('schedulesPage.colNextRun') }}</th>
                <th class="hidden px-4 py-3 font-medium sm:table-cell">{{ $t('schedulesPage.colLastRun') }}</th>
                <th class="px-4 py-3 font-medium">{{ $t('schedulesPage.colEnabled') }}</th>
                <th class="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              <tr v-for="schedule in schedules" :key="schedule.id" class="border-t border-default/60">
                <td class="px-4 py-3">
                  <p class="font-medium">{{ schedule.job?.name ?? '—' }}</p>
                  <p class="text-xs text-muted">{{ schedule.job?.operation_type }}</p>
                </td>
                <td class="px-4 py-3 text-xs">{{ schedule.description }}</td>
                <td class="hidden px-4 py-3 text-xs text-muted lg:table-cell">
                  {{ $t('schedulesPage.policies', { overlap: schedule.overlap_policy, misfire: schedule.misfire_policy }) }}
                </td>
                <td class="whitespace-nowrap px-4 py-3 text-xs">
                  {{ schedule.enabled ? formatDateTime(schedule.next_run_at) : '—' }}
                  <p v-if="schedule.enabled && schedule.next_run_at" class="text-muted">{{ formatRelative(schedule.next_run_at) }}</p>
                </td>
                <td class="hidden whitespace-nowrap px-4 py-3 text-xs text-muted sm:table-cell">{{ formatDateTime(schedule.last_run_at) }}</td>
                <td class="px-4 py-3">
                  <USwitch :model-value="schedule.enabled" size="sm" @update:model-value="toggle(schedule)" />
                </td>
                <td class="px-4 py-3 text-right">
                  <UButton icon="i-lucide-trash-2" color="error" variant="ghost" size="sm" square :aria-label="$t('schedulesPage.deleteAria')" @click="remove(schedule)" />
                </td>
              </tr>
              <tr v-if="schedules.length === 0">
                <td colspan="7" class="px-4 py-10 text-center text-sm text-muted">
                  {{ $t('schedulesPage.emptySchedules') }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="panel overflow-hidden">
          <div class="flex items-center justify-between border-b border-default px-4 py-3">
            <p class="text-sm font-medium">{{ $t('schedulesPage.jobs') }}</p>
            <span class="text-xs text-muted">{{ $t('schedulesPage.jobsTotal', { count: jobs.length }) }}</span>
          </div>
          <table class="w-full text-sm">
            <tbody>
              <tr v-for="job in jobs" :key="job.id" class="border-t border-default/60">
                <td class="px-4 py-3">
                  <p class="font-medium">{{ job.name }}</p>
                  <p class="mono text-xs text-muted">{{ shortId(job.id) }}</p>
                </td>
                <td class="px-4 py-3 text-xs text-muted">{{ job.operation_type }}</td>
                <td class="px-4 py-3 text-xs text-muted">{{ formatDateTime(job.created_at) }}</td>
                <td class="px-4 py-3 text-right">
                  <UButton icon="i-lucide-trash-2" color="error" variant="ghost" size="sm" square :aria-label="$t('schedulesPage.deleteJobAria')" @click="removeJob(job)" />
                </td>
              </tr>
              <tr v-if="jobs.length === 0">
                <td class="px-4 py-8 text-center text-sm text-muted">{{ $t('schedulesPage.noJobs') }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <UAlert
          color="neutral"
          variant="subtle"
          icon="i-lucide-info"
          :title="$t('schedulesPage.workerAlertTitle')"
          :description="$t('schedulesPage.workerAlertDescription')"
        />
      </div>
    </div>

    <UModal
      v-model:open="showCreate"
      :title="$t('schedulesPage.createTitle')"
      :description="$t('schedulesPage.createDescription')"
    >
      <template #body>
        <div class="grid gap-4">
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField :label="$t('schedulesPage.jobName')" required>
              <UInput v-model="name" :placeholder="$t('schedulesPage.jobNamePlaceholder')" class="w-full" />
            </UFormField>
            <UFormField :label="$t('schedulesPage.connection')" required>
              <USelect
                v-model="connectionId"
                :items="connections.map((item) => ({ value: item.id, label: `${item.name} · ${item.provider_id}` }))"
                class="w-full"
              />
            </UFormField>
          </div>

          <UFormField :label="$t('schedulesPage.resource')" required>
            <USelect
              v-model="resource"
              :items="resources.filter((item) => ['table', 'view', 'collection'].includes(item.type)).map((item) => ({ value: item.id, label: item.id }))"
              :placeholder="$t('schedulesPage.resourcePlaceholder')"
              class="w-full"
            />
          </UFormField>

          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField :label="$t('schedulesPage.format')">
              <USelect v-model="format" :items="['jsonl', 'csv', 'json']" class="w-full" />
            </UFormField>
            <UFormField :label="$t('schedulesPage.compression')">
              <USelect v-model="compression" :items="['gzip', 'none']" class="w-full" />
            </UFormField>
          </div>

          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField :label="$t('schedulesPage.scheduleType')">
              <USelect
                v-model="scheduleType"
                :items="[
                  { value: 'interval', label: $t('schedulesPage.typeInterval') },
                  { value: 'daily', label: $t('schedulesPage.typeDaily') },
                  { value: 'weekly', label: $t('schedulesPage.typeWeekly') },
                  { value: 'monthly', label: $t('schedulesPage.typeMonthly') },
                ]"
                class="w-full"
              />
            </UFormField>
            <UFormField :label="$t('schedulesPage.timezone')">
              <UInput v-model="timezone" :placeholder="$t('schedulesPage.timezonePlaceholder')" class="w-full" />
            </UFormField>
          </div>

          <UFormField v-if="scheduleType === 'interval'" :label="$t('schedulesPage.minutes')">
            <UInput v-model.number="everyMinutes" type="number" min="1" class="w-full" />
          </UFormField>

          <div v-else class="grid gap-4 sm:grid-cols-2">
            <UFormField :label="$t('schedulesPage.hour')">
              <UInput v-model.number="hour" type="number" min="0" max="23" class="w-full" />
            </UFormField>
            <UFormField :label="$t('schedulesPage.minute')">
              <UInput v-model.number="minute" type="number" min="0" max="59" class="w-full" />
            </UFormField>
          </div>

          <UFormField v-if="scheduleType === 'weekly'" :label="$t('schedulesPage.days')">
            <UInput v-model="days" placeholder="1,2,3,4,5" class="w-full" />
          </UFormField>
          <UFormField v-if="scheduleType === 'monthly'" :label="$t('schedulesPage.dayOfMonth')">
            <UInput v-model.number="day" type="number" min="1" max="31" class="w-full" />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="showCreate = false">{{ $t('common.cancel') }}</UButton>
          <UButton :loading="saving" icon="i-lucide-calendar-plus" @click="create">{{ $t('schedulesPage.createAction') }}</UButton>
        </div>
      </template>
    </UModal>
  </PageShell>
</template>
