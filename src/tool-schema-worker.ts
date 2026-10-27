import { parentPort, workerData } from 'node:worker_threads'
import { Ajv } from 'ajv'

// Static imports finish within the startup deadline. Start the compute deadline before AJV compilation.
parentPort!.postMessage({ ready: true })
// Never return provider schemas, argument values, or AJV's potentially sensitive diagnostics.
try {
  const ajv = new Ajv({ allErrors: false, strict: false, coerceTypes: false, removeAdditional: false, validateFormats: false })
  const validate = ajv.compile(workerData.schema)
  parentPort!.postMessage(validate(workerData.value) === true
    ? { valid: true }
    : { valid: false, error: 'Tool value does not match schema' })
} catch {
  parentPort!.postMessage({ valid: false, error: 'Invalid tool schema' })
}
