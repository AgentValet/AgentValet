import * as vscode from 'vscode';
import { StateStore } from '../state/store';
import { requestGitHubSession } from '../auth/github-session';
import { createOrFindAccount, registerAgent, detectEditor, fetchWithTimeout } from '../api/client';
import { updateStatusBar } from '../ui/status-bar';

export function registerCommands(
  context: vscode.ExtensionContext,
  store: StateStore,
  statusBar: vscode.StatusBarItem,
): void {

  // ── agentvalet.register ──────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('agentvalet.register', async () => {
      if (store.isRegistered()) {
        const state = store.get();
        const action = await vscode.window.showInformationMessage(
          `Already registered as "${state.agentName}" (${state.agentId}).`,
          'Open dashboard',
          'Re-register',
          'Cancel',
        );
        if (action === 'Open dashboard') {
          vscode.env.openExternal(vscode.Uri.parse('https://app.agentvalet.ai'));
        } else if (action === 'Re-register') {
          store.clear();
          // fall through to registration below
        } else {
          return;
        }
      }

      const session = await requestGitHubSession();
      if (!session) {
        vscode.window.showWarningMessage(
          'AgentValet: GitHub sign-in cancelled. Previous registration was cleared — run the command again to re-register.',
        );
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'AgentValet: Registering agent...',
          cancellable: false,
        },
        async () => {
          try {
            const emailResponse = await fetchWithTimeout('https://api.github.com/user/emails', {
              headers: { Authorization: `Bearer ${session.token}` },
            });
            const emails = emailResponse.ok
              ? await emailResponse.json() as Array<{ email: string; primary: boolean; verified: boolean }>
              : [];
            const email = emails.find(e => e.primary && e.verified)?.email
              ?? `${session.accountName}@users.noreply.github.com`;

            const account = await createOrFindAccount({
              github_token: session.token,
              github_username: session.accountName,
              email,
              display_name: session.accountName,
            });

            const editor = detectEditor();
            const agent = await registerAgent(
              {
                owner_id: account.owner_id,
                name: `${session.accountName} — ${editor}`,
                source: 'vscode',
                description: `Registered via AgentValet VSCode extension (${editor})`,
              },
              account.owner_id,
            );

            await context.secrets.store(
              `agentvalet.privateKey.${agent.agent_id}`,
              agent.private_key_pem,
            );

            store.set({
              ownerId: account.owner_id,
              orgId: account.org_id,
              agentId: agent.agent_id,
              agentName: agent.agent_name,
              proxyUrl: account.proxy_url,
              email,
              githubUsername: session.accountName,
              registeredAt: new Date().toISOString(),
              pendingApproval: true,
            });

            updateStatusBar(statusBar, store);

            const action = await vscode.window.showInformationMessage(
              `Agent "${agent.agent_name}" registered. Approve it in the dashboard to activate.`,
              'Approve now',
              'Dismiss',
            );
            if (action === 'Approve now') {
              vscode.env.openExternal(vscode.Uri.parse('https://app.agentvalet.ai/agents'));
            }
          } catch (err: any) {
            vscode.window.showErrorMessage(`AgentValet: Registration failed — ${err.message}`);
          }
        },
      );
    }),
  );

  // ── agentvalet.openDashboard ─────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('agentvalet.openDashboard', () => {
      vscode.env.openExternal(vscode.Uri.parse('https://app.agentvalet.ai'));
    }),
  );

  // ── agentvalet.showStatus ────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('agentvalet.showStatus', async () => {
      const state = store.get();

      if (!store.isRegistered()) {
        const action = await vscode.window.showInformationMessage(
          'AgentValet: Not registered.',
          'Register now',
          'Cancel',
        );
        if (action === 'Register now') {
          vscode.commands.executeCommand('agentvalet.register');
        }
        return;
      }

      const statusLine = state.pendingApproval ? 'Pending approval' : 'Active';
      const items = [
        `Agent: ${state.agentName}`,
        `ID: ${state.agentId}`,
        `Status: ${statusLine}`,
        `Proxy: ${state.proxyUrl}`,
        'Open dashboard →',
        'Copy proxy URL',
        'Sign out',
      ];

      const selected = await vscode.window.showQuickPick(items, {
        title: 'AgentValet Status',
        placeHolder: 'Select an action',
      });

      if (selected === 'Open dashboard →') {
        vscode.commands.executeCommand('agentvalet.openDashboard');
      } else if (selected === 'Copy proxy URL') {
        vscode.commands.executeCommand('agentvalet.copyProxyUrl');
      } else if (selected === 'Sign out') {
        vscode.commands.executeCommand('agentvalet.signOut');
      }
    }),
  );

  // ── agentvalet.copyProxyUrl ──────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('agentvalet.copyProxyUrl', async () => {
      const state = store.get();
      if (!state.proxyUrl) {
        vscode.window.showWarningMessage('AgentValet: Not registered yet.');
        return;
      }
      await vscode.env.clipboard.writeText(state.proxyUrl);
      vscode.window.showInformationMessage('AgentValet: Proxy URL copied to clipboard.');
    }),
  );

  // ── agentvalet.signOut ───────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('agentvalet.signOut', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'AgentValet: Sign out? Your agent will remain registered in the dashboard.',
        { modal: true },
        'Sign out',
      );
      if (confirm === 'Sign out') {
        const agentId = store.get().agentId;
        if (agentId) {
          await context.secrets.delete(`agentvalet.privateKey.${agentId}`);
        }
        store.clear();
        updateStatusBar(statusBar, store);
        vscode.window.showInformationMessage('AgentValet: Signed out.');
      }
    }),
  );
}
