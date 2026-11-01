<script setup lang="ts">
import type { Connection, ProviderDescriptor, ResourceDescriptor, ResourcePreview } from '~/types'

const api = useApi()
const reportError = useApiToast()
const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const view = computed(() => ({ name: decodeURIComponent(String(route.params.name ?? '')) }))

const connection = ref<Connection | null>(null)
const providers = ref<ProviderDescriptor[]>([])
const resources = ref<ResourceDescriptor[]>([])
const loading = ref(true)
const resourcesLoading = ref(false)
const rowsLoading = ref(false)
const notFound = ref(false)
const selected = ref<string | null>(null)
const preview = ref<ResourcePreview | null>(null)
const search = ref('')
const collapsed = ref<Record<string, boolean>>({})
const selectedRow = ref<{ index: number; row: Record<string, unknown> } | null>(null)

const providerName = computed(() => {
  const id = connection.value?.provider_id
  if (!id) return ''
  return providers.value.find((provider) => provider.provider_id === id)?.display_name ?? id
})

const isContainer = (resource: ResourceDescriptor) => resource.type === 'database' || resource.type === 'schema'

const groups = computed(() => {
  const needle = search.value.trim().toLowerCase()
  const containers = resources.value.filter(isContainer)
  const leaves = resources.value.filter((resource) => !isContainer(resource))
  const matches = (resource: ResourceDescriptor) =>
    !needle || resource.name.toLowerCase().includes(needle) || resource.id.toLowerCase().includes(needle)

  if (containers.length === 0) {
    const items = leaves.filter(matches)
    return items.length ? [{ id: '__root', label: view.value.name, items }] : []
  }

  const buckets = new Map<string, { id: string; label: string; items: ResourceDescriptor[] }>()
  for (const container of containers) {
    buckets.set(container.namespace, { id: container.namespace, label: container.name, items: [] })
  }
  for (const leaf of leaves) {
    const bucket = buckets.get(leaf.namespace) ?? { id: leaf.namespace, label: leaf.namespace, items: [] }
    if (!buckets.has(leaf.namespace)) buckets.set(leaf.namespace, bucket)
    if (matches(leaf)) bucket.items.push(leaf)
  }
  return [...buckets.values()]
    .filter((bucket) => bucket.items.length > 0)
    .sort((a, b) => a.label.localeCompare(b.label))
})

const columns = computed<string[]>(() => {
  const declared = preview.value?.columns.map((column) => column.name) ?? []
  if (declared.length > 0) return declared
  const first = preview.value?.rows[0]
  return first ? Object.keys(first) : []
})

const visibleRows = computed(() => preview.value?.rows ?? [])

const detailFields = computed(() => {
  const row = selectedRow.value?.row
  if (!row) return []
  const keys = Object.keys(row)
  const ordered = [...columns.value.filter((column) => keys.includes(column)), ...keys.filter((key) => !columns.value.includes(key))]
  return ordered.map((name) => ({ name, value: row[name] }))
})

async function load() {
  loading.value = true
  notFound.value = false
  try {
    const [connectionList, providerList] = await Promise.all([
      api.get<Connection[]>('/connections'),
      api.get<ProviderDescriptor[]>('/providers'),
    ])
    providers.value = providerList
    connection.value = connectionList.find((item) => item.name === view.value.name) ?? null
    if (!connection.value) {
      notFound.value = true
      return
    }
    await loadResources(false)
  } catch (error) {
    reportError(error, t('connections.loadFailed'))
  } finally {
    loading.value = false
  }
}

async function loadResources(keepSelection: boolean) {
  if (!connection.value) return
  resourcesLoading.value = true
  try {
    resources.value = await api.get<ResourceDescriptor[]>(
      `/connections/${encodeURIComponent(connection.value.name)}/resources`,
    )
    const wanted = keepSelection ? selected.value : (route.query.resource as string | undefined)
    const target = wanted ? resources.value.find((resource) => resource.id === wanted) : undefined
    const first = target ?? resources.value.find((resource) => !isContainer(resource))
    if (first) await select(first.id)
  } catch (error) {
    reportError(error, t('connections.discoveryFailed'))
  } finally {
    resourcesLoading.value = false
  }
}

async function select(resourceId: string) {
  if (!connection.value) return
  selected.value = resourceId
  selectedRow.value = null
  preview.value = null
  rowsLoading.value = true
  void router.replace({ query: { resource: resourceId } })
  try {
    preview.value = await api.get<ResourcePreview>(
      `/connections/${encodeURIComponent(connection.value.name)}/rows?resource=${encodeURIComponent(resourceId)}&limit=100`,
    )
  } catch (error) {
    reportError(error, t('connectionDetail.rowsFailed'))
  } finally {
    rowsLoading.value = false
  }
}

function toggleGroup(id: string) {
  collapsed.value = { ...collapsed.value, [id]: !collapsed.value[id] }
}

function pickRow(index: number) {
  const row = visibleRows.value[index]
  if (!row) return
  selectedRow.value = selectedRow.value?.index === index ? null : { index, row }
}

function iconFor(resource: ResourceDescriptor): string {
  if (resource.type === 'collection') return 'i-lucide-boxes'
  if (resource.type === 'view') return 'i-lucide-eye'
  if (resource.type === 'table') return 'i-lucide-table-2'
  return 'i-lucide-folder'
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function isComplex(value: unknown): boolean {
  return typeof value === 'object' && value !== null
}

onMounted(load)
watch(() => view.value.name, () => { if (route.name) void load() })
</script>

<template>
  <PageShell
    id="connection-detail"
    :title="connection?.name ?? view.name"
    :description="connection ? `${providerName} · ${connection.environment}` : $t('connectionDetail.loading')"
  >
    <template #leading>
      <UButton
        icon="i-lucide-arrow-left"
        color="neutral"
        variant="ghost"
        square
        :to="'/connections'"
        :aria-label="$t('connectionDetail.back')"
      />
    </template>
    <template #right>
      <UButton
        v-if="connection"
        icon="i-lucide-pencil"
        color="neutral"
        variant="soft"
        :to="'/connections'"
      >
        {{ $t('common.edit') }}
      </UButton>
      <UButton
        icon="i-lucide-refresh-cw"
        color="neutral"
        variant="ghost"
        square
        :aria-label="$t('common.refresh')"
        @click="load"
      />
    </template>

    <div class="flex min-h-0 flex-1 flex-col md:flex-row">
      <!-- left: databases and collections -->
      <aside class="flex min-h-0 w-full shrink-0 flex-col border-default md:w-80 md:border-e lg:w-96">
        <div class="shrink-0 px-3 py-3">
          <UInput
            v-model="search"
            icon="i-lucide-search"
            size="sm"
            :placeholder="$t('connectionDetail.searchPlaceholder')"
          />
        </div>
        <div class="min-h-0 flex-1 overflow-auto scroll-thin px-2 pb-3">
          <div v-if="loading || resourcesLoading" class="flex items-center gap-2 px-2 py-2 text-sm text-muted">
            <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" /> {{ $t('connections.discovering') }}
          </div>
          <template v-else>
            <p v-if="groups.length === 0" class="px-2 py-2 text-sm text-muted">
              {{ search ? $t('connectionDetail.noMatch') : $t('connections.noResources') }}
            </p>
            <div v-for="group in groups" :key="group.id" class="mb-1">
              <button
                v-if="group.id !== '__root'"
                class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-muted transition hover:bg-elevated/70"
                @click="toggleGroup(group.id)"
              >
                <UIcon
                  :name="collapsed[group.id] ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'"
                  class="size-3.5 shrink-0"
                />
                <UIcon name="i-lucide-database" class="size-3.5 shrink-0 text-dimmed" />
                <span class="mono truncate normal-case">{{ group.label }}</span>
                <span class="ms-auto text-[11px] font-normal text-dimmed">{{ group.items.length }}</span>
              </button>
              <div v-show="group.id === '__root' || !collapsed[group.id]" class="grid gap-0.5">
                <button
                  v-for="resource in group.items"
                  :key="resource.id"
                  class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition"
                  :class="selected === resource.id ? 'bg-primary/10 text-primary' : 'hover:bg-elevated/70'"
                  @click="select(resource.id)"
                >
                  <UIcon :name="iconFor(resource)" class="size-4 shrink-0 text-dimmed" />
                  <span class="mono truncate">{{ resource.name }}</span>
                </button>
              </div>
            </div>
          </template>
        </div>
      </aside>

      <!-- right: records of the selected collection + detail of the picked record -->
      <section class="flex min-h-0 min-w-0 flex-1 flex-col xl:flex-row">
        <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        <div class="shrink-0 border-b border-default px-4 py-3">
          <div class="flex flex-wrap items-center gap-2">
            <UIcon name="i-lucide-table-2" class="size-4 text-dimmed" />
            <p class="mono truncate text-sm font-medium">{{ selected ?? $t('connectionDetail.pickCollection') }}</p>
            <UBadge v-if="preview" color="neutral" variant="subtle" size="sm">
              {{ preview.rows.length }} {{ $t('connectionDetail.rowsShown') }}
            </UBadge>
            <UBadge v-if="preview?.truncated" color="warning" variant="subtle" size="sm">
              {{ $t('connectionDetail.limitReached', { limit: preview.limit }) }}
            </UBadge>
            <span v-if="preview" class="text-xs text-dimmed">{{ preview.latency_ms }}ms</span>
            <span v-if="preview && !selectedRow" class="ms-auto text-xs text-dimmed">
              {{ $t('connectionDetail.pickRecordHint') }}
            </span>
          </div>
        </div>

        <div class="min-h-0 flex-1 overflow-auto scroll-thin">
          <div v-if="rowsLoading" class="flex items-center gap-2 p-4 text-sm text-muted">
            <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" /> {{ $t('connectionDetail.loadingRows') }}
          </div>
          <EmptyState
            v-else-if="notFound"
            icon="i-lucide-plug-zap"
            :title="$t('connectionDetail.notFoundTitle')"
            :description="$t('connectionDetail.notFoundDescription', { name: view.name })"
          >
            <UButton to="/connections" icon="i-lucide-arrow-left">{{ $t('connectionDetail.back') }}</UButton>
          </EmptyState>
          <EmptyState
            v-else-if="!selected"
            icon="i-lucide-mouse-pointer-click"
            :title="$t('connectionDetail.pickCollection')"
            :description="$t('connectionDetail.pickCollectionHint')"
          />
          <div v-else-if="preview && visibleRows.length === 0" class="p-4">
            <EmptyState
              icon="i-lucide-inbox"
              :title="$t('connectionDetail.noRowsTitle')"
              :description="$t('connectionDetail.noRowsDescription')"
            />
          </div>
          <table v-else-if="preview" class="w-full text-xs">
            <thead class="sticky top-0 z-10 bg-elevated/90 text-left text-dimmed backdrop-blur">
              <tr>
                <th class="w-10 px-3 py-2 font-medium">#</th>
                <th v-for="column in columns" :key="column" class="whitespace-nowrap px-3 py-2 font-medium mono">
                  {{ column }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(row, index) in visibleRows"
                :key="index"
                class="cursor-pointer border-t border-default/50 align-top transition hover:bg-elevated/40"
                :class="{ 'bg-primary/10': selectedRow?.index === index }"
                @click="pickRow(index)"
              >
                <td class="px-3 py-1.5 text-dimmed">{{ index + 1 }}</td>
                <td v-for="column in columns" :key="column" class="max-w-[26rem] px-3 py-1.5">
                  <span v-if="isComplex(row[column])" class="mono text-primary">
                    {{ cellText(row[column]).slice(0, 120) }}…
                  </span>
                  <span v-else-if="row[column] === null || row[column] === undefined" class="text-dimmed">null</span>
                  <span v-else class="mono break-words">{{ cellText(row[column]) }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        </div>

        <!-- record detail of the picked row -->
        <aside
          v-if="selectedRow"
          class="flex min-h-0 w-full shrink-0 flex-col border-t border-default xl:w-96 xl:border-s xl:border-t-0"
        >
          <div class="flex shrink-0 items-start gap-2 border-b border-default px-4 py-3">
            <div class="min-w-0">
              <p class="text-[11px] font-semibold uppercase tracking-wide text-dimmed">
                {{ $t('connectionDetail.recordTitle') }}
              </p>
              <p class="mono truncate text-sm">
                {{ selected }} · #{{ selectedRow.index + 1 }}
              </p>
            </div>
            <UButton
              class="ms-auto"
              icon="i-lucide-x"
              color="neutral"
              variant="ghost"
              size="xs"
              square
              :aria-label="$t('connectionDetail.closeRecord')"
              @click="selectedRow = null"
            />
          </div>
          <div class="min-h-0 flex-1 overflow-auto scroll-thin px-4 py-3">
            <dl class="grid gap-3">
              <div v-for="field in detailFields" :key="field.name">
                <dt class="mono text-[11px] uppercase tracking-wide text-dimmed">{{ field.name }}</dt>
                <dd class="mt-1 text-xs">
                  <pre
                    v-if="isComplex(field.value)"
                    class="scroll-thin max-h-64 overflow-auto rounded-md bg-elevated/60 p-2 mono"
                  >{{ JSON.stringify(field.value, null, 2) }}</pre>
                  <span v-else-if="field.value === null || field.value === undefined" class="text-dimmed">null</span>
                  <span v-else class="mono break-words">{{ cellText(field.value) }}</span>
                </dd>
              </div>
            </dl>
          </div>
        </aside>
      </section>
    </div>
  </PageShell>
</template>
