import * as vscode from 'vscode';
import { getExistingGitHubSession } from '../auth/github-session';
import { createOrFindAccount, registerAgent, detectEditor, fetchWithTimeout } from '../api/client';
import { StateStore } from '../state/store';
import { updateStatusBar } from '../ui/status-bar';

export async function attemptAutoRegistration(
  store: StateStore,
  secretStorage: vscode.SecretStorage,
  statusBar: vscode.StatusBarItem,
): Promise<void> {
  if (store.isRegistered()) return;

  const autoRegister = vscode.workspace
    .getConfiguration('agentvalet')
    .get('autoRegister', true);
  if (!autoRegister) return;

  const session = await getExistingGitHubSession();
  if (!session) return;

  statusBar.text = '$(sync~spin) AgentValet: Setting up...';
  statusBar.show();

  try {
    // Fetch primary verified email from GitHub
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

    // Store private key in OS-keychain-backed secret storage
    await secretStorage.store(
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

    const message = account.is_new_account
      ? `AgentValet: Account created for @${session.accountName}. Agent "${agent.agent_name}" is pending approval.`
      : `AgentValet: Agent "${agent.agent_name}" registered. Pending your approval in the dashboard.`;

    const action = await vscode.window.showInformationMessage(
      message,
      'Approve now',
      'Dismiss',
    );

    if (action === 'Approve now') {
      vscode.env.openExternal(vscode.Uri.parse('https://app.agentvalet.ai/agents'));
    }

    updateStatusBar(statusBar, store);

  } catch (err: any) {
    // Silent failure — never interrupt the developer with an error notification
    statusBar.hide();
    console.error('[AgentValet] Auto-registration failed:', err.message);
  }
}
