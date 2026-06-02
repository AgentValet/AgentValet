import { createOAuthDeviceAuth } from '@octokit/auth-oauth-device';
import open from 'open';
import chalk from 'chalk';

// AgentValet's GitHub OAuth App client ID — public value, safe to commit
const GITHUB_CLIENT_ID = process.env.AGENTVALET_GITHUB_CLIENT_ID
  ?? 'Ov23liQcaW0HcqJxmLfF';

export interface GitHubAuthResult {
  token: string;
  scopes: string[];
}

export async function authenticateWithGitHub(): Promise<GitHubAuthResult> {
  const auth = createOAuthDeviceAuth({
    clientType: 'oauth-app',
    clientId: GITHUB_CLIENT_ID,
    scopes: ['user:email', 'read:user'],

    onVerification(verification) {
      console.log('');
      console.log(chalk.bold('  Authenticate with GitHub'));
      console.log('');
      console.log(`  1. Open: ${chalk.cyan.underline(verification.verification_uri)}`);
      console.log(`  2. Enter code: ${chalk.bold.yellow(verification.user_code)}`);
      console.log('');
      open(verification.verification_uri).catch(() => {
        console.log(chalk.dim('  (Could not open browser — navigate to the URL above manually)'));
      });
      console.log(chalk.dim('  Waiting for authorisation...'));
    },
  });

  const tokenAuth = await auth({ type: 'oauth' });

  return {
    token: tokenAuth.token,
    scopes: tokenAuth.scopes ?? [],
  };
}

export async function getGitHubUser(token: string) {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status}`);
  }

  const user = await response.json() as {
    login: string;
    name: string | null;
    email: string | null;
    avatar_url: string;
    id: number;
  };

  if (!user.email) {
    const emailsResponse = await fetch('https://api.github.com/user/emails', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (emailsResponse.ok) {
      const emails = await emailsResponse.json() as Array<{
        email: string;
        primary: boolean;
        verified: boolean;
      }>;

      user.email = emails.find(e => e.primary && e.verified)?.email
        ?? emails[0]?.email
        ?? null;
    }
  }

  return user;
}
