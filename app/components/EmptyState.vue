<script setup lang="ts">
defineProps<{ icon?: string; title: string; description?: string }>()
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-default px-6 py-12 text-center">
    <UIcon :name="icon ?? 'i-lucide-inbox'" class="size-8 text-dimmed" />
    <p class="font-medium text-highlighted">{{ title }}</p>
    <p v-if="description" class="max-w-md text-sm text-muted">{{ description }}</p>
    <div v-if="$slots.default" class="mt-2">
      <slot />
    </div>
  </div>
</template>
