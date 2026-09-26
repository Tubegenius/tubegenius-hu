export const AUTH_SESSION_ENDED_EVENT = 'willviral:auth-session-ended'
export const LOGIN_PATH = '/auth/login'
export const SESSION_ENDED_ATTRIBUTE = 'data-wv-session'

export type AuthSessionEndReason = 'logout' | 'signed-out-elsewhere' | 'unauthorized' | 'restored-without-session'

// Idempotencia: ugyanannak a munkamenet-végnek több forrása van (a sikeres kijelentkezés
// ÉS a supabase SIGNED_OUT eseménye). Mindegyik ugyanide jut, de az esemény és a kemény
// navigáció pontosan egyszer fut le, különben a második navigáció megszakítja az elsőt.
// A jelzők NEM tartósak: egy újonnan felépülő védett fa (arm) vagy egy visszaállított
// lap (rearm) újra élesíti őket, így egy későbbi, új munkamenet szabályosan lezárható.
let endAnnounced = false
let leaveRequested = false

/** Új védett fa épült fel: friss munkamenet-hatókör, az elrejtés is megszűnik. */
export function armAuthSessionEnd(): void {
  endAnnounced = false
  leaveRequested = false
  if (typeof document !== 'undefined') document.documentElement.removeAttribute(SESSION_ENDED_ATTRIBUTE)
}

/** Visszaállított (bfcache) lap: a jelzők újra élesek, az elrejtés marad a revalidációig. */
export function rearmAuthSessionEnd(): void {
  endAnnounced = false
  leaveRequested = false
}

/**
 * A közös auth-állapot egyetlen jelzése: a munkamenet véget ért. A kredit-állapot
 * erre kiüríti magát, a shell pedig azonnal el van rejtve, amíg a kemény
 * navigáció be nem fejeződik. A kemény navigáció (nem router.push) szükséges:
 * csak az dobja el a Next kliensoldali Router Cache-t és a memóriabeli
 * állapotot, amelyből a böngésző Vissza gombja egyébként a védett fát
 * kiszolgálás nélkül állítaná vissza.
 */
export function announceAuthSessionEnded(reason: AuthSessionEndReason): void {
  if (typeof window === 'undefined') return
  if (endAnnounced) return
  endAnnounced = true
  document.documentElement.setAttribute(SESSION_ENDED_ATTRIBUTE, 'ended')
  window.dispatchEvent(new CustomEvent<AuthSessionEndReason>(AUTH_SESSION_ENDED_EVENT, { detail: reason }))
}

export function leaveToLogin(): void {
  if (typeof window === 'undefined') return
  if (window.location.pathname === LOGIN_PATH) return
  if (leaveRequested) return
  leaveRequested = true
  window.location.replace(LOGIN_PATH)
}

export function endAuthSession(reason: AuthSessionEndReason): void {
  announceAuthSessionEnded(reason)
  leaveToLogin()
}
