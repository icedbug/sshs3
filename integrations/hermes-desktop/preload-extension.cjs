// App-specific capability; native Hermes capabilities remain untouched.
const { contextBridge: sshs3ContextBridge, ipcRenderer: sshs3Ipc } = require('electron');
if (process.argv.includes('--sshs3-hermes-host')) {
sshs3ContextBridge.exposeInMainWorld('sshs3Shell', {
  get: () => sshs3Ipc.invoke('sshs3:hermes:state'),
  set: update => sshs3Ipc.invoke('sshs3:hermes:layout', update),
  tools: () => sshs3Ipc.invoke('sshs3:hermes:tools:state'),
  arm: shell => sshs3Ipc.invoke('sshs3:hermes:tools:arm', shell),
  approve: (task, change, allowed) => sshs3Ipc.invoke('sshs3:hermes:tools:approve', task, change, allowed),
  takeover: task => sshs3Ipc.invoke('sshs3:hermes:tools:takeover', task),
  resume: task => sshs3Ipc.invoke('sshs3:hermes:tools:resume', task),
  onToolsChanged: listener => {
    const handler = (_event, state) => listener(state);
    sshs3Ipc.on('sshs3:hermes:tools:changed', handler);
    return () => sshs3Ipc.removeListener('sshs3:hermes:tools:changed', handler);
  },
  onChange: listener => {
    const handler = (_event, state) => listener(state);
    sshs3Ipc.on('sshs3:hermes:changed', handler);
    return () => sshs3Ipc.removeListener('sshs3:hermes:changed', handler);
  },
});
}
