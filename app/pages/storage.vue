<script setup lang="ts">
import type { StorageBackendRecord, StorageBackendType, StorageTestResult } from '~/types'

const api = useApi()
const toast = useToast()
const reportError = useApiToast()
const { t } = useI18n()

const backends = ref<StorageBackendRecord[]>([])
const loading = ref(true)
const saving = ref(false)
const testingId = ref<string | null>(null)
const deleteTarget = ref<StorageBackendRecord | null>(null)
const detail = ref<{ backend: StorageBackendRecord; result: StorageTestResult } | null>(null)

const showForm = ref(false)
const editing = ref<StorageBackendRecord | null>(null)
const backendType = ref<StorageBackendType>('s3')
const name = ref('')
const localRoot = ref('')
const endpoint = ref('')
const bucket = ref('')
const prefix = ref('')
const region = ref('auto')
const forcePathStyle = ref(true)
const accessKeyId = ref('')
const secretAccessKey = ref('')

async function load() {
  try {
    backends.value = await api.get<StorageBackendRecord[]>('/storage/backends')
  } catch (error) {
    reportError(error, t('storagePage.loadFailed'))
  } finally {
    loading.value = false
  }
}

onMounted(load)

function readString(config: Record<string, unknown>, key: string): string {
  const value = config[key]
  return typeof value === 'string' ? value : ''
}

function openCreate() {
  editing.value = null
  backendType.value = 's3'
  name.value = ''
  localRoot.value = ''
  endpoint.value = ''
  bucket.value = ''
  prefix.value = ''
  region.value = 'auto'
  forcePathStyle.value = true
  accessKeyId.value = ''
  secretAccessKey.value = ''
  showForm.value = true
}

function openEdit(backend: StorageBackendRecord) {
  editing.value = backend
  backendType.value = backend.backend_type
  name.value = backend.name
  localRoot.value = readString(backend.config, 'root')
  endpoint.value = readString(backend.config, 'endpoint')
  bucket.value = readString(backend.config, 'bucket')
  prefix.value = readString(backend.config, 'prefix')
  region.value = readString(backend.config, 'region') || 'auto'
  forcePathStyle.value = backend.config.force_path_style !== false
  accessKeyId.value = ''
  secretAccessKey.value = ''
  showForm.value = true
}

const editingLocalDefault = computed(() => editing.value?.id === 'local-default')

function payload(): Record<string, unknown> {
  if (backendType.value === 'local') {
    const config: Record<string, unknown> = {}
    if (localRoot.value.trim()) config.root = localRoot.value.trim()
    return { backend_type: 'local', config }
  }
  const secret: Record<string, unknown> = {}
  if (accessKeyId.value.trim()) secret.access_key_id = accessKeyId.value.trim()
  if (secretAccessKey.value.trim()) secret.secret_access_key = secretAccessKey.value.trim()
  return {
    backend_type: 's3',
    config: {
      endpoint: endpoint.value.trim(),
      bucket: bucket.value.trim(),
      prefix: prefix.value.trim() || undefined,
      region: region.value.trim() || 'auto',
      force_path_style: forcePathStyle.value,
    },
    ...(Object.keys(secret).length ? { secret } : {}),
  }
}

async function save() {
  if (!name.value.trim()) {
    toast.add({ title: t('storagePage.requiredFields'), color: 'warning', icon: 'i-lucide-triangle-alert' })
    return
  }
  if (backendType.value === 's3' && (!endpoint.value.trim() || !bucket.value.trim())) {
    toast.add({ title: t('storagePage.requiredFields'), color: 'warning', icon: 'i-lucide-triangle-alert' })
    return
  }
  if (backendType.value === 's3' && !editing.value && (!accessKeyId.value.trim() || !secretAccessKey.value.trim())) {
    toast.add({ title: t('storagePage.requiredFields'), color: 'warning', icon: 'i-lucide-triangle-alert' })
    return
  }
  saving.value = true
  try {
    if (editing.value) {
      const body = payload()
      await api.patch(`/storage/backends/${encodeURIComponent(editing.value.id)}`, {
        name: name.value.trim(),
        config: body.config,
        ...(body.secret ? { secret: body.secret } : {}),
      })
      toast.add({ title: t('storagePage.updated'), color: 'success', icon: 'i-lucide-hard-drive' })
    } else {
      await api.post('/storage/backends', { name: name.value.trim(), ...payload() })
      toast.add({ title: t('storagePage.created'), color: 'success', icon: 'i-lucide-hard-drive' })
    }
    showForm.value = false
    await load()
  } catch (error) {
    reportError(error, editing.value ? t('storagePage.updateFailed') : t('storagePage.createFailed'))
  } finally {
    saving.value = false
  }
}

