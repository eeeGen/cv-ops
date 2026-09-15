import { spawn } from 'node:child_process';
import { once } from 'node:events';

const LOCK_SCRIPT = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class CvOpsDirectoryLock {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern SafeFileHandle CreateFile(
    string name, uint access, uint shareMode, IntPtr security,
    uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);
}
'@
$handles = [System.Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]]::new()
function Lock-Directory([string]$path) {
  $handle = [CvOpsDirectoryLock]::CreateFile(
    $path, [uint32]0x00010000, [uint32]0x00000003, [IntPtr]::Zero,
    [uint32]3, [uint32]0x02000000, [IntPtr]::Zero)
  if ($handle.IsInvalid) { return $false }
  $handles.Add($handle)
  return $true
}
foreach ($path in ($env:CV_OPS_LOCK_PATHS | ConvertFrom-Json)) {
  if (-not (Lock-Directory $path)) { exit 1 }
}
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
while ($true) {
  $path = [Console]::In.ReadLine()
  if ($null -eq $path -or $path -eq 'RELEASE') { break }
  if (Lock-Directory $path) { [Console]::Out.WriteLine('LOCKED') }
  else { [Console]::Out.WriteLine('ERROR') }
  [Console]::Out.Flush()
}
foreach ($handle in $handles) { $handle.Dispose() }
`;

function startLock(paths) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', LOCK_SCRIPT], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      env: { ...process.env, CV_OPS_LOCK_PATHS: JSON.stringify(paths) },
    });
    let output = '';
    const messages = [];
    const waiters = [];
    let ready = false;
    const receive = () => new Promise((resolveMessage) => {
      const message = messages.shift();
      if (message) {
        resolveMessage(message);
      } else {
        waiters.push(resolveMessage);
      }
    });
    const publish = (message) => {
      const waiter = waiters.shift();
      if (waiter) {
        waiter(message);
      } else {
        messages.push(message);
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Directory lock timed out.'));
    }, 5000);

    child.stdout.on('data', (chunk) => {
      output += chunk;
      let newline;
      while ((newline = output.indexOf('\n')) !== -1) {
        const message = output.slice(0, newline).trim();
        output = output.slice(newline + 1);
        if (message) {
          publish(message);
        }
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      if (!ready) {
        clearTimeout(timer);
        reject(new Error(`Directory lock process exited with ${code}.`));
      }
    });
    receive().then((message) => {
      if (message !== 'READY') {
        clearTimeout(timer);
        reject(new Error('Directory lock was not ready.'));
        return;
      }
      ready = true;
      clearTimeout(timer);
      child.lock = async (path) => {
        child.stdin.write(`${path}\n`);
        if (await receive() !== 'LOCKED') {
          throw new Error('Directory lock failed.');
        }
      };
      resolve(child);
    });
  });
}

async function releaseLock(child) {
  if (child.exitCode !== null) {
    return;
  }
  child.stdin.end('RELEASE\n');
  await once(child, 'exit');
}

export async function acquireDirectoryLocks(paths) {
  if (process.platform !== 'win32') {
    throw new Error('Atomic directory locks are unavailable on this platform.');
  }

  const lock = await startLock(paths);

  return {
    lock: lock.lock,
    release: async () => releaseLock(lock),
  };
}
