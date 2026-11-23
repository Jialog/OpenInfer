import * as React from "react"
import { cn } from "cn"

// A white panel with a 1px border, a 11px radius and a very light shadow.
function Card({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      data-slot="card"
      className={cn("flex min-w-0 flex-col rounded-xl border bg-card text-sm text-card-foreground shadow-[0_1px_2px_rgb(0_0_0/0.04)]", className)}
      {...props}
    />
  )
}

/** Title, an optional one-line description and optional actions on the right. */
function CardHeader({
  className,
  title,
  description,
  action,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & { title?: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div data-slot="card-header" className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 pt-5 pb-4 sm:px-6", className)} {...props}>
      {(title || description) && (
        <div className="flex min-w-0 flex-col gap-1">
          {title && <CardTitle>{title}</CardTitle>}
          {description && <CardDescription>{description}</CardDescription>}
        </div>
      )}
      {children}
      {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
    </div>
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return <h2 data-slot="card-title" className={cn("text-[15px] leading-snug font-semibold", className)} {...props} />
}

function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="card-description" className={cn("text-sm text-muted-foreground", className)} {...props} />
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-5 pb-5 sm:px-6", className)} {...props} />
}

/** Rows separated by thin lines, flush with the card's edges. */
function CardList({ className, ...props }: React.ComponentProps<"ul">) {
  return <ul data-slot="card-list" className={cn("divide-y border-t", className)} {...props} />
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardList }
