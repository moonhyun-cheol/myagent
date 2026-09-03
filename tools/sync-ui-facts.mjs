#!/usr/bin/env node
/**
 * Scan live UI sources → core/config/defaults/ui-facts.json
 * Injected into the code agent so it trusts build-time facts over model memory.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readText(rel) {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) return null;
  return readFileSync(abs, 'utf8');
}

function attr(xml, name) {
  const m = xml.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return m ? m[1] : null;
}

function firstMatch(text, re) {
  const m = text.match(re);
  return m ? (m[1] ?? m[0]) : null;
}

const mainWinRel = 'shell/CqrPa.Shell/MainWindow.xaml';
const mainWin = readText(mainWinRel) ?? '';
const navRel = 'ui/workspace/src/components/GeminiNavSidebar.tsx';
const nav = readText(navRel) ?? '';
const treeRel = 'ui/workspace/src/components/ProjectsTree.tsx';
const tree = readText(treeRel) ?? '';
const confirmModalRel = 'ui/workspace/src/components/ConfirmModal.tsx';
const confirmLibRel = 'ui/workspace/src/lib/confirmDialog.ts';
const chatPaneRel = 'ui/workspace/src/components/ChatPane.tsx';

const titleBarBg = firstMatch(mainWin, /<!-- Custom title bar[\s\S]*?Background="(#[0-9A-Fa-f]{3,8})"/)
  || firstMatch(mainWin, /Grid\.Row="0"[\s\S]*?Background="(#[0-9A-Fa-f]{3,8})"/);
const accent = firstMatch(mainWin, /Background="(#2dd4bf|#[0-9A-Fa-f]{6})"\s+Margin="0,0,10/);
const captionText = firstMatch(mainWin, /TextBlock\s+Text="([^"]+)"/);

const facts = {
  version: 1,
  generated_at: new Date().toISOString(),
  note: 'Build-generated. Code agent must prefer this over memory. Re-run: node tools/sync-ui-facts.mjs',
  shell: {
    main_window: mainWinRel,
    title: attr(mainWin, 'Title'),
    window_style: attr(mainWin, 'WindowStyle'),
    has_window_chrome: /WindowChrome/.test(mainWin),
    caption_height: firstMatch(mainWin, /CaptionHeight="(\d+)"/),
    title_bar_background: titleBarBg,
    title_bar_label: captionText,
    accent_bar: accent,
    custom_caption: attr(mainWin, 'WindowStyle') === 'None' && /WindowChrome/.test(mainWin),
  },
  workspace: {
    chat_pane: existsSync(path.join(root, chatPaneRel)) ? chatPaneRel : null,
    confirm_modal: existsSync(path.join(root, confirmModalRel)) ? confirmModalRel : null,
    confirm_dialog_helper: existsSync(path.join(root, confirmLibRel)) ? confirmLibRel : null,
    nav_sidebar: existsSync(path.join(root, navRel)) ? navRel : null,
    projects_tree: existsSync(path.join(root, treeRel)) ? treeRel : null,
    nav_uses_confirm_dialog: /confirmDialog\s*\(/.test(nav),
    nav_uses_window_confirm: /\bconfirm\s*\(/.test(nav) && !/confirmDialog/.test(nav),
    tree_uses_confirm_dialog: /confirmDialog\s*\(/.test(tree),
  },
  targets: {
    title_bar: [mainWinRel, 'shell/CqrPa.Shell/DarkTitleBar.cs', 'shell/CqrPa.Shell/MainWindow.xaml.cs'],
    delete_confirm: [confirmModalRel, confirmLibRel, navRel, treeRel],
    composer: [chatPaneRel, 'ui/workspace/src/store/workspaceStore.ts'],
    document: [
      'ui/workspace/src/components/MarkdownDocument.tsx',
      'ui/workspace/src/lib/documentFile.ts',
      'ui/workspace/src/lib/documentMemo.ts',
      'ui/workspace/src/components/workspacePreviewModes.ts',
      'ui/workspace/src/store/workspaceStore.ts',
      'core/config/defaults/document-scratch.json',
    ],
  },
  work_kit_launcher: {
    shell: existsSync(path.join(root, 'shell/WorkKitLauncher/MainWindow.xaml'))
      ? 'shell/WorkKitLauncher/MainWindow.xaml'
      : null,
    ui: existsSync(path.join(root, 'ui/work-kit-launcher/src/App.tsx'))
      ? 'ui/work-kit-launcher/src/App.tsx'
      : null,
    profile_library: existsSync(path.join(root, 'ui/work-kit-launcher/src/components/ProfileLibrary.tsx'))
      ? 'ui/work-kit-launcher/src/components/ProfileLibrary.tsx'
      : null,
    serve_path: '/launcher/',
  },
};

const outDir = path.join(root, 'core', 'config', 'defaults');
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'ui-facts.json');
writeFileSync(outPath, `${JSON.stringify(facts, null, 2)}\n`, 'utf8');

const lines = [
  `sync-ui-facts: ${outPath}`,
  `  shell.title=${facts.shell.title} window_style=${facts.shell.window_style} custom=${facts.shell.custom_caption}`,
  `  confirmDialog nav=${facts.workspace.nav_uses_confirm_dialog} tree=${facts.workspace.tree_uses_confirm_dialog}`,
];
console.log(lines.join('\n'));
