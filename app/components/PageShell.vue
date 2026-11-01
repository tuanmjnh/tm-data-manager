<script setup lang="ts">
const props = defineProps<{
  id: string
  title: string
  description?: string
}>()

const panelUi = {
  root: 'min-h-full',
}

const navbarUi = {
  root: 'bg-elevated/40 backdrop-blur-xl',
  title: props.description ? 'flex flex-col items-start justify-center gap-px h-full truncate' : undefined,
}

useHead(() => ({ title: props.title }))
</script>

<template>
  <UDashboardPanel :id="id" :ui="panelUi">
    <template #header>
      <div class="shrink-0">
        <UDashboardNavbar :title="title" :ui="navbarUi">
          <template v-if="description" #title>
            <span class="truncate font-semibold">{{ title }}</span>
            <span class="truncate text-xs font-normal text-muted">{{ description }}</span>
          </template>
          <template #leading>
            <slot name="leading">
              <UDashboardSidebarCollapse />
            </slot>
          </template>
          <template #right>
            <div class="flex items-center gap-2">
              <slot name="right" />
            </div>
          </template>
        </UDashboardNavbar>
        <slot name="toolbar" />
      </div>
    </template>

    <template #body>
      <div class="flex min-h-0 flex-1 flex-col">
        <slot />
      </div>
    </template>

    <template #footer>
      <div v-if="$slots.footer" class="hidden shrink-0 border-t border-default bg-elevated/50 px-4 py-2 backdrop-blur-md sm:block">
        <slot name="footer" />
      </div>
    </template>
  </UDashboardPanel>
</template>
