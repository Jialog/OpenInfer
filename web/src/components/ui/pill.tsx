import * as React from "react"
import { cn } from "cn"

export type Tone = "success" | "warning" | "danger" | "neutral" | "info"

// Small capsule on a light tint: green done, amber to do or attention, red failed, grey not started.
const TONES: Record<Tone, string> = {
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  neutral: "bg-neutral-soft text-neutral",
  info: "bg-primary/10 text-info",
}

function Pill({ tone = "neutral", className, ...props }: React.ComponentProps<"span"> & { tone?: Tone }) {
  return (
    <span
      data-slot="pill"
      data-tone={tone}
      className={cn("inline-flex h-6 w-fit shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-medium whitespace-nowrap", TONES[tone], className)}
      {...props}
    />
  )
}

export { Pill }
