<script setup lang="ts">
import type { ConfigField, Connection, ProviderDescriptor } from '~/types'

const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{
  providers: ProviderDescriptor[]
  connection?: Connection | null
}>()
const emit = defineEmits<{ saved: [Connection] }>()

const api = useApi()
const toast = useToast()
const reportError = useApiToast()
const { t } = useI18n()

const name = ref('')
const providerId = ref<string>('sqlite')
const serviceProfile = ref<string>('')
const environment = ref<'local' | 'development' | 'staging' | 'production' | 'custom'>('local')
const description = ref('')
const values = reactive<Record<string, string | number | boolean>>({})
const secretValues = reactive<Record<string, string>>({ password: '' })
const saving = ref(false)
const active = ref(true)

const isEdit = computed(() => Boolean(props.connection))
const provider = computed(() => props.providers.find((item) => item.provider_id === providerId.value))

const configFields = computed<ConfigField[]>(() => provider.value?.config_fields ?? [])
const secretFields = computed<ConfigField[]>(() =>
  configFields.value.filter((field) => field.type === 'password' || secretType(field.name)),
)
const plainFields = computed<ConfigField[]>(() =>
  configFields.value.filter((field) => !secretFields.value.includes(field)),
)

function secretType(name: string): boolean {
  return /password|secret|token/i.test(name)
}

function clearValues() {
  for (const key of Object.keys(values)) delete values[key]
  for (const key of Object.keys(secretValues)) delete secretValues[key]
}

function applyDefaults() {
  for (const field of configFields.value) {
    if (field.type === 'password' || secretType(field.name)) continue
    if (field.default !== undefined) values[field.name] = field.default
  }
}

/**
 * Local connections talk to a server on this machine, so prefill localhost and
 * drop TLS. Switching back to a shared environment restores the secure default
 * instead of leaving a connection that silently sends traffic unencrypted.
 */
function applyEnvironmentDefaults(next: string) {
  for (const field of plainFields.value) {
    if (next === 'local') {
      if (field.name === 'ssl') values[field.name] = 'disable'
      if (field.name === 'uri' && !values[field.name]) values[field.name] = 'mongodb://localhost:27017'
    } else if (field.name === 'ssl' && values[field.name] === 'disable') {
      values[field.name] = field.default ?? 'require'
    }
  }
}

function resetForCreate() {
  name.value = ''
  providerId.value = props.providers[0]?.provider_id ?? 'sqlite'
  serviceProfile.value = ''
  environment.value = 'local'
  description.value = ''
  active.value = true
  clearValues()
  applyDefaults()
  applyEnvironmentDefaults(environment.value)
}

function populateFromConnection(connection: Connection) {
  name.value = connection.name
  providerId.value = connection.provider_id
  serviceProfile.value = connection.service_profile ?? ''
  environment.value = connection.environment
  description.value = connection.description ?? ''
  active.value = connection.is_active
  clearValues()
  applyDefaults()
  for (const field of plainFields.value) {
    const configured = connection.config[field.name]
    if (configured !== undefined && configured !== null) {
      values[field.name] = configured as string | number | boolean
    }
  }
}

watch(providerId, (next, previous) => {
  if (!previous || next === previous || isEdit.value) return
  serviceProfile.value = ''
  clearValues()
  applyDefaults()
  applyEnvironmentDefaults(environment.value)
})

/**
 * MongoDB URIs usually carry the database after the host (`/app`, or `/prod?retryWrites=true`
 * for Atlas). Mirror it into the separate database field so exports and imports resolve
 * `<database>.<collection>` without asking for the same name twice.
 */
function databaseFromUri(uri: unknown): string {
  if (typeof uri !== 'string') return ''
  const match = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/.exec(uri)
  return match ? decodeURIComponent(match[1] ?? '') : ''
}

watch(
  () => values.uri,
  (uri) => {
    if (!plainFields.value.some((field) => field.name === 'database')) return
    const fromUri = databaseFromUri(uri)
    if (fromUri && !values.database) values.database = fromUri
  },
)

watch(open, (isOpen) => {
  if (!isOpen) return
  if (props.connection) populateFromConnection(props.connection)
  else resetForCreate()
})

watch(
  () => props.connection,
  (connection) => {
    if (open.value && connection) populateFromConnection(connection)
  },
)

function buildConfig(): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  for (const field of plainFields.value) {
    const value = values[field.name]
    if (value === undefined || value === '') continue
    if (field.type === 'number') config[field.name] = Number(value)
    else config[field.name] = value
  }
  return config
}

function buildSecret(): Record<string, unknown> {
  const secret: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(secretValues)) {
    if (value) secret[key] = value
  }
  return secret
}

