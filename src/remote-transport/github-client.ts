export interface GitHubRemoteIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  htmlUrl: string;
  authorLogin: string;
  labels: string[];
}

export interface GitHubRemoteClient {
  listOpenCommandIssues(): Promise<GitHubRemoteIssue[]>;
  comment(issueNumber: number, body: string): Promise<void>;
  close(issueNumber: number): Promise<void>;
}

export interface GitHubIssueRemoteClientOptions {
  repository: string;
  token: string;
  label: string;
  apiBaseUrl?: string;
  requestTimeoutMs?: number;
}

interface GitHubIssueResponse {
  id?: number;
  number?: number;
  title?: string;
  body?: string | null;
  html_url?: string;
  user?: { login?: string };
  labels?: Array<string | { name?: string }>;
  pull_request?: unknown;
}

function repositoryParts(repository: string): { owner: string; repo: string } {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository.trim());
  if (!match) throw new Error('Remote GitHub repository must be in owner/name form.');
  return { owner: match[1]!, repo: match[2]! };
}

function labelNames(input: GitHubIssueResponse['labels']): string[] {
  return (input ?? []).map((label) => typeof label === 'string' ? label : label.name ?? '').filter(Boolean);
}

export class GitHubIssueRemoteClient implements GitHubRemoteClient {
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly owner: string;
  private readonly repo: string;

  constructor(private readonly options: GitHubIssueRemoteClientOptions) {
    if (!options.token.trim()) throw new Error('NEXUS remote GitHub token is required.');
    if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(options.label)) throw new Error('Remote GitHub label is invalid.');
    const parts = repositoryParts(options.repository);
    this.owner = parts.owner;
    this.repo = parts.repo;
    this.apiBaseUrl = (options.apiBaseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.timeoutMs = options.requestTimeoutMs ?? 10_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 30_000) {
      throw new Error('GitHub transport request timeout must be from 1000 to 30000 ms.');
    }
  }

  async listOpenCommandIssues(): Promise<GitHubRemoteIssue[]> {
    const query = new URLSearchParams({
      state: 'open',
      labels: this.options.label,
      sort: 'created',
      direction: 'asc',
      per_page: '20',
    });
    const payload = await this.request(`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/issues?${query.toString()}`);
    if (!Array.isArray(payload)) throw new Error('GitHub Issues response was not an array.');

    const issues: GitHubRemoteIssue[] = [];
    for (const raw of payload as GitHubIssueResponse[]) {
      if (raw.pull_request) continue;
      if (!Number.isInteger(raw.id) || !Number.isInteger(raw.number)) continue;
      if (typeof raw.title !== 'string' || typeof raw.user?.login !== 'string') continue;
      issues.push({
        id: raw.id!,
        number: raw.number!,
        title: raw.title,
        body: typeof raw.body === 'string' ? raw.body : null,
        htmlUrl: typeof raw.html_url === 'string' ? raw.html_url : '',
        authorLogin: raw.user.login,
        labels: labelNames(raw.labels),
      });
    }
    return issues;
  }

  async comment(issueNumber: number, body: string): Promise<void> {
    if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error('Invalid GitHub issue number.');
    const bounded = body.slice(0, 60_000);
    await this.request(`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/issues/${issueNumber}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: bounded }),
    });
  }

  async close(issueNumber: number): Promise<void> {
    if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error('Invalid GitHub issue number.');
    await this.request(`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/issues/${issueNumber}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed' }),
    });
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.apiBaseUrl}${path}`, {
        ...init,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.options.token}`,
          'content-type': 'application/json',
          'user-agent': 'nexus-remote-transport-v1',
          'x-github-api-version': '2022-11-28',
        },
      });
      const length = Number(response.headers.get('content-length') ?? '0');
      if (Number.isFinite(length) && length > 2 * 1024 * 1024) throw new Error('GitHub transport response exceeded 2 MiB.');
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) throw new Error('GitHub transport response exceeded 2 MiB.');
      if (!response.ok) throw new Error(`GitHub transport request failed with HTTP ${response.status}.`);
      if (!text) return {};
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error('GitHub transport returned invalid JSON.');
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('GitHub transport request timed out.');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
