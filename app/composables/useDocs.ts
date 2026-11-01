import { marked } from 'marked'

/**
 * Documentation centre.
 *
 * Every article lives in `app/docs/<locale>/*.md` with a small frontmatter block,
 * so adding a page later is: drop a file in both folders, no route or menu edit:
 *
 *   ---
 *   title: Exporting data
 *   description: One sentence
 *   section: data          # i18n key under docsPage.sections.*
 *   order: 3
 *   ---
 *
 * Slugs are shared across locales (`/docs/exporting` is the same article in both
 * languages), which keeps deep links stable when the user switches language.
 *
 * The markdown is bundled at build time from this repository, never user input,
 * which is why rendering it with `v-html` is acceptable.
 */
export interface DocEntry {
  slug: string
  locale: string
  title: string
  description: string
  /** i18n key under `docsPage.sections`. */
  section: string
  order: number
  updated?: string
  tags: string[]
  body: string
  html: string
}

export interface DocSection {
  key: string
  docs: DocEntry[]
}

export const DOC_LOCALES = ['en', 'vi'] as const
export type DocLocale = (typeof DOC_LOCALES)[number]
const FALLBACK_LOCALE: DocLocale = 'en'

const sources = import.meta.glob('../docs/*/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

marked.setOptions({ gfm: true, breaks: false })

function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const normalised = raw.replace(/\r\n/g, '\n')
  if (!normalised.startsWith('---\n')) return { data: {}, body: normalised }
  const end = normalised.indexOf('\n---', 4)
  if (end === -1) return { data: {}, body: normalised }

  const block = normalised.slice(4, end)
  const body = normalised.slice(end + 4).replace(/^\n+/, '')
  const data: Record<string, string> = {}
  for (const line of block.split('\n')) {
    const separator = line.indexOf(':')
    if (separator === -1) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, '')
    if (key) data[key] = value
  }
  return { data, body }
}

function toTags(value: string | undefined): string[] {
  if (!value) return []
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
}

function parse(path: string, raw: string): DocEntry {
  const { data, body } = parseFrontmatter(raw)
  // '../docs/en/exporting.md' → locale 'en', slug 'exporting'
  const [, locale = FALLBACK_LOCALE, file = path] = path.match(/\/([^/]+)\/([^/]+)\.md$/) ?? []
  const slug = file.replace(/\.md$/, '')
  return {
    slug,
    locale,
    title: data.title ?? slug,
    description: data.description ?? '',
    section: data.section ?? 'other',
    order: Number(data.order ?? 999),
    updated: data.updated,
    tags: toTags(data.tags),
    body,
    html: marked.parse(body) as string,
  }
}

const byLocale = new Map<string, DocEntry[]>()
for (const [path, raw] of Object.entries(sources)) {
  const doc = parse(path, raw)
  const bucket = byLocale.get(doc.locale) ?? []
  bucket.push(doc)
  byLocale.set(doc.locale, bucket)
}
for (const docs of byLocale.values()) docs.sort((a, b) => a.order - b.order)

function localeDocs(locale: string): DocEntry[] {
  return byLocale.get(locale) ?? byLocale.get(FALLBACK_LOCALE) ?? []
}

function groupBySection(docs: DocEntry[]): DocSection[] {
  const sections = new Map<string, DocEntry[]>()
  for (const doc of docs) {
    const bucket = sections.get(doc.section) ?? []
    bucket.push(doc)
    sections.set(doc.section, bucket)
  }
  return [...sections.entries()].map(([key, entries]) => ({ key, docs: entries }))
}

export function useDocs() {
  const { locale, t } = useI18n()

  const currentLocale = computed<DocLocale>(() =>
    (DOC_LOCALES as readonly string[]).includes(locale.value)
      ? (locale.value as DocLocale)
      : FALLBACK_LOCALE,
  )

  const docs = computed<DocEntry[]>(() => localeDocs(currentLocale.value))
  const sections = computed<DocSection[]>(() => groupBySection(docs.value))
  const sectionLabel = (key: string) => t(`docsPage.sections.${key}`)

  function findDoc(slug: string | undefined | null): DocEntry | undefined {
    if (!slug) return undefined
    return docs.value.find((doc) => doc.slug === slug)
  }

  function search(term: string): DocEntry[] {
    const needle = term.trim().toLowerCase()
    if (!needle) return docs.value
    return docs.value.filter((doc) =>
      [doc.title, doc.description, doc.tags.join(' '), doc.body]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    )
  }

  function neighbours(slug: string): { previous?: DocEntry; next?: DocEntry } {
    const index = docs.value.findIndex((doc) => doc.slug === slug)
    if (index === -1) return {}
    return { previous: docs.value[index - 1], next: docs.value[index + 1] }
  }

  return {
    docs,
    sections,
    sectionLabel,
    findDoc,
    search,
    neighbours,
    first: computed(() => docs.value[0]),
  }
}
