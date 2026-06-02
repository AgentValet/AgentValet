import * as vscode from 'vscode';
import { StateStore } from '../state/store';

export function createStatusBar(): vscode.StatusBarItem {
  const bar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  bar.command = 'agentvalet.showStatus';
  return bar;
}

export function updateStatusBar(
  bar: vscode.StatusBarItem,
  store: StateStore,
): void {
  const showStatusBar = vscode.workspace
    .getConfiguration('agentvalet')
    .get('showStatusBar', true);

  if (!showStatusBar) {
    bar.hide();
    return;
  }

  const state = store.get();

  if (!store.isRegistered()) {
    bar.text = '$(shield) AgentValet';
    bar.tooltip = 'AgentValet: Not registered. Click to set up.';
    bar.command = 'agentvalet.register';
    bar.show();
    return;
  }

  if (store.isPendingApproval()) {
    bar.text = '$(clock) AgentValet: Pending approval';
    bar.tooltip =
      `Agent: ${state.agentName}\n` +
      `Waiting for your approval in the dashboard.\n` +
      `Click to open dashboard.`;
    bar.command = 'agentvalet.openDashboard';
    bar.show();
    return;
  }

  bar.text = '$(shield-check) AgentValet';
  bar.tooltip =
    `Agent: ${state.agentName}\n` +
    `ID: ${state.agentId}\n` +
    `Status: Active\n` +
    `Click to open dashboard`;
  bar.command = 'agentvalet.openDashboard';
  bar.show();
}
