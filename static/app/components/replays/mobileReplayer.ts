import {Timer} from 'sentry/utils/replays/timer';

interface MobileAttachment {
  duration: number;
  timestamp: number;
  uri: string;
}

type RootElem = HTMLDivElement | null;

interface OffsetOptions {
  segmentOffsetMs?: number;
}

interface MobileReplayerOptions {
  onFinished: () => void;
  onLoaded: (event: any) => void;
  root: RootElem;
  start: number;
}

function findSegmentIndex(trackList: [ts: number, index: number][], segments: MobileAttachment[], targetTimestamp: number, start: number, end: number) {
  if (start > end) {
    // XXX: This means we are not returning "exact" segments, but the prior
    // segment if it doesn't not satisfy the exact time constraints
    return end;
  }

  const mid = Math.floor((start + end) / 2);

  const [ts, index] = trackList[mid];
  const segment = segments[index];

  // Segment match found
  if (targetTimestamp >= ts && targetTimestamp <= (ts + segment.duration)) {
    return index;
  }

  // Search higher half
  if (targetTimestamp > ts) {
    return findSegmentIndex(trackList, segments, targetTimestamp, mid + 1, end);
  }

  // Search lower half
  return findSegmentIndex(trackList, segments, targetTimestamp, start, mid - 1);
}

/**
  * A special replayer that is specific to mobile replays. Should replicate rrweb's player interface.
  */
export class MobileReplayer {
  private _attachments: MobileAttachment[];
  private _callbacks: Record<string, (args?: any) => unknown>;
  private _currentIndex: number | undefined;
  private _playbackSpeed: number = 1.0;
  private _startTimestamp: number;
  private _timer = new Timer();
  private _trackList: [ts: number, index: number][];
  private _videos: HTMLVideoElement[];
  public wrapper: HTMLElement;
  public iframe = {};

  constructor(attachments: MobileAttachment[], { root, start, onFinished, onLoaded}: MobileReplayerOptions) {
    this._attachments = attachments;
    this._startTimestamp = start;
    this._trackList = [];
    this._callbacks = {
      onFinished,
      onLoaded,
    };

    this.wrapper = document.createElement('div');
    if (root) {
      root.appendChild(this.wrapper);
    }

    this._videos = attachments.map((attachment, index) => this.createVideo(attachment, index));
    this._trackList = attachments.map(({ timestamp }, i) => [timestamp, i]);
    this.loadSegment(0);
  }

  private createVideo(segmentData: MobileAttachment, index: number) {
    const el = document.createElement('video');
    el.src = segmentData.uri;
    el.style.display = "none";

    // TODO: only attach these when needed
    el.addEventListener('ended', () => this.handleSegmentEnd(index));
    el.addEventListener('loadedmetadata', (event) => {
      // Only call this for current segment?
      if (index === this._currentIndex) {
        this._callbacks.onLoaded(event);
      }
    });
    // TODO: Only preload when necessary
    el.preload = "auto";
    el.playbackRate = this._playbackSpeed;

      // Append the video element to the mobile player wrapper element
    this.wrapper.appendChild(el);

    return el;
  }

  private handleSegmentEnd(index: number) {
    const nextIndex = index + 1;

    // No more segments
    if (nextIndex >= this._attachments.length) {
      this._timer.stop();
      this._callbacks.onFinished();
      return;
    }

    this.playSegmentAtIndex(nextIndex);
  }

  /**
   * Given a relative time offset, get the segment number where the time offset would be contained in
   */
  protected getSegmentIndexForTime(relativeOffsetMs: number): {previousSegment: number|undefined, segment: number|undefined} {
    const timestamp = this._startTimestamp + relativeOffsetMs;

    // This function will return the prior segment index if no valid segments
    // were found, so we will need to double check if the result was an exact
    // match or not
    const result = findSegmentIndex(this._trackList, this._attachments, timestamp, 0, this._trackList.length - 1);
    const resultSegment = this.getSegment(result)!;
    const isExactSegment = (timestamp >= resultSegment.timestamp && timestamp <= (resultSegment.timestamp + resultSegment.duration));

    // TODO: Handle the case where relativeOffsetMs > length of the replay/seekbar (shouldn't happen)
    return {
      segment: isExactSegment ? result : undefined,
      previousSegment: !isExactSegment ? result : undefined,
    }
  }

  protected getSegment(index?: number | undefined): MobileAttachment | null {
    if (typeof index === 'undefined') {
      return null;
    }

    return this._attachments[index];
  }

  protected getVideo(index: number | undefined): HTMLVideoElement | null {
    if (typeof index === 'undefined') {
      return null;
    }

    return this._videos[index];
  }

  protected hideVideo(index: number | undefined): void {
    const video = this.getVideo(index);

    if (!video) {
      return;
    }

    video.style.display = 'none';
  }

  protected showVideo(video: HTMLVideoElement | null): void {
    if (!video) {
      return;
    }

    video.style.display = 'block';
  }

  protected playVideo(video: HTMLVideoElement | null): Promise<void> | undefined {
    if (!video) {return undefined; }
    video.playbackRate = this._playbackSpeed;
    return video.play();

  }

  protected setVideoTime(video: HTMLVideoElement, timeMs: number) {
    // Needs to be in seconds
    video.currentTime = timeMs / 1000;
  }

