import { useCallback, useEffect, useState } from 'react'
import { fetchQuota } from './capture.js'

// What the person has used today (captures, folders). `quota` is null until loaded or if it can't be read;
// the UI then simply doesn't show counters, and the database still enforces every limit.
export function useCaptureQuota() {
  const [quota, setQuota] = useState(null)
  const refresh = useCallback(async () => {
    const q = await fetchQuota()
    setQuota(q)
    return q
  }, [])
  useEffect(() => { refresh() }, [refresh])
  return { quota, refresh }
}
