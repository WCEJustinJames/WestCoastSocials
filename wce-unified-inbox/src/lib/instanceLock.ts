import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

// One engine process at a time (ENG-51). The new-chat cap is counted over
// REST, which is only safe with a single sender: two processes could each
// read "one slot left" and both open.
//
// The lock is a named pipe (a Unix socket elsewhere) held open for the life
// of the process. The OS releases it the moment the process dies, however it
// dies: a closed console window, taskkill /F, a power cut or an update
// reboot. A PID file outlived those and, with Windows reusing PIDs, could
// leave the engine refusing to start for good (independent review, FIX-4).

export class AlreadyRunningError extends Error {}

export const DEFAULT_LOCK_NAME = 'wce-unified-inbox-engine'

function address(name: string): string {
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`)
}

/** Takes the lock, or rejects with AlreadyRunningError. Resolves to a release function. */
export function acquireInstanceLock(name = DEFAULT_LOCK_NAME): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => sock.end())
    server.once('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') {
        reject(new AlreadyRunningError(`another engine already holds the lock (${address(name)}); not starting a second one`))
      } else {
        reject(e)
      }
    })
    server.listen(address(name), () => {
      // Never keep the process alive on the lock's account.
      server.unref()
      resolve(() => server.close())
    })
  })
}
