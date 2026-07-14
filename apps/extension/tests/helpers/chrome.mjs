function clone(value) {
  return structuredClone(value)
}

function createEvent() {
  const listeners = new Set()
  return {
    api: {
      addListener(listener) {
        listeners.add(listener)
      },
      removeListener(listener) {
        listeners.delete(listener)
      },
      hasListener(listener) {
        return listeners.has(listener)
      },
    },
    async emit(...args) {
      for (const listener of [...listeners]) {
        await listener(...clone(args))
      }
    },
    listenerCount() {
      return listeners.size
    },
  }
}

function createStorageArea(initialValues, areaName, onChanged) {
  let values = clone(initialValues)
  const failures = new Map()

  async function yieldTurn() {
    await new Promise((resolve) => setImmediate(resolve))
  }

  function maybeFail(operation) {
    const failure = failures.get(operation)
    if (!failure) return
    failures.delete(operation)
    throw failure
  }

  return {
    api: {
      async get(keys = null) {
        await yieldTurn()
        maybeFail("get")
        if (keys === null) return clone(values)
        if (typeof keys === "string") {
          return keys in values ? { [keys]: clone(values[keys]) } : {}
        }
        if (Array.isArray(keys)) {
          return Object.fromEntries(
            keys.filter((key) => key in values).map((key) => [key, clone(values[key])]),
          )
        }
        const result = clone(keys)
        for (const key of Object.keys(keys)) {
          if (key in values) result[key] = clone(values[key])
        }
        return result
      },
      async set(updates) {
        await yieldTurn()
        maybeFail("set")
        const changes = {}
        for (const [key, value] of Object.entries(updates)) {
          changes[key] = {
            oldValue: key in values ? clone(values[key]) : undefined,
            newValue: clone(value),
          }
          values[key] = clone(value)
        }
        if (Object.keys(changes).length > 0) await onChanged.emit(changes, areaName)
      },
      async remove(keys) {
        await yieldTurn()
        maybeFail("remove")
        const changes = {}
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          if (!(key in values)) continue
          changes[key] = { oldValue: clone(values[key]) }
          delete values[key]
        }
        if (Object.keys(changes).length > 0) await onChanged.emit(changes, areaName)
      },
      async clear() {
        await yieldTurn()
        maybeFail("clear")
        const changes = Object.fromEntries(
          Object.entries(values).map(([key, value]) => [key, { oldValue: clone(value) }]),
        )
        values = {}
        if (Object.keys(changes).length > 0) await onChanged.emit(changes, areaName)
      },
    },
    control: {
      snapshot() {
        return clone(values)
      },
      replace(nextValues) {
        values = clone(nextValues)
      },
      failNext(operation, error = new Error(`synthetic ${operation} failure`)) {
        failures.set(operation, error)
      },
    },
  }
}

