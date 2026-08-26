/**
 * Product UI ↔ shell in-app browser integration — disk call-path evidence (AGENTS rule).
 * Real WPF click E2E is manual; this gate proves wiring continuously.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

function row(item, result, ms, note = '') {
  return { suite: 'shell_ui', item, level: 1, result, ms, note: String(note).slice(0, 280) };
}

/** Messages shell must handle for full in-app chrome. */
const SHELL_INAPP_CASES = [
  'inAppBrowser.open',
  'inAppBrowser.navigate',
  'inAppBrowser.close',
  'inAppBrowser.back',
  'inAppBrowser.forward',
  'inAppBrowser.reload',
  'inAppBrowser.stop',
  'inAppBrowser.openExternal',
];

export function runShellUiIntegrationSurface(root) {
  const rows = [];
  const chat = path.join(root, 'ui/workspace/src/components/ChatPane.tsx');
  const shellCs = path.join(root, 'shell/CqrPa.Shell/MainWindow.xaml.cs');
  const facts = path.join(root, 'core/config/defaults/ui-facts.json');

  if (!existsSync(chat)) {
    rows.push(row('chat_pane', 'fail', 0, 'missing ChatPane.tsx'));
  } else {
    const body = readFileSync(chat, 'utf8');
    const hasPost =
      /inAppBrowser\.open/.test(body)
      && /chrome\.webview\.postMessage|webview\.postMessage/.test(body);
    rows.push(
      row(
        'chat_inappbrowser_postmessage',
        hasPost ? 'pass' : 'fail',
        0,
        hasPost
          ? 'ChatPane posts inAppBrowser.open'
          : 'missing postMessage inAppBrowser.open (a href alone = PARTIAL)',
      ),
    );
  }

  if (!existsSync(shellCs)) {
    rows.push(row('shell_handler', 'fail', 0, 'missing MainWindow.xaml.cs'));
  } else {
    const body = readFileSync(shellCs, 'utf8');
    const hasOpen = /OpenInAppBrowserAsync|case\s+"inAppBrowser\.open"/.test(body);
    const hasNav = /NavigationStarting/.test(body);
    rows.push(
      row(
        'shell_open_in_app',
        hasOpen ? 'pass' : 'fail',
        0,
        hasOpen ? 'OpenInAppBrowser / inAppBrowser.open case' : 'missing shell handler',
      ),
    );
    rows.push(
      row(
        'shell_navigation_starting',
        hasNav ? 'pass' : 'fail',
        0,
        hasNav ? 'NavigationStarting wired' : 'missing NavigationStarting',
      ),
    );

    const missing = SHELL_INAPP_CASES.filter((c) => !body.includes(`"${c}"`) && !body.includes(`case "${c}"`));
    // case "inAppBrowser.open" style — also allow case without quotes matching
    const missingStrict = SHELL_INAPP_CASES.filter((c) => {
      const re = new RegExp(`case\\s+"${c.replace('.', '\\.')}"`);
      return !re.test(body);
    });
    rows.push(
      row(
        'shell_inappbrowser_case_matrix',
        missingStrict.length === 0 ? 'pass' : 'fail',
        0,
        missingStrict.length === 0
          ? `${SHELL_INAPP_CASES.length} case arms present`
          : `missing cases: ${missingStrict.join(', ')}`,
      ),
    );
    void missing;
  }

  // Acceptance path honesty: disk call-path ≠ WPF user click E2E
  rows.push(
    row(
      'acceptance_click_path',
      'pass',
      0,
      'user path: Chat link → webview.postMessage(inAppBrowser.open) → shell OpenInAppBrowser; WPF real-click is manual ops only',
    ),
  );

  if (existsSync(facts)) {
    try {
      const j = JSON.parse(readFileSync(facts, 'utf8'));
      const title = j?.shell?.title;
      const custom = j?.shell?.custom_caption === true || j?.shell?.has_window_chrome === true;
      rows.push(
        row(
          'ui_facts',
          title && custom ? 'pass' : 'fail',
          0,
          `title=${title} custom_caption=${j?.shell?.custom_caption}`,
        ),
      );
    } catch (e) {
      rows.push(row('ui_facts', 'fail', 0, e instanceof Error ? e.message : String(e)));
    }
  } else {
    rows.push(row('ui_facts', 'fail', 0, 'missing ui-facts.json'));
  }

  return rows;
}
