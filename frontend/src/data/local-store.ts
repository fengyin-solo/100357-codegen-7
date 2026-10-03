import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydrology-monitor-station:entries'
// 断面批量校核的批次与核对项单独存一份，和各模块清单互不干扰。
export const CROSSCHECK_STORAGE_KEY = 'hydrology-monitor-station:crosscheck'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

// 通用集合存取：批量批次、核对项这类「清单之外」的数据也走同一套缓存机制。
export function readCollection<T>(storageKey: string, fallback: T): T {
  if (typeof window === 'undefined' || !window.localStorage) {
    return clone(fallback)
  }
  const raw = window.localStorage.getItem(storageKey)
  if (!raw) {
    window.localStorage.setItem(storageKey, JSON.stringify(fallback))
    return clone(fallback)
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    window.localStorage.setItem(storageKey, JSON.stringify(fallback))
    return clone(fallback)
  }
}

export function writeCollection<T>(storageKey: string, value: T): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(storageKey, JSON.stringify(value))
  }
}

// 事务式提交：先在内存里把「清单 + 校核数据」整体改完，再一次性落库；
// 校验阶段任一断面失败，或持久化异常，都会恢复快照，保证不出现半批入库。
export type CommitDraft = {
  entries: Record<string, EntryRow[]>
  collection: unknown
}

export function commitAtomic<T>(
  collectionKey: string,
  mutate: (draft: CommitDraft) => T,
): T {
  const entriesSnapshot = clone(allRows())
  const collectionRaw =
    typeof window !== 'undefined' && window.localStorage
      ? window.localStorage.getItem(collectionKey)
      : null
  const entriesDraft = clone(entriesSnapshot)
  const collectionDraft =
    collectionRaw === null ? null : (JSON.parse(collectionRaw) as unknown)

  let result: T
  try {
    result = mutate({ entries: entriesDraft, collection: collectionDraft })
  } catch (error) {
    cache = entriesSnapshot
    throw error
  }

  try {
    cache = entriesDraft
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entriesDraft))
      window.localStorage.setItem(collectionKey, JSON.stringify(collectionDraft))
    }
    return result
  } catch (error) {
    cache = entriesSnapshot
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entriesSnapshot))
      if (collectionRaw === null) {
        window.localStorage.removeItem(collectionKey)
      } else {
        window.localStorage.setItem(collectionKey, collectionRaw)
      }
    }
    throw error instanceof Error ? error : new Error('批量校核落库失败，已整体回退')
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
