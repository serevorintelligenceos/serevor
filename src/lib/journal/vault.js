// Vault store: holds the unlocked key IN MEMORY ONLY (never localStorage), auto-locks when idle,
// and lets any screen ask "please unlock" via requestUnlock() — the VaultHost sheet answers it.
import { useSyncExternalStore } from 'react'
import { supabase } from '../supabase.js'
import * as C from './crypto.js'

const IDLE_MS = 10 * 60 * 1000 // lock after 10 min of no vault activity
const HIDDEN_MS = 5 * 60 * 1000 // …or after the tab/app was in the background for 5 min

let state = { userId: null, status: 'unknown', row: null, key: null, prompt: null, promptReason: null }
const listeners = new Set()
const emit = (patch) => {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}
export const subscribe = (l) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
export const getState = () => state
export const useVault = () => useSyncExternalStore(subscribe, getState)

let idleTimer = null
let hiddenAt = 0
function arm() {
  clearTimeout(idleTimer)
  if (state.key) idleTimer = setTimeout(() => lock(), IDLE_MS)
}
export function touch() {
  if (state.key) arm()
}

export function lock() {
  clearTimeout(idleTimer)
  emit({ key: null, status: state.row ? 'locked' : state.status === 'unknown' ? 'unknown' : 'none' })
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now()
    else if (hiddenAt && Date.now() - hiddenAt > HIDDEN_MS) lock()
  })
}
supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') emit({ userId: null, row: null, key: null, status: 'unknown', prompt: null })
})

export function bindUser(userId) {
  if (state.userId && state.userId !== userId) {
    clearTimeout(idleTimer)
    emit({ userId, row: null, key: null, status: 'unknown' })
  } else if (!state.userId) {
    emit({ userId })
  }
}

export async function loadVault(userId = state.userId) {
  const { data, error } = await supabase.from('journal_vault').select('*').eq('user_id', userId).maybeSingle()
  if (error) throw error
  emit({ userId, row: data || null, status: data ? (state.key ? 'unlocked' : 'locked') : 'none' })
  return data
}

// ---- brute-force slowdown (client-side; the real protection is the 600k-round KDF) ----
const FAIL_KEY = 'serevor_vault_fails'
function readFails() {
  try { return JSON.parse(sessionStorage.getItem(FAIL_KEY) || '{"n":0,"until":0}') } catch { return { n: 0, until: 0 } }
}
function writeFails(v) {
  try { sessionStorage.setItem(FAIL_KEY, JSON.stringify(v)) } catch { /* ignore */ }
}
function waitLeft() {
  const f = readFails()
  return f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0
}
function registerFail() {
  const f = readFails()
  const n = f.n + 1
  const until = n >= 5 ? Date.now() + Math.min(30 * 2 ** Math.min(n - 5, 5), 900) * 1000 : 0
  writeFails({ n, until })
  return until ? Math.ceil((until - Date.now()) / 1000) : 0
}

function validPassphrase(p) {
  if (typeof p !== 'string' || p.length < C.MIN_PASSPHRASE) throw new Error(`Use at least ${C.MIN_PASSPHRASE} characters.`)
}

// Registers the reset proof with the server (one-time, can never be replaced). Best effort: for vaults created before the
// reset guard existed it simply happens on the next successful unlock.
async function registerProof(proof) {
  try {
    await supabase.rpc('journal_vault_register', { p_proof: proof })
  } catch {
    /* retried on the next unlock */
  }
}

// Returns the recovery key (show it ONCE; it is not stored anywhere in readable form).
export async function setupVault(passphrase) {
  validPassphrase(passphrase)
  const userId = state.userId
  const { row, recoveryKey, key, proof } = await C.createVault(passphrase)
  const { error } = await supabase.from('journal_vault').insert({ user_id: userId, ...row })
  if (error) throw error
  await registerProof(proof)
  emit({ row: { user_id: userId, ...row }, key, status: 'unlocked' })
  arm()
  return recoveryKey
}

// -> { ok, wait }
export async function unlock(passphrase) {
  const wait = waitLeft()
  if (wait) return { ok: false, wait }
  try {
    const row = state.row || (await loadVault())
    if (!row) return { ok: false, wait: 0, error: 'No vault found.' }
    const master = await C.unwrapMaster(row.wrapped_key, passphrase, row.kdf_salt, row.kdf_iter, true)
    const usable = await C.toUsableKey(master)
    writeFails({ n: 0, until: 0 })
    emit({ key: usable, status: 'unlocked' })
    arm()
    C.resetProof(master).then(registerProof).catch(() => {})
    return { ok: true, wait: 0 }
  } catch (err) {
    if (err.message === 'bad_secret') return { ok: false, wait: registerFail() }
    return { ok: false, wait: 0, error: 'Could not unlock. Check your connection and try again.' }
  }
}

