/// <reference types="vite/client" />

import type { DesktopBridge } from './types'

declare module '*.svg' {
  const source: string
  export default source
}

declare global {
  interface Window {
    desktopBridge?: DesktopBridge
  }
}

export {}