async function submit() {
  if (!name.value.trim()) {
    toast.add({ title: t('connectionForm.nameRequired'), color: 'warning', icon: 'i-lucide-triangle-alert' })
    return
  }
  saving.value = true
  try {
    const secret = buildSecret()
    let saved: Connection
    if (props.connection) {
      saved = await api.patch<Connection>(`/connections/${encodeURIComponent(props.connection.name)}`, {
        name: name.value.trim(),
        service_profile: serviceProfile.value || null,
        config: buildConfig(),
        environment: environment.value,
        description: description.value || null,
        is_active: active.value,
        ...(Object.keys(secret).length > 0 ? { secret } : {}),
      })
      toast.add({ title: t('connectionForm.updated'), description: saved.name, color: 'success', icon: 'i-lucide-circle-check' })
    } else {
      saved = await api.post<Connection>('/connections', {
        name: name.value.trim(),
        provider_id: providerId.value,
        service_profile: serviceProfile.value || null,
        config: buildConfig(),
        secret,
        environment: environment.value,
        description: description.value || null,
      })
      toast.add({ title: t('connectionForm.created'), description: saved.name, color: 'success', icon: 'i-lucide-circle-check' })
    }
    emit('saved', saved)
    open.value = false
  } catch (error) {
    reportError(error, isEdit.value ? t('connectionForm.updateFailed') : t('connectionForm.createFailed'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="isEdit ? $t('connectionForm.editTitle') : $t('connectionForm.createTitle')"
    :description="isEdit
      ? $t('connectionForm.editDescription')
      : $t('connectionForm.createDescription')"
  >
    <template #body>
      <div class="grid gap-4">
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField :label="$t('connectionForm.name')" required>
            <UInput v-model="name" :placeholder="$t('connectionForm.namePlaceholder')" class="w-full" autofocus />
          </UFormField>
          <UFormField :label="$t('connectionForm.provider')" required :help="isEdit ? $t('connectionForm.providerLocked') : undefined">
            <USelect
              v-model="providerId"
              :items="providers.map((p) => ({ value: p.provider_id, label: p.display_name }))"
              class="w-full"
              :disabled="isEdit"
            />
          </UFormField>
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField :label="$t('connectionForm.serviceProfile')">
            <USelect
              v-model="serviceProfile"
              :items="[{ value: '', label: $t('common.none') }, ...(provider?.service_profiles ?? []).map((p) => ({ value: p.id, label: p.display_name }))]"
              class="w-full"
            />
          </UFormField>
          <UFormField :label="$t('connectionForm.environment')">
            <USelect
              v-model="environment"
              :items="['local', 'development', 'staging', 'production', 'custom'].map((value) => ({ value, label: value }))"
              class="w-full"
              @update:model-value="(value) => applyEnvironmentDefaults(String(value))"
            />
          </UFormField>
        </div>

        <div v-if="provider?.service_profiles.find((p) => p.id === serviceProfile)?.notes?.length" class="rounded-lg bg-elevated/60 p-3 text-xs text-muted">
          <p v-for="note in provider.service_profiles.find((p) => p.id === serviceProfile)?.notes" :key="note">• {{ note }}</p>
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField v-for="field in plainFields" :key="field.name" :label="field.label" :required="field.required" :help="field.help">
            <USwitch v-if="field.type === 'boolean'" v-model="values[field.name]" />
            <USelect
              v-else-if="field.type === 'select'"
              v-model="values[field.name]"
              :items="field.options ?? []"
              class="w-full"
            />
            <UInput
              v-else
              v-model="values[field.name]"
              :type="field.type === 'number' ? 'number' : 'text'"
              :placeholder="field.placeholder"
              class="w-full"
            />
          </UFormField>
        </div>

        <UFormField
          v-for="field in secretFields"
          :key="field.name"
          :label="field.label"
          :help="field.help ?? (isEdit ? $t('connectionForm.keepPassword') : $t('connectionForm.secretHelp'))"
        >
          <UInput v-model="secretValues[field.name]" type="password" :placeholder="field.placeholder ?? '••••••••'" class="w-full" />
        </UFormField>

        <UFormField :label="$t('connectionForm.description')">
          <UTextarea v-model="description" :rows="2" :placeholder="$t('connectionForm.descriptionPlaceholder')" class="w-full" />
        </UFormField>

        <div v-if="isEdit" class="flex items-center gap-3">
          <USwitch v-model="active" />
          <div>
            <p class="text-sm">{{ $t('connectionForm.enabled') }}</p>
            <p class="text-xs text-muted">{{ $t('connectionForm.enabledHint') }}</p>
          </div>
        </div>

        <UAlert
          v-if="provider"
          color="neutral"
          variant="subtle"
          icon="i-lucide-info"
          :title="t('connectionForm.capabilities', { list: provider.capabilities.filter((c) => c.supported).map((c) => c.id).join(', ') })"
        />
      </div>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="open = false">{{ $t('common.cancel') }}</UButton>
        <UButton :loading="saving" :icon="isEdit ? 'i-lucide-save' : 'i-lucide-plus'" @click="submit">
          {{ isEdit ? $t('common.save') : $t('connectionForm.createAction') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
