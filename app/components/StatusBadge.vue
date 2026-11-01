<script setup lang="ts">
const props = defineProps<{ status: string; size?: 'sm' | 'md' }>()

const { t, te } = useI18n()

const config = computed(() => {
  const status = props.status
  if (['completed', 'verified', 'success', 'ok', 'running'].includes(status)) {
    return { color: 'success' as const, icon: 'i-lucide-circle-check' }
  }
  if (['completed_with_warnings', 'cancelled', 'cancel_requested', 'stale', 'unverified', 'warning'].includes(status)) {
    return { color: 'warning' as const, icon: 'i-lucide-triangle-alert' }
  }
  if (['failed', 'interrupted', 'crashed', 'error'].includes(status)) {
    return { color: 'error' as const, icon: 'i-lucide-circle-x' }
  }
  if (['queued', 'preparing', 'preflight', 'finalizing', 'verifying', 'starting', 'stopping'].includes(status)) {
    return { color: 'info' as const, icon: 'i-lucide-loader-circle' }
  }
  return { color: 'neutral' as const, icon: 'i-lucide-circle' }
})

const label = computed(() => {
  const key = `status.${props.status}`
  return te(key) ? t(key) : props.status.replaceAll('_', ' ')
})
</script>

<template>
  <UBadge :color="config.color" variant="subtle" :size="size ?? 'sm'" class="capitalize">
    <UIcon :name="config.icon" class="size-3.5" />
    {{ label }}
  </UBadge>
</template>
