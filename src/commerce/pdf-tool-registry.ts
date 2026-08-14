export type PdfToolCostClass = 'free_local' | 'free_tier' | 'optional_paid' | 'usage_paid';
export type PdfToolStatus = 'active_core' | 'planned_adapter' | 'optional_adapter';

export interface PdfToolDefinition {
  id:
    | 'nexus'
    | 'html_css_templates'
    | 'weasyprint'
    | 'local_qa'
    | 'canva_free'
    | 'canva_pro'
    | 'claude'
    | 'ai_image_generation';
  name: string;
  role: string;
  costClass: PdfToolCostClass;
  status: PdfToolStatus;
  useWhen: string[];
  avoidWhen?: string[];
}

export const COMMERCE_PDF_TOOLS: PdfToolDefinition[] = [
  {
    id: 'nexus',
    name: 'NEXUS',
    role: 'Orchestrator, policy enforcement, routing, approvals, logging, and repair-loop control',
    costClass: 'free_local',
    status: 'active_core',
    useWhen: ['Coordinate every PDF job', 'Choose tools', 'Enforce approval and quality gates'],
  },
  {
    id: 'html_css_templates',
    name: 'HTML/CSS Templates',
    role: 'Reusable printable layouts, tables, trackers, typography, spacing, and page components',
    costClass: 'free_local',
    status: 'planned_adapter',
    useWhen: ['Build repeatable inner pages', 'Create A4 and US Letter variants', 'Keep layout deterministic'],
  },
  {
    id: 'weasyprint',
    name: 'WeasyPrint',
    role: 'Local HTML/CSS-to-PDF renderer for high-volume printable production',
    costClass: 'free_local',
    status: 'planned_adapter',
    useWhen: ['Render final printable PDFs', 'Produce repeated worksheet/tracker pages', 'Avoid AI token use for page drawing'],
  },
  {
    id: 'local_qa',
    name: 'Local QA Tools',
    role: 'Deterministic PDF inspection for spelling, geometry, page size, margins, duplicates, integrity, and printability',
    costClass: 'free_local',
    status: 'planned_adapter',
    useWhen: ['Run every PDF before visual review', 'Catch objective defects cheaply', 'Generate exact repair feedback'],
  },
  {
    id: 'canva_free',
    name: 'Canva Free',
    role: 'Optional visual design workspace for covers, mockups, brand exploration, and reusable design references',
    costClass: 'free_tier',
    status: 'optional_adapter',
    useWhen: ['A human-assisted visual design pass is useful', 'Create covers or listing imagery'],
    avoidWhen: ['Bulk repetitive inner-page rendering can be handled locally'],
  },
  {
    id: 'canva_pro',
    name: 'Canva Pro',
    role: 'Optional premium Canva capabilities when account features justify the cost',
    costClass: 'optional_paid',
    status: 'optional_adapter',
    useWhen: ['Premium assets or brand-management features materially improve the product'],
    avoidWhen: ['The free/local toolchain already meets the acceptance criteria'],
  },
  {
    id: 'claude',
    name: 'Claude or Routed AI Model',
    role: 'Research synthesis, product structure, copywriting, difficult reasoning, and unusual repair decisions',
    costClass: 'usage_paid',
    status: 'planned_adapter',
    useWhen: ['Intelligence is required', 'A deterministic rule cannot solve the problem', 'Generate or improve product content'],
    avoidWhen: ['Drawing repeated boxes, tables, trackers, margins, or other deterministic layout work'],
  },
  {
    id: 'ai_image_generation',
    name: 'AI Image Generation',
    role: 'Optional custom illustrations, decorative assets, and selected listing graphics',
    costClass: 'optional_paid',
    status: 'optional_adapter',
    useWhen: ['A product genuinely benefits from original illustration or visual assets'],
    avoidWhen: ['A clean typography/layout solution is sufficient'],
  },
];

export const COMMERCE_PDF_ROUTING_POLICY = {
  localFirst: true,
  requireQualityGate: true,
  requireOwnerApprovalBeforePublishing: true,
  useAiForDeterministicLayout: false,
  preferredProductionPath: [
    'nexus',
    'html_css_templates',
    'weasyprint',
    'local_qa',
  ] as const,
  optionalEnhancementTools: ['canva_free', 'canva_pro', 'claude', 'ai_image_generation'] as const,
};

export function getPdfTool(id: PdfToolDefinition['id']): PdfToolDefinition {
  const tool = COMMERCE_PDF_TOOLS.find((candidate) => candidate.id === id);
  if (!tool) throw new Error(`Unknown commerce PDF tool: ${id}`);
  return tool;
}
