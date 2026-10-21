/**
 * Secret storage.
 *
 * On Windows, secrets (API keys) are encrypted at rest with **DPAPI**
 * (CryptProtectData, CurrentUser scope) through PowerShell — no native npm
 * module needed. The ciphertext is machine+user bound: copying the file to
 * another machine or another user renders it useless.
 *
 * On non-Windows platforms (or when DPAPI fails), the secret is stored
 * plainly — same as before — so behaviour never silently breaks.
 *
 * Format of the stored value:
 *   "dpapi:<base64 ciphertext>"  → encrypted
 *   anything else                → legacy plaintext (transparently readable)
 */
import { execFileSync } from 'child_process'
import Conf from 'conf'

const secretStore = new Conf<Record<string, string>>({
  projectName: 'eco-agent-secrets',
})

const DPAPI_PREFIX = 'dpapi:'

const isWindows = () => process.platform === 'win32'

function runPowerShell(script: string, extraEnv?: Record<string, string>): string | null {
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf-8',
        timeout: 15_000,
        windowsHide: true,
        env: { ...process.env, ...extraEnv },
      }
    )
    const trimmed = out.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

/** Double single-quotes so a value can be safely embedded in PS strings. */
function psQuote(value: string): string {
  return value.replace(/'/g, "''")
}

export function saveSecret(name: string, value: string): void {
  if (!value) {
    secretStore.delete(name)
    return
  }

  if (isWindows()) {
    // The value travels via the child process env — avoids any
    // command-injection / quoting risks on the PowerShell command line.
    const b64 = runPowerShell(
      "Add-Type -AssemblyName 'System.Security'; " +
      '$raw = $env:ECO_SECRET_VALUE; ' +
      '$bytes = [System.Text.Encoding]::UTF8.GetBytes($raw); ' +
      '$enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); ' +
      '[System.Convert]::ToBase64String($enc)',
      { ECO_SECRET_VALUE: value }
    )
    if (b64 !== null) {
      secretStore.set(name, DPAPI_PREFIX + b64)
      return
    }
  }

  // Fallback: store plainly (non-Windows, or DPAPI unavailable)
  secretStore.set(name, value)
}

export function loadSecret(name: string): string {
  const stored = secretStore.get(name) ?? ''

  if (!stored.startsWith(DPAPI_PREFIX)) return stored // legacy plaintext

  const b64 = stored.slice(DPAPI_PREFIX.length)
  const decrypted = runPowerShell(
    "Add-Type -AssemblyName 'System.Security'; " +
    `$enc = [System.Convert]::FromBase64String('${psQuote(b64)}'); ` +
    '$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); ' +
    '[System.Text.Encoding]::UTF8.GetString($bytes)'
  )
  if (decrypted !== null) return decrypted

  // DPAPI failed (e.g. config copied from another user/machine).
  // Return empty so callers show "key not configured" instead of crashing.
  return ''
}

/** True when the stored secret is DPAPI-protected (for status display). */
export function isSecretProtected(name: string): boolean {
  return (secretStore.get(name) ?? '').startsWith(DPAPI_PREFIX)
}
