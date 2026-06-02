import * as vscode from 'vscode';
import { StateStore } from './state/store';
import { createStatusBar, updateStatusBar } from './ui/status-bar';
import { registerCommands } from './commands/index';
import { attemptAutoRegistration } from './registration/auto-register';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const store = new StateStore(context);
  const statusBar = createStatusBar();
  context.subscriptions.push(statusBar);

  registerCommands(context, store, statusBar);
  updateStatusBar(statusBar, store);

  // Auto-registration after 3s — never blocks editor startup
  setTimeout(() => {
    attemptAutoRegistration(store, context.secrets, statusBar).then(() => {
      updateStatusBar(statusBar, store);
    }).catch(() => {
      // Silent — auto-registration is best-effort
    });
  }, 3000);

  // Re-attempt when GitHub auth changes
  context.subscriptions.push(
    vscode.authentication.onDidChangeSessions(async (e) => {
      if (e.provider.id === 'github' && !store.isRegistered()) {
        await attemptAutoRegistration(store, context.secrets, statusBar);
        updateStatusBar(statusBar, store);
      }
    }),
  );
}

export function deactivate(): void {
  // Nothing to clean up — subscriptions are disposed automatically
}