async function test(backend: StorageBackendRecord) {
  testingId.value = backend.id
  try {
    const result = await api.post<StorageTestResult>(`/storage/backends/${encodeURIComponent(backend.id)}/test`)
    detail.value = { backend, result }
    toast.add({
      title: result.success ? t('storagePage.testPassed') : t('storagePage.testFailed'),
      description: t('storagePage.testLatency', { ms: result.latency_ms }),
      color: result.success ? 'success' : 'error',
      icon: result.success ? 'i-lucide-circle-check' : 'i-lucide-circle-x',
    })
    await load()
  } catch (error) {
    reportError(error, t('storagePage.testFailed'))
  } finally {
    testingId.value = null
  }
}

async function makeDefault(backend: StorageBackendRecord) {
  try {
    await api.post(`/storage/backends/${encodeURIComponent(backend.id)}/default`)
    toast.add({ title: t('storagePage.defaultSet'), description: backend.name, color: 'success', icon: 'i-lucide-star' })
    await load()
  } catch (error) {
    reportError(error, t('storagePage.defaultFailed'))
  }
}

async function remove() {
  if (!deleteTarget.value) return
  try {
    await api.del(`/storage/backends/${encodeURIComponent(deleteTarget.value.id)}`)
    toast.add({ title: t('storagePage.deleted'), color: 'success', icon: 'i-lucide-trash-2' })
    deleteTarget.value = null
    detail.value = null
    await load()
  } catch (error) {
    reportError(error, t('storagePage.deleteFailed'))
  }
}
</script>

