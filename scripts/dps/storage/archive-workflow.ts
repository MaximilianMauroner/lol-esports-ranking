export interface ArchiveFirstWorkflowHooks<TIntent, TObject> {
  createPendingIntent: () => Promise<TIntent>;
  markUploadAttempt: (intent: TIntent) => Promise<void>;
  uploadAndVerify: () => Promise<TObject>;
  markUploadFailed: (intent: TIntent, error: unknown) => Promise<void>;
  finalizeTransactionally: (intent: TIntent, object: TObject) => Promise<void>;
}

/**
 * The small orchestration contract used by ingestion and its failure-mode tests.
 * A failed upload is explicitly marked failed; a failed final transaction deliberately leaves
 * the intent pending so a reconciler can see the already-uploaded immutable object.
 */
export async function runArchiveFirst<TIntent, TObject>(
  hooks: ArchiveFirstWorkflowHooks<TIntent, TObject>,
): Promise<void> {
  const intent = await hooks.createPendingIntent();
  await hooks.markUploadAttempt(intent);
  let object: TObject;
  try {
    object = await hooks.uploadAndVerify();
  } catch (error) {
    await hooks.markUploadFailed(intent, error);
    throw error;
  }
  await hooks.finalizeTransactionally(intent, object);
}
