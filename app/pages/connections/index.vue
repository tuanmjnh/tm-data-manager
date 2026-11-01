<script setup lang="ts">
import type { Connection, ConnectionTestResult, ProviderDescriptor } from '~/types'

const api = useApi()
const toast = useToast()
const reportError = useApiToast()
const { t } = useI18n()

const connections = ref<Connection[]>([])
const providers = ref<ProviderDescriptor[]>([])
const loading = ref(true)
const showCreate = ref(false)
const editTarget = ref<Connection | null>(null)
const testing = ref<string | null>(null)
const testResult = ref<ConnectionTestResult | null>(null)
const showTest = ref(false)


const removeTarget = ref<Connection | null>(null)

async function load() {
  loading.value = true
  try {
    const [connectionList, providerList] = await Promise.all([
      api.get<Connection[]>('/connections'),
      api.get<ProviderDescriptor[]>('/providers'),
    ])
    connections.value = connectionList
    providers.value = providerList
  } catch (error) {
    reportError(error, t('connections.loadFailed'))
  } finally {
    loading.value = false
  }
}

onMounted(load)

function providerName(id: string): string {
  return providers.value.find((provider) => provider.provider_id === id)?.display_name ?? id
}

function openCreate() {
  editTarget.value = null
  showCreate.value = true
}

function openEdit(connection: Connection) {
  editTarget.value = connection
  showCreate.value = true
}

async function onSaved(saved: Connection) {
  editTarget.value = null
  await load()
  if (saved.last_test_status === 'failed') {
    toast.add({
      title: t('connections.savedTestFailed'),
      description: t('connections.savedTestFailedDescription'),
      color: 'warning',
      icon: 'i-lucide-triangle-alert',
    })
  }
}

async function test(connection: Connection) {
  testing.value = connection.id
  try {
    const result = await api.post<ConnectionTestResult>(`/connections/${encodeURIComponent(connection.name)}/test`)
    testResult.value = result
    showTest.value = true
    await load()
    toast.add({
      title: result.success ? t('connections.connectionOk') : t('connections.connectionFailed'),
      description: result.success ? `${connection.name} · ${result.latency_ms}ms` : result.diagnostics[0],
      color: result.success ? 'success' : 'error',
      icon: result.success ? 'i-lucide-circle-check' : 'i-lucide-circle-x',
    })
  } catch (error) {
    reportError(error, t('connections.testFailed'))
  } finally {
    testing.value = null
  }
}

function browse(connection: Connection) {
  return navigateTo(`/connections/${encodeURIComponent(connection.name)}`)
}

async function remove() {
  if (!removeTarget.value) return
  try {
    await api.del(`/connections/${encodeURIComponent(removeTarget.value.name)}`)
    toast.add({ title: t('connections.deleted'), color: 'success', icon: 'i-lucide-trash-2' })
    removeTarget.value = null
    await load()
  } catch (error) {
    reportError(error, t('connections.deleteFailed'))
  }
}

const filtered = computed(() => connections.value)
</script>

