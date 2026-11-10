<template>
  <div class="min-h-screen bg-neutral-50 dark:bg-neutral-950 flex items-center justify-center p-4">
    <UCard class="w-full max-w-md">
      <div v-if="loadingApp" class="py-12 flex flex-col items-center gap-4">
        <UIcon name="i-heroicons-arrow-path" class="w-10 h-10 animate-spin text-primary" />
        <p class="text-sm text-gray-500 font-medium">Loading...</p>
      </div>

      <div v-else class="space-y-6">
        <!-- App Identity -->
        <div class="flex flex-col items-center gap-4 text-center">
          <div class="flex items-center gap-3">
            <img src="/media/logo.webp" alt="Coach Watts" class="size-10 object-contain" />
            <UIcon name="i-heroicons-plus" class="text-gray-400 w-4 h-4" />
            <UAvatar
              :src="app?.logoUrl || undefined"
              :alt="app?.name || 'App'"
              size="lg"
              icon="i-heroicons-cube"
            />
          </div>
          <div>
            <h1 class="text-xl font-bold text-gray-900 dark:text-white">Sign in to Coach Watts</h1>
            <p v-if="app" class="text-sm text-gray-500 dark:text-gray-400 mt-1 font-medium">
              to continue to
              <span class="text-gray-900 dark:text-white font-bold">{{ app.name }}</span>
            </p>
          </div>
        </div>

        <USeparator />

        <div
          v-if="providerErrorMessage"
          role="alert"
          class="rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900/60 dark:bg-red-950/30"
        >
          <div class="flex items-start gap-3">
            <UIcon
              name="i-heroicons-exclamation-circle"
              class="mt-0.5 size-5 shrink-0 text-red-600 dark:text-red-400"
            />
            <div>
              <p class="text-sm font-bold text-red-900 dark:text-red-100">
                Sign-in could not be completed
              </p>
              <p class="mt-1 text-xs leading-relaxed text-red-700 dark:text-red-300">
                {{ providerErrorMessage }}
              </p>
            </div>
          </div>
        </div>

        <!-- Current User (if logged in) -->
        <div v-if="status === 'authenticated' && user" class="space-y-4">
          <div
            class="p-4 bg-primary-50 dark:bg-primary-900/10 rounded-xl border border-primary-100 dark:border-primary-900/20"
          >
            <p
              class="text-xs font-bold text-primary-600 dark:text-primary-400 uppercase tracking-wider mb-3"
            >
              Currently signed in as:
            </p>
            <div class="flex items-center gap-3">
              <UAvatar :src="user.image || undefined" :alt="user.name || undefined" size="md" />
              <div class="flex flex-col min-w-0">
                <p class="text-sm font-bold text-gray-900 dark:text-white truncate">
                  {{ user.name }}
                </p>
                <p class="text-xs text-gray-500 dark:text-gray-400 truncate">{{ user.email }}</p>
              </div>
            </div>
          </div>

          <div class="flex flex-col gap-3">
            <UButton
              label="Continue with this account"
              color="primary"
              block
              size="lg"
              class="font-bold"
              @click="
                () => {
                  void navigateTo(callbackUrl, { external: true })
                }
              "
            />
            <p class="text-center text-xs text-gray-500 font-medium">
              or sign in with another account below
            </p>
          </div>
        </div>

        <!-- Auth Options -->
        <div class="space-y-3">
          <UButton
            v-if="appleSignInEnabled"
            block
            size="lg"
            icon="i-simple-icons-apple"
            color="neutral"
            variant="solid"
            class="font-bold py-3 bg-black text-white hover:bg-neutral-900 dark:bg-white dark:text-black dark:hover:bg-neutral-100"
            :loading="loadingApple"
            @click="
              () => {
                void handleLogin('apple')
              }
            "
          >
            Sign in with Apple
          </UButton>

          <UButton
            block
            size="lg"
            icon="i-lucide-chrome"
            color="neutral"
            variant="outline"
            class="font-bold py-3"
            :loading="loadingGoogle"
            @click="
              () => {
                void handleLogin('google')
              }
            "
          >
            Sign in with Google
          </UButton>

          <UButton
            block
            size="lg"
            color="neutral"
            variant="outline"
            class="font-bold py-3"
            :loading="loadingIntervals"
            @click="
              () => {
                void handleLogin('intervals')
              }
            "
          >
            <template #leading>
              <img src="/images/logos/intervals.png" alt="Intervals.icu Logo" class="w-5 h-5" />
            </template>
            Sign in with Intervals.icu
          </UButton>
        </div>

        <USeparator />

        <div class="text-center">
          <UButton
            label="Cancel"
            color="neutral"
            variant="ghost"
            size="sm"
            class="font-medium"
            @click="
              () => {
                void handleCancel()
              }
            "
          />
        </div>

        <p
          class="text-[10px] text-gray-400 dark:text-gray-500 text-center font-medium leading-relaxed"
        >
          By continuing, you allow Coach Watts to share your identity with
          {{ app?.name || 'this application' }}.
        </p>
      </div>
    </UCard>
  </div>
