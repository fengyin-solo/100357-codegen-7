import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydrology-monitor-station:entries'

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

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

// 附属数据：断面校核批次、水位整编核对待办等非「业务条目」对象，单独放一个命名空间。
const EXTRA_STORAGE_KEY = 'hydrology-monitor-station:extras'

function readExtras(): Record<string, unknown> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return {}
  }
  const raw = window.localStorage.getItem(EXTRA_STORAGE_KEY)
  if (!raw) {
    return {}
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

let extraCache: Record<string, unknown> | null = null

function extraStore(): Record<string, unknown> {
  if (extraCache === null) {
    extraCache = readExtras()
  }
  return extraCache
}

export function readExtra<T>(key: string, fallback: T): T {
  const value = extraStore()[key]
  return value === undefined ? clone(fallback) : clone(value as T)
}

export function writeExtra<T>(key: string, value: T): void {
  const next = { ...extraStore(), [key]: clone(value) }
  extraCache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(EXTRA_STORAGE_KEY, JSON.stringify(next))
  }
}