<template>
  <PageShell id="connections" :title="$t('connections.title')" :description="$t('connections.description')">
    <template #right>
      <UButton icon="i-lucide-plus" color="primary" variant="soft" @click="openCreate">
        {{ $t('connections.add') }}
      </UButton>
      <UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" square :aria-label="$t('common.refresh')" @click="load" />
    </template>

    <div class="flex-1 overflow-auto scroll-thin p-4 sm:p-6">
      <div v-if="loading" class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" /> {{ $t('connections.loading') }}
      </div>

      <EmptyState
        v-else-if="filtered.length === 0"
        icon="i-lucide-cable"
        :title="$t('connections.emptyTitle')"
        :description="$t('connections.emptyDescription')"
      >
        <UButton icon="i-lucide-plus" @click="openCreate">{{ $t('connections.emptyAction') }}</UButton>
      </EmptyState>

      <div v-else class="panel overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-elevated/60 text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th class="px-4 py-3 font-medium">{{ $t('connections.colName') }}</th>
              <th class="px-4 py-3 font-medium">{{ $t('connections.colProvider') }}</th>
              <th class="px-4 py-3 font-medium">{{ $t('connections.colEnvironment') }}</th>
              <th class="hidden px-4 py-3 font-medium lg:table-cell">{{ $t('connections.colEndpoint') }}</th>
              <th class="hidden px-4 py-3 font-medium md:table-cell">{{ $t('connections.colLastTest') }}</th>
              <th class="px-4 py-3 text-right font-medium">{{ $t('common.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="connection in filtered" :key="connection.id" class="border-t border-default/60 hover:bg-elevated/40">
              <td class="px-4 py-3">
                <div class="flex items-center gap-2">
                  <UIcon name="i-lucide-database" class="size-4 text-dimmed" />
                  <div class="min-w-0">
                    <NuxtLink
                      :to="`/connections/${encodeURIComponent(connection.name)}`"
                      class="truncate font-medium text-highlighted hover:text-primary hover:underline"
                    >
                      {{ connection.name }}
                    </NuxtLink>
                    <p v-if="connection.description" class="truncate text-xs text-muted">{{ connection.description }}</p>
                  </div>
                </div>
              </td>
              <td class="px-4 py-3">
                <p>{{ providerName(connection.provider_id) }}</p>
                <p v-if="connection.service_profile" class="text-xs text-muted">{{ connection.service_profile }}</p>
              </td>
              <td class="px-4 py-3">
                <UBadge
                  :color="connection.environment === 'production' ? 'error' : 'neutral'"
                  variant="subtle"
                  size="sm"
                  class="capitalize"
                >
                  {{ connection.environment }}
                </UBadge>
              </td>
              <td class="mono hidden max-w-[22rem] truncate px-4 py-3 text-xs text-muted lg:table-cell">
                {{ connection.endpoint_hint ?? '—' }}
              </td>
              <td class="hidden px-4 py-3 md:table-cell">
                <div class="flex flex-col gap-1">
                  <StatusBadge v-if="connection.last_test_status" :status="connection.last_test_status" />
                  <span v-else class="text-xs text-muted">{{ $t('common.never') }}</span>
                  <span class="text-[11px] text-dimmed">{{ formatRelative(connection.last_tested_at) }}</span>
                </div>
              </td>
              <td class="px-4 py-3">
                <div class="flex justify-end gap-1">
                  <UTooltip :text="$t('connections.editTooltip')">
                    <UButton
                      icon="i-lucide-pencil"
                      color="neutral"
                      variant="ghost"
                      size="sm"
                      square
                      :aria-label="$t('connections.editTooltip')"
                      @click="openEdit(connection)"
                    />
                  </UTooltip>
                  <UTooltip :text="$t('connections.testTooltip')">
                    <UButton
                      icon="i-lucide-plug-zap"
                      color="neutral"
                      variant="ghost"
                      size="sm"
                      square
                      :loading="testing === connection.id"
                      :aria-label="$t('connections.testTooltip')"
                      @click="test(connection)"
                    />
                  </UTooltip>
                  <UTooltip :text="$t('connections.browseTooltip')">
                    <UButton
                      icon="i-lucide-folder-search"
                      color="neutral"
                      variant="ghost"
                      size="sm"
                      square
                      :aria-label="$t('connections.browseTooltip')"
                      @click="browse(connection)"
                    />
                  </UTooltip>
                  <UTooltip :text="$t('connections.deleteTooltip')">
                    <UButton
                      icon="i-lucide-trash-2"
                      color="error"
                      variant="ghost"
                      size="sm"
                      square
                      :aria-label="$t('connections.deleteTooltip')"
                      @click="removeTarget = connection"
                    />
                  </UTooltip>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="mt-3 text-xs text-muted">
        {{ $t('connections.secretsNote') }}
      </p>
    </div>

    <ConnectionModal
      v-model:open="showCreate"
      :providers="providers"
      :connection="editTarget"
      @saved="onSaved"
    />

    <UModal v-model:open="showTest" :title="t('connections.testTitle', { provider: testResult?.provider_id ?? '' })">
      <template #body>
        <div v-if="testResult" class="grid gap-3">
          <div class="flex items-center gap-2">
            <StatusBadge :status="testResult.success ? 'success' : 'failed'" />
            <span class="text-sm text-muted">{{ testResult.latency_ms }}ms</span>
            <span v-if="testResult.server_version" class="mono text-xs text-muted">{{ testResult.server_version }}</span>
          </div>
          <div class="rounded-lg bg-elevated/60 p-3 text-xs">
            <p v-for="line in testResult.diagnostics" :key="line" class="mono">{{ line }}</p>
          </div>
          <div v-if="testResult.detected_capabilities.length" class="flex flex-wrap gap-1">
            <UBadge v-for="capability in testResult.detected_capabilities" :key="capability" color="neutral" variant="subtle" size="sm">
              {{ capability }}
            </UBadge>
          </div>
        </div>
      </template>
    </UModal>

    <UModal
      :open="Boolean(removeTarget)"
      :title="$t('connections.deleteTitle')"
      @update:open="(value) => { if (!value) removeTarget = null }"
    >
      <template #body>
        <p class="text-sm text-muted">
          {{ $t('connections.deleteBody', { name: removeTarget?.name ?? '' }) }}
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="removeTarget = null">{{ $t('common.cancel') }}</UButton>
          <UButton color="error" icon="i-lucide-trash-2" @click="remove">{{ $t('common.delete') }}</UButton>
        </div>
      </template>
    </UModal>
  </PageShell>
</template>
