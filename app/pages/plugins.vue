<script setup lang="ts">
import type { PluginPermission, PluginRecord, PluginTestResult } from '~/types'

const api = useApi()
const toast = useToast()
const reportError = useApiToast()
const { t } = useI18n()

const plugins = ref<PluginRecord[]>([])
const loading = ref(true)
const installPath = ref('')
const installing = ref(false)
const busyId = ref<string | null>(null)

const trustTarget = ref<PluginRecord | null>(null)
const trustSelection = ref<PluginPermission[]>([])
const removeTarget = ref<PluginRecord | null>(null)

const permissionLabels: Record<PluginPermission, string> = {
  read_config: 'pluginsPage.permReadConfig',
  read_secrets: 'pluginsPage.permReadSecrets',
  network: 'pluginsPage.permNetwork',
  filesystem: 'pluginsPage.permFilesystem',
  write_data: 'pluginsPage.permWriteData',
}

async function load() {
  loading.value = true
  try {
    plugins.value = await api.get<PluginRecord[]>('/plugins')
  } catch (error) {
    reportError(error, t('pluginsPage.loadFailed'))
  } finally {
    loading.value = false
  }
}

onMounted(load)

function statusColor(status: PluginRecord['status']) {
  if (status === 'installed') return 'success'
  if (status === 'error') return 'error'
  return 'neutral'
}

async function install() {
  if (!installPath.value.trim()) return
  installing.value = true
  try {
    const record = await api.post<PluginRecord>('/plugins', { path: installPath.value.trim() })
    installPath.value = ''
    toast.add({ title: t('pluginsPage.installed'), description: record.id, color: 'success', icon: 'i-lucide-circle-check' })
    await load()
  } catch (error) {
    reportError(error, t('pluginsPage.installFailed'))
  } finally {
    installing.value = false
  }
}

async function run(id: string, action: () => Promise<unknown>, successKey: string) {
  busyId.value = id
  try {
    await action()
    toast.add({ title: t(successKey), description: id, color: 'success', icon: 'i-lucide-circle-check' })
    await load()
  } catch (error) {
    reportError(error, t('pluginsPage.actionFailed'))
  } finally {
    busyId.value = null
  }
}

function openTrust(plugin: PluginRecord) {
  trustTarget.value = plugin
  trustSelection.value = [...plugin.requested_permissions]
}

async function confirmTrust() {
  if (!trustTarget.value) return
  const target = trustTarget.value
  busyId.value = target.id
  try {
    await api.patch<PluginRecord>(`/plugins/${encodeURIComponent(target.id)}`, {
      trusted: true,
      granted_permissions: trustSelection.value,
    })
    trustTarget.value = null
    toast.add({ title: t('pluginsPage.trusted'), description: target.id, color: 'success', icon: 'i-lucide-shield-check' })
    await load()
  } catch (error) {
    reportError(error, t('pluginsPage.actionFailed'))
  } finally {
    busyId.value = null
  }
}

async function revoke(plugin: PluginRecord) {
  await run(plugin.id, () => api.patch(`/plugins/${encodeURIComponent(plugin.id)}`, { trusted: false, enabled: false }), 'pluginsPage.revoked')
}

async function confirmRemove() {
  if (!removeTarget.value) return
  const target = removeTarget.value
  busyId.value = target.id
  try {
    await api.delete(`/plugins/${encodeURIComponent(target.id)}`)
    removeTarget.value = null
    toast.add({ title: t('pluginsPage.removed'), description: target.id, color: 'success', icon: 'i-lucide-trash-2' })
    await load()
  } catch (error) {
    reportError(error, t('pluginsPage.actionFailed'))
  } finally {
    busyId.value = null
  }
}

async function testPlugin(plugin: PluginRecord) {
  busyId.value = plugin.id
  try {
    const result = await api.post<PluginTestResult>(`/plugins/${encodeURIComponent(plugin.id)}/test`, {})
    toast.add({
      title: result.success ? t('pluginsPage.testOk') : t('pluginsPage.testFailed'),
      description: result.diagnostics.join(' ') || `${result.latency_ms}ms`,
      color: result.success ? 'success' : 'error',
      icon: result.success ? 'i-lucide-circle-check' : 'i-lucide-triangle-alert',
    })
    await load()
  } catch (error) {
    reportError(error, t('pluginsPage.actionFailed'))
  } finally {
    busyId.value = null
  }
}
</script>

