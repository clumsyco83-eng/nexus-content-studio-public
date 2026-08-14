export type NexusNotificationEvent =
  | 'approval_required'
  | 'budget_blocked'
  | 'provider_unready'
  | 'publish_failed'
  | 'guardian_red'
  | 'guardian_yellow'
  | 'published'
  | 'analytics_ready';

export type NotificationDelivery = 'immediate' | 'digest' | 'silent';

export interface NotificationInput {
  event: NexusNotificationEvent;
  jobId?: string;
  project?: string;
  message: string;
  containsSecret?: boolean;
}

export interface NotificationPlan {
  delivery: NotificationDelivery;
  title: string;
  message: string;
  safeToSend: boolean;
  reason: string;
}

const immediateEvents = new Set<NexusNotificationEvent>(['approval_required', 'budget_blocked', 'publish_failed', 'guardian_red']);
const digestEvents = new Set<NexusNotificationEvent>(['provider_unready', 'guardian_yellow', 'published', 'analytics_ready']);

function eventTitle(event: NexusNotificationEvent): string {
  const titles: Record<NexusNotificationEvent, string> = {
    approval_required: 'NEXUS approval required',
    budget_blocked: 'NEXUS budget gate blocked',
    provider_unready: 'NEXUS provider not ready',
    publish_failed: 'NEXUS publishing failed',
    guardian_red: 'NEXUS Guardian RED',
    guardian_yellow: 'NEXUS Guardian YELLOW',
    published: 'NEXUS publish completed',
    analytics_ready: 'NEXUS analytics ready',
  };
  return titles[event];
}

export function planNotification(input: NotificationInput): NotificationPlan {
  if (input.containsSecret) {
    return {
      delivery: 'silent',
      title: eventTitle(input.event),
      message: 'Notification suppressed because the payload was marked as containing sensitive credentials or secrets.',
      safeToSend: false,
      reason: 'Secrets must not leave the local NEXUS runtime through notification payloads.',
    };
  }

  const prefix = [input.project, input.jobId].filter(Boolean).join(' / ');
  const message = `${prefix ? `${prefix}: ` : ''}${input.message}`.trim();
  const delivery: NotificationDelivery = immediateEvents.has(input.event) ? 'immediate' : digestEvents.has(input.event) ? 'digest' : 'silent';

  return {
    delivery,
    title: eventTitle(input.event),
    message,
    safeToSend: true,
    reason: delivery === 'immediate'
      ? 'Owner attention is required to unblock or protect the workflow.'
      : 'Event is useful context but does not require an interruption.',
  };
}
