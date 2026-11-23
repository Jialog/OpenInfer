// The horizontal segmented bar for steps: each segment has an icon, a name and one line of small text.
// On narrow screens the segments stack.
import {cn} from '@/lib/utils';
import {STATUS_WORD, StatusIcon, type Status} from './status';

export type Segment = {key: string; label: string; detail?: string | null; status: Status};

export function SegmentBar({segments, className, testId}: {segments: Segment[]; className?: string; testId?: string}) {
  return (
    <ol data-testid={testId}
        className={cn('grid overflow-hidden rounded-lg border bg-card max-sm:divide-y sm:grid-flow-col sm:auto-cols-fr sm:divide-x', className)}>
      {segments.map((s) => (
        <li key={s.key} data-testid={testId ? `${testId}-${s.key}` : undefined} data-status={s.status}
            className={cn('flex min-w-0 gap-2.5 px-4 py-3 sm:flex-col sm:gap-1.5', s.status === 'current' && 'bg-subtle')}>
          <StatusIcon status={s.status} className="mt-0.5 sm:mt-0" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className={cn('text-sm', s.status === 'pending' ? 'text-muted-foreground' : 'font-medium')}>
              {s.label}<span className="sr-only">{STATUS_WORD[s.status]}</span>
            </span>
            {s.detail && <span className="text-[13px] [overflow-wrap:anywhere] text-muted-foreground">{s.detail}</span>}
          </div>
        </li>
      ))}
    </ol>
  );
}
