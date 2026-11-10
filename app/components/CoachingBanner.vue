<template>
  <!--
    Mounted exactly once, from `app/app.vue`, above the router outlet — so the
    exit affordance is reachable on every page, and never renders twice stacked
    on top of itself (CW-541).
  -->
  <div>
    <div
      v-if="coachingStore.isCoachingMode"
      role="status"
      class="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] max-w-[calc(100vw-2rem)] bg-primary-600 text-white py-2 px-4 rounded-full shadow-xl flex items-center gap-4 border border-white/20 whitespace-nowrap"
    >
      <div class="flex items-center gap-2 text-sm font-medium min-w-0">
        <UIcon name="i-heroicons-eye" class="w-5 h-5 shrink-0" />
        <span class="truncate">
          {{ tCommon('coaching_banner_active', { name: coachingStore.actingAsUserName }) }}
        </span>
      </div>
      <div class="flex items-center gap-4">
        <UButton
          color="neutral"
          variant="solid"
          size="xs"
          class="shrink-0"
          :label="tCommon('banner_exit')"
          :aria-label="t('act_as_exit_aria', { name: coachingStore.actingAsUserName ?? '' })"
          @click="
            () => {
              coachingStore.stopActingAs()
            }
          "
        />
      </div>
    </div>

    <UModal
      :open="coachingStore.hasPendingActAsRequest"
      :title="t('act_as_confirm_title', { name: pendingName })"
      :description="t('act_as_confirm_description', { name: pendingName })"
      @update:open="
        (open) => {
          if (!open) coachingStore.cancelActingAs()
        }
      "
    >
      <template #body>
        <ul class="space-y-2 p-4 text-sm text-muted">
          <li class="flex items-start gap-2">
            <UIcon name="i-heroicons-eye" class="w-4 h-4 mt-0.5 shrink-0" />
            <span>{{ t('act_as_confirm_point_view', { name: pendingName }) }}</span>
          </li>
          <li class="flex items-start gap-2">
            <UIcon name="i-heroicons-arrow-path" class="w-4 h-4 mt-0.5 shrink-0" />
            <span>{{ t('act_as_confirm_point_persists') }}</span>
          </li>
          <li class="flex items-start gap-2">
            <UIcon name="i-heroicons-arrow-left-on-rectangle" class="w-4 h-4 mt-0.5 shrink-0" />
            <span>{{ t('act_as_confirm_point_exit') }}</span>
          </li>
        </ul>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            :label="t('act_as_confirm_cancel')"
            @click="
              () => {
                coachingStore.cancelActingAs()
              }
            "
          />
          <UButton
            color="primary"
            :label="t('act_as_confirm_submit', { name: pendingName })"
            @click="
              () => {
                coachingStore.confirmActingAs()
              }
            "
          />
        </div>
      </template>
    </UModal>
  </div>
</template>

<script setup lang="ts">
  import { useTranslate } from '@tolgee/vue'

  const { t: tCommon } = useTranslate('common')
  const { t } = useTranslate('coaching')
  const coachingStore = useCoachingStore()

  const pendingName = computed(() => coachingStore.pendingActAs?.userName ?? '')
</script>
