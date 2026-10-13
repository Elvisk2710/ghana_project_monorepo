/** Audit actions that change whether a document may be served to the public (read when reconstructing an answer). */
export const GOVERNED_DOCUMENT_ACTIONS = [
  'document.ingest', 'document.metadata.update', 'document.reprocess', 'document.approve', 'document.reject',
  'document.publish', 'document.unpublish', 'document.supersede',
];
