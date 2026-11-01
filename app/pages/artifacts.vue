<script setup lang="ts">
import type { Artifact } from '~/types'

const api = useApi()
const toast = useToast()
const reportError = useApiToast()
const { t } = useI18n()

const artifacts = ref<Artifact[]>([])
const loading = ref(true)
const verifyingId = ref<string | null>(null)
const detail = ref<Artifact | null>(null)
const deleteTarget = ref<Artifact | null>(null)
const showPrune = ref(false)
const pruneDays = ref(30)
const pruneKeep = ref(3)
const pruneDryRun = ref(true)
const pruneResult = ref<{ deleted: Artifact[]; kept: number; skipped_reasons: string[] } | null>(null)
const pruning = ref(false)

async function load() {
  try {
    artifacts.value = await api.get<Artifact[]>('/artifacts?limit=200')
  } catch (error) {
    reportError(error, t('artifactsPage.loadFailed'))
  } finally {
    loading.value = false
  }
}

onMounted(load)

async function verify(artifact: Artifact) {
  verifyingId.value = artifact.id
  try {
    const result = await api.post<{ valid: boolean; artifact: Artifact }>(`/artifacts/${artifact.id}/verify`)
    toast.add({
      title: result.valid ? t('artifactsPage.verifiedTitle') : t('artifactsPage.mismatchTitle'),
      description: result.valid ? artifact.absolute_path : t('artifactsPage.mismatchDescription'),
      color: result.valid ? 'success' : 'error',
      icon: result.valid ? 'i-lucide-shield-check' : 'i-lucide-shield-x',
    })
    await load()
    if (detail.value?.id === artifact.id) detail.value = artifacts.value.find((item) => item.id === artifact.id) ?? null
  } catch (error) {
    reportError(error, t('artifactsPage.verifyFailed'))
  } finally {
    verifyingId.value = null
  }
}

async function togglePin(artifact: Artifact) {
  try {
    await api.post(`/artifacts/${artifact.id}/pin`, { pinned: !artifact.pinned })
    await load()
    toast.add({
      title: artifact.pinned ? t('artifactsPage.unpinnedTitle') : t('artifactsPage.pinnedTitle'),
      description: t('artifactsPage.pinDescription'),
      color: 'success',
      icon: 'i-lucide-pin',
    })
  } catch (error) {
    reportError(error, t('artifactsPage.pinFailed'))
  }
}

async function remove() {
  if (!deleteTarget.value) return
  try {
    await api.del(`/artifacts/${deleteTarget.value.id}`)
    toast.add({ title: t('artifactsPage.deleted'), color: 'success', icon: 'i-lucide-trash-2' })
    deleteTarget.value = null
    detail.value = null
    await load()
  } catch (error) {
    reportError(error, t('artifactsPage.deleteFailed'))
  }
}

async function prune() {
  pruning.value = true
  try {
    pruneResult.value = await api.post<{ deleted: Artifact[]; kept: number; skipped_reasons: string[] }>('/artifacts/prune', {
      older_than_days: Number(pruneDays.value),
      keep_last: Number(pruneKeep.value),
      dry_run: pruneDryRun.value,
    })
    toast.add({
      title: pruneDryRun.value ? t('artifactsPage.prunePreview') : t('artifactsPage.retentionApplied'),
      description: t('artifactsPage.pruneSummaryDescription', {
        count: pruneResult.value.deleted.length,
        action: pruneDryRun.value ? t('artifactsPage.wouldBeDeleted') : t('artifactsPage.wereDeleted'),
      }),
      color: 'success',
      icon: 'i-lucide-brush',
    })
    if (!pruneDryRun.value) await load()
  } catch (error) {
    reportError(error, t('artifactsPage.pruneFailed'))
  } finally {
    pruning.value = false
  }
}

const totalBytes = computed(() => artifacts.value.reduce((sum, artifact) => sum + artifact.size_bytes, 0))
</script>

