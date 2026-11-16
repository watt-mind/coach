export default defineNuxtRouteMiddleware(async (to) => {
  const { status, data, getSession, signOut } = useAuth()

  await getSession().catch(() => null)

  if (status.value === 'loading') {
    return
  }

  // Handle prompt=login: if user is authenticated, we sign them out first
  // to ensure they see the specialized OAuth login screen
  if (to.query.prompt === 'login' && status.value === 'authenticated') {
    // We remove the prompt from the URL to avoid an infinite loop of signouts
    const newQuery = { ...to.query }
    delete newQuery.prompt

    const targetUrl = {
      path: to.path,
      query: newQuery
    }

    const callbackUrl = useNuxtApp().$router.resolve(targetUrl).fullPath

    // signOut() POSTs to the auth sign-out endpoint; a transient failure there
    // must not crash the OAuth consent page (CW-372). Fall back to a plain
    // redirect that strips `prompt` so the flow can continue.
    try {
      await signOut({
        callbackUrl
      })
      return
    } catch {
      return navigateTo(callbackUrl)
    }
  }

  // If not authenticated, redirect to the specialized OAuth login page
  if (status.value !== 'authenticated') {
    return navigateTo(`/oauth/login?callbackUrl=${encodeURIComponent(to.fullPath)}`)
  }

  const deactivatedAt = (data.value?.user as { deactivatedAt?: string | Date | null } | undefined)
    ?.deactivatedAt

  if (deactivatedAt) {
    const callbackUrl = '/login?error=deactivated'
    // Same defensive guard as above: a failing sign-out request must still get
    // the user to the deactivated login page instead of erroring (CW-372).
    try {
      await signOut({
        callbackUrl
      })
      return
    } catch {
      return navigateTo(callbackUrl)
    }
  }
})