  /**
   * Loads a segment at a specified index. Handles hiding/showing the video
   * segment, and ensures that the videos are synced with the timer. That is,
   * do not show videos before the timer has reached the segment's current
   * starting timestamp.
   */
  protected async loadSegment(index: number | undefined, {segmentOffsetMs = 0}: OffsetOptions = {}): Promise<number> {
    // Check if index is valid
    if (index === undefined || index < 0 || index >= this._attachments.length) {
      return -1;
    }

    // Check if video at index should be played (e.g. if scrubber time is
    // within bounds of video time constraints)
    const currentSegment = this.getSegment(index);
    const now = this._timer.getTime();

    if (!currentSegment) {
      // Error if segment isn't found
      return -1;
    }

    const currentSegmentOffset = currentSegment.timestamp - this._startTimestamp;

    // `handleEnd()` dumbly gives the next video, we need to make sure that the
    // current seek time is inside of the video timestamp, as there can be gaps
    // in between videos
    if (now < currentSegmentOffset) {
      // There should not be the case where this is called and we need to
      // display the previous segment. `loadSegmentAtTime` handles showing the
      // previous segment when you seek.
      await new Promise((resolve) => this._timer.addNotificationAtTime(currentSegmentOffset, () => resolve(true)));
    }

    // TODO: This shouldn't be needed? previous video shouldn't be displayed?
    const previousIndex = index - 1;
    if (previousIndex >= 0) {
      // Hide the previous video
      this.hideVideo(previousIndex);
    }

    // Hide current video
    this.hideVideo(this._currentIndex);

    const nextVideo = this.getVideo(index);
    // Show the next video
    this.showVideo(nextVideo);

    // Set video to proper offset
    if (nextVideo) {
      this.setVideoTime(nextVideo, segmentOffsetMs);
      this._currentIndex = index;
    } else {
      console.error(new Error('Loading invalid video'))
      return -1;
    }

    return this._currentIndex;
  }

  /**
   * Plays a segment at the segment index
   */
  protected async playSegmentAtIndex(index: number | undefined) {
    const loadedSegmentIndex = await this.loadSegment(index, {segmentOffsetMs: 0});

    if (loadedSegmentIndex !== undefined) {
      this.playVideo(this.getVideo(loadedSegmentIndex));
    }
  }

  /**
   * Loads a segment based on the video offset (all of the segments
   * concatenated together). Finds the proper segment to load based on each
   * segment's timestamp and duration. Displays the closest prior segment if
   * offset exists in a gap where there is no recorded segment.
   */
  protected async loadSegmentAtTime(videoOffsetMs: number = 0): Promise<number|undefined> {
    const {segment: segmentIndex, previousSegment: previousSegmentIndex} = this.getSegmentIndexForTime(videoOffsetMs)

    let nextSegmentIndex = segmentIndex;

    // It's possible video and segment don't exist, e.g. if we seek to a gap
    // between two replays. In this case, we load the previous segment index
    // and wait until the timer reaches the next video segment's starting
    // timestamp before playing.
    if (segmentIndex === undefined && previousSegmentIndex !== undefined) {
      const previousSegment = this.getSegment(previousSegmentIndex)!;
      // Load the last frame of the previous segment
      await this.loadSegment(previousSegmentIndex, {segmentOffsetMs: previousSegment.duration});

      // segmentIndex is undefined because user has seeked into a gap where
      // there is no segment, because we have the previous index, we know what
      // the next index will be since segments are expected to be sorted
      nextSegmentIndex = previousSegmentIndex + 1;
    }

    const segment = this.getSegment(nextSegmentIndex);
    if (!segment) {
      // There could be an edge case where we have a gap at the end of the
      // video (due to bad data maybe?), and there is no next segment
      return undefined;
    }

    // We are given an offset based on all videos combined, so we have to
    // calculate the individual video segment's offset
    const segmentOffsetMs = (this._startTimestamp + videoOffsetMs) - segment.timestamp;

    return this.loadSegment(nextSegmentIndex, {segmentOffsetMs})
  }

  /**
   * Plays the video segment at a time (offset), e.g. starting at 20 seconds
   */
  protected async playSegmentAtTime(videoOffsetMs: number = 0) {
    const loadedSegmentIndex = await this.loadSegmentAtTime(videoOffsetMs);

    if (loadedSegmentIndex === undefined) {
      // TODO: this shouldn't happen, loadSegment should load the previous
      // segment until it's time to start the next segment
      return;
    }

    this.playVideo(this.getVideo(loadedSegmentIndex));
  }

  /**
   * Returns the current time of our timer
   *
   * We keep a separate timer because there can be cases where we have "gaps"
   * between videos. In this case we will need the seek bar to continue running
   * until the next video starts.
   */
  public getCurrentTime() {
    if (this._currentIndex === undefined) {
      return 0;
    }

    return this._timer.getTime();
  }

  /**
   * @param videoOffsetMs The time within the entire video, to start playing at
   */
  public play(videoOffsetMs: number) {
    this._timer.start(videoOffsetMs);
    this.playSegmentAtTime(videoOffsetMs);
  }

  /**
   * Pause at a specific time in the replay. Note that this gets called when seeking.
   */
  public pause(videoOffsetMs: number) {
    // Pause the current video
    const currentVideo = this.getVideo(this._currentIndex);
    currentVideo?.pause();
    this._timer.stop(videoOffsetMs);

    // Load the current segment and set to correct time
    this.loadSegmentAtTime(videoOffsetMs);
  }

  /**
  * Equivalent to rrweb's `setConfig()`, but here we only support the `speed` configuration
  */
  public setConfig({speed}: Partial<{skipInactive: boolean; speed: number;}>): void {
    if (typeof speed === "undefined") {
      return;
    }

    this._playbackSpeed = speed;
    const currentVideo = this.getVideo(this._currentIndex);

    if (!currentVideo) {
      return;
    }

    currentVideo.playbackRate = this._playbackSpeed;;
  }
}
