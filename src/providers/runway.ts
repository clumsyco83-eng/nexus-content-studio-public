export type RunwayVideoModel =
  | 'gen4.5'
  | 'veo3.1'
  | 'veo3.1_fast'
  | 'veo3'
  | 'seedance2'
  | 'seedance2_fast'
  | 'seedance2_mini'
  | 'gemini_omni_flash'
  | 'happyhorse_1_0';

export interface RunwayTextToVideoRequest {
  promptText: string;
  model: RunwayVideoModel;
  ratio: '1280:720' | '720:1280';
  duration: number;
  seed?: number;
  negativePrompt?: string;
}

export interface RunwayTask {
  id: string;
  status?: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | string;
  output?: string[];
  failure?: string;
  failureCode?: string;
}

export interface RunwayProviderOptions {
  apiKey?: string;
  allowPaidGeneration?: boolean;
  baseUrl?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export class RunwayProvider {
  private readonly apiKey?: string;
  private readonly allowPaidGeneration: boolean;
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;

  constructor(options: RunwayProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.RUNWAYML_API_SECRET;
    this.allowPaidGeneration = options.allowPaidGeneration ?? process.env.NEXUS_ALLOW_PAID_GENERATION === 'true';
    this.baseUrl = options.baseUrl ?? 'https://api.dev.runwayml.com';
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;
    this.timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  private headers(): Record<string, string> {
    if (!this.apiKey) throw new Error('RUNWAYML_API_SECRET is not configured.');
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'X-Runway-Version': '2024-11-06',
    };
  }

  async createTextToVideo(request: RunwayTextToVideoRequest): Promise<RunwayTask> {
    if (!this.allowPaidGeneration) {
      throw new Error('Paid generation is disabled. Set NEXUS_ALLOW_PAID_GENERATION=true locally only after owner approval.');
    }
    if (request.promptText.length < 1 || request.promptText.length > 1000) {
      throw new Error('Runway promptText must contain 1-1000 characters.');
    }
    if (!Number.isInteger(request.duration) || request.duration < 2 || request.duration > 10) {
      throw new Error('Runway text-to-video duration must be an integer from 2 to 10 seconds.');
    }

    const response = await fetch(`${this.baseUrl}/v1/text_to_video`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`Runway generation request failed (${response.status}): ${await response.text()}`);
    }

    return await response.json() as RunwayTask;
  }

  async getTask(taskId: string): Promise<RunwayTask> {
    const response = await fetch(`${this.baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`, {
      method: 'GET',
      headers: this.headers(),
    });
    if (!response.ok) {
      throw new Error(`Runway task lookup failed (${response.status}): ${await response.text()}`);
    }
    return await response.json() as RunwayTask;
  }

  async waitForTask(taskId: string): Promise<RunwayTask> {
    const started = Date.now();
    while (Date.now() - started < this.timeoutMs) {
      const task = await this.getTask(taskId);
      if (task.status === 'SUCCEEDED') return task;
      if (task.status === 'FAILED' || task.status === 'CANCELLED') {
        throw new Error(`Runway task ${taskId} ended with status ${task.status}: ${task.failure ?? task.failureCode ?? 'unknown failure'}`);
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
    throw new Error(`Timed out waiting for Runway task ${taskId}.`);
  }

  async generateTextToVideo(request: RunwayTextToVideoRequest): Promise<RunwayTask> {
    const task = await this.createTextToVideo(request);
    return await this.waitForTask(task.id);
  }
}
