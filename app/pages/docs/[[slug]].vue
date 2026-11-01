<script setup lang="ts">
import type { DocEntry } from '~/composables/useDocs'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const { docs, sections, sectionLabel, findDoc, search, neighbours } = useDocs()

const term = ref('')
const matching = computed(() => search(term.value))

const visibleSections = computed(() => {
  if (!term.value.trim()) return sections.value
  const allowed = new Set(matching.value.map((doc) => doc.slug))
  return sections.value
    .map((section) => ({ ...section, docs: section.docs.filter((doc) => allowed.has(doc.slug)) }))
    .filter((section) => section.docs.length > 0)
})

const slug = computed(() => String(route.params.slug ?? ''))
const active = computed<DocEntry | undefined>(() => findDoc(slug.value) ?? docs.value[0])
const links = computed(() => (active.value ? neighbours(active.value.slug) : {}))

watchEffect(() => {
  if (!slug.value && docs.value[0]) void router.replace(`/docs/${docs.value[0].slug}`)
})

const mobileItems = computed(() =>
  docs.value.map((doc) => ({ label: doc.title, value: doc.slug })),
)
const mobileSlug = computed({
  get: () => active.value?.slug ?? '',
  set: (value: string) => {
    if (value && value !== active.value?.slug) void router.push(`/docs/${value}`)
  },
})

useHead(() => ({
  title: active.value ? `${active.value.title} · ${t('docsPage.title')}` : t('docsPage.title'),
}))
</script>

