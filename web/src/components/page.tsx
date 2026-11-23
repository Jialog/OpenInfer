import type {ReactNode} from 'react';

export function PageHeader({title, description, action, aside}: {title: string; description?: ReactNode; action?: ReactNode; aside?: ReactNode}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {aside}
        </div>
        {description && <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
}

/** One row of a list: icon, title, one line of description, and something on the right. */
export function ListRow({icon, title, description, aside, children, testId}: {
  icon?: ReactNode; title: ReactNode; description?: ReactNode; aside?: ReactNode; children?: ReactNode; testId?: string;
}) {
  return (
    <li data-testid={testId} className="flex min-w-0 flex-col gap-2 px-5 py-4 sm:px-6">
      <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2">
        {icon && <span className="mt-0.5 flex">{icon}</span>}
        <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
          <div className="min-w-0 font-medium [overflow-wrap:anywhere]">{title}</div>
          {description && <div className="text-[13px] [overflow-wrap:anywhere] text-muted-foreground">{description}</div>}
        </div>
        {aside && <div className="flex flex-wrap items-center gap-2">{aside}</div>}
      </div>
      {children}
    </li>
  );
}
