import { contextBridge, ipcRenderer } from 'electron';

/* The whole of the renderer's privilege lives in this file. It exposes a fixed
 * set of named operations — never `ipcRenderer` itself, and never a generic
 * `invoke(channel, ...)`, which would hand the renderer the entire main-process
 * surface and defeat context isolation. Keep this list in step with the
 * `ManifoldBridge` type in src/core/bridge.ts. */

type Unsubscribe = () => void;

const bridge = {
  openProject: () =>
    ipcRenderer.invoke('project:open') as Promise<{ path: string; text: string } | null>,

  readProject: (filePath: string) =>
    ipcRenderer.invoke('project:read', filePath) as Promise<{ path: string; text: string }>,

  saveProject: (args: { path: string | null; text: string; suggestedName?: string }) =>
    ipcRenderer.invoke('project:save', args) as Promise<{ path: string } | null>,

  exportText: (args: { defaultName: string; text: string; extensions: string[]; typeName: string }) =>
    ipcRenderer.invoke('file:exportText', args) as Promise<{ path: string } | null>,

  exportBinary: (args: {
    defaultName: string;
    dataUrl: string;
    extensions: string[];
    typeName: string;
  }) => ipcRenderer.invoke('file:exportBinary', args) as Promise<{ path: string } | null>,

  importText: (args: { extensions: string[]; typeName: string }) =>
    ipcRenderer.invoke('file:importText', args) as Promise<{ path: string; text: string } | null>,

  confirmDiscard: (args: { verb: string }) =>
    ipcRenderer.invoke('app:confirmDiscard', args) as Promise<'save' | 'discard' | 'cancel'>,

  setDirty: (dirty: boolean) => ipcRenderer.send('app:setDirty', dirty),
  setTitle: (title: string) => ipcRenderer.send('app:setTitle', title),
  confirmClose: () => ipcRenderer.send('app:closeConfirmed'),

  info: () =>
    ipcRenderer.invoke('app:info') as Promise<{
      version: string;
      electron: string;
      chrome: string;
      node: string;
      platform: string;
      arch: string;
    }>,

  onMenuCommand: (handler: (cmd: string) => void): Unsubscribe => {
    const listener = (_e: unknown, cmd: string) => handler(cmd);
    ipcRenderer.on('menu:command', listener);
    return () => ipcRenderer.removeListener('menu:command', listener);
  },

  onProjectOpened: (handler: (p: { path: string; text: string }) => void): Unsubscribe => {
    const listener = (_e: unknown, payload: { path: string; text: string }) => handler(payload);
    ipcRenderer.on('project:opened', listener);
    return () => ipcRenderer.removeListener('project:opened', listener);
  },
};

contextBridge.exposeInMainWorld('manifold', bridge);
