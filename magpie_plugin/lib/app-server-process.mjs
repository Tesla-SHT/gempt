import { execFile, spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const system32 = join(process.env.SystemRoot || 'C:/Windows', 'System32');
const powershell = join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const psArgs = (script) => ['-NoProfile', '-NonInteractive', '-Command', script];

function quoteWindowsArg(value) {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, '$&$&')}"`;
}

export async function launchAppServer(bin, args, options) {
  if (process.platform !== 'win32') return spawn(bin, args, options);
  try {
    const launch = execFileAsync(powershell, psArgs(`
      $ErrorActionPreference = 'Stop'
      [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
      $inputPacket = [Console]::In.ReadToEnd() | ConvertFrom-Json
      $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{
        ShowWindow = [uint16]0
        CreateFlags = [uint32]0x01000000
        EnvironmentVariables = [string[]]$inputPacket.environment
      }
      $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = [string]$inputPacket.commandLine
        CurrentDirectory = [string]$inputPacket.cwd
        ProcessStartupInformation = $startup
      }
      if ($result.ReturnValue -ne 0) { throw "Win32_Process.Create returned $($result.ReturnValue)." }
      [Console]::WriteLine($result.ProcessId)
    `), { windowsHide: true, timeout: 10000 });
    launch.child.stdin.on('error', () => {});
    launch.child.stdin.end(JSON.stringify({
      commandLine: [bin, ...args].map(quoteWindowsArg).join(' '),
      cwd: options.cwd,
      environment: Object.entries(options.env).filter(([, value]) => value != null).map(([key, value]) => `${key}=${value}`),
    }));
    const pid = Number((await launch).stdout.trim());
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Windows did not return a Codex app-server PID.');
    return { pid, detachedOutOfJob: true };
  } catch {
    // Fallback if WMI/CIM is disabled in a locked-down Windows environment.
    return spawn(bin, args, options);
  }
}

export function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

export async function matchesAppServerProcess(pid, marker) {
  if (!pidAlive(pid) || typeof marker !== 'string' || !marker) return false;
  try {
    const { stdout } = process.platform === 'win32'
      ? await execFileAsync(powershell, psArgs(`(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`),
        { windowsHide: true, timeout: 3000 })
      : await execFileAsync('ps', ['-ww', '-p', String(pid), '-o', 'args='], { timeout: 3000 });
    return stdout.includes('--ws-token-file ') && stdout.includes(marker);
  } catch {
    return false;
  }
}

export function terminateAppServer(child) {
  if (!child?.pid || child.exitCode != null || child.signalCode != null) return;
  if (child.kill && !child.spawnfile) {
    child.kill();
    return;
  }
  if (child.pid === process.pid) return;
  if (process.platform === 'win32') {
    const result = spawnSync(join(system32, 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, stdio: 'ignore', timeout: 3000 });
    if (result.status === 0 || !pidAlive(child.pid)) return;
    throw new Error(`Could not terminate Codex app-server (PID ${child.pid}).`);
  }
  if (child.kill) child.kill();
  else {
    try { process.kill(child.pid, 'SIGTERM'); } catch (err) { if (err.code !== 'ESRCH') throw err; }
  }
}
