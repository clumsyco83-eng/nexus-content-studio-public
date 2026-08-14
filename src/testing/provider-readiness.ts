import 'dotenv/config';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RunwayProvider } from '../providers/runway.js';

export interface ProviderReadinessReport {
  paidGenerationAllowed: boolean;
  higgsfield: {
    enabled: boolean;
    mcpUrl: string;
    requiresInteractiveAuth: true;
  };
  runway: {
    configured: boolean;
    paidCallsBlocked: boolean;
  };
  safeToSmokeTest: boolean;
  notes: string[];
}

export function providerReadiness(): ProviderReadinessReport {
  const paidGenerationAllowed = process.env.NEXUS_ALLOW_PAID_GENERATION === 'true';
  const runway = new RunwayProvider({ allowPaidGeneration: paidGenerationAllowed });
  const higgsfieldEnabled = process.env.HIGGSFIELD_ENABLED === 'true';
  const notes: string[] = [];

  if (!paidGenerationAllowed) {
    notes.push('Paid generation is safely disabled.');
  } else {
    notes.push('WARNING: paid generation is enabled in the local environment.');
  }

  if (!runway.isConfigured()) {
    notes.push('Runway is not configured; set RUNWAYML_API_SECRET locally when ready.');
  }

  if (!higgsfieldEnabled) {
    notes.push('Higgsfield is disabled until CLI/MCP authentication is completed locally.');
  }

  return {
    paidGenerationAllowed,
    higgsfield: {
      enabled: higgsfieldEnabled,
      mcpUrl: process.env.HIGGSFIELD_MCP_URL ?? 'https://mcp.higgsfield.ai/mcp',
      requiresInteractiveAuth: true,
    },
    runway: {
      configured: runway.isConfigured(),
      paidCallsBlocked: !paidGenerationAllowed,
    },
    safeToSmokeTest: !paidGenerationAllowed,
    notes,
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  console.log(JSON.stringify(providerReadiness(), null, 2));
}