<template>
  <PageShell
    id="artifacts"
    :title="$t('artifactsPage.title')"
    :description="$t('artifactsPage.description', { count: artifacts.length, size: formatBytes(totalBytes) })"
  >
    <template #right>
      <UButton icon="i-lucide-brush" color="neutral" variant="soft" @click="showPrune = true">{{ $t('artifactsPage.retention') }}</UButton>
      <UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" square :aria-label="$t('common.refresh')" @click="load" />
    </template>

    <div class="flex-1 overflow-auto scroll-thin p-4 sm:p-6">
      <div v-if="loading" class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" /> {{ $t('artifactsPage.loading') }}
      </div>

      <EmptyState
        v-else-if="artifacts.length === 0"
        icon="i-lucide-package"
        :title="$t('artifactsPage.emptyTitle')"
        :description="$t('artifactsPage.emptyDescription')"
      >
        <UButton to="/export" icon="i-lucide-arrow-up-from-line">{{ $t('artifactsPage.emptyAction') }}</UButton>
      </EmptyState>

      <div v-else class="panel overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-elevated/60 text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th class="px-4 py-3 font-medium">{{ $t('artifactsPage.colArtifact') }}</th>
              <th class="hidden px-4 py-3 font-medium md:table-cell">{{ $t('artifactsPage.colResource') }}</th>
              <th class="px-4 py-3 font-medium">{{ $t('artifactsPage.colRows') }}</th>
              <th class="px-4 py-3 font-medium">{{ $t('artifactsPage.colSize') }}</th>
              <th class="hidden px-4 py-3 font-medium sm:table-cell">{{ $t('artifactsPage.colChecksum') }}</th>
              <th class="px-4 py-3 font-medium">{{ $t('artifactsPage.colCreated') }}</th>
              <th class="px-4 py-3 text-right font-medium">{{ $t('artifactsPage.colActions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="artifact in artifacts" :key="artifact.id" class="border-t border-default/60 hover:bg-elevated/40">
              <td class="px-4 py-3">
                <button class="flex items-center gap-2 text-left" @click="detail = artifact">
                  <UIcon name="i-lucide-package" class="size-4 shrink-0 text-dimmed" />
                  <span class="min-w-0">
                    <span class="mono block truncate text-xs">{{ shortId(artifact.id) }}</span>
                    <span class="block text-xs text-muted">{{ artifact.provider_id }} · {{ artifact.manifest.format }}{{ artifact.manifest.compression === 'gzip' ? '.gz' : '' }}</span>
                  </span>
                </button>
              </td>
              <td class="hidden max-w-48 truncate px-4 py-3 md:table-cell">{{ artifact.manifest.resource ?? '—' }}</td>
              <td class="px-4 py-3">{{ formatNumber(artifact.manifest.row_count) }}</td>
              <td class="px-4 py-3">{{ formatBytes(artifact.size_bytes) }}</td>
              <td class="hidden px-4 py-3 sm:table-cell">
                <div class="flex items-center gap-2">
                  <StatusBadge :status="artifact.verification_status" />
                  <UIcon v-if="artifact.pinned" name="i-lucide-pin" class="size-3.5 text-primary" />
                </div>
              </td>
              <td class="whitespace-nowrap px-4 py-3 text-xs text-muted">{{ formatRelative(artifact.created_at) }}</td>
              <td class="px-4 py-3">
                <div class="flex justify-end gap-1">
                  <UTooltip :text="$t('artifactsPage.verify')">
                    <UButton icon="i-lucide-shield-check" color="neutral" variant="ghost" size="sm" square :loading="verifyingId === artifact.id" :aria-label="$t('artifactsPage.verifyShort')" @click="verify(artifact)" />
                  </UTooltip>
                  <UTooltip :text="artifact.pinned ? $t('artifactsPage.unpin') : $t('artifactsPage.pin')">
                    <UButton :icon="artifact.pinned ? 'i-lucide-pin-off' : 'i-lucide-pin'" color="neutral" variant="ghost" size="sm" square :aria-label="artifact.pinned ? $t('artifactsPage.unpin') : $t('artifactsPage.pin')" @click="togglePin(artifact)" />
                  </UTooltip>
                  <UTooltip :text="$t('artifactsPage.deleteTooltip')">
                    <UButton icon="i-lucide-trash-2" color="error" variant="ghost" size="sm" square :aria-label="$t('common.delete')" @click="deleteTarget = artifact" />
                  </UTooltip>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <USlideover :open="Boolean(detail)" :title="detail ? $t('artifactsPage.detailTitle', { id: shortId(detail.id) }) : $t('artifactsPage.detailFallback')" @update:open="(value) => { if (!value) detail = null }">
      <template #body>
        <div v-if="detail" class="grid gap-4 text-sm">
          <div class="flex flex-wrap items-center gap-2">
            <StatusBadge :status="detail.verification_status" />
            <UBadge color="neutral" variant="subtle" size="sm">{{ detail.manifest.format }}</UBadge>
            <UBadge color="neutral" variant="subtle" size="sm">{{ detail.manifest.compression }}</UBadge>
            <UBadge v-if="detail.pinned" color="primary" variant="subtle" size="sm">{{ $t('common.pinned') }}</UBadge>
          </div>

          <dl class="grid gap-2 text-xs">
            <div class="flex justify-between gap-3">
              <dt class="text-muted">{{ $t('common.rows') }}</dt>
              <dd>{{ formatNumber(detail.manifest.row_count) }}</dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-muted">{{ $t('common.size') }}</dt>
              <dd>{{ formatBytes(detail.size_bytes) }}</dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-muted">{{ $t('artifactsPage.provider') }}</dt>
              <dd>{{ detail.manifest.provider_id }}{{ detail.manifest.service_profile ? ` / ${detail.manifest.service_profile}` : '' }}</dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-muted">{{ $t('artifactsPage.source') }}</dt>
              <dd>{{ detail.manifest.source_label ?? '—' }}</dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-muted">{{ $t('artifactsPage.colCreated') }}</dt>
              <dd>{{ formatDateTime(detail.created_at) }}</dd>
            </div>
            <div class="flex justify-between gap-3">
              <dt class="text-muted">{{ $t('artifactsPage.outputMode') }}</dt>
              <dd>{{ detail.manifest.output_mode ?? $t('artifactsPage.managed') }}</dd>
            </div>
          </dl>

          <div>
            <p class="mb-1 text-xs text-muted">{{ $t('artifactsPage.file') }}</p>
            <p class="mono break-all rounded-lg bg-elevated/60 p-2 text-[11px]">{{ detail.absolute_path }}</p>
          </div>

          <div>
            <p class="mb-1 text-xs text-muted">SHA-256</p>
            <p class="mono break-all rounded-lg bg-elevated/60 p-2 text-[11px]">{{ detail.checksum_value }}</p>
          </div>

          <div>
            <p class="mb-1 text-xs text-muted">{{ $t('artifactsPage.columns', { count: detail.manifest.columns.length }) }}</p>
            <div class="grid gap-1 rounded-lg border border-default p-2">
              <div v-for="column in detail.manifest.columns" :key="column.name" class="flex items-center justify-between text-xs">
                <span class="mono truncate">{{ column.name }}</span>
                <span class="text-muted">{{ column.type }}</span>
              </div>
            </div>
          </div>

          <div v-if="detail.manifest.warnings.length" class="rounded-lg bg-warning/10 p-2 text-xs text-warning">
            <p v-for="warning in detail.manifest.warnings" :key="warning">• {{ warning }}</p>
          </div>

          <div class="flex flex-wrap gap-2">
            <UButton size="sm" icon="i-lucide-arrow-down-to-line" @click="navigateTo(`/import?artifact=${detail.id}`)">{{ $t('artifactsPage.importAction') }}</UButton>
            <UButton size="sm" icon="i-lucide-shield-check" color="neutral" variant="soft" :loading="verifyingId === detail.id" @click="verify(detail)">{{ $t('artifactsPage.verifyShort') }}</UButton>
            <UButton size="sm" :icon="detail.pinned ? 'i-lucide-pin-off' : 'i-lucide-pin'" color="neutral" variant="ghost" @click="togglePin(detail)">
              {{ detail.pinned ? $t('artifactsPage.unpin') : $t('artifactsPage.pin') }}
            </UButton>
          </div>
        </div>
      </template>
    </USlideover>

    <UModal :open="Boolean(deleteTarget)" :title="$t('artifactsPage.deleteTitle')" @update:open="(value) => { if (!value) deleteTarget = null }">
      <template #body>
        <p class="text-sm text-muted">
          {{ $t('artifactsPage.deleteBody', { path: deleteTarget?.absolute_path ?? '' }) }}
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="deleteTarget = null">{{ $t('common.cancel') }}</UButton>
          <UButton color="error" icon="i-lucide-trash-2" @click="remove">{{ $t('common.delete') }}</UButton>
        </div>
      </template>
    </UModal>

    <UModal
      v-model:open="showPrune"
      :title="$t('artifactsPage.pruneTitle')"
      :description="$t('artifactsPage.pruneDescription')"
    >
      <template #body>
        <div class="grid gap-4">
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField :label="$t('artifactsPage.olderThan')">
              <UInput v-model.number="pruneDays" type="number" min="0" class="w-full" />
            </UFormField>
            <UFormField :label="$t('artifactsPage.keepNewest')">
              <UInput v-model.number="pruneKeep" type="number" min="0" class="w-full" />
            </UFormField>
          </div>
          <div class="flex items-center gap-3">
            <USwitch v-model="pruneDryRun" />
            <div>
              <p class="text-sm">{{ $t('artifactsPage.previewOnly') }}</p>
              <p class="text-xs text-muted">{{ $t('artifactsPage.previewOnlyHint') }}</p>
            </div>
          </div>
          <div v-if="pruneResult" class="rounded-lg border border-default p-3 text-xs">
            <p class="mb-1 font-medium">
              {{ $t('artifactsPage.pruneSummary', {
                label: pruneDryRun ? $t('artifactsPage.wouldDelete') : $t('artifactsPage.deletedLabel'),
                count: pruneResult.deleted.length,
                kept: pruneResult.kept,
              }) }}
            </p>
            <p v-for="artifact in pruneResult.deleted" :key="artifact.id" class="mono text-muted">
              {{ shortId(artifact.id) }} · {{ artifact.manifest.resource }} · {{ formatBytes(artifact.size_bytes) }}
            </p>
            <p v-for="reason in pruneResult.skipped_reasons" :key="reason" class="text-warning">{{ reason }}</p>
          </div>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="showPrune = false">{{ $t('common.close') }}</UButton>
          <UButton :loading="pruning" :color="pruneDryRun ? 'primary' : 'error'" icon="i-lucide-brush" @click="prune">
            {{ pruneDryRun ? $t('artifactsPage.preview') : $t('artifactsPage.applyCleanup') }}
          </UButton>
        </div>
      </template>
    </UModal>
  </PageShell>
</template>