// Forgot the passphrase: recovery key + a NEW passphrase. Old entries stay readable.
export async function unlockWithRecovery(recoveryKey, newPassphrase) {
  validPassphrase(newPassphrase)
  const wait = waitLeft()
  if (wait) return { ok: false, wait }
  const row = state.row || (await loadVault())
  try {
    const master = await C.unwrapMaster(row.rec_wrapped_key, C.normalizeRecoveryKey(recoveryKey), row.rec_salt, row.kdf_iter, true)
    const next = await C.wrapWithPassphrase(master, newPassphrase, row.kdf_iter)
    const { error } = await supabase.from('journal_vault').update(next).eq('user_id', state.userId)
    if (error) throw error
    writeFails({ n: 0, until: 0 })
    emit({ row: { ...row, ...next }, key: await C.toUsableKey(master), status: 'unlocked' })
    arm()
    C.resetProof(master).then(registerProof).catch(() => {})
    return { ok: true, wait: 0 }
  } catch (err) {
    if (err.message === 'bad_secret') return { ok: false, wait: registerFail(), error: 'That recovery key is not right.' }
    return { ok: false, wait: 0, error: err.message || 'Could not reset. Try again.' }
  }
}

export async function changePassphrase(oldPassphrase, newPassphrase) {
  validPassphrase(newPassphrase)
  const row = state.row || (await loadVault())
  const master = await C.unwrapMaster(row.wrapped_key, oldPassphrase, row.kdf_salt, row.kdf_iter, true)
  const next = await C.wrapWithPassphrase(master, newPassphrase, row.kdf_iter)
  const { error } = await supabase.from('journal_vault').update(next).eq('user_id', state.userId)
  if (error) throw error
  emit({ row: { ...row, ...next }, key: await C.toUsableKey(master), status: 'unlocked' })
  arm()
}

// Issue a fresh recovery key (invalidates the old one). Requires the passphrase.
export async function regenerateRecovery(passphrase) {
  const row = state.row || (await loadVault())
  const master = await C.unwrapMaster(row.wrapped_key, passphrase, row.kdf_salt, row.kdf_iter, true)
  const next = await C.wrapWithNewRecovery(master, row.kdf_iter)
  const { recoveryKey, ...cols } = next
  const { error } = await supabase.from('journal_vault').update(cols).eq('user_id', state.userId)
  if (error) throw error
  emit({ row: { ...row, ...cols } })
  return recoveryKey
}

// Permanently deletes private entries + the vault. Requires the vault passphrase, and the SERVER re-checks a proof derived
// from it (journal_vault_reset), so a stolen login session alone cannot wipe the vault, not even by calling the API directly.
export async function resetVault(passphrase) {
  const wait = waitLeft()
  if (wait) throw new Error(`Too many attempts. Try again in ${wait}s.`)
  if (!passphrase) throw new Error('Enter your vault passphrase.')
  const row = state.row || (await loadVault())
  if (!row) throw new Error('No vault found.')

  let master
  try {
    master = await C.unwrapMaster(row.wrapped_key, passphrase, row.kdf_salt, row.kdf_iter, true)
  } catch (err) {
    if (err.message === 'bad_secret') {
      const w = registerFail()
      throw new Error(w ? `Too many attempts. Try again in ${w}s.` : 'Wrong passphrase.')
    }
    throw new Error('Could not check your passphrase. Check your connection and try again.')
  }
  const proof = await C.resetProof(master)

  let { error } = await supabase.rpc('journal_vault_reset', { p_proof: proof })
  if (error && /vault_not_registered/.test(error.message)) {
    // Vault created before the guard existed: the passphrase was just verified on this device, so register and retry once.
    await registerProof(proof)
    ;({ error } = await supabase.rpc('journal_vault_reset', { p_proof: proof }))
  }
  if (error && !/no_vault/.test(error.message)) {
    if (/invalid_proof/.test(error.message)) throw new Error("Couldn't verify this reset. Please contact support.")
    throw new Error('Could not reset the vault. Check your connection and try again.')
  }
  writeFails({ n: 0, until: 0 })
  clearTimeout(idleTimer)
  emit({ row: null, key: null, status: 'none' })
}

// ---- encrypt / decrypt entry payloads ----
export async function encryptEntry({ title, content }) {
  if (!state.key) throw new Error('vault_locked')
  touch()
  return C.encryptPayload(state.key, state.userId, { t: title || '', c: content || '' })
}
export async function decryptEntry(payload) {
  if (!state.key) throw new Error('vault_locked')
  touch()
  const o = await C.decryptPayload(state.key, state.userId, payload)
  return { title: o.t || '', content: o.c || '' }
}

// ---- "please unlock" requests (answered by <VaultHost/>) ----
let waiters = []
export async function requestUnlock(reason) {
  if (state.status === 'unlocked') return true
  if (state.status === 'unknown') {
    try { await loadVault() } catch { return false }
    if (state.status === 'unlocked') return true
  }
  return new Promise((resolve) => {
    waiters.push(resolve)
    emit({ prompt: state.status === 'none' ? 'setup' : 'unlock', promptReason: reason || null })
  })
}
export function resolvePrompt(ok) {
  const w = waiters
  waiters = []
  emit({ prompt: null, promptReason: null })
  w.forEach((r) => r(ok))
}
export function openVaultSettings() {
  emit({ prompt: 'settings' })
}
