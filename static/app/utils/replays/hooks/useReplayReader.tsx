import {useMemo} from 'react';

import useReplayData from 'sentry/utils/replays/hooks/useReplayData';
import ReplayReader from 'sentry/utils/replays/replayReader';

type Props = {
  orgSlug: string;
  replaySlug: string;
};

export default function useReplayReader({orgSlug, replaySlug}: Props) {
  const replayId = parseReplayId(replaySlug);

  const {attachments, accessibilityFrames, errors, replayRecord, ...replayData} =
    useReplayData({
      orgSlug,
      replayId,
    });

  const replay = useMemo(
    () => ReplayReader.factory({attachments, errors, replayRecord, accessibilityFrames}),
    [attachments, errors, replayRecord, accessibilityFrames]
  );

  return {
    ...replayData,
    attachments,
    errors,
    replay,
    replayId,
    replayRecord,
    accessibilityFrames,
  };
}

// see https://github.com/getsentry/sentry/pull/47859
// replays can apply to many projects when incorporating backend errors
// this makes having project in the `replaySlug` obsolete
// we must keep this url schema for now for backward compat but we should remove it at some point
// TODO: remove support for projectSlug in replay url?
function parseReplayId(replaySlug: string) {
  const maybeProjectSlugAndReplayId = replaySlug.split(':');
  if (maybeProjectSlugAndReplayId.length === 2) {
    return maybeProjectSlugAndReplayId[1];
  }

  // if there is no projectSlug then we assume we just have the replayId
  // all other cases would be a malformed url
  return maybeProjectSlugAndReplayId[0];
}
