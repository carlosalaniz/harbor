import type { EventDto, InstanceSummary, OperationDto, PlanDto } from '../contracts/api.js';
import { browserUrlFor } from '../config.js';
import type { EventRow, InstanceRow, OperationRow, PlanRow } from '../state/repo.js';

export function eventDto(e: EventRow): EventDto {
  return { cursor: String(e.cursor), at: e.at, phase: e.phase, message: e.message };
}

export function instanceSummary(i: InstanceRow, packageName: string, primaryEndpoint: string): InstanceSummary {
  return {
    id: i.id,
    name: i.name,
    packageId: i.packageId,
    packageName,
    revision: i.revision,
    desired: i.desired,
    installState: i.installState,
    runtime: i.runtime,
    readiness: i.readiness,
    observedAt: i.observedAt,
    endpoints: i.endpoints.map((e) => ({ id: e.id, containerPort: e.containerPort, hostPort: e.hostPort, browserUrl: browserUrlFor(e.hostPort) })),
    primaryEndpoint,
    operationId: i.activeOperationId ?? i.lastOperationId,
    hasRetainedData: i.everInstalled || i.secrets.length > 0,
  };
}

export function planDto(p: PlanRow, storageStates: Record<string, 'new' | 'existing'>, secretStates: Record<string, 'new' | 'existing'>): PlanDto {
  return {
    id: p.id,
    kind: p.kind,
    instanceId: p.instanceId,
    name: p.proposal.name,
    packageId: p.proposal.packageId,
    revision: p.proposal.revision,
    expiresAt: p.expiresAt,
    expectedGeneration: p.expectedGeneration,
    changes: p.proposal.changes,
    endpoints: p.proposal.endpoints.map((e) => ({ id: e.id, containerPort: e.containerPort, hostPort: e.hostPort, browserUrl: browserUrlFor(e.hostPort) })),
    storage: p.proposal.storage.map((s) => ({ id: s.id, volumeName: s.volumeName, purpose: s.purpose, state: storageStates[s.id] ?? 'new' })),
    secrets: p.proposal.secrets.map((s) => ({ id: s.id, state: secretStates[s.id] ?? 'new' })),
    warnings: p.proposal.warnings,
  };
}

export function operationDto(o: OperationRow, events: EventRow[]): OperationDto {
  return {
    id: o.id,
    kind: o.kind,
    instanceId: o.instanceId,
    planId: o.planId,
    state: o.state,
    phase: o.phase,
    createdAt: o.createdAt,
    startedAt: o.startedAt,
    finishedAt: o.finishedAt,
    error: o.errorCode ? { code: o.errorCode, message: o.errorMessage ?? '', nextAction: o.nextAction ?? '' } : null,
    result: o.result,
    events: events.map(eventDto),
  };
}
