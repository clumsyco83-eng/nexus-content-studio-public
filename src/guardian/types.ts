export type GuardianStatus = 'GREEN' | 'YELLOW' | 'RED';

export interface GuardianCheck {
  name: string;
  ok: boolean;
  severity: 'info' | 'warning' | 'critical';
  details: string;
  durationMs?: number;
}

export interface GuardianReport {
  id: string;
  generatedAt: string;
  status: GuardianStatus;
  score: number;
  summary: string;
  checks: GuardianCheck[];
  counters: {
    passed: number;
    failed: number;
    criticalFailures: number;
    warningFailures: number;
  };
  recommendations: string[];
}
