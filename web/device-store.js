const DATABASE_NAME = 'jarvis-device-v1'
const STORE_NAME = 'private-state'

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME)
    request.onerror = () => reject(new Error('device storage is unavailable'))
    request.onsuccess = () => resolve(request.result)
  })
}

export async function readDeviceState(key) {
  const database = await openDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly')
      const request = transaction.objectStore(STORE_NAME).get(key)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(new Error('device storage could not be read'))
    })
  } finally {
    database.close()
  }
}

export async function writeDeviceState(key, value) {
  const database = await openDatabase()
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).put(value, key)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(new Error('device storage could not be written'))
    })
  } finally {
    database.close()
  }
}

export async function deleteDeviceState(key) {
  const database = await openDatabase()
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).delete(key)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(new Error('device storage could not be updated'))
    })
  } finally {
    database.close()
  }
}
