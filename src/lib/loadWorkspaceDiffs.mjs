// Only the initial preview group runs concurrently. The remaining reads yield
// between files so Git work and renderer updates do not flood the app.
export async function loadWorkspaceDiffs(files, { read, publish, cancelled, yieldTask }) {
  const load = async file => {
    if (cancelled()) return;
    let result;
    try { result = await read(file.path); }
    catch (error) { result = { error: error.message }; }
    if (!cancelled()) publish(file.path, result);
  };
  await Promise.all(files.slice(0, 3).map(load));
  for (const file of files.slice(3)) {
    if (cancelled()) return;
    await yieldTask();
    if (cancelled()) return;
    await load(file);
  }
}