<template>
  <PageShell
    id="docs"
    :title="$t('docsPage.title')"
    :description="$t('docsPage.description', { count: docs.length })"
  >
    <template #right>
      <USelectMenu
        v-model="mobileSlug"
        :items="mobileItems"
        value-key="value"
        class="w-56 lg:hidden"
        :placeholder="$t('docsPage.pickerPlaceholder')"
      />
      <UButton
        icon="i-lucide-book-open"
        color="neutral"
        variant="ghost"
        to="/docs"
        :aria-label="$t('docsPage.title')"
        class="hidden lg:inline-flex"
      />
    </template>

    <div class="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <aside class="hidden min-h-0 flex-col border-e border-default lg:flex">
        <div class="shrink-0 p-3">
          <UInput
            v-model="term"
            icon="i-lucide-search"
            :placeholder="$t('docsPage.searchPlaceholder')"
            size="sm"
            class="w-full"
          />
        </div>
        <nav class="scroll-thin min-h-0 flex-1 overflow-auto px-2 pb-4">
          <div v-for="section in visibleSections" :key="section.key" class="mb-4">
            <p class="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-dimmed">
              {{ sectionLabel(section.key) }}
            </p>
            <NuxtLink
              v-for="doc in section.docs"
              :key="doc.slug"
              :to="`/docs/${doc.slug}`"
              class="flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors"
              :class="
                doc.slug === active?.slug
                  ? 'bg-primary/12 text-primary'
                  : 'text-muted hover:bg-elevated hover:text-default'
              "
            >
              <UIcon
                :name="doc.slug === active?.slug ? 'i-lucide-file-text' : 'i-lucide-file'"
                class="mt-0.5 size-4 shrink-0"
              />
              <span class="min-w-0">
                <span class="block truncate">{{ doc.title }}</span>
                <span v-if="doc.description" class="block truncate text-[11px] text-dimmed">
                  {{ doc.description }}
                </span>
              </span>
            </NuxtLink>
          </div>
          <p v-if="visibleSections.length === 0" class="px-2 py-6 text-center text-xs text-muted">
            {{ $t('docsPage.empty', { term }) }}
          </p>
        </nav>
      </aside>

      <div class="scroll-thin min-h-0 overflow-auto">
        <article v-if="active" class="mx-auto w-full max-w-3xl px-4 py-6 sm:px-8">
          <div class="mb-6 border-b border-default pb-4">
            <p class="text-[11px] font-semibold uppercase tracking-wide text-primary">
              {{ sectionLabel(active.section) }}
            </p>
            <h1 class="mt-1 text-2xl font-semibold tracking-tight">{{ active.title }}</h1>
            <p v-if="active.description" class="mt-1 text-sm text-muted">{{ active.description }}</p>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <UBadge v-for="tag in active.tags" :key="tag" color="neutral" variant="subtle" size="sm">
                {{ tag }}
              </UBadge>
              <span v-if="active.updated" class="text-[11px] text-dimmed">
                {{ $t('docsPage.updated', { date: active.updated }) }}
              </span>
            </div>
          </div>

          <!-- Bundled markdown from app/docs/*.md, not user input. -->
          <div class="doc-body" v-html="active.html" />

          <div class="mt-8 grid gap-3 border-t border-default pt-4 sm:grid-cols-2">
            <NuxtLink
              v-if="links.previous"
              :to="`/docs/${links.previous.slug}`"
              class="panel flex flex-col gap-0.5 p-3 transition-colors hover:border-primary/50"
            >
              <span class="flex items-center gap-1 text-[11px] text-dimmed">
                <UIcon name="i-lucide-arrow-left" class="size-3" /> {{ $t('docsPage.previous') }}
              </span>
              <span class="truncate text-sm font-medium">{{ links.previous.title }}</span>
            </NuxtLink>
            <NuxtLink
              v-if="links.next"
              :to="`/docs/${links.next.slug}`"
              class="panel flex flex-col items-end gap-0.5 p-3 text-end transition-colors hover:border-primary/50 sm:col-start-2"
            >
              <span class="flex items-center gap-1 text-[11px] text-dimmed">
                {{ $t('docsPage.next') }} <UIcon name="i-lucide-arrow-right" class="size-3" />
              </span>
              <span class="truncate text-sm font-medium">{{ links.next.title }}</span>
            </NuxtLink>
          </div>
        </article>

        <div v-else class="p-8 text-sm text-muted">
          {{ $t('docsPage.noDocs') }} <code class="mono">app/docs/</code> {{ $t('docsPage.noDocsTail') }}
        </div>
      </div>
    </div>
  </PageShell>
</template>

<style scoped>
.doc-body {
  font-size: 0.875rem;
  line-height: 1.7;
}

.doc-body :deep(h1),
.doc-body :deep(h2),
.doc-body :deep(h3) {
  scroll-margin-top: 4rem;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.doc-body :deep(h1) {
  font-size: 1.35rem;
  margin: 1.5rem 0 0.75rem;
}

.doc-body :deep(h2) {
  font-size: 1.1rem;
  margin: 1.75rem 0 0.5rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--ui-border);
}

.doc-body :deep(h3) {
  font-size: 0.95rem;
  margin: 1.25rem 0 0.35rem;
}

.doc-body :deep(p),
.doc-body :deep(ul),
.doc-body :deep(ol) {
  margin: 0.6rem 0;
}

.doc-body :deep(ul),
.doc-body :deep(ol) {
  padding-inline-start: 1.15rem;
}

.doc-body :deep(ul) {
  list-style: disc;
}

.doc-body :deep(ol) {
  list-style: decimal;
}

.doc-body :deep(li) {
  margin: 0.15rem 0;
}

.doc-body :deep(li)::marker {
  color: var(--ui-text-dimmed);
}

.doc-body :deep(a) {
  color: var(--ui-primary);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.doc-body :deep(strong) {
  color: var(--ui-text-highlighted);
  font-weight: 600;
}

.doc-body :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  padding: 0.1rem 0.35rem;
  border-radius: 0.35rem;
  background: var(--ui-bg-elevated);
  border: 1px solid var(--ui-border);
}

.doc-body :deep(pre) {
  margin: 0.75rem 0;
  padding: 0.85rem 1rem;
  border-radius: 0.65rem;
  overflow-x: auto;
  background: var(--ui-bg-elevated);
  border: 1px solid var(--ui-border);
}

.doc-body :deep(pre code) {
  padding: 0;
  border: 0;
  background: transparent;
  font-size: 0.8125rem;
  line-height: 1.55;
}

.doc-body :deep(blockquote) {
  margin: 0.75rem 0;
  padding: 0.5rem 0.9rem;
  border-inline-start: 3px solid var(--ui-primary);
  border-radius: 0.35rem;
  background: color-mix(in oklab, var(--ui-primary) 8%, transparent);
  color: var(--ui-text-muted);
}

.doc-body :deep(table) {
  width: 100%;
  margin: 0.85rem 0;
  border-collapse: collapse;
  font-size: 0.8125rem;
}

.doc-body :deep(th),
.doc-body :deep(td) {
  border: 1px solid var(--ui-border);
  padding: 0.4rem 0.6rem;
  text-align: start;
  vertical-align: top;
}

.doc-body :deep(th) {
  background: var(--ui-bg-elevated);
  font-weight: 600;
}

.doc-body :deep(hr) {
  margin: 1.5rem 0;
  border: 0;
  border-top: 1px solid var(--ui-border);
}
</style>
