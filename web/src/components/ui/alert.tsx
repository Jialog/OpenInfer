import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { CircleAlert, Info, TriangleAlert } from "lucide-react"

const alertVariants = cva(
  "flex w-full min-w-0 items-start gap-2.5 rounded-lg border px-3.5 py-3 text-left text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-border bg-subtle text-foreground [&>svg]:text-muted-foreground",
        warning: "border-warning/25 bg-warning-soft text-foreground [&>svg]:text-warning",
        destructive: "border-danger/25 bg-danger-soft text-danger",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

const ICONS = { default: Info, warning: TriangleAlert, destructive: CircleAlert }

function Alert({
  className,
  variant,
  children,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  const Icon = ICONS[variant ?? "default"]
  return (
    <div data-slot="alert" role="alert" className={cn(alertVariants({ variant }), className)} {...props}>
      <Icon aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-1">{children}</div>
    </div>
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-title" className={cn("font-medium", className)} {...props} />
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn("text-sm [overflow-wrap:anywhere] [&_a]:underline [&_a]:underline-offset-3", className)}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription }
