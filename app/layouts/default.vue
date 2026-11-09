<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'
import type { Health } from '~/types'

const api = useApi()
const route = useRoute()
const colorMode = useColorMode()
const { t, locale, locales, setLocale } = useI18n()
const health = ref<Health | null>(null)
const open = ref(false)

let timer: ReturnType<typeof setInterval> | undefined
async function loadHealth() {
  try {
    health.value = await api.get<Health>('/health')
  } catch {
    health.value = null
  }
}
onMounted(() => {
  void loadHealth()
  timer = setInterval(loadHealth, 5000)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})

const languageItems = computed(() =>
  (locales.value as Array<{ code: string; name: string }>).map((item) => ({
    label: item.name,
    value: item.code,
    icon: locale.value === item.code ? 'i-lucide-check' : undefined,
    onSelect: () => setLocale(item.code),
  })),
)

const links = computed<NavigationMenuItem[][]>(() => [
  [
    { label: t('nav.overview'), icon: 'i-lucide-layout-dashboard', to: '/', active: route.path === '/' },
    { label: t('nav.connections'), icon: 'i-lucide-cable', to: '/connections', active: route.path.startsWith('/connections') },
  ],
  [
    { label: t('nav.export'), icon: 'i-lucide-arrow-up-from-line', to: '/export', active: route.path === '/export' },
    { label: t('nav.import'), icon: 'i-lucide-arrow-down-to-line', to: '/import', active: route.path === '/import' },
    { label: t('nav.artifacts'), icon: 'i-lucide-package', to: '/artifacts', active: route.path === '/artifacts' },
    { label: t('nav.storage'), icon: 'i-lucide-hard-drive', to: '/storage', active: route.path === '/storage' },
  ],
  [
    { label: t('nav.operations'), icon: 'i-lucide-activity', to: '/operations', active: route.path.startsWith('/operations') },
    { label: t('nav.schedules'), icon: 'i-lucide-calendar-clock', to: '/schedules', active: route.path === '/schedules' },
  ],
  [
    { label: t('nav.system'), icon: 'i-lucide-settings-2', to: '/system', active: route.path === '/system' },
    { label: t('nav.docs'), icon: 'i-lucide-book-open', to: '/docs', active: route.path.startsWith('/docs') },
  ],
])

const workerState = computed(() => {
  if (!health.value) return { label: t('worker.apiOffline'), color: 'error', icon: 'i-lucide-plug-zap' }
  if (health.value.worker.running) return { label: t('worker.running'), color: 'success', icon: 'i-lucide-circle-play' }
  return { label: t('worker.stopped'), color: 'neutral', icon: 'i-lucide-circle-pause' }
})
</script>

<template>
  <UDashboardGroup unit="rem">
    <div class="udmt-backdrop" />

    <UDashboardSidebar
      id="udmt-sidebar"
      v-model:open="open"
      collapsible
      resizable
      class="border-e border-default bg-elevated/55 backdrop-blur-2xl"
    >
      <template #header="{ collapsed }">
        <NuxtLink to="/" class="flex items-center gap-2 overflow-hidden">
          <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <UIcon name="i-lucide-database-zap" class="size-5" />
          </span>
          <span v-if="!collapsed" class="min-w-0">
            <span class="block truncate text-sm font-semibold leading-tight">{{ $t('app.name') }}</span>
            <span class="block truncate text-[11px] text-muted">{{ $t('app.tagline') }}</span>
          </span>
        </NuxtLink>
      </template>

      <template #default="{ collapsed }">
        <UNavigationMenu
          v-for="(group, index) in links"
          :key="index"
          :collapsed="collapsed"
          :items="group"
          orientation="vertical"
          :tooltip="collapsed"
          class="mb-2"
        />
      </template>

      <template #footer="{ collapsed }">
        <div class="flex flex-col gap-2">
          <div
            v-if="!collapsed"
            class="flex items-center gap-2 rounded-lg border border-default/70 px-2.5 py-2 text-xs"
          >
            <span
              class="size-2 rounded-full"
              :class="{
                'bg-success animate-pulse': workerState.color === 'success',
                'bg-error': workerState.color === 'error',
                'bg-dimmed': workerState.color === 'neutral',
              }"
            />
            <span class="truncate text-muted">{{ workerState.label }}</span>
            <UTooltip v-if="health" :text="`${health.counts.runs} runs · ${health.counts.artifacts} artifacts`">
              <UIcon name="i-lucide-info" class="ms-auto size-3.5 text-dimmed" />
            </UTooltip>
          </div>
          <UDropdownMenu :items="languageItems" :content="{ align: 'start' }">
            <UButton
              icon="i-lucide-languages"
              color="neutral"
              variant="ghost"
              :block="!collapsed"
              :square="collapsed"
              :aria-label="$t('common.language')"
            >
              <span v-if="!collapsed" class="text-xs">{{ $t('common.language') }}</span>
            </UButton>
          </UDropdownMenu>
          <UButton
            :icon="colorMode.value === 'dark' ? 'i-lucide-sun' : 'i-lucide-moon'"
            color="neutral"
            variant="ghost"
            :block="!collapsed"
            :square="collapsed"
            :aria-label="colorMode.value === 'dark' ? $t('common.switchToLight') : $t('common.switchToDark')"
            @click="colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'"
          >
            <span v-if="!collapsed" class="text-xs">{{ colorMode.value === 'dark' ? $t('common.lightMode') : $t('common.darkMode') }}</span>
          </UButton>
        </div>
      </template>
    </UDashboardSidebar>

    <slot />
  </UDashboardGroup>
</template>
