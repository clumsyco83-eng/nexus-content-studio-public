export type ClaimStatus = 'PENDING' | 'VERIFIED' | 'REJECTED' | 'OPINION_OR_ADVICE';

export interface SourceReference {
  title: string;
  publisher?: string;
  url?: string;
  accessedAt?: string;
  note?: string;
}

export interface ContentClaim {
  id: string;
  slideIndex?: number;
  text: string;
  status: ClaimStatus;
  sources: SourceReference[];
  reviewerNote?: string;
}

export interface VerificationGateResult {
  ok: boolean;
  blockingClaims: ContentClaim[];
  rejectedClaims: ContentClaim[];
  warnings: string[];
}

export function evaluateVerificationGate(claims: ContentClaim[]): VerificationGateResult {
  const blockingClaims = claims.filter((claim) => claim.status === 'PENDING');
  const rejectedClaims = claims.filter((claim) => claim.status === 'REJECTED');
  const warnings: string[] = [];

  for (const claim of claims) {
    if (claim.status === 'VERIFIED' && claim.sources.length === 0) {
      blockingClaims.push(claim);
      warnings.push(`Claim ${claim.id} is marked VERIFIED but has no source reference.`);
    }

    if (claim.status === 'OPINION_OR_ADVICE' && claim.sources.length === 0) {
      warnings.push(`Claim ${claim.id} is advice/opinion; keep wording non-clinical and avoid implying scientific proof.`);
    }
  }

  return {
    ok: blockingClaims.length === 0 && rejectedClaims.length === 0,
    blockingClaims,
    rejectedClaims,
    warnings,
  };
}

export function assertVerificationReady(claims: ContentClaim[]): void {
  const result = evaluateVerificationGate(claims);
  if (!result.ok) {
    const blockers = [...result.blockingClaims, ...result.rejectedClaims]
      .map((claim) => `${claim.id}:${claim.status}`)
      .join(', ');
    throw new Error(`Content verification gate failed: ${blockers}`);
  }
}
