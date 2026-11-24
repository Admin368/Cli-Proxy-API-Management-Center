import { projectLane, type TimelineLane, type TimelineMode } from './quotaTimelineModel';

export function earliestActiveWindowStart(
  lanes: TimelineLane[],
  start: number,
  end: number,
  now: number
): number | null {
  const starts = lanes.flatMap((lane) =>
    projectLane(lane, start, end, now, 'session')
      .filter((window) => window.state === 'live' && window.remaining !== null)
      .map((window) => window.startMs)
  );
  return starts.length ? Math.max(start, Math.min(...starts)) : null;
}

export function timelineScrollLeft(
  mode: TimelineMode,
  target: number,
  start: number,
  end: number,
  trackWidth: number,
  visibleTrackWidth: number
): number {
  if (end <= start || visibleTrackWidth <= 0) return 0;
  const at = ((target - start) / (end - start)) * trackWidth;
  const offset = at - (mode === 'session' ? 12 : visibleTrackWidth / 2);
  return Math.max(0, Math.min(trackWidth - visibleTrackWidth, offset));
}