</template>

<script setup lang="ts">
  const { status, data: authData, signIn } = useAuth()
  const route = useRoute()
  const toast = useToast()

  definePageMeta({
    layout: 'simple',
    auth: false
  })

  const runtimeConfig = useRuntimeConfig()
  const appleSignInEnabled = computed(() => Boolean(runtimeConfig.public.appleSignInEnabled))

  const providerErrorCode = computed(() => {
    const value = Array.isArray(route.query.error) ? route.query.error[0] : route.query.error
    return typeof value === 'string' ? value : null
  })
  const providerErrorMessage = computed(() => {
    switch (providerErrorCode.value) {
      case 'AccessDenied':
        return 'The provider cancelled the request. Try again or choose another provider.'
      case 'OAuthAccountNotLinked':
        return 'This email already belongs to another sign-in method. Choose the provider you used before.'
      case 'OAuthSignin':
      case 'OAuthCallback':
      case 'OAuthCreateAccount':
        return 'The provider could not finish the request. Try again or choose another provider.'
      default:
        return providerErrorCode.value
          ? 'The provider returned an unexpected response. Try again or choose another provider.'
          : null
    }
  })

  const user = computed(() => authData.value?.user)
  const loadingApp = ref(true)
  const loadingApple = ref(false)
  const loadingGoogle = ref(false)
  const loadingIntervals = ref(false)
  const app = ref<any>(null)

  const callbackUrl = (route.query.callbackUrl as string) || '/dashboard'

  // Extract client_id from callbackUrl if possible
  const clientId = computed(() => {
    try {
      const url = new URL(callbackUrl, window.location.origin)
      return url.searchParams.get('client_id')
    } catch {
      return null
    }
  })

  async function fetchAppDetails() {
    if (!clientId.value) {
      loadingApp.value = false
      return
    }

    try {
      const data: any = await $fetch<any, string & {}>('/api/oauth/authorize-details', {
        params: { client_id: clientId.value }
      })
      app.value = data
    } catch (err: any) {
      console.error('Failed to load app details:', err)
    } finally {
      loadingApp.value = false
    }
  }

  async function handleLogin(provider: 'apple' | 'google' | 'intervals') {
    if (provider === 'apple') loadingApple.value = true
    else if (provider === 'google') loadingGoogle.value = true
    else loadingIntervals.value = true

    try {
      // Force account selection for Google; Apple ignores prompt but accepts the call.
      await signIn(provider, {
        callbackUrl,
        ...(provider === 'google' ? { prompt: 'select_account' } : {})
      })
    } catch (error: any) {
      toast.add({
        title: 'Login Failed',
        description: error.message || `Could not initiate ${provider} login.`,
        color: 'error'
      })
      loadingApple.value = false
      loadingGoogle.value = false
      loadingIntervals.value = false
    }
  }

  function oauthCancellationPath(): string | null {
    try {
      const url = new URL(callbackUrl, window.location.origin)
      if (url.origin !== window.location.origin || url.pathname !== '/api/oauth/authorize') {
        return null
      }
      url.searchParams.set('action', 'deny')
      return `${url.pathname}${url.search}`
    } catch {
      return null
    }
  }

  async function handleCancel() {
    const cancellationPath = oauthCancellationPath()
    if (clientId.value && cancellationPath) {
      await navigateTo(cancellationPath, { external: true })
      return
    }
    await navigateTo('/dashboard')
  }

  onMounted(() => {
    fetchAppDetails()
  })

  useHead({
    title: 'Sign in - Coach Watts',
    meta: [
      {
        name: 'description',
        content: 'Sign in to your Coach Watts account to authorize an application.'
      }
    ]
  })
</script>
