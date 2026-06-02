import * as vscode from 'vscode';

export interface GitHubSession {
  token: string;
  accountName: string;
  accountId: string;
  scopes: string[];
}

export async function getExistingGitHubSession(): Promise<GitHubSession | null> {
  try {
    const session = await vscode.authentication.getSession(
      'github',
      ['user:email', 'read:user'],
      { createIfNone: false, silent: true }
    );
    if (!session) return null;
    return {
      token: session.accessToken,
      accountName: session.account.label,
      accountId: session.account.id,
      scopes: session.scopes,
    };
  } catch {
    return null;
  }
}

export async function requestGitHubSession(): Promise<GitHubSession | null> {
  try {
    const session = await vscode.authentication.getSession(
      'github',
      ['user:email', 'read:user'],
      { createIfNone: true }
    );
    if (!session) return null;
    return {
      token: session.accessToken,
      accountName: session.account.label,
      accountId: session.account.id,
      scopes: session.scopes,
    };
  } catch {
    return null;
  }
}
