# Sign in with Apple (IdP)

Coach Watts uses **Sign in with Apple** on the Auth.js login surfaces (`/oauth/login`, `/login`, `/join`) so the official mobile companion satisfies [App Store Guideline 4.8](https://developer.apple.com/app-store/review/guidelines/#login-services) when Google is also offered.

Mobile still uses OAuth 2.0 + PKCE against Coach Watts; SIWA runs in the **system browser** on the IdP page (same pattern as Google).

## Apple Developer setup (Watt Mind team)

1. **Identifiers → App IDs → `com.coachwatts.app`**  
   Enable **Sign In with Apple**.

2. **Identifiers → Services IDs → Create** — registered **`com.coachwatts.web`** (Coach Watts Web Auth)
   - Enable **Sign In with Apple** → Configure
   - Primary App ID: `com.coachwatts.app`
   - Domains: `coachwatts.com`
   - Return URL (Auth.js): `https://coachwatts.com/api/auth/callback/apple`
   - Note: Apple requires `https://` return URLs; local Auth.js Apple smoke uses production callback or a TLS tunnel.

3. **Keys → Create** (Sign in with Apple) — registered **Coach Watts Sign in with Apple**
   - Primary App ID: `com.coachwatts.app` (Services ID grouped)
   - **Key ID:** `4T63PU845X` · **Team ID:** `42K8S6866N`
   - Download the `.p8` once; store in the password manager — never commit

## Environment variables

Set on the hosted coach-wattz deploy (never commit the private key):

| Variable                            | Value                                            |
| ----------------------------------- | ------------------------------------------------ |
| `APPLE_ID`                          | Services ID (e.g. `com.coachwatts.web`)          |
| `APPLE_TEAM_ID`                     | `42K8S6866N`                                     |
| `APPLE_KEY_ID`                      | Key ID from step 3                               |
| `APPLE_PRIVATE_KEY`                 | Full PEM, `\n` escaped in single-line env stores |
| `APPLE_CLIENT_SECRET`               | Optional: pre-built JWT instead of key material  |
| `NUXT_PUBLIC_APPLE_SIGN_IN_ENABLED` | Optional `true` to force-show the button         |

When configured, `runtimeConfig.public.appleSignInEnabled` becomes true and the Apple button appears. The Auth.js client secret JWT is generated at process start via `server/utils/apple-client-secret.ts`.

`NUXT_AUTH_ORIGIN` must remain `https://coachwatts.com/api/auth` in production so the callback path matches Apple’s Return URL.

## PKCE / form_post cookies

Apple’s web flow posts the authorization code back (`response_mode=form_post`). Auth.js stores the PKCE `code_verifier` in a cookie; with the default `SameSite=Lax`, browsers do not attach that cookie on Apple’s cross-site POST, and the callback fails with `PKCE code_verifier cookie was missing` (surface error: “Try signing in with a different account.”).

`server/api/auth/[...].ts` overrides `cookies.pkceCodeVerifier` to `SameSite=None; Secure` so the verifier survives the Apple callback.

## Account linking

Apple uses `allowDangerousEmailAccountLinking: true` (same as Google). Stable identity is Apple `sub` on the `Account` row. Returning sign-ins may omit email; a synthetic `…@apple.coachwatts.com` email is only used when Apple does not return one (first-login Hide My Email still provides a relay address).

## App Review

There is **no** Coach Watts-native password. ASC Sign-In Information should hold a **dedicated Google** (or Apple ID) demo account. Notes must say: Safari → Sign in with Apple or Google → return via `coachwatts://oauth/callback`.

### Failure and cancellation smoke

Before a mobile store submission, verify all of these against the hosted IdP:

1. New Apple identity creates an account and returns to the mobile callback.
2. Returning Apple identity reaches the same Coach Watts user when Apple omits name/email.
3. Hide My Email creates a relay identity that can sign in again.
4. Cancelling the Apple sheet returns to `/oauth/login` with safe retry/alternate-provider copy.
5. Cancelling `/oauth/login` itself returns `error=access_denied` plus the original OAuth `state` to the registered mobile redirect.
6. A provider callback failure shows safe recovery copy and does not expose Auth.js or Apple configuration details.

The mobile and hosted UI may record only stable stages/error codes. Never log the provider response, email, authorization code, OAuth state, PKCE challenge/verifier, access token, refresh token, or the full callback URL.
