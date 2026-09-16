export interface WaitingStatus {
  latest_tag: string | null;
  ahead_by: number;
}

// A repo that has never cut a release is unlikely to ever cut one — and its
// ahead_by is the whole branch history, so it would swamp the list. Only an
// explicit pin gets it in.
export function isWaiting(status: WaitingStatus | undefined, pinned: boolean): boolean {
  if (!status || status.ahead_by <= 0) return false;
  return status.latest_tag !== null || pinned;
}
