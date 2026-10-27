// Test assertions can contain OAuth material, native rows or provider bodies.
// Export only complete root result lines whose names are fixed by this fixture.
export const clientTests = ['TestPinnedClaudeCodeCLIThroughPublicMessagesPostgres', 'TestPinnedCodexCLIThroughPublicResponsesPostgres'] as const;
export const repositoryTests = ['TestGatewayNativeClaudePostgresLifecycleAndPassiveLimits', 'TestGatewayNativeClaudePostgresStreamsReleaseSQLAtHeaders'] as const;
export const publicTests = ['TestPublicIngressStreamsReplaysEvictsAndPreservesPrivateBoundary', 'TestPublicIngressDisconnectClosesBodyAndSettlesWithoutClientContext',
  'TestStandardResponsesDefaultsPreserveBytesAndDenyDuplicateAuthority', 'TestBoundReservationNonceSharedVectorAndScope',
  'TestPublicStatusOnlyReceiptsDisposeButAmbiguousAdmissionRemainsBounded', 'TestPublicTerminalEventAndEOFWaitForDurableSettlementAndFailureTruncates',
  'TestPublicTerminalBurstPacesTwelveCallbacksAndRetainsAbortedQueuedOwner', 'TestPublicTerminalAggregateBudgetWithholdsOnSaturationAndReleases',
  'TestPublicPreclaimAuthorityCapacityIsDistinctFromAuthenticationAndProtocolFailure', 'TestPublicNativeMessagesPreserveProtocolAndExecutionAuthority',
  'TestPublicPreworkRefusalIsExactNonceBoundAndNeverReplaysAmbiguousAdmission',
  'TestPublicPostclaimVerificationFailureRetainsProofForIndependentNoEntrySettlement',
  'TestPublicPreclaimRPCProducersWaitBoundedlyWithoutBlockingCriticalCallbacks',
  'TestPublicPreclaimQueueHasFreshActiveBudgetForAuthorityAndClaim',
  'TestPublicPreclaimQueueExpiryAndCallerCancellationNeverPost',
  'TestPublicPreclaimActiveTimeoutOrCancellationPreservesAttemptAmbiguity',
  'TestPublicRequestedModelMetadataRemainsBoundToReservation',
  'TestPublicLateClaimReplyCannotOverwriteRecoveredOriginalProof',
  'TestPublicTerminalQueueWaitHasIndependentActiveBudgetAndFourOwners',
  'TestPublicTerminalQueueExpiryRetainsEvidenceWithoutCallbackOrReplay',
  'TestPublicTerminalDeliveryRefreshesOnlyWriteDeadlineAfterDurableSettlement',
  'TestClaudePrivateHTTPRejectsLossyPayloadBeforeAdmission'] as const;
export const bootstrapTests = ['TestPublicListenerSaturatedRequestsReturnSafeAdmissionRefusal', 'TestPublicInferenceConfigurationIsExplicitAndBounded',
  'TestPublicHTTPServerClosesEachConnection'] as const;
export const reservationTests = [
  'TestNEWTESTConcurrentReservationsOneHTTPCallback', 'TestNEWTESTSaturationBeforeHTTPCallbackAndChangedIntent',
  'TestNEWTESTHeldAndLostAdmitACKNeverRearms', 'TestNEWTESTCallbackFullBindingMutationsDeny',
  'TestNEWTESTReadbackCallbackNoPermission', 'TestNEWTESTCleanupRecoveredOriginalProofRepeatedReceipt',
  'TestNEWTESTPrivateHTTPConcurrentDuplicatesAndConsumerBodyRejected', 'TestNEWTESTDuplicateCallbackInvocationNoSecondPermission',
  'TestNEWTESTCallbackAmbiguousBytesAndBoundedFailure', 'TestNEWTESTConstructorAbsentAuthorityDenied',
  'TestNEWTESTContextCancellationSealVisibleAndProofRecoverable', 'TestNEWTESTCleanupLostACKRetainsExactReceipt',
  'TestGatewayNativeUsageReceipt', 'TestGatewayNativeOwnerHTTPClosureOnActualCompletedTransport',
] as const;

export function goTestEvidence(raw: string, allowed: readonly string[]) {
  const names = new Set(allowed);
  const tests: { name: string; outcome: 'PASS' | 'FAIL' | 'SKIP'; seconds: number }[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = /^--- (PASS|FAIL|SKIP): (Test[A-Za-z0-9_]{1,160}) \(([0-9]{1,5}(?:\.[0-9]{1,9})?)s\)$/.exec(line);
    if (!match || !names.has(match[2])) continue;
    tests.push({ name: match[2], outcome: match[1] as 'PASS' | 'FAIL' | 'SKIP', seconds: Number(match[3]) });
    if (tests.length >= 4096) break;
  }
  return { kind: 'gateway-go-test-evidence/v1', tests };
}
