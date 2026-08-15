const { execSync } = require('child_process');
const port = Number(process.argv[2]) || Number(process.env.PORT) || 3001;

function killOnWindows() {
  const out = execSync('netstat -ano', { encoding: 'utf8' });
  const pids = new Set();
  for (const line of out.split('\n')) {
    if (!line.includes(`:${port}`) || !line.includes('LISTENING')) continue;
    const parts = line.trim().split(/\s+/);
    const pid = parts[parts.length - 1];
    if (pid && /^\d+$/.test(pid)) pids.add(pid);
  }
  if (pids.size === 0) { console.log(`[kill-port] Port ${port} is free.`); return; }
  for (const pid of pids) {
    try {
      execSync(`taskkill /PID ${pid}`, { stdio: 'ignore' });
      console.log(`[kill-port] Sent shutdown to process ${pid} on port ${port}`);
    } catch {
      /* ignore */
    }
  }
  // Give processes time to clean up, then force-kill any survivors
  try { execSync('ping -n 4 127.0.0.1 >nul', { stdio: 'ignore' }); } catch { /* ignore */ }
  for (const pid of pids) {
    try {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
      console.log(`[kill-port] Force-killed process ${pid}`);
    } catch {
      /* already exited */
    }
  }
  console.log(`[kill-port] Port ${port} cleared.`);
}

if (process.platform === 'win32') killOnWindows();
else {
  try {
    const out = execSync(`lsof -ti :${port}`, { encoding: 'utf8' }).trim();
    for (const pid of out.split('\n').filter(Boolean)) execSync(`kill -9 ${pid}`);
  } catch {
    console.log(`[kill-port] Port ${port} is free.`);
  }
}
