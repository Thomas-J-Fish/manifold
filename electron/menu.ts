import { app, Menu, MenuItemConstructorOptions, shell } from 'electron';
import * as path from 'node:path';

/** Every command the native menu can send to the renderer. Kept as a union so
 *  the renderer's dispatcher is exhaustively checked against this list. */
export type MenuCommand =
  | 'file.new'
  | 'file.open'
  | 'file.save'
  | 'file.saveAs'
  | 'file.saveThenClose'
  | 'file.exportPng'
  | 'file.exportCsv'
  | 'tab.new'
  | 'tab.close'
  | 'tab.next'
  | 'tab.prev'
  | 'tab.duplicate'
  | 'tab.rename'
  | 'view.resetViewport'
  | 'view.zoomIn'
  | 'view.zoomOut'
  | 'view.squareAxes'
  | 'view.toggleGrid'
  | 'view.toggleSidebar'
  | 'run.playPause'
  | 'run.step'
  | 'run.restart'
  | 'run.reseed'
  | 'help.shortcuts'
  | 'help.about'
  | 'help.examples';

interface MenuOptions {
  recents: string[];
  onCommand: (cmd: MenuCommand) => void;
  onOpenRecent: (filePath: string) => void;
  onClearRecents: () => void;
}

export function buildMenu(opts: MenuOptions): void {
  const isMac = process.platform === 'darwin';
  const send = (cmd: MenuCommand) => () => opts.onCommand(cmd);

  const recentItems: MenuItemConstructorOptions[] = opts.recents.length
    ? [
        ...opts.recents.map((p) => ({
          label: path.basename(p, '.manifold'),
          sublabel: path.dirname(p),
          click: () => opts.onOpenRecent(p),
        })),
        { type: 'separator' as const },
        { label: 'Clear Menu', click: () => opts.onClearRecents() },
      ]
    : [{ label: 'No Recent Projects', enabled: false }];

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { label: 'About Manifold', click: send('help.about') },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: send('file.new') },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: send('file.open') },
        { label: 'Open Recent', submenu: recentItems },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('file.save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: send('file.saveAs') },
        { type: 'separator' },
        { label: 'Export Plot as PNG…', accelerator: 'CmdOrCtrl+E', click: send('file.exportPng') },
        { label: 'Export Data as CSV…', accelerator: 'CmdOrCtrl+Shift+E', click: send('file.exportCsv') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Tab',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: send('tab.new') },
        { label: 'Duplicate Tab', accelerator: 'CmdOrCtrl+Shift+D', click: send('tab.duplicate') },
        { label: 'Rename Tab…', accelerator: 'CmdOrCtrl+R', click: send('tab.rename') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: send('tab.close') },
        { type: 'separator' },
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: send('tab.next') },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: send('tab.prev') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reset Viewport', accelerator: 'CmdOrCtrl+0', click: send('view.resetViewport') },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: send('view.zoomIn') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: send('view.zoomOut') },
        { label: 'Square Up Axes', accelerator: 'CmdOrCtrl+Alt+0', click: send('view.squareAxes') },
        { type: 'separator' },
        { label: 'Toggle Grid', accelerator: 'CmdOrCtrl+G', click: send('view.toggleGrid') },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: send('view.toggleSidebar') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
        { role: 'reload' },
      ],
    },
    {
      label: 'Run',
      submenu: [
        { label: 'Play / Pause', accelerator: 'Space', click: send('run.playPause') },
        { label: 'Step Forward', accelerator: 'Right', click: send('run.step') },
        { label: 'Restart', accelerator: 'CmdOrCtrl+Shift+R', click: send('run.restart') },
        { type: 'separator' },
        { label: 'New Random Seed', accelerator: 'CmdOrCtrl+Shift+N', click: send('run.reseed') },
      ],
    },
    {
      label: 'Window',
      submenu: isMac
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'close' }],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Load an Example…', click: send('help.examples') },
        { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: send('help.shortcuts') },
        { type: 'separator' },
        { label: 'About Manifold', click: send('help.about') },
        {
          label: 'Mathematical Notes',
          click: () => void shell.openExternal('https://en.wikipedia.org/wiki/Numerical_analysis'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
