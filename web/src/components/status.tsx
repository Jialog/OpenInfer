// Row icons in the line style of lucide: green check circle done, blue dot current, empty circle not
// started, red exclamation failed, amber triangle needs attention.
import {Circle, CircleAlert, CircleCheck, CircleDot, Hourglass, LoaderCircle, TriangleAlert} from 'lucide-react';
import {cn} from '@/lib/utils';

export type Status = 'done' | 'current' | 'pending' | 'failed' | 'attention' | 'running' | 'waiting';

const ICON = {
  done: {Icon: CircleCheck, className: 'text-success'},
  current: {Icon: CircleDot, className: 'text-primary'},
  pending: {Icon: Circle, className: 'text-muted-foreground/60'},
  failed: {Icon: CircleAlert, className: 'text-danger'},
  attention: {Icon: TriangleAlert, className: 'text-warning'},
  running: {Icon: LoaderCircle, className: 'animate-spin text-primary'},
  waiting: {Icon: Hourglass, className: 'text-muted-foreground'},
} as const;

export function StatusIcon({status, className}: {status: Status; className?: string}) {
  const {Icon, className: tone} = ICON[status];
  return <Icon aria-hidden data-status-icon={status} className={cn('size-4 shrink-0', tone, className)} />;
}

/** The status in words, for screen readers: the icon is hidden from them. */
export const STATUS_WORD: Record<Status, string> = {
  done: 'Done',
  current: 'In progress',
  running: 'In progress',
  pending: 'Not started',
  failed: 'Failed',
  attention: 'Needs attention',
  waiting: 'Waiting',
};