function createTabsDouble(initialTabs, currentWindowId) {
  const tabs = new Map(initialTabs.map((tab) => [tab.id, clone(tab)]))
  const onActivated = createEvent()
  const onRemoved = createEvent()
  const onUpdated = createEvent()
  let nextGetFailure = null

  return {
    api: {
      async get(tabId) {
        if (nextGetFailure) {
          const error = nextGetFailure
          nextGetFailure = null
          throw error
        }
        const tab = tabs.get(tabId)
        if (!tab) throw new Error(`No tab with id ${tabId}`)
        return clone(tab)
      },
      async query(queryInfo = {}) {
        return [...tabs.values()]
          .filter((tab) => queryInfo.active === undefined || tab.active === queryInfo.active)
          .filter(
            (tab) =>
              queryInfo.currentWindow === undefined ||
              !queryInfo.currentWindow ||
              tab.windowId === currentWindowId,
          )
          .map(clone)
      },
      async sendMessage() {
        return undefined
      },
      onActivated: onActivated.api,
      onRemoved: onRemoved.api,
      onUpdated: onUpdated.api,
    },
    control: {
      snapshot() {
        return [...tabs.values()].map(clone)
      },
      set(tab) {
        tabs.set(tab.id, clone(tab))
      },
      async update(tabId, changes) {
        const tab = tabs.get(tabId)
        if (!tab) throw new Error(`No tab with id ${tabId}`)
        const updated = { ...tab, ...clone(changes) }
        tabs.set(tabId, updated)
        await onUpdated.emit(tabId, clone(changes), clone(updated))
      },
      async activate(tabId) {
        const selected = tabs.get(tabId)
        if (!selected) throw new Error(`No tab with id ${tabId}`)
        for (const tab of tabs.values()) {
          if ((tab.windowId ?? 1) === (selected.windowId ?? 1)) tab.active = tab.id === tabId
        }
        await onActivated.emit({ tabId, windowId: selected.windowId ?? 1 })
      },
      async remove(tabId) {
        const tab = tabs.get(tabId)
        if (!tab) return false
        tabs.delete(tabId)
        await onRemoved.emit(tabId, { windowId: tab.windowId ?? 1, isWindowClosing: false })
        return true
      },
      failNextGet(error = new Error("synthetic tabs.get failure")) {
        nextGetFailure = error
      },
      events: { onActivated, onRemoved, onUpdated },
    },
  }
}

function createAlarmsDouble(now) {
  const alarms = new Map()
  const onAlarm = createEvent()

  function normalize(name, info) {
    const delay = info.delayInMinutes ?? info.periodInMinutes ?? 0
    return {
      name,
      scheduledTime: info.when ?? now() + delay * 60_000,
      ...(info.periodInMinutes === undefined
        ? {}
        : { periodInMinutes: info.periodInMinutes }),
    }
  }

  async function fire(name) {
    const alarm = alarms.get(name)
    if (!alarm) return false
    const firedAlarm = clone(alarm)
    if (alarm.periodInMinutes === undefined) {
      alarms.delete(name)
    } else {
      alarm.scheduledTime += alarm.periodInMinutes * 60_000
    }
    await onAlarm.emit(firedAlarm)
    return true
  }

  return {
    api: {
      async create(name, info) {
        alarms.set(name, normalize(name, info))
      },
      async get(name) {
        const alarm = alarms.get(name)
        return alarm ? clone(alarm) : undefined
      },
      async getAll() {
        return [...alarms.values()].map(clone)
      },
      async clear(name) {
        return alarms.delete(name)
      },
      async clearAll() {
        const hadAlarms = alarms.size > 0
        alarms.clear()
        return hadAlarms
      },
      onAlarm: onAlarm.api,
    },
    control: {
      snapshot() {
        return [...alarms.values()].map(clone)
      },
      fire,
      async fireDue(timestamp = now()) {
        const dueNames = [...alarms.values()]
          .filter((alarm) => alarm.scheduledTime <= timestamp)
          .sort((left, right) => left.scheduledTime - right.scheduledTime)
          .map((alarm) => alarm.name)
        for (const name of dueNames) await fire(name)
        return dueNames
      },
      events: { onAlarm },
    },
  }
}

export function createChromeMock(options = {}) {
  const onStorageChanged = createEvent()
  const session = createStorageArea(options.session ?? {}, "session", onStorageChanged)
  const local = createStorageArea(options.local ?? {}, "local", onStorageChanged)
  const tabs = createTabsDouble(options.tabs ?? [], options.currentWindowId ?? 1)
  const alarms = createAlarmsDouble(options.now ?? (() => Date.now()))

  return {
    chrome: {
      storage: {
        session: session.api,
        local: local.api,
        onChanged: onStorageChanged.api,
      },
      tabs: tabs.api,
      alarms: alarms.api,
    },
    storage: {
      session: session.control,
      local: local.control,
      onChanged: onStorageChanged,
    },
    tabs: tabs.control,
    alarms: alarms.control,
  }
}
