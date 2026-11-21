import { useNow } from "../lib/clock";
import { formatRelative, formatUtc, isoTime } from "../lib/format";

/** Relative time ("13 min ago") that keeps itself current; absolute UTC in the title. Unix seconds. */
export function TimeAgo(props: { time: number; suffix?: boolean }) {
  const now = useNow();
  return (
    <time class="num" datetime={isoTime(props.time)} title={formatUtc(props.time)}>
      {formatRelative(props.time, now(), { suffix: props.suffix !== false })}
    </time>
  );
}

/** Absolute UTC time ("11 Nov 2026, 20:41:07 UTC"; without seconds, "11 Nov 2026, 20:41 UTC"). */
export function TimeUtc(props: { time: number; seconds?: boolean }) {
  return (
    <time class="num" datetime={isoTime(props.time)}>
      {formatUtc(props.time, props.seconds !== false)}
    </time>
  );
}
