<script setup lang="ts">
defineProps<{
  label: string
  value: string | number
  icon: string
  hint?: string
  to?: string
}>()
</script>

<template>
  <component
    :is="to ? 'NuxtLink' : 'div'"
    :to="to"
    class="panel flex flex-col gap-2 p-4 transition hover:border-primary/40"
  >
    <div class="flex items-center justify-between">
      <span class="text-xs font-medium uppercase tracking-wide text-muted">{{ label }}</span>
      <UIcon :name="icon" class="size-4 text-dimmed" />
    </div>
    <p class="text-2xl font-semibold text-highlighted">{{ value }}</p>
    <p v-if="hint" class="text-xs text-muted">{{ hint }}</p>
  </component>
</template>
