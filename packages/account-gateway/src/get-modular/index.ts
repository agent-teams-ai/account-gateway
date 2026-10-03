import { compileComposition, defineModule, required } from '@get-modular/core';
import { assemblyFor } from '@get-modular/assembly';
import type { Assembly, CapabilityContract } from '@get-modular/assembly';
import { createManagementClient, createExecutionClient, GatewayError } from '../http/index.js';
import type { ManagementConfig, ExecutionConfig, ManagementClient, ExecutionClient } from '../http/index.js';

const compatibility = Object.freeze({ family: 'exact', familyVersion: 1, token: 'account-gateway/v1' } as const);
export const managementHost = defineModule({ kind: 'get-modular.module-declaration', schemaVersion: 1,
  moduleId: 'account-gateway/management-host', implementationId: 'account-gateway/management-host/static',
  owner: { authority: 'consumer', path: ['gateway'] }, slots: [],
  provides: [{ capabilityId: 'account-gateway/management-config', compatibility }] } as const);
export const executionHost = defineModule({ kind: 'get-modular.module-declaration', schemaVersion: 1,
  moduleId: 'account-gateway/execution-host', implementationId: 'account-gateway/execution-host/static',
  owner: { authority: 'consumer', path: ['gateway'] }, slots: [],
  provides: [{ capabilityId: 'account-gateway/execution-config', compatibility }] } as const);
export const managementDeclaration = defineModule({ kind: 'get-modular.module-declaration', schemaVersion: 1,
  moduleId: 'account-gateway/management', implementationId: 'account-gateway/management/http-v1',
  owner: { authority: 'agent-teams', path: ['account-gateway'] },
  slots: [{ slotId: 'config', capabilityId: 'account-gateway/management-config', compatibility, cardinality: required() }],
  provides: [{ capabilityId: 'account-gateway/management', compatibility }] } as const);
export const executionDeclaration = defineModule({ kind: 'get-modular.module-declaration', schemaVersion: 1,
  moduleId: 'account-gateway/execution', implementationId: 'account-gateway/execution/http-v1',
  owner: { authority: 'agent-teams', path: ['account-gateway'] },
  slots: [{ slotId: 'config', capabilityId: 'account-gateway/execution-config', compatibility, cardinality: required() }],
  provides: [{ capabilityId: 'account-gateway/execution', compatibility }] } as const);
export const managementProfile = Object.freeze({ kind: 'get-modular.composition-profile', schemaVersion: 1,
  profileId: 'account-gateway/management-static', roots: [managementDeclaration.moduleId],
  selections: [managementHost, managementDeclaration].map(({ moduleId, implementationId }) => ({ moduleId, implementationId })),
  bindings: [{ consumerImplementationId: managementDeclaration.implementationId, slotId: 'config', providerImplementationIds: [managementHost.implementationId] }] } as const);
export const executionProfile = Object.freeze({ kind: 'get-modular.composition-profile', schemaVersion: 1,
  profileId: 'account-gateway/execution-static', roots: [executionDeclaration.moduleId],
  selections: [executionHost, executionDeclaration].map(({ moduleId, implementationId }) => ({ moduleId, implementationId })),
  bindings: [{ consumerImplementationId: executionDeclaration.implementationId, slotId: 'config', providerImplementationIds: [executionHost.implementationId] }] } as const);
export type ClientCapabilities = {
  'account-gateway/management-config': CapabilityContract<ManagementConfig, 'account-gateway/v1'>;
  'account-gateway/execution-config': CapabilityContract<ExecutionConfig, 'account-gateway/v1'>;
  'account-gateway/management': CapabilityContract<ManagementClient, 'account-gateway/v1'>;
  'account-gateway/execution': CapabilityContract<ExecutionClient, 'account-gateway/v1'>;
};
export function bindManagementFactory(assembly: Assembly<ClientCapabilities>) {
  return assembly.bindFactory(managementDeclaration, async ({ config }) => {
    const client = createManagementClient(config);
    return { instance: client, capabilities: { 'account-gateway/management': client } };
  });
}
export function bindExecutionFactory(assembly: Assembly<ClientCapabilities>) {
  return assembly.bindFactory(executionDeclaration, async ({ config }) => {
    const client = createExecutionClient(config);
    return { instance: client, capabilities: { 'account-gateway/execution': client } };
  });
}
/** Host passes credentials only to construction, never to declaration/profile. */
export async function constructManagementClient(settings: ManagementConfig): Promise<ManagementClient> {
  const assembly = assemblyFor<ClientCapabilities>();
  const host = assembly.bindFactory(managementHost, async () => ({ instance: undefined, capabilities: { 'account-gateway/management-config': settings } }));
  const client = bindManagementFactory(assembly);
  const composition = await compileComposition({ declarations: [managementHost, managementDeclaration], profile: managementProfile });
  if (!composition.ok) throw new GatewayError('invalid_input', 'not_dispatched');
  const prepared = await assembly.prepare({ composition, factories: [host, client], roots: { client } });
  if (prepared.status !== 'prepared') throw new GatewayError('invalid_input', 'not_dispatched');
  const result = await prepared.prepared.run();
  if (result.status !== 'succeeded') throw new GatewayError('invalid_input', 'not_dispatched');
  return result.roots.client;
}
export async function constructExecutionClient(settings: ExecutionConfig): Promise<ExecutionClient> {
  const assembly = assemblyFor<ClientCapabilities>();
  const host = assembly.bindFactory(executionHost, async () => ({ instance: undefined, capabilities: { 'account-gateway/execution-config': settings } }));
  const client = bindExecutionFactory(assembly);
  const composition = await compileComposition({ declarations: [executionHost, executionDeclaration], profile: executionProfile });
  if (!composition.ok) throw new GatewayError('invalid_input', 'not_dispatched');
  const prepared = await assembly.prepare({ composition, factories: [host, client], roots: { client } });
  if (prepared.status !== 'prepared') throw new GatewayError('invalid_input', 'not_dispatched');
  const result = await prepared.prepared.run();
  if (result.status !== 'succeeded') throw new GatewayError('invalid_input', 'not_dispatched');
  return result.roots.client;
}
