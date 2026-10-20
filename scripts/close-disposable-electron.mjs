// Cleanup for a ChildProcess returned by this smoke's own electron.launch().
// Never discover apps by name or touch a user's running Electron/profile.
export async function closeDisposableElectron(application) {
  const child = application?.process();
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    let forceTimer;
    let deadline;
    const exited = () => {
      clearTimeout(forceTimer);
      clearTimeout(deadline);
      resolve();
    };
    child.once('exit', exited);
    // This is harness cleanup after assertions, not the production quit test.
    // Inspector evaluation can hang after a deliberately crashed renderer.
    child.kill('SIGTERM');
    forceTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    deadline = setTimeout(() => {
      child.off('exit', exited);
      reject(new Error('The disposable smoke Electron process did not exit'));
    }, 10000);
  });
}
