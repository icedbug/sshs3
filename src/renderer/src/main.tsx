import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'
import '@fontsource/fira-code/400.css'
import '@fontsource/fira-code/700.css'
import App from './App'
import './index.css'
import { ensureWebClientBridgeInstalled } from './lib/webClientBridge'
import { WebAuthGate } from './components/WebAuthGate'
import { installGlobalErrorLogging } from './lib/log'

ensureWebClientBridgeInstalled()
installGlobalErrorLogging()

// Guarantee dropEffect is set to 'copy' during drag operations across the entire application window
const handleGlobalDragOver = (e: DragEvent): void => {
  e.preventDefault()
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'copy'
  }
}

document.addEventListener('dragover', handleGlobalDragOver, true)
document.addEventListener('dragenter', handleGlobalDragOver, true)
window.addEventListener('dragover', handleGlobalDragOver, true)
window.addEventListener('dragenter', handleGlobalDragOver, true)

const rootElement = document.getElementById('root')
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <WebAuthGate>
        <App />
      </WebAuthGate>
    </React.StrictMode>
  )
}
