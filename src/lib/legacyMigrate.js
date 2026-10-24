// One-time migration of browser storage from the app's former name.
//
// Every localStorage / sessionStorage key used to start with `nexora_`; they now start with `serevor_`.
// Renaming a key without moving its value would silently reset things users care about: most importantly the
// App Lock (PIN/biometric record) and its failed-attempt counter, plus theme, unsent journal drafts and dismissed
// notices. This copies each old value to its new key (never overwriting a value that already exists under the new
// name), then removes the old key. It is idempotent and cheap, and runs before anything else reads storage:
// it MUST stay the first import in main.jsx.
//
// Safe to delete once enough time has passed that no active install still holds `nexora_*` keys.

const OLD_PREFIX = 'nexora_'
const NEW_PREFIX = 'serevor_'

function migrate(getStore) {
  try {
    const store = getStore() // reading window.localStorage itself can throw when storage is blocked
    const keys = []
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i)
      if (k && k.startsWith(OLD_PREFIX)) keys.push(k)
    }
    for (const oldKey of keys) {
      try {
        const newKey = NEW_PREFIX + oldKey.slice(OLD_PREFIX.length)
        if (store.getItem(newKey) === null) store.setItem(newKey, store.getItem(oldKey))
        store.removeItem(oldKey) // only reached if the copy did not throw
      } catch { /* quota / blocked storage: leave the old key in place, try again next load */ }
    }
  } catch { /* storage unavailable (private mode, blocked): nothing to migrate */ }
}

migrate(() => globalThis.localStorage)
migrate(() => globalThis.sessionStorage)
