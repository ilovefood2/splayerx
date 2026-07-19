/* eslint-disable @typescript-eslint/no-explicit-any */
import 'electron';

declare global {
  namespace Electron {
    interface App {
      utils: any,
      getCrossThreadCache(key: string[] | string): any,
      setCrossThreadCache(key: string[] | string, val: any): void,
    }

    interface WebContentsView {
      destroy(): void,
      isDestroyed(): boolean,
    }

    interface BrowserWindow {
      addWebContentsView(view: WebContentsView): void,
      removeWebContentsView(view: WebContentsView): void,
      getWebContentsViews(): WebContentsView[],
      setWebContentsView(view: WebContentsView | null): void,
      setWebContentsViewAutoResize(
        view: WebContentsView,
        options: { width?: boolean, height?: boolean },
      ): void,
    }

    interface IpcMain {
      on(channel: string, listener: (event: any, ...args: any[]) => void): this,
    }

    interface IpcRenderer {
      on(channel: string, listener: (event: any, ...args: any[]) => void): this,
      once(channel: string, listener: (event: any, ...args: any[]) => void): this,
    }

    namespace CrossProcessExports {
      const remote: any;
    }
  }
}

declare module 'electron' {
  export const remote: any;

  interface WebContentsView {
    destroy(): void,
    isDestroyed(): boolean,
  }

  interface BrowserWindow {
    addWebContentsView(view: WebContentsView): void,
    removeWebContentsView(view: WebContentsView): void,
    getWebContentsViews(): WebContentsView[],
    setWebContentsView(view: WebContentsView | null): void,
    setWebContentsViewAutoResize(
      view: WebContentsView,
      options: { width?: boolean, height?: boolean },
    ): void,
  }
}
