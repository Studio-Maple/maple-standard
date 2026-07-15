import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export type ButtonVariant = "primary" | "secondary" | "ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "btn btn-primary",
  secondary: "btn btn-secondary",
  ghost: "btn btn-ghost",
};

/**
 * `components/ui/` holds presentational primitives only — no data fetching,
 * no `services/` imports (dependency-cruiser `ui-primitives-no-services`).
 * Swap this file set for shadcn/ui, Radix, or your design system of choice;
 * the layering rule is what matters, not this specific implementation.
 */
export function Button({ variant = "primary", className, ...props }: ButtonProps) {
  return <button className={cn(VARIANT_CLASS[variant], className)} {...props} />;
}
