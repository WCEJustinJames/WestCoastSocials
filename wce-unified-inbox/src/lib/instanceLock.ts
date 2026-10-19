import fs from 'node:fs'

// One engine process at a time (ENG-51). The new-chat cap is counted over
// REST, which is only safe with a single sender: two processes could each
// read "one slot left" and both open. The lock is a file holding the owner's
// PID, created exclusively; a file left by a process that has since died is
// taken over.

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM means it exists but belongs to someone else: still running.
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class AlreadyRunningError extends Error {}

/** Takes the lock or throws AlreadyRunningError. Returns a release function. */
export function acquireInstanceLock(path: string, pid = process.pid): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(path, 'wx')
      fs.writeSync(fd, String(pid))
      fs.closeSync(fd)
      const release = () => {
        try {
          if (fs.readFileSync(path, 'utf8').trim() === String(pid)) fs.unlinkSync(path)
        } catch { /* already gone */ }
      }
      return release
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const owner = Number(fs.readFileSync(path, 'utf8').trim())
      if (owner !== pid && alive(owner)) {
        throw new AlreadyRunningError(`engine already running (PID ${owner}); not starting a second one`)
      }
      fs.unlinkSync(path) // stale: its owner is gone
    }
  }
  throw new AlreadyRunningError('could not take the engine lock')
}