<template>
  <UDashboardPanel id="plugins">
    <template #header>
      <UDashboardNavbar :title="$t('pluginsPage.title')" :description="$t('pluginsPage.subtitle')">
        <template #right>
          <UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" :loading="loading" @click="load">
            {{ $t('common.refresh') }}
          </UButton>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="grid gap-6">
        <UCard>
          <template #header>
            <div>
              <h3 class="text-sm font-semibold">{{ $t('pluginsPage.installTitle') }}</h3>
              <p class="text-xs text-muted">{{ $t('pluginsPage.installHelp') }}</p>
            </div>
          </template>
          <div class="flex flex-col gap-3 sm:flex-row">
            <UInput v-model="installPath" class="w-full" :placeholder="$t('pluginsPage.installPlaceholder')" />
            <UButton icon="i-lucide-package-plus" :loading="installing" @click="install">
              {{ $t('pluginsPage.install') }}
            </UButton>
          </div>
        </UCard>

        <UCard>
          <template #header>
            <h3 class="text-sm font-semibold">{{ $t('pluginsPage.installedTitle') }}</h3>
          </template>

          <div v-if="loading" class="py-6 text-center text-sm text-muted">{{ $t('common.loading') }}</div>
          <div v-else-if="plugins.length === 0" class="py-6 text-center text-sm text-muted">{{ $t('pluginsPage.empty') }}</div>

          <div v-else class="grid gap-4">
            <div v-for="plugin in plugins" :key="plugin.id" class="rounded-lg border border-default p-4">
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <UIcon name="i-lucide-puzzle" class="size-4 text-primary" />
                    <span class="font-medium">{{ plugin.name }}</span>
                    <UBadge :color="statusColor(plugin.status)" variant="subtle" size="sm">{{ plugin.status }}</UBadge>
                    <UBadge v-if="!plugin.trusted" color="warning" variant="subtle" size="sm">{{ $t('pluginsPage.untrusted') }}</UBadge>
                  </div>
                  <p class="mt-1 text-xs text-muted">
                    {{ plugin.id }} - v{{ plugin.version }} - {{ plugin.protocol_version }}
                  </p>
                  <p v-if="plugin.description" class="mt-1 text-xs text-muted">{{ plugin.description }}</p>
                  <div class="mt-2 flex flex-wrap gap-1">
                    <UBadge v-for="cap in plugin.manifest.provider.capabilities" :key="cap" color="neutral" variant="subtle" size="sm">
                      {{ cap }}
                    </UBadge>
                  </div>
                  <p class="mt-2 text-xs text-muted">
                    {{ $t('pluginsPage.requested') }}:
                    {{ plugin.requested_permissions.join(', ') || $t('common.none') }}
                    <span v-if="plugin.trusted"> - {{ $t('pluginsPage.granted') }}: {{ plugin.granted_permissions.join(', ') || $t('common.none') }}</span>
                  </p>
                  <p v-if="plugin.last_error" class="mt-1 text-xs text-error">{{ plugin.last_error }}</p>
                </div>

                <div class="flex flex-wrap items-center gap-2">
                  <USwitch
                    v-if="plugin.trusted"
                    :model-value="plugin.enabled"
                    :disabled="busyId === plugin.id"
                    :label="$t('pluginsPage.enabled')"
                    @update:model-value="(value) => run(plugin.id, () => api.patch(`/plugins/${encodeURIComponent(plugin.id)}`, { enabled: value }), value ? 'pluginsPage.enabledDone' : 'pluginsPage.disabledDone')"
                  />
                  <UButton
                    v-if="!plugin.trusted"
                    icon="i-lucide-shield-check"
                    size="sm"
                    color="warning"
                    variant="soft"
                    @click="openTrust(plugin)"
                  >
                    {{ $t('pluginsPage.review') }}
                  </UButton>
                  <UButton
                    v-else
                    icon="i-lucide-shield-off"
                    size="sm"
                    color="neutral"
                    variant="ghost"
                    :disabled="busyId === plugin.id"
                    @click="revoke(plugin)"
                  >
                    {{ $t('pluginsPage.untrust') }}
                  </UButton>
                  <UButton icon="i-lucide-plug-zap" size="sm" color="neutral" variant="ghost" :loading="busyId === plugin.id" @click="testPlugin(plugin)">
                    {{ $t('pluginsPage.test') }}
                  </UButton>
                  <UButton icon="i-lucide-refresh-cw" size="sm" color="neutral" variant="ghost" :disabled="busyId === plugin.id" @click="run(plugin.id, () => api.post(`/plugins/${encodeURIComponent(plugin.id)}/update`, {}), 'pluginsPage.updated')">
                    {{ $t('pluginsPage.update') }}
                  </UButton>
                  <UButton icon="i-lucide-trash-2" size="sm" color="error" variant="ghost" @click="removeTarget = plugin">
                    {{ $t('common.delete') }}
                  </UButton>
                </div>
              </div>
            </div>
          </div>
        </UCard>
      </div>
    </template>
  </UDashboardPanel>

  <UModal :open="Boolean(trustTarget)" :title="$t('pluginsPage.trustTitle')" :description="$t('pluginsPage.trustHelp')" @update:open="(value) => { if (!value) trustTarget = null }">
    <template #body>
      <div v-if="trustTarget" class="grid gap-3">
        <p class="text-xs text-muted">{{ trustTarget.id }} - {{ trustTarget.name }}</p>
        <USwitch
          v-for="permission in trustTarget.requested_permissions"
          :key="permission"
          :model-value="trustSelection.includes(permission)"
          :label="t(permissionLabels[permission])"
          @update:model-value="(value) => { trustSelection = value ? [...trustSelection, permission] : trustSelection.filter((p) => p !== permission) }"
        />
        <p v-if="trustTarget.requested_permissions.length === 0" class="text-sm text-muted">{{ $t('pluginsPage.noPermissions') }}</p>
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="trustTarget = null">{{ $t('common.cancel') }}</UButton>
        <UButton color="warning" icon="i-lucide-shield-check" :loading="busyId === trustTarget?.id" @click="confirmTrust">
          {{ $t('pluginsPage.grantAndTrust') }}
        </UButton>
      </div>
    </template>
  </UModal>

  <UModal :open="Boolean(removeTarget)" :title="$t('pluginsPage.removeTitle')" :description="$t('pluginsPage.removeHelp')" @update:open="(value) => { if (!value) removeTarget = null }">
    <template #body>
      <p v-if="removeTarget" class="text-sm">{{ removeTarget.name }} ({{ removeTarget.id }})</p>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="removeTarget = null">{{ $t('common.cancel') }}</UButton>
        <UButton color="error" icon="i-lucide-trash-2" :loading="busyId === removeTarget?.id" @click="confirmRemove">
          {{ $t('common.delete') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
