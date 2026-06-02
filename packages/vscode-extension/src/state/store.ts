import * as vscode from 'vscode';

export interface AgentValetState {
  ownerId: string;
  orgId: string;
  agentId: string;
  agentName: string;
  proxyUrl: string;
  email: string;
  githubUsername: string;
  registeredAt: string;
  pendingApproval: boolean;
}

export class StateStore {
  constructor(private context: vscode.ExtensionContext) {}

  get(): Partial<AgentValetState> {
    return this.context.globalState.get<AgentValetState>(
      'agentvaletState',
      {} as AgentValetState
    );
  }

  set(state: Partial<AgentValetState>): void {
    const existing = this.get();
    this.context.globalState.update('agentvaletState', {
      ...existing,
      ...state,
    });
  }

  clear(): void {
    this.context.globalState.update('agentvaletState', undefined);
  }

  isRegistered(): boolean {
    return !!this.get().agentId;
  }

  isPendingApproval(): boolean {
    return this.get().pendingApproval === true;
  }
}
