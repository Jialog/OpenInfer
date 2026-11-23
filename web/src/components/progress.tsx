import {cn} from '@/lib/utils';

/** "3 of 5 …" with a thin accent bar under it. */
export function ProgressBar({value, max, label, className}: {value: number; max: number; label: string; className?: string}) {
  const percent = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}
           className="h-1.5 w-full overflow-hidden rounded-full bg-track">
        <div className="h-full rounded-full bg-primary transition-[width]" style={{width: `${percent}%`}} />
      </div>
    </div>
  );
}
