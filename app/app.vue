<script setup lang="ts">
const { t, locale } = useI18n()

useHead(() => ({
  titleTemplate: (title?: string) => (title ? t('app.titleTemplate', { title }) : t('app.title')),
  htmlAttrs: { lang: locale.value },
}))
</script>

<template>
  <UApp>
    <NuxtLoadingIndicator />
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
