// A detached GUI may outlive its launching shell. Closed stdio must not recurse through
// exception loggers or freeze the main process.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
  });
}

await import('./index');

export {};