<template>
  <PageShell
    id="storage"
    :title="$t('storagePage.title')"
    :description="$t('storagePage.description', { count: backends.length })"
  >
    <template #right>
      <UButton icon="i-lucide-plus" @click="openCreate">{{ $t('storagePage.newBackend') }}</UButton>
      <UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" square :aria-label="$t('common.refresh')" @click="load" />
    </template>

    <div class="flex-1 overflow-auto scroll-thin p-4 sm:p-6">
      <div v-if="loading" class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" /> {{ $t('storagePage.loading') }}
      </div>

      <EmptyState
        v-else-if="backends.length === 0"
        icon="i-lucide-hard-drive"
        :title="$t('storagePage.emptyTitle')"
        :description="$t('storagePage.emptyDescription')"
      >
        <UButton icon="i-lucide-plus" @click="openCreate">{{ $t('storagePage.newBackend') }}</UButton>
      </EmptyState>

      <div v-else class="panel overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-elevated/60 text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th class="px-4 py-3 font-medium">{{ $t('storagePage.colBackend') }}</th>
              <th class="hidden px-4 py-3 font-medium sm:table-cell">{{ $t('common.type') }}</th>
              <th class="hidden px-4 py-3 font-medium md:table-cell">{{ $t('storagePage.colLocation') }}</th>
              <th class="hidden px-4 py-3 font-medium lg:table-cell">{{ $t('storagePage.colHealth') }}</th>
              <th class="px-4 py-3 text-right font-medium">{{ $t('common.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="backend in backends" :key="backend.id" class="border-t border-default/60 hover:bg-elevated/40">
              <td class="px-4 py-3">
                <div class="flex items-center gap-2">
                  <UIcon :name="backend.backend_type === 's3' ? 'i-lucide-cloud' : 'i-lucide-hard-drive'" class="size-4 shrink-0 text-dimmed" />
                  <span class="min-w-0">
                    <span class="block truncate font-medium">{{ backend.name }}</span>
                    <span class="mono block truncate text-xs text-muted">{{ backend.id }}</span>
                  </span>
                  <UBadge v-if="backend.is_default" color="primary" variant="subtle" size="sm">{{ $t('storagePage.defaultBadge') }}</UBadge>
                </div>
              </td>
              <td class="hidden px-4 py-3 sm:table-cell">
                <UBadge color="neutral" variant="subtle" size="sm">{{ backend.backend_type }}</UBadge>
              </td>
              <td class="hidden max-w-64 truncate px-4 py-3 md:table-cell">
                <span class="mono text-xs">{{ backend.endpoint_hint ?? '—' }}</span>
              </td>
              <td class="hidden px-4 py-3 lg:table-cell">
                <div class="flex items-center gap-2">
                  <StatusBadge :status="backend.last_test_status ?? 'unknown'" />
                  <span v-if="backend.last_tested_at" class="text-xs text-muted">{{ formatRelative(backend.last_tested_at) }}</span>
                </div>
              </td>
              <td class="px-4 py-3">
                <div class="flex justify-end gap-1">
                  <UTooltip :text="$t('storagePage.test')">
                    <UButton
                      icon="i-lucide-plug-zap"
                      color="neutral"
                      variant="ghost"
                      size="sm"
                      square
                      :loading="testingId === backend.id"
                      :aria-label="$t('storagePage.test')"
                      @click="test(backend)"
                    />
                  </UTooltip>
                  <UTooltip :text="$t('storagePage.makeDefault')">
                    <UButton
                      icon="i-lucide-star"
                      color="neutral"
                      variant="ghost"
                      size="sm"
                      square
                      :disabled="backend.is_default"
                      :aria-label="$t('storagePage.makeDefault')"
                      @click="makeDefault(backend)"
                    />
                  </UTooltip>
                  <UTooltip :text="$t('common.edit')">
                    <UButton icon="i-lucide-pencil" color="neutral" variant="ghost" size="sm" square :aria-label="$t('common.edit')" @click="openEdit(backend)" />
                  </UTooltip>
                  <UTooltip :text="$t('storagePage.deleteTooltip')">
                    <UButton
                      icon="i-lucide-trash-2"
                      color="error"
                      variant="ghost"
                      size="sm"
                      square
                      :disabled="backend.id === 'local-default' || backend.is_default"
                      :aria-label="$t('common.delete')"
                      @click="deleteTarget = backend"
                    />
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
      :title="editing ? $t('storagePage.editTitle') : $t('storagePage.createTitle')"
      :description="$t('storagePage.formDescription')"
    >
      <template #body>
        <div class="grid gap-4">
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField :label="$t('common.name')" required>
              <UInput v-model="name" class="w-full" :placeholder="$t('storagePage.namePlaceholder')" />
            </UFormField>
            <UFormField :label="$t('common.type')">
              <USelect v-model="backendType" :items="['s3', 'local']" class="w-full" :disabled="Boolean(editing)" />
            </UFormField>
          </div>

          <template v-if="backendType === 'local'">
            <UFormField :label="$t('storagePage.localRoot')" :help="$t('storagePage.localRootHelp')">
              <UInput v-model="localRoot" class="w-full" placeholder="D:\\backups\\udmt" :disabled="editingLocalDefault" />
            </UFormField>
          </template>

          <template v-else>
            <div class="grid gap-4 sm:grid-cols-2">
              <UFormField :label="$t('storagePage.endpoint')" required>
                <UInput v-model="endpoint" class="w-full" placeholder="https://<account>.r2.cloudflarestorage.com" />
              </UFormField>
              <UFormField :label="$t('storagePage.bucket')" required>
                <UInput v-model="bucket" class="w-full" placeholder="udmt-artifacts" />
              </UFormField>
            </div>
            <div class="grid gap-4 sm:grid-cols-3">
              <UFormField :label="$t('storagePage.prefix')">
                <UInput v-model="prefix" class="w-full" placeholder="udmt" />
              </UFormField>
              <UFormField :label="$t('storagePage.region')">
                <UInput v-model="region" class="w-full" placeholder="auto" />
              </UFormField>
              <UFormField :label="$t('storagePage.pathStyle')" :help="$t('storagePage.pathStyleHelp')">
                <div class="flex h-8 items-center">
                  <USwitch v-model="forcePathStyle" />
                </div>
              </UFormField>
            </div>
            <div class="grid gap-4 sm:grid-cols-2">
              <UFormField :label="$t('storagePage.accessKey')" :required="!editing">
                <UInput v-model="accessKeyId" class="w-full" autocomplete="off" :placeholder="editing ? $t('storagePage.secretKeep') : ''" />
              </UFormField>
              <UFormField :label="$t('storagePage.secretKey')" :required="!editing">
                <UInput
                  v-model="secretAccessKey"
                  class="w-full"
                  type="password"
                  autocomplete="new-password"
                  :placeholder="editing ? $t('storagePage.secretKeep') : ''"
                />
              </UFormField>
            </div>
            <p class="text-xs text-muted">{{ $t('storagePage.secretHint') }}</p>
          </template>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="showForm = false">{{ $t('common.cancel') }}</UButton>
          <UButton :loading="saving" icon="i-lucide-save" @click="save">{{ editing ? $t('common.save') : $t('common.create') }}</UButton>
        </div>
      </template>
    </UModal>

    <USlideover
      :open="Boolean(detail)"
      :title="detail ? $t('storagePage.diagnosticsTitle', { name: detail.backend.name }) : $t('storagePage.diagnostics')"
      @update:open="(value) => { if (!value) detail = null }"
    >
      <template #body>
        <div v-if="detail" class="grid gap-4 text-sm">
          <div class="flex flex-wrap items-center gap-2">
            <StatusBadge :status="detail.result.success ? 'success' : 'failed'" />
            <UBadge color="neutral" variant="subtle" size="sm">{{ detail.backend.backend_type }}</UBadge>
            <span class="text-xs text-muted">{{ $t('storagePage.testLatency', { ms: detail.result.latency_ms }) }}</span>
          </div>
          <div>
            <p class="mb-1 text-xs text-muted">{{ $t('storagePage.colLocation') }}</p>
            <p class="mono break-all rounded-lg bg-elevated/60 p-2 text-[11px]">{{ detail.result.endpoint_hint ?? '—' }}</p>
          </div>
          <div>
            <p class="mb-1 text-xs text-muted">{{ $t('storagePage.credentials') }}</p>
            <p class="text-xs">{{ $t('storagePage.credentialRef', { ref: detail.backend.credential_ref ?? $t('common.none') }) }}</p>
          </div>
          <div>
            <p class="mb-1 text-xs text-muted">{{ $t('storagePage.diagnostics') }}</p>
            <ul class="grid gap-1 rounded-lg border border-default p-2 text-xs">
              <li v-for="line in detail.result.diagnostics" :key="line" class="mono break-all">{{ line }}</li>
            </ul>
          </div>
          <div class="text-xs text-muted">
            {{ $t('storagePage.lastTested', { at: formatDateTime(detail.result.tested_at) }) }}
          </div>
        </div>
      </template>
    </USlideover>

    <UModal
      :open="Boolean(deleteTarget)"
      :title="$t('storagePage.deleteTitle')"
      @update:open="(value) => { if (!value) deleteTarget = null }"
    >
      <template #body>
        <p class="text-sm text-muted">
          {{ $t('storagePage.deleteBody', { name: deleteTarget?.name ?? '' }) }}
        </p>
        <p v-if="deleteTarget?.credential_ref" class="mt-2 text-xs text-warning">
          {{ $t('storagePage.deleteSecretWarning') }}
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="deleteTarget = null">{{ $t('common.cancel') }}</UButton>
          <UButton color="error" icon="i-lucide-trash-2" @click="remove">{{ $t('common.delete') }}</UButton>
        </div>
      </template>
    </UModal>
  </PageShell>
</template>
