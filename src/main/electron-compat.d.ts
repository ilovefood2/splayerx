import 'electron';

declare module 'electron' {
  interface BrowserView {
    destroy(): void,
    isDestroyed(): boolean,
  }
}
